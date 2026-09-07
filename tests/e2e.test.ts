import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CredentialStore } from "../src/auth.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { ProcessAdapter } from "../src/process-adapter.ts";
import { loadRegistry, type DefinitionRevision, type Registry } from "../src/registry.ts";
import { TrustedWorkerRuntime, type ModelAdapter } from "../src/worker-runtime.ts";
import type { Delivery, EffectEvidence } from "../src/protocol.ts";
import { LeaseReaper } from "../src/reaper.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { openStore, type Store } from "../src/store.ts";

const fixtures = join(new URL(".", import.meta.url).pathname, "fixtures");
const baseTime = 1_700_000_000_000;

type TestClock = { now(): number; set(value: number): void; advance(delta: number): void };
function clock(): TestClock {
  let value = baseTime;
  return { now: () => value, set: (next) => { value = next; }, advance: (delta) => { value += delta; } };
}

async function request(base: string, method: string, path: string, token: string, value?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { "Content-Type": "application/json" }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}

interface RelayProject {
  root: string;
  dbPath: string;
  countPath: string;
  time: TestClock;
  store: Store;
  registry: Registry;
  startRelay(runProcess?: boolean): Promise<RelayHandle>;
  reopenStore(): void;
  effectExecutionCount(key: string): Promise<number>;
  cleanup(): Promise<void>;
}
interface RelayHandle {
  server: RelayServer;
  base: string;
  producer: string;
  observer: string;
  emit(input: { idempotencyKey: string; payload?: unknown; correlationId?: string }): Promise<{ id: string; state: string; definitionRevision: string }>;
  get(id: string): Promise<Record<string, unknown>>;
  waitForState(id: string, state: string): Promise<Record<string, unknown>>;
  waitForUpdate(id: string, kind: string): Promise<void>;
  killRelay(): Promise<void>;
}

async function testProject(options: { plugin?: string; effectPolicy?: string } = {}): Promise<RelayProject> {
  const root = await mkdtemp(join(tmpdir(), "open-relay-e2e-"));
  await Promise.all([
    cp(join(fixtures, "events"), join(root, "events"), { recursive: true }),
    cp(join(fixtures, "schemas"), join(root, "schemas"), { recursive: true }),
    cp(join(fixtures, "handlers"), join(root, "handlers"), { recursive: true }),
  ]);
  const countPath = join(root, "effect-count.log");
  if (options.plugin) {
    await cp(join(fixtures, "plugins", options.plugin), join(root, options.plugin));
    await writeFile(join(root, "events", "effect.v1.json"), JSON.stringify({
      type: "effect.test", version: 1, inputSchema: "schemas/request.json", outputSchema: "schemas/result.json",
      effectPolicy: options.effectPolicy ?? "manual-recovery", timeoutMs: 30_000, hardDeadlineMs: 60_000,
      retry: { maxAttempts: 2, backoffMs: [1], retryableCodes: ["plugin_crash", "plugin_cancelled"] },
      requires: { tools: [], structuredOutput: false, minContextTokens: 0, maxInputTokens: 0, maxOutputTokens: 0, maxPayloadBytes: 65_536 },
      handler: { kind: "process", command: options.plugin, args: [], env: ["PATH", "EFFECT_COUNT_FILE", "CRASH_DELAY_MS"] },
    }));
  }
  const time = clock();
  const registry = loadRegistry(root, "events");
  const dbPath = join(root, "relay.sqlite");
  const initialStore = openStore(dbPath, time);
  initialStore.installRevisions(registry.revisions());
  const project: RelayProject = {
    root, dbPath, countPath, time, store: initialStore, registry,
    async startRelay(runProcess = true): Promise<RelayHandle> {
      const credentials = new CredentialStore({ now: time });
      const dispatcher = new Dispatcher(project.store, credentials, { now: time, pollTimeoutMs: 100 });
      const reaper = new LeaseReaper(project.store, () => dispatcher.notifyWork(), time);
      const processAdapter = options.plugin && runProcess ? new ProcessAdapter({ projectRoot: root, env: { ...process.env, EFFECT_COUNT_FILE: countPath, CRASH_DELAY_MS: "20" }, gracePeriodMs: 20 }) : undefined;
      const server = createRelayServer({ store: project.store, registry, credentials, dispatcher, reaper, processAdapter, projectRoot: root, definitionsDir: "events", closeStore: false }) as RelayServer;
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const producer = (await (await request(base, "POST", "/v1/credentials", server.adminToken, { scope: "producer", subjectId: "e2e:producer" })).json() as { token: string }).token;
      const observer = (await (await request(base, "POST", "/v1/credentials", server.adminToken, { scope: "observer", subjectId: "e2e:observer" })).json() as { token: string }).token;
      const handle: RelayHandle = {
        server, base, producer, observer,
        async emit(input) {
          const response = await request(base, "POST", "/v1/events", producer, { type: options.plugin ? "effect.test" : "ui.variant.requested", version: 1, idempotencyKey: input.idempotencyKey, payload: input.payload ?? { variant: "dark" }, ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }) });
          assert.ok(response.status === 200 || response.status === 201);
          return ((await response.json()) as { event: { id: string; state: string; definitionRevision: string } }).event;
        },
        async get(id) { return await (await request(base, "GET", `/v1/events/${encodeURIComponent(id)}`, observer)).json() as Record<string, unknown>; },
        async waitForState(id, state) {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const event = await this.get(id);
            if (event.state === state) return event;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.fail(`event ${id} did not reach ${state}`);
        },
        async waitForUpdate(id, kind) {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (project.store.listUpdatesAfter(0, id).some((update) => update.kind === kind)) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.fail(`event ${id} did not emit ${kind}`);
        },
        async killRelay() { await new Promise<void>((resolve) => server.close(() => resolve())); },
      };
      return handle;
    },
    async effectExecutionCount(key) {
      let text = "";
      try { text = await readFile(countPath, "utf8"); } catch { return 0; }
      return text.split("\n").filter((line) => line === key).length;
    },
    reopenStore() {
      project.store.close();
      project.store = openStore(dbPath, time);
      project.store.installRevisions(registry.revisions());
    },
    async cleanup() { project.store.close(); await rm(root, { recursive: true, force: true }); },
  };
  return project;
}

