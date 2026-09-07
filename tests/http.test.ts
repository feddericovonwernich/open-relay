import assert from "node:assert/strict";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CredentialStore } from "../src/auth.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { loadRegistry } from "../src/registry.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { openStore } from "../src/store.ts";
import { fixtureProject } from "./helpers.ts";

async function request(base: string, method: string, path: string, token: string, value?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...extraHeaders, ...(value === undefined ? {} : { "Content-Type": "application/json" }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
interface Harness { root: string; base: string; server: RelayServer; producer: string; observer: string; store: ReturnType<typeof openStore>; }
async function harness(options: { pollTimeoutMs?: number; maxBodyBytes?: number; allowedOrigins?: string[] } = {}): Promise<Harness> {
  const root = await fixtureProject(); const registry = loadRegistry(root, "events"); const credentials = new CredentialStore(); const store = openStore(":memory:", { now: () => 1_700_000_000_000 }); store.installRevisions(registry.revisions());
  const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: options.pollTimeoutMs ?? 50 }); const server = createRelayServer({ store, registry, credentials, dispatcher, projectRoot: root, definitionsDir: "events", ...options }) as RelayServer;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const producer = ((await (await request(base, "POST", "/v1/credentials", server.adminToken, { scope: "producer", subjectId: "producer:test" })).json()) as { token: string }).token;
  const observer = ((await (await request(base, "POST", "/v1/credentials", server.adminToken, { scope: "observer", subjectId: "observer:test" })).json()) as { token: string }).token;
  return { root, base, server, producer, observer, store };
}
async function closeHarness(value: Harness): Promise<void> { await new Promise<void>((resolve) => value.server.close(() => resolve())); await rm(value.root, { recursive: true, force: true }); }
async function accept(value: Harness, key: string, payload: unknown = { variant: "dark" }): Promise<string> { const response = await request(value.base, "POST", "/v1/events", value.producer, { type: "ui.variant.requested", version: 1, idempotencyKey: key, payload }); assert.ok(response.status === 201 || response.status === 200); return ((await response.json()) as { event: { id: string } }).event.id; }
async function register(value: Harness, workerId = "worker:test"): Promise<string> { const response = await request(value.base, "POST", "/v1/workers/register", value.server.adminToken, { workerId, allowedDefinitions: ["*"], tools: [], structuredOutput: true, contextTokens: 5000, systemReserveTokens: 0, maxConcurrent: 1 }); assert.equal(response.status, 201); return ((await response.json()) as { token: string }).token; }

test("loopback routes accept, observe, and settle an agent delivery", async () => {
  const relay = await harness();
  try {
    const eventId = await accept(relay, "http:1"); const worker = await register(relay); const polled = await request(relay.base, "POST", "/v1/agent/poll", worker, {}); assert.equal(polled.status, 200); const delivery = await polled.json() as { leaseId: string };
    assert.equal((await request(relay.base, "GET", `/v1/events/${eventId}`, relay.observer)).status, 200); assert.equal((await request(relay.base, "POST", `/v1/deliveries/${delivery.leaseId}/complete`, worker, { result: { ok: true }, effects: [] })).status, 200);
    assert.equal(((await (await request(relay.base, "GET", `/v1/events/${eventId}`, relay.observer)).json()) as { state: string }).state, "completed");
  } finally { await closeHarness(relay); }
});
test("authenticated workers can persist lease-scoped effect evidence", async () => {
  const relay = await harness();
  try {
    const eventId = await accept(relay, "effect-http:1");
    const worker = await register(relay);
    const delivery = await (await request(relay.base, "POST", "/v1/agent/poll", worker, {})).json() as { leaseId: string };
    assert.equal((await request(relay.base, "POST", `/v1/deliveries/${delivery.leaseId}/effect-intent`, worker, { effectKey: "charge", idempotencyBoundaryConfirmed: true })).status, 200);
    assert.equal((await request(relay.base, "POST", `/v1/deliveries/${delivery.leaseId}/effect-confirmation`, worker, { effectKey: "charge", externalRef: "ref-1" })).status, 200);
    assert.equal((await request(relay.base, "POST", `/v1/deliveries/${delivery.leaseId}/effect-intent`, relay.observer, { effectKey: "forged", idempotencyBoundaryConfirmed: true })).status, 403);
    assert.deepEqual(relay.store.listUpdatesAfter(0, eventId).map((entry) => entry.kind), ["queued", "leased", "effect_started", "effect_confirmed"]);
  } finally { await closeHarness(relay); }
});


