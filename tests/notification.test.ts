import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import type { Delivery } from "../src/protocol.ts";
import { CredentialStore } from "../src/auth.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { loadRegistry } from "../src/registry.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { openStore } from "../src/store.ts";
import { fixtureProject } from "./helpers.ts";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}


async function readToken(value: Response): Promise<string> {
  const body: unknown = await value.json();
  assert.ok(body !== null && typeof body === "object" && "token" in body && typeof body.token === "string");
  return body.token;
}

async function readEventId(value: Response): Promise<string> {
  const body: unknown = await value.json();
  assert.ok(body !== null && typeof body === "object" && "event" in body);
  const event = body.event;
  assert.ok(event !== null && typeof event === "object" && "id" in event && typeof event.id === "string");
  return event.id;
}

test("relay notify renews expired worker credentials before printing and acknowledging one payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-notify-"));
  await mkdir(join(root, ".relay"), { recursive: true });
  await writeFile(join(root, ".relay", "runtime.json"), JSON.stringify({ port: 4_321, token: "admin-secret" }));
  const payload = { verdict: "action_required", actions: ["resolve_review_findings"] };
  let registration: Record<string, unknown> | undefined;
  let releasePoll: ((value: Response) => void) | undefined;
  let releaseStdout: ((error?: Error | null) => void) | undefined;
  const requests: Array<{ path: string; body: unknown }> = [];
  let registrationCount = 0;
  let pollCount = 0;
  let markRegistered!: () => void;
  const registered = new Promise<void>((resolve) => { markRegistered = resolve; });
  let markPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => { markPollStarted = resolve; });
  let markStdout!: () => void;
  const stdoutStarted = new Promise<void>((resolve) => { markStdout = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ path, body });
    if (path === "/v1/workers/register") {
      registration = body as Record<string, unknown>;
      registrationCount += 1;
      markRegistered();
      return response({ workerId: registration.workerId, token: `worker-secret-${registrationCount}` }, 201);
    }
    if (path === "/v1/notification/poll") {
      pollCount += 1;
      if (pollCount === 1) return response({ error: { code: "unauthorized" } }, 401);
      return await new Promise<Response>((resolve) => {
        releasePoll = resolve;
        markPollStarted();
      });
    }
    if (path.endsWith("/start") || path.endsWith("/complete")) return response({ ok: true });
    throw new Error(`unexpected request: ${path}`);
  };

  let stdout = "";
  let stderr = "";
  try {
    const running = runCli([
      "notify",
      "--definitions", "pr.verification.settled@1",
      "--correlation-id", "github:octo/repo:pull-request:33",
    ], {
      cwd: root,
      stdout: {
        write(value: string, callback?: (error?: Error | null) => void): void {
          stdout += value;
          releaseStdout = callback;
          markStdout();
        },
      },
      stderr: { write: (value) => { stderr += value; } },
    });

    await Promise.race([registered, running]);
    assert.equal(stderr, "");
    assert.equal(stdout, "");
    assert.match(String(registration?.workerId), /^notify:\d+:[0-9a-f-]{36}$/);
    assert.deepEqual(registration, {
      workerId: registration?.workerId,
      allowedDefinitions: ["pr.verification.settled@1"],
      tools: [],
      structuredOutput: false,
      contextTokens: 0,
      systemReserveTokens: 0,
      maxConcurrent: 1,
      correlationId: "github:octo/repo:pull-request:33",
    });

    const delivery: Delivery = {
      event: {
        id: "event-1",
        producerId: "github",
        idempotencyKey: "notification-1",
        type: "pr.verification.settled",
        version: 1,
        definitionRevision: "digest-1",
        payload,
        payloadDigest: "payload-digest",
        emittedAt: "2026-09-17T00:00:00.000Z",
        correlationId: "github:octo/repo:pull-request:33",
      },
      outputSchema: { type: "object", properties: { delivered: { const: true } }, required: ["delivered"], additionalProperties: false },
      attempt: 1,
      workerId: String(registration?.workerId),
      leaseId: "lease/1",
      leaseExpiresAt: "2026-09-17T00:00:30.000Z",
      hardDeadlineAt: "2026-09-17T00:01:00.000Z",
    };
    await Promise.race([pollStarted, running]);
    assert.ok(releasePoll);
    releasePoll(response(delivery));
    await Promise.race([stdoutStarted, running]);

    assert.equal(stderr, "");
    assert.equal(stdout, `${JSON.stringify(payload)}\n`);
    assert.deepEqual(requests.map(({ path }) => path), [
      "/v1/workers/register",
      "/v1/notification/poll",
      "/v1/workers/register",
      "/v1/notification/poll",
      "/v1/deliveries/lease%2F1/start",
    ]);

    releaseStdout?.();
    assert.equal(await running, 0);
    assert.deepEqual(requests.at(-1), {
      path: "/v1/deliveries/lease%2F1/complete",
      body: { result: { delivered: true }, effects: [] },
    });
    assert.deepEqual(await readdir(join(root, ".relay", "agent-leases")), []);
    assert.doesNotMatch(stdout + stderr, /admin-secret|worker-secret|lease\/1/);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("notification events bypass agent polling and complete through the real notify path", async () => {
  const root = await fixtureProject();
  let server: RelayServer | undefined;
  try {
    await writeFile(join(root, "schemas", "notification-delivered.json"), JSON.stringify({
      type: "object",
      properties: { delivered: { const: true } },
      required: ["delivered"],
      additionalProperties: false,
    }));
    await writeFile(join(root, "events", "notification.v1.json"), JSON.stringify({
      type: "notification.mock",
      version: 1,
      inputSchema: "schemas/request.json",
      outputSchema: "schemas/notification-delivered.json",
      effectPolicy: "retry-safe",
      timeoutMs: 1_000,
      hardDeadlineMs: 2_000,
      retry: { maxAttempts: 2, backoffMs: [0], retryableCodes: [] },
      requires: { tools: [], structuredOutput: false, minContextTokens: 0, maxInputTokens: 0, maxOutputTokens: 0, maxPayloadBytes: 65_536 },
      handler: { kind: "notification" },
    }));
    const registry = loadRegistry(root, "events");
    const store = openStore(":memory:");
    store.installRevisions(registry.revisions());
    const credentials = new CredentialStore();
    const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: 10 });
    server = createRelayServer({ store, registry, credentials, dispatcher, projectRoot: root, definitionsDir: "events", pollTimeoutMs: 10 }) as RelayServer;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const port = address.port;
    const base = `http://127.0.0.1:${port}`;
    await mkdir(join(root, ".relay"), { recursive: true });
    await writeFile(join(root, ".relay", "runtime.json"), JSON.stringify({ port, token: server.adminToken }));

    const producerResponse = await fetch(`${base}/v1/credentials`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "producer", subjectId: "test:producer" }),
    });
    const producer = await readToken(producerResponse);
    const payload = { variant: "dark" };
    const accepted = await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${producer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "notification.mock",
        version: 1,
        idempotencyKey: "notification:1",
        correlationId: "test:notification:1",
        payload,
      }),
    });
    assert.equal(accepted.status, 201);
    const eventId = await readEventId(accepted);

    for (const [index, selector] of ["*", "notification.*"].entries()) {
      const wildcardWorkerResponse = await fetch(`${base}/v1/workers/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${server.adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          workerId: `notify:wildcard:${index}`,
          allowedDefinitions: [selector],
          tools: [],
          structuredOutput: false,
          contextTokens: 0,
          systemReserveTokens: 0,
          maxConcurrent: 1,
          correlationId: "test:notification:1",
        }),
      });
      const wildcardWorker = await readToken(wildcardWorkerResponse);
      const wildcardPoll = await fetch(`${base}/v1/notification/poll`, {
        method: "POST",
        headers: { Authorization: `Bearer ${wildcardWorker}`, "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(await wildcardPoll.json(), null);
    }

    const ordinaryWorkerResponse = await fetch(`${base}/v1/workers/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "agent:ordinary",
        allowedDefinitions: ["notification.mock@1"],
        tools: [],
        structuredOutput: true,
        contextTokens: 5_000,
        systemReserveTokens: 0,
        maxConcurrent: 1,
        correlationId: "test:notification:1",
      }),
    });
    const ordinaryWorker = await readToken(ordinaryWorkerResponse);
    const ordinaryPoll = await fetch(`${base}/v1/agent/poll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ordinaryWorker}`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(await ordinaryPoll.json(), null);

    let stdout = "";
    let stderr = "";
    const code = await runCli([
      "notify",
      "--definitions", "notification.mock@1",
      "--correlation-id", "test:notification:1",
    ], {
      cwd: root,
      stdout: {
        write(value: string, callback?: (error?: Error | null) => void): void {
          stdout += value;
          callback?.();
        },
      },
      stderr: { write: (value) => { stderr += value; } },
    });

    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.equal(stdout, `${JSON.stringify(payload)}\n`);
    assert.equal(store.getEvent(eventId)?.state, "completed");
    assert.deepEqual(store.listUpdatesAfter(0, eventId).map(({ kind }) => kind), ["queued", "leased", "started", "completed"]);
  } finally {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