function seedExpired(project: RelayProject, policy: DefinitionRevision["definition"]["effectPolicy"], boundary: boolean | undefined, key: string): string {
  const base = project.registry.resolve("ui.variant.requested", 1);
  const revision: DefinitionRevision = { ...base, digest: `e2e:${key}`, definition: { ...base.definition, type: `e2e.${key}`, effectPolicy: policy } };
  project.store.installRevisions([revision]);
  const event = project.store.accept({ producerId: "e2e:matrix", idempotencyKey: key, payload: { variant: "dark" }, revision }).event;
  const worker = { workerId: "e2e:worker", allowedDefinitions: ["*"], tools: [], structuredOutput: true, contextTokens: 8_000, systemReserveTokens: 0, maxConcurrent: 1 };
  const delivery = project.store.acquireAgent(worker, project.time.now());
  if (!delivery) throw new Error("matrix event was not leased");
  const authority = { eventId: event.id, workerId: delivery.workerId, leaseId: delivery.leaseId };
  project.store.start(authority);
  if (boundary !== undefined) project.store.recordEffectIntent(authority, "effect:42", boundary);
  project.time.set(Number(project.store.getEvent(event.id)?.leaseExpiresAt) + 1);
  return event.id;
}

test("startup immediately expires persisted leases before waiting for a deadline", async () => {
  const project = await testProject();
  const calls: number[] = [];
  const original = project.store.expireLeases.bind(project.store);
  const observed = new Proxy(project.store, { get(target, property, receiver) { if (property !== "expireLeases") return Reflect.get(target, property, receiver); return (now: number) => { calls.push(now); return original(now); }; } });
  project.store = observed;
  let relay: RelayHandle | undefined;
  try {
    relay = await project.startRelay();
    assert.equal(calls.length, 1);
  } finally {
    if (relay) await relay.killRelay();
    await project.cleanup();
  }
});

test("restart expiry schedules only retry-safe and proven idempotent work", async () => {
  const cases: readonly [DefinitionRevision["definition"]["effectPolicy"], boolean | undefined, string][] = [
    ["retry-safe", undefined, "retry_wait"],
    ["idempotency-required", true, "retry_wait"],
    ["idempotency-required", false, "recovery_required"],
    ["manual-recovery", false, "recovery_required"],
  ];
  for (const [policy, boundary, expected] of cases) {
    const project = await testProject();
    let relay: RelayHandle | undefined;
    try {
      const eventId = seedExpired(project, policy, boundary, `expiry:${policy}:${String(boundary)}`);
      relay = await project.startRelay();
      const event = await relay.waitForState(eventId, expected);
      assert.equal(event.attempt, 1);
      assert.equal(event.workerId, undefined);
    } finally {
      if (relay) await relay.killRelay();
      await project.cleanup();
    }
  }
});

