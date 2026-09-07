import assert from "node:assert/strict";
import test from "node:test";
import { CredentialStore } from "../src/auth.ts";
import { Dispatcher, matches } from "../src/dispatcher.ts";
import { loadRegistry, type DefinitionRevision } from "../src/registry.ts";
import { openStore } from "../src/store.ts";
import type { WorkerCapabilities } from "../src/protocol.ts";

const revision = loadRegistry(new URL("./fixtures", import.meta.url).pathname, "events").resolve("ui.variant.requested", 1);
const clock = { now: () => 1_700_000_000_000 };
function worker(overrides: Partial<WorkerCapabilities> = {}): WorkerCapabilities {
  return { workerId: "worker:test", allowedDefinitions: ["*"], tools: [], structuredOutput: true, contextTokens: 8_000, systemReserveTokens: 0, maxConcurrent: 1, ...overrides };
}
function app(definition: DefinitionRevision["definition"] = revision.definition) {
  const store = openStore(":memory:", clock);
  const storedRevision = definition === revision.definition ? revision : { ...revision, definition, digest: "test-revision" } as DefinitionRevision;
  store.installRevisions([storedRevision]);
  const accepted = store.accept({ producerId: "browser:test", idempotencyKey: "test:1", payload: { variant: "dark" }, revision: storedRevision });
  const credentials = new CredentialStore({ now: clock });
  const dispatcher = new Dispatcher(store, credentials, { now: clock });
  return { store, credentials, dispatcher, event: () => store.getEvent(accepted.event.id)! };
}

test("opaque credentials are scoped and short-lived for workers", () => {
  let now = 100;
  const credentials = new CredentialStore({ now: () => now, workerTtlMs: 10 });
  const token = credentials.issue("worker", "worker:1");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(credentials.verify(token, "worker").subjectId, "worker:1");
  assert.throws(() => credentials.verify(token, "observer"), { code: "forbidden" });
  now = 111;
  assert.throws(() => credentials.verify(token, "worker"), { code: "unauthorized" });
});

test("observer token cannot poll or settle work", () => {
  const current = app();
  const token = current.credentials.issue("observer", "browser:1");
  assert.throws(() => current.dispatcher.authenticateWorker(token), { code: "forbidden" });
});

test("incompatible worker blocks without consuming an attempt", async () => {
  const current = app({ ...revision.definition, requires: { ...revision.definition.requires, tools: ["workspace.edit"] } });
  const registration = current.dispatcher.registerWorker(worker({ tools: ["workspace.read"] }));
  assert.equal(await current.dispatcher.poll(registration, AbortSignal.timeout(5)), undefined);
  const event = current.event();
  assert.equal(event.attempt, 0);
  assert.equal(event.state, "blocked");
});

test("process definitions never enter external agent polling", async () => {
  const current = app({ ...revision.definition, handler: { kind: "process", command: "echo", args: [], env: [] } });
  const registration = current.dispatcher.registerWorker(worker());
  assert.equal(await current.dispatcher.poll(registration, AbortSignal.timeout(5)), undefined);
  assert.equal(current.event().attempt, 0);
  assert.equal(current.event().state, "blocked");
});

test("matching accepts exact, namespace, tools, output, context, and concurrency", () => {
  const definition = revision.definition;
  assert.equal(matches(definition, worker({ allowedDefinitions: ["ui.*"] }), 0), true);
  assert.equal(matches(definition, worker({ allowedDefinitions: ["ui.variant.requested@99"] }), 0), false);
  assert.equal(matches(definition, worker({ structuredOutput: false }), 0), definition.requires.structuredOutput === false);
  assert.equal(matches(definition, worker({ contextTokens: 1 }), 0), false);
  assert.equal(matches(definition, worker({ maxConcurrent: 1 }), 1), false);
});

test("registration changes wake blocked polling", async () => {
  const current = app({ ...revision.definition, requires: { ...revision.definition.requires, tools: ["workspace.edit"] } });
  const first = current.dispatcher.registerWorker(worker({ tools: ["workspace.read"] }));
  const controller = new AbortController();
  const pending = current.dispatcher.poll(first, controller.signal);
  await Promise.resolve();
  const compatible = current.dispatcher.registerWorker(worker({ workerId: "worker:compatible", tools: ["workspace.edit"] }));
  const delivery = await current.dispatcher.poll(compatible, AbortSignal.timeout(50));
  controller.abort();
  await pending;
  assert.equal(delivery?.workerId, "worker:compatible");
});

test("accepted compatible work wakes an existing poll", async () => {
  const store = openStore(":memory:", clock);
  store.installRevisions([revision]);
  const credentials = new CredentialStore({ now: clock });
  const dispatcher = new Dispatcher(store, credentials, { now: clock });
  const registration = dispatcher.registerWorker(worker());
  const pending = dispatcher.poll(registration, AbortSignal.timeout(100));
  await Promise.resolve();
  const accepted = store.accept({ producerId: "browser:new", idempotencyKey: "event:1", payload: { variant: "dark" }, revision });
  const delivery = await pending;
  assert.equal(delivery?.event.id, accepted.event.id);
  assert.equal(delivery?.workerId, registration.workerId);
});

test("worker registration identity fences settlement", () => {
  const current = app();
  const registration = current.dispatcher.registerWorker(worker());
  const delivery = current.store.acquireAgent(registration.capabilities, clock.now());
  assert.ok(delivery);
  const forged = current.dispatcher.registerWorker(worker({ workerId: "worker:other" }));
  assert.throws(() => current.dispatcher.complete(forged, { eventId: delivery.event.id, workerId: delivery.workerId, leaseId: delivery.leaseId }, { ok: true }, []), { code: "forbidden" });
});
test("retry backoff wakes polling at availableAt", async () => {
  const now = Date.now;
  const time = { now };
  const retryRevision = {
    ...revision,
    digest: "retry-wake-revision",
    definition: { ...revision.definition, retry: { ...revision.definition.retry, backoffMs: [25] } },
  } as DefinitionRevision;
  const store = openStore(":memory:", time);
  store.installRevisions([retryRevision]);
  const accepted = store.accept({ producerId: "retry:producer", idempotencyKey: "retry:wake", payload: { variant: "dark" }, revision: retryRevision });
  const credentials = new CredentialStore({ now: time });
  const dispatcher = new Dispatcher(store, credentials, { now: time, pollTimeoutMs: 200 });
  const registration = dispatcher.registerWorker(worker());
  const delivery = await dispatcher.poll(registration, AbortSignal.timeout(100));
  assert.ok(delivery);
  dispatcher.start(registration, { eventId: accepted.event.id, workerId: delivery.workerId, leaseId: delivery.leaseId });
  dispatcher.fail(registration, { eventId: accepted.event.id, workerId: delivery.workerId, leaseId: delivery.leaseId }, { code: "temporarily_unavailable", effectStatus: "none" });
  const startedAt = Date.now();
  const retried = await dispatcher.poll(registration, AbortSignal.timeout(500));
  assert.ok(retried);
  assert.ok(Date.now() - startedAt < 200);
});
