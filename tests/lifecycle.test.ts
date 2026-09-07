import assert from "node:assert/strict";
import test from "node:test";
import { loadRegistry, type DefinitionRevision } from "../src/registry.ts";
import { openStore, type DeliveryAuthority, type Store } from "../src/store.ts";
import { LeaseReaper } from "../src/reaper.ts";
import type { Delivery, WorkerCapabilities } from "../src/protocol.ts";

const baseRevision = loadRegistry(new URL("./fixtures", import.meta.url).pathname, "events").resolve("ui.variant.requested", 1);

function clock() {
  let value = 1_700_000_000_000;
  return { now: () => value, set: (next: number) => { value = next; }, advance: (delta: number) => { value += delta; } };
}

function worker(workerId = "worker:a"): WorkerCapabilities {
  return { workerId, allowedDefinitions: ["*"], tools: [], structuredOutput: true, contextTokens: 8_000, systemReserveTokens: 0, maxConcurrent: 1 };
}

function authority(delivery: Delivery): DeliveryAuthority {
  return { eventId: delivery.event.id, workerId: delivery.workerId, leaseId: delivery.leaseId };
}

function queuedStore(overrides: Partial<DefinitionRevision["definition"]> = {}) {
  const time = clock();
  const store = openStore(":memory:", time);
  const revision = Object.keys(overrides).length > 0 ? {
    ...baseRevision,
    digest: `revision-${Math.random()}`,
    definition: { ...baseRevision.definition, ...overrides },
  } as DefinitionRevision : baseRevision;
  store.installRevisions([revision]);
  const accepted = store.accept({ producerId: "producer", idempotencyKey: "key", payload: { variant: "dark" }, revision }).event;
  return { store, time, revision, accepted, workerA: worker("worker:a"), workerB: worker("worker:b") };
}

function runningStore(overrides: Partial<DefinitionRevision["definition"]> = {}) {
  const context = queuedStore(overrides);
  const delivery = context.store.acquireAgent(context.workerA, context.time.now());
  assert.ok(delivery);
  context.store.start(authority(delivery));
  return { ...context, delivery };
}

function expectCode(code: string) {
  return (error: unknown): boolean => error instanceof Error && "code" in error && (error as { code: string }).code === code;
}

function failUpdate(store: Store, kind: string): void {
  const sqlite = (store as unknown as { db: { exec(sql: string): void } }).db;
  sqlite.exec(`CREATE TRIGGER fail_${kind} BEFORE INSERT ON updates WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'forced update failure'); END`);
}

test("two workers cannot lease one event", () => {
  const { store, workerA, workerB } = queuedStore();
  assert.ok(store.acquireAgent(workerA, 1000));
  assert.equal(store.acquireAgent(workerB, 1000), undefined);
  assert.deepEqual(store.listUpdatesAfter(0).map((x) => x.kind), ["queued", "leased"]);
});

test("stale worker and lease cannot settle", () => {
  const { store, time, workerB } = queuedStore();
  const delivery = store.acquireAgent(worker("worker:a"), time.now());
  assert.ok(delivery);
  time.advance(60_000);
  store.expireLeases(time.now());
  time.advance(1_000);
  const reacquired = store.acquireAgent(workerB, time.now());
  assert.ok(reacquired);
  assert.throws(() => store.complete(authority(delivery), { ok: true }, []), expectCode("stale_delivery"));
  assert.equal(store.getEvent(delivery.event.id)?.workerId, workerB.workerId);
});

test("unknown consequential effect enters recovery instead of retry", () => {
  const { store, delivery } = runningStore({ effectPolicy: "manual-recovery" });
  const event = store.fail(authority(delivery), { code: "WORKER_LOST", effectStatus: "unknown" });
  assert.equal(event.state, "recovery_required");
  assert.equal(store.listUpdatesAfter(0).at(-1)?.kind, "recovery_required");
});