test("HTTP idempotency conflict and concurrent identical acceptance", async () => {
  const relay = await harness();
  try { const responses = await Promise.all([1, 2].map(() => request(relay.base, "POST", "/v1/events", relay.producer, { type: "ui.variant.requested", version: 1, idempotencyKey: "race:1", payload: { variant: "dark" } }))); assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]); assert.equal((await request(relay.base, "POST", "/v1/events", relay.producer, { type: "ui.variant.requested", version: 1, idempotencyKey: "race:1", payload: { variant: "light" } })).status, 409); } finally { await closeHarness(relay); }
});

test("HTTP rejects JSON/schema errors, process exclusion, abort, CORS, body limits, and token echo", async () => {
  const relay = await harness({ maxBodyBytes: 512, allowedOrigins: ["https://allowed.example"] });
  try {
    const malformed = await fetch(`${relay.base}/v1/events`, { method: "POST", headers: { Authorization: `Bearer ${relay.producer}`, "Content-Type": "application/json" }, body: "{" }); assert.equal(malformed.status, 400);
    assert.equal((await request(relay.base, "POST", "/v1/events", relay.producer, { type: "ui.variant.requested", version: 1, idempotencyKey: "bad", payload: { nope: true } })).status, 400);
    assert.equal((await request(relay.base, "POST", "/v1/events", relay.producer, { type: "ui.variant.requested", version: 1, idempotencyKey: "large", payload: { variant: "x".repeat(1000) } })).status, 413);
    assert.equal((await request(relay.base, "GET", "/v1/events/nope", relay.observer, undefined, { Origin: "https://denied.example" })).status, 403);
    const secret = "Bearer definitely-not-valid-secret"; const redacted = await fetch(`${relay.base}/v1/events/nope`, { headers: { Authorization: secret } }); assert.equal(redacted.status, 401); assert.equal((await redacted.text()).includes(secret), false);
    assert.throws(() => relay.server.listen(0, "0.0.0.0"), /loopback/);
    const worker = await register(relay); const controller = new AbortController(); const pending = fetch(`${relay.base}/v1/agent/poll`, { method: "POST", headers: { Authorization: `Bearer ${worker}`, "Content-Type": "application/json" }, body: "{}", signal: controller.signal }).catch((error: unknown) => error); controller.abort(); assert.equal((await pending as Error).name, "AbortError");
  } finally { await closeHarness(relay); }
});

test("server close aborts outstanding agent poll signals", async () => {
  const relay = await harness({ pollTimeoutMs: 1000 });
  const worker = await register(relay);
  const pending = fetch(`${relay.base}/v1/agent/poll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${worker}`, "Content-Type": "application/json" },
    body: "{}",
  }).catch((error: unknown) => error);
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  await new Promise<void>((resolve) => relay.server.close(() => resolve()));
  assert.ok(Date.now() - startedAt < 500);
  assert.ok((await pending) instanceof Error);
  await rm(relay.root, { recursive: true, force: true });
});
test("HTTP cancellation control and acknowledgement settle the lease", async () => {
  const relay = await harness({ pollTimeoutMs: 500 });
  try { const eventId = await accept(relay, "cancel:1"); const worker = await register(relay); const delivery = await (await request(relay.base, "POST", "/v1/agent/poll", worker, {})).json() as { leaseId: string }; const control = fetch(`${relay.base}/v1/deliveries/${delivery.leaseId}/control`, { headers: { Authorization: `Bearer ${worker}` } }); await new Promise((resolve) => setImmediate(resolve)); assert.equal((await request(relay.base, "POST", `/v1/events/${eventId}/cancel`, relay.producer, {})).status, 200); assert.equal((await (await control).json() as { status: string }).status, "cancel_requested"); assert.equal((await request(relay.base, "POST", `/v1/deliveries/${delivery.leaseId}/cancelled`, worker, { effects: [] })).status, 200); assert.equal(((await (await request(relay.base, "GET", `/v1/events/${eventId}`, relay.observer)).json()) as { state: string }).state, "cancelled"); } finally { await closeHarness(relay); }
});