test("restart preserves queued, blocked, leased, running, retry-waiting, cancel-requested, completed, and recovery states", async () => {
  const states = ["queued", "blocked", "leased", "running", "retry_wait", "cancel_requested", "completed", "recovery_required"] as const;
  for (const expected of states) {
    const project = await testProject();
    let first: RelayHandle | undefined;
    let second: RelayHandle | undefined;
    try {
      first = await project.startRelay(false);
      const base = project.registry.resolve("ui.variant.requested", 1);
      const revision: DefinitionRevision = expected === "recovery_required"
        ? { ...base, digest: `e2e:restart:${expected}`, definition: { ...base.definition, type: `e2e.restart.${expected}`, effectPolicy: "manual-recovery" } }
        : base;
      const event = project.store.accept({ producerId: "e2e:restart", idempotencyKey: `restart:${expected}`, payload: { variant: "dark" }, revision }).event;
      if (expected === "blocked") project.store.blockUnmatched?.([], project.time.now());
      else if (expected !== "queued") {
        const delivery = project.store.acquireAgent({ workerId: "e2e:restart-worker", allowedDefinitions: ["*"], tools: [], structuredOutput: true, contextTokens: 8_000, systemReserveTokens: 0, maxConcurrent: 1 }, project.time.now());
        if (!delivery) throw new Error(`could not lease ${expected} event`);
        const authority = { eventId: event.id, workerId: delivery.workerId, leaseId: delivery.leaseId };
        if (expected !== "leased") project.store.start(authority);
        if (expected === "retry_wait") project.store.fail(authority, { code: "temporarily_unavailable", effectStatus: "none" });
        else if (expected === "cancel_requested") project.store.requestCancel(event.id);
        else if (expected === "completed") project.store.complete(authority, { ok: true }, []);
        else if (expected === "recovery_required") project.store.fail(authority, { code: "worker_lost", effectStatus: "unknown" });
      }
      assert.equal(project.store.getEvent(event.id)?.state, expected);
      await first.killRelay();
      project.reopenStore();
      second = await project.startRelay(false);
      assert.equal((await second.get(event.id)).state, expected);
    } finally {
      if (second) await second.killRelay();
      else if (first) await first.killRelay();
      await project.cleanup();
    }
  }
});

test("historical revision remains deliverable after its active definition is removed", async () => {
  const project = await testProject();
  try {
    const revision = project.registry.resolve("ui.variant.requested", 1);
    const accepted = project.store.accept({ producerId: "e2e:history", idempotencyKey: "history:1", payload: { variant: "dark" }, revision }).event;
    await rm(join(project.root, "events", "ui-variant.v1.json"));
    const current = loadRegistry(project.root, "events");
    assert.throws(() => current.resolve("ui.variant.requested", 1));
    const restored = project.store.getRevision(accepted.definitionRevision);
    assert.equal(restored.instructions, revision.instructions);
    const worker = { workerId: "e2e:history-worker", allowedDefinitions: ["*"], tools: [], structuredOutput: true, contextTokens: 8_000, systemReserveTokens: 0, maxConcurrent: 1 };
    const delivery = project.store.acquireAgent(worker, project.time.now());
    assert.equal(delivery?.event.id, accepted.id);
    assert.equal(delivery?.event.definitionRevision, accepted.definitionRevision);
  } finally { await project.cleanup(); }
});

test("correlated events preserve correlation IDs without promising cross-event ordering", async () => {
  const project = await testProject();
  let relay: RelayHandle | undefined;
  try {
    relay = await project.startRelay();
    const first = await relay.emit({ idempotencyKey: "correlation:1", correlationId: "batch:42" });
    const second = await relay.emit({ idempotencyKey: "correlation:2", correlationId: "batch:42" });
    assert.notEqual(first.id, second.id);
    const firstEvent = await relay.get(first.id);
    const secondEvent = await relay.get(second.id);
    assert.equal(firstEvent.correlationId, "batch:42");
    assert.equal(secondEvent.correlationId, "batch:42");
  } finally {
    if (relay) await relay.killRelay();
    await project.cleanup();
  }
});