test("process acquisition is private to the relay process worker", () => {
  const context = queuedStore({ handler: { kind: "process", command: "handlers/echo", args: [], env: [] } });
  assert.equal(context.store.acquireAgent(worker(), context.time.now()), undefined);
  const first = context.store.acquireProcess({ workerId: "relay:process", maxConcurrent: 1 }, context.time.now());
  assert.ok(first);
  assert.equal(context.store.listUpdatesAfter(0).at(-1)?.kind, "leased");
  assert.equal(context.store.acquireProcess({ workerId: "relay:process", maxConcurrent: 1 }, context.time.now()), undefined);
  context.store.complete(authority(first), { ok: true }, []);
  assert.equal(context.store.acquireProcess({ workerId: "relay:process", maxConcurrent: 1 }, context.time.now()), undefined);
});

test("retry uses attempt-indexed backoff and progress does not renew", () => {
  const { store, time, delivery } = runningStore();
  const originalExpiry = store.getEvent(delivery.event.id)?.leaseExpiresAt;
  store.progress(authority(delivery), { step: 1 });
  assert.equal(store.getEvent(delivery.event.id)?.leaseExpiresAt, originalExpiry);
  const event = store.fail(authority(delivery), { code: "temporarily_unavailable", effectStatus: "none" });
  assert.equal(event.state, "retry_wait");
  assert.equal(event.availableAt, time.now() + 1_000);
});

test("renewal refuses a hard deadline", () => {
  const { store, time, delivery } = runningStore();
  assert.throws(() => store.renew(authority(delivery), time.now() + 60_001), expectCode("invalid_expiry"));
});

test("cancellation settles with no effect and recovers when effect may exist", () => {
  const first = runningStore();
  const requested = first.store.requestCancel(first.delivery.event.id);
  assert.equal(requested.state, "cancel_requested");
  assert.equal(first.store.acknowledgeCancel(authority(first.delivery), []).state, "cancelled");

  const second = runningStore();
  second.store.requestCancel(second.delivery.event.id);
  assert.equal(second.store.acknowledgeCancel(authority(second.delivery), [{ effectStatus: "unknown" }]).state, "recovery_required");

  const confirmed = runningStore({ effectPolicy: "manual-recovery" });
  confirmed.store.recordEffectIntent(authority(confirmed.delivery), "charge", false);
  confirmed.store.confirmEffect(authority(confirmed.delivery), "charge", "ref");
  confirmed.store.requestCancel(confirmed.delivery.event.id);
  assert.equal(confirmed.store.acknowledgeCancel(authority(confirmed.delivery), []).state, "recovery_required");
});

test("idempotency-required expiry retries only with persisted boundary evidence", () => {
  const confirmed = runningStore({ effectPolicy: "idempotency-required" });
  confirmed.store.recordEffectIntent(authority(confirmed.delivery), "charge", true);
  confirmed.time.advance(30_001);
  assert.equal(confirmed.store.expireLeases(confirmed.time.now())[0].state, "retry_wait");

  const unknown = runningStore({ effectPolicy: "idempotency-required" });
  unknown.store.recordEffectIntent(authority(unknown.delivery), "charge", false);
  unknown.time.advance(30_001);
  assert.equal(unknown.store.expireLeases(unknown.time.now())[0].state, "recovery_required");
});

test("all recovery resolutions require admin evidence", () => {
  for (const resolution of ["completed", "failed", "cancelled"] as const) {
    const context = runningStore({ effectPolicy: "manual-recovery" });
    context.store.fail(authority(context.delivery), { code: "WORKER_LOST", effectStatus: "unknown" });
    assert.throws(() => context.store.resolveRecovery(context.delivery.event.id, { as: resolution, evidence: {}, role: "worker" }), expectCode("forbidden"));
    assert.equal(context.store.resolveRecovery(context.delivery.event.id, { as: resolution, evidence: { verified: true }, role: "admin" }).state, resolution);
  }
});

test("lease expiry is transactionally journaled", () => {
  const context = runningStore();
  context.time.advance(30_001);
  const expired = context.store.expireLeases(context.time.now());
  assert.equal(expired[0].state, "retry_wait");
  assert.equal(context.store.listUpdatesAfter(0).at(-1)?.kind, "retry_wait");
});
test("expired cancellation can retry and clears the cancellation marker", () => {
  const context = runningStore();
  context.store.requestCancel(context.delivery.event.id);
  context.time.advance(30_001);
  const expired = context.store.expireLeases(context.time.now())[0];
  assert.equal(expired.state, "retry_wait");
  assert.equal(expired.cancelRequestedAt, undefined);
});

