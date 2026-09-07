import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CredentialStore } from "../src/auth.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { Registry, loadRegistry } from "../src/registry.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { openStore } from "../src/store.ts";
import { fixtureProject } from "./helpers.ts";

async function request(base: string, method: string, path: string, token: string, value?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(value === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

test("loopback routes accept, observe, and settle an agent delivery", async () => {
  const root = await fixtureProject();
  const registry = loadRegistry(root, "events");
  const credentials = new CredentialStore();
  const store = openStore(":memory:", { now: () => 1_700_000_000_000 });
  store.installRevisions(registry.revisions());
  const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: 100 });
  const server = createRelayServer({ store, registry, credentials, dispatcher, projectRoot: root, definitionsDir: "events", pollTimeoutMs: 100 }) as RelayServer;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const producer = (await (await request(base, "POST", "/v1/credentials", server.adminToken, { scope: "producer", subjectId: "browser:test" })).json() as { token: string }).token;
  const observer = (await (await request(base, "POST", "/v1/credentials", server.adminToken, { scope: "observer", subjectId: "browser:observer" })).json() as { token: string }).token;
  const accepted = await request(base, "POST", "/v1/events", producer, { type: "ui.variant.requested", version: 1, idempotencyKey: "http:1", payload: { variant: "dark" } });
  assert.equal(accepted.status, 201);
  const event = (await accepted.json() as { event: { id: string } }).event;
  const observed = await request(base, "GET", `/v1/events/${event.id}`, observer);
  assert.equal(observed.status, 200);
  const admin = await request(base, "POST", "/v1/workers/register", server.adminToken, { workerId: "worker:http", allowedDefinitions: ["ui.variant.requested@1"], tools: [], structuredOutput: true, contextTokens: 5000, systemReserveTokens: 0, maxConcurrent: 1 });
  assert.equal(admin.status, 201);
  const worker = await admin.json() as { token: string };
  const polled = await request(base, "POST", "/v1/agent/poll", worker.token, {});
  assert.equal(polled.status, 200);
  const delivery = await polled.json() as { event: { id: string }; leaseId: string };
  const complete = await request(base, "POST", `/v1/deliveries/${delivery.leaseId}/complete`, worker.token, { result: { ok: true }, effects: [] });
  assert.equal(complete.status, 200, await complete.clone().text());
  const final = await (await request(base, "GET", `/v1/events/${event.id}`, observer)).json() as { state: string };
  assert.equal(final.state, "completed");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("producer cannot settle a worker delivery", async () => {
  const root = await fixtureProject();
  const registry = loadRegistry(root, "events");
  const credentials = new CredentialStore();
  const store = openStore(":memory:", { now: () => 1_700_000_000_000 });
  store.installRevisions(registry.revisions());
  const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: 20 });
  const server = createRelayServer({ store, registry, credentials, dispatcher, projectRoot: root, definitionsDir: "events", pollTimeoutMs: 20 }) as RelayServer;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const producer = (await (await request(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "POST", "/v1/credentials", server.adminToken, { scope: "producer", subjectId: "producer" })).json() as { token: string }).token;
  const denied = await request(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "POST", "/v1/deliveries/nope/complete", producer, { result: {} });
  assert.equal(denied.status, 403);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