test("HTTP recovery authorization and all resolutions", async () => {
  for (const [index, state] of ["completed", "failed", "cancelled"].entries()) {
    const relay = await harness();
    try {
      await writeFile(join(relay.root, "events", "manual.v1.json"), JSON.stringify({ type: "manual.event", version: 1, inputSchema: "schemas/request.json", outputSchema: "schemas/result.json", effectPolicy: "manual-recovery", timeoutMs: 1000, hardDeadlineMs: 2000, retry: { maxAttempts: 1, backoffMs: [], retryableCodes: [] }, requires: { tools: [], structuredOutput: true, minContextTokens: 0, maxInputTokens: 1, maxOutputTokens: 1, maxPayloadBytes: 1000 }, handler: { kind: "agent", instructions: "handlers/ui-variant.md" } }));
      assert.equal((await request(relay.base, "POST", "/v1/admin/reload", relay.server.adminToken, {})).status, 200);
      const accepted = await request(relay.base, "POST", "/v1/events", relay.producer, { type: "manual.event", version: 1, idempotencyKey: `recovery:${index}`, payload: { variant: "dark" } });
      const eventId = ((await accepted.json()) as { event: { id: string } }).event.id;
      const worker = await register(relay, `worker:${index}`);
      const delivery = await (await request(relay.base, "POST", "/v1/agent/poll", worker, {})).json() as { leaseId: string };
      assert.equal((await request(relay.base, "POST", `/v1/deliveries/${delivery.leaseId}/fail`, worker, { code: "unknown", effectStatus: "unknown" })).status, 200);
      assert.equal((await request(relay.base, "POST", `/v1/recovery/${eventId}/resolve`, relay.producer, { state, evidence: {} })).status, 403);
      assert.equal((await request(relay.base, "POST", `/v1/recovery/${eventId}/resolve`, relay.server.adminToken, { state, evidence: {} })).status, 200);
    } finally { await closeHarness(relay); }
  }
});

test("HTTP admin reload accepts a valid new definition", async () => {
  const relay = await harness();
  try { await writeFile(join(relay.root, "events", "new.v1.json"), JSON.stringify({ type: "new.event", version: 1, inputSchema: "schemas/request.json", outputSchema: "schemas/result.json", effectPolicy: "retry-safe", timeoutMs: 1000, hardDeadlineMs: 2000, retry: { maxAttempts: 1, backoffMs: [], retryableCodes: [] }, requires: { tools: [], structuredOutput: true, minContextTokens: 0, maxInputTokens: 1, maxOutputTokens: 1, maxPayloadBytes: 1000 }, handler: { kind: "agent", instructions: "handlers/ui-variant.md" } })); assert.equal((await request(relay.base, "POST", "/v1/admin/reload", relay.server.adminToken, {})).status, 200); } finally { await closeHarness(relay); }
});
test("HTTP external agent poll rejects process definitions", async () => {
  const root = await fixtureProject();
  await writeFile(join(root, "handlers", "process.sh"), "#!/bin/sh\n");
  await chmod(join(root, "handlers", "process.sh"), 0o755);
  await writeFile(join(root, "events", "process.v1.json"), JSON.stringify({ type: "process.only", version: 1, inputSchema: "schemas/request.json", outputSchema: "schemas/result.json", effectPolicy: "retry-safe", timeoutMs: 1000, hardDeadlineMs: 2000, retry: { maxAttempts: 1, backoffMs: [], retryableCodes: [] }, requires: { tools: [], structuredOutput: true, minContextTokens: 0, maxInputTokens: 1, maxOutputTokens: 1, maxPayloadBytes: 1000 }, handler: { kind: "process", command: "handlers/process.sh", args: [], env: [] } }));
  const registry = loadRegistry(root, "events"); const credentials = new CredentialStore(); const store = openStore(":memory:", { now: () => 1_700_000_000_000 }); store.installRevisions(registry.revisions()); const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: 20 }); const server = createRelayServer({ store, registry, credentials, dispatcher, projectRoot: root, definitionsDir: "events", pollTimeoutMs: 20 }) as RelayServer;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const producer = ((await (await request(base, "POST", "/v1/credentials", server.adminToken, { scope: "producer", subjectId: "process:producer" })).json()) as { token: string }).token; const worker = await (await request(base, "POST", "/v1/workers/register", server.adminToken, { workerId: "agent:worker", allowedDefinitions: ["*"], tools: [], structuredOutput: true, contextTokens: 5000, systemReserveTokens: 0, maxConcurrent: 1 })).json() as { token: string };
    assert.equal((await request(base, "POST", "/v1/events", producer, { type: "process.only", version: 1, idempotencyKey: "process:1", payload: { variant: "dark" } })).status, 201); assert.equal(await (await request(base, "POST", "/v1/agent/poll", worker.token, {})).json(), null);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