test("repeated cancellation request remains pending", () => {
  const context = runningStore();
  const first = context.store.requestCancel(context.delivery.event.id);
  const second = context.store.requestCancel(context.delivery.event.id);
  assert.equal(first.state, "cancel_requested");
  assert.equal(second.state, "cancel_requested");
  assert.equal(context.store.listUpdatesAfter(0).filter((entry) => entry.kind === "cancel_requested").length, 1);
});

test("confirmed effects settle and manual recovery failures recover", () => {
  const complete = runningStore({ effectPolicy: "manual-recovery" });
  assert.equal(complete.store.complete(authority(complete.delivery), { ok: true }, [{ effectStatus: "confirmed", externalRef: "ref" }]).state, "completed");

  const failed = runningStore({ effectPolicy: "manual-recovery" });
  assert.equal(failed.store.fail(authority(failed.delivery), { code: "temporarily_unavailable", effectStatus: "confirmed" }).state, "recovery_required");
});
test("later confirmed effect evidence overrides earlier started evidence", () => {
  const context = runningStore({ effectPolicy: "manual-recovery" });
  const event = context.store.complete(authority(context.delivery), { ok: true }, [
    { effectKey: "charge", status: "started" },
    { effectKey: "charge", status: "confirmed", externalRef: "ref" },
  ]);
  assert.equal(event.state, "completed");
});

test("acceptance rejects payloads larger than immutable revision limit", () => {
  const context = queuedStore({ requires: { ...baseRevision.definition.requires, maxPayloadBytes: 20 } });
  assert.throws(
    () => context.store.accept({ producerId: "producer:large", idempotencyKey: "large", payload: { variant: "this is too large" }, revision: context.revision }),
    expectCode("payload_too_large"),
  );
  assert.equal(context.store.countEvents(), 1);
});

test("renewal wakes the reaper to reschedule a nearer deadline", async () => {
  const context = runningStore();
  const controller = new AbortController();
  const reaper = new LeaseReaper(context.store, () => controller.abort(), context.time);
  const running = reaper.start(controller.signal);
  await Promise.resolve();
  context.store.renew(authority(context.delivery), context.time.now() + 1_000);
  context.time.advance(1_001);
  await running;
  assert.equal(context.store.getEvent(context.delivery.event.id)?.state, "retry_wait");
});

test("state and effect transitions roll back when their update fails", () => {
  const started = queuedStore();
  const startedDelivery = started.store.acquireAgent(started.workerA, started.time.now());
  assert.ok(startedDelivery);
  failUpdate(started.store, "started");
  assert.throws(() => started.store.start(authority(startedDelivery)));
  assert.equal(started.store.getEvent(startedDelivery.event.id)?.state, "leased");

  const intent = runningStore();
  failUpdate(intent.store, "effect_started");
  assert.throws(() => intent.store.recordEffectIntent(authority(intent.delivery), "charge", false));
  assert.throws(() => intent.store.confirmEffect(authority(intent.delivery), "charge", "ref"), expectCode("effect_not_started"));

  const confirmation = runningStore();
  confirmation.store.recordEffectIntent(authority(confirmation.delivery), "charge", false);
  failUpdate(confirmation.store, "effect_confirmed");
  assert.throws(() => confirmation.store.confirmEffect(authority(confirmation.delivery), "charge", "ref"));
  const sqlite = (confirmation.store as unknown as { db: { exec(sql: string): void } }).db;
  sqlite.exec("DROP TRIGGER fail_effect_confirmed");
  confirmation.store.confirmEffect(authority(confirmation.delivery), "charge", "ref");

});
test("reaper wakes after committed expiry", async () => {
  const context = runningStore();
  const controller = new AbortController();
  let wakes = 0;
  const reaper = new LeaseReaper(context.store, () => { wakes += 1; controller.abort(); }, context.time);
  context.time.set(Number(context.store.getEvent(context.delivery.event.id)?.leaseExpiresAt) + 1);
  await reaper.start(controller.signal);
  assert.equal(wakes, 1);
  assert.equal(context.store.getEvent(context.delivery.event.id)?.state, "retry_wait");
});