test("agent cancellation control reports and settles every effect boundary", async () => {
  const cases: readonly [string, EffectEvidence | undefined, string][] = [
    ["before intent", undefined, "cancelled"],
    ["after intent", { effectKey: "effect:42", status: "started", idempotencyBoundaryConfirmed: false }, "recovery_required"],
    ["after external call", { effectKey: "effect:42", status: "unknown" }, "recovery_required"],
    ["after confirmation", { effectKey: "effect:42", status: "confirmed", externalRef: "external:42" }, "recovery_required"],
  ];
  for (const [boundary, effect, expected] of cases) {
    const project = await testProject();
    let relay: RelayHandle | undefined;
    try {
      relay = await project.startRelay(false);
      const activeRelay = relay;
      const event = await relay.emit({ idempotencyKey: `cancel:${boundary}` });
      const registrationResponse = await request(relay.base, "POST", "/v1/workers/register", relay.server.adminToken, { workerId: `e2e:${boundary}`, allowedDefinitions: ["*"], tools: [], structuredOutput: true, contextTokens: 8_000, systemReserveTokens: 0, maxConcurrent: 1 });
      const worker = (await registrationResponse.json()) as { token: string };
      const deliveryResponse = await request(relay.base, "POST", "/v1/agent/poll", worker.token, {});
      const delivery = (await deliveryResponse.json()) as Delivery;
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
      const model: ModelAdapter = {
        async *generate(_context, signal) {
          if (effect) yield { type: "effect", evidence: effect } as const;
          readyResolve();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      };
      let reportedEffects: readonly EffectEvidence[] | undefined;
      const runtime = new TrustedWorkerRuntime({
        model,
        tools: { invoke: async () => ({}) },
        systemPolicy: "policy",
        definitionInstructions: "instructions",
        definitionTools: [],
        registeredTools: [],
        systemTools: [],
        transport: {
          async control(_authority, signal) {
            const response = await fetch(`${activeRelay.base}/v1/deliveries/${delivery.leaseId}/control`, { headers: { Authorization: `Bearer ${worker.token}` }, signal });
            if (!response.ok) return "timeout";
            return (await response.json() as { status: "cancel_requested" | "timeout" }).status;
          },
          async cancelled(authority, effects) {
            reportedEffects = effects;
            const response = await request(activeRelay.base, "POST", `/v1/deliveries/${authority.leaseId}/cancelled`, worker.token, { effects });
            assert.equal(response.status, 200);
          },
        },
        maxInputTokens: 200,
        maxOutputTokens: 20,
        tokenizer: (text) => text.length,
      });
      const running = runtime.run(delivery);
      await ready;
      const cancelResponse = await request(relay.base, "POST", `/v1/events/${event.id}/cancel`, relay.producer, {});
      assert.equal(cancelResponse.status, 200);
      const outcome = await running;
      assert.equal(outcome.status, "cancelled");
      assert.deepEqual(reportedEffects, effect ? [effect] : []);
      assert.equal((await relay.get(event.id)).state, expected);
    } finally {
      if (relay) await relay.killRelay();
      await project.cleanup();
    }
  }
});
test("ambiguous consequential effect survives a crashed worker restart without duplicate execution", async () => {
  const project = await testProject({ plugin: "effect-then-crash.mjs", effectPolicy: "manual-recovery" });
  let first: RelayHandle | undefined;
  let second: RelayHandle | undefined;
  try {
    first = await project.startRelay(false);
    const event = await first.emit({ idempotencyKey: "effect:42" });
    const revision = project.store.getRevision(event.definitionRevision);
    const delivery = project.store.acquireProcess({ workerId: "relay:process", maxConcurrent: 1 }, project.time.now());
    if (!delivery) throw new Error("effect event was not leased");
    const authority = { eventId: event.id, workerId: delivery.workerId, leaseId: delivery.leaseId };
    const adapter = new ProcessAdapter({ projectRoot: project.root, env: { ...process.env, EFFECT_COUNT_FILE: project.countPath, CRASH_DELAY_MS: "20" }, gracePeriodMs: 20 });
    await assert.rejects(adapter.run(delivery, revision, AbortSignal.timeout(1_000), {
      onMessage(message) {
        if (message.type === "started") project.store.start(authority);
        else if (message.type === "effect_started") project.store.recordEffectIntent(authority, message.effectKey, message.idempotencyBoundaryConfirmed === true);
      },
    }), (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "plugin_crash");
    const leaseExpiry = Number((await first.get(event.id)).leaseExpiresAt);
    await first.killRelay();
    project.reopenStore();
    project.time.set(leaseExpiry + 1);
    second = await project.startRelay(false);
    const recovered = await second.waitForState(event.id, "recovery_required");
    assert.equal(recovered.attempt, 1);
    assert.equal(await project.effectExecutionCount("effect:42"), 1);
  } finally {
    if (second) await second.killRelay();
    else if (first) await first.killRelay();
    await project.cleanup();
  }
});
 
