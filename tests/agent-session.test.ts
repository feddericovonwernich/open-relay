import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pollAgent, replyAgent } from "../src/agent-session.ts";
import type { Delivery, WorkerCapabilities } from "../src/protocol.ts";

const capabilities: WorkerCapabilities = {
  workerId: "onboarding-agent",
  allowedDefinitions: ["example.requested@1"],
  tools: [],
  structuredOutput: true,
  contextTokens: 5_000,
  systemReserveTokens: 0,
  maxConcurrent: 1,
};
const runtime = { port: 4_321, token: "admin-secret", pid: 123 };
const delivery: Delivery = {
  event: {
    id: "event-1",
    producerId: "producer-1",
    idempotencyKey: "event-1",
    type: "example.requested",
    version: 1,
    definitionRevision: "digest-1",
    payload: { prompt: "hello" },
    payloadDigest: "digest",
    emittedAt: "2026-09-09T00:00:00.000Z",
  },
  attempt: 1,
  workerId: capabilities.workerId,
  leaseId: "lease/1",
  leaseExpiresAt: "2026-09-09T00:00:30.000Z",
  hardDeadlineAt: "2026-09-09T00:10:00.000Z",
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
function relayId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function leasePath(root: string, leaseId = delivery.leaseId): string {
  return join(root, ".relay", "agent-leases", Buffer.from(leaseId).toString("base64url") + ".json");
}
async function seedLease(root: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, ".relay", "agent-leases"), { recursive: true, mode: 0o700 });
  await writeFile(leasePath(root, String(value.leaseId ?? delivery.leaseId)), JSON.stringify(value), { mode: 0o600 });
}
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await nextTurn();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

test("pollAgent registers once, renews null polls silently, and persists one mode-0600 authority", async () => {
  const actualRoot = await mkdtemp(join(tmpdir(), "relay-agent-session-"));
  let registrations = 0;
  let polls = 0;
  let outstanding = 0;
  const firstPoll = deferred<Response>();
  const secondPoll = deferred<Response>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/v1/workers/register")) {
      registrations += 1;
      assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer admin-secret");
      return response({ workerId: capabilities.workerId, token: "worker-secret" }, 201);
    }
    assert.equal(url, "http://127.0.0.1:4321/v1/agent/poll");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer worker-secret");
    polls += 1;
    outstanding += 1;
    try {
      return await (polls === 1 ? firstPoll.promise : secondPoll.promise);
    } finally {
      outstanding -= 1;
    }
  };
  try {
    const running = pollAgent({ root: actualRoot, runtime, capabilities, timeoutMs: 1_000, fetch });
    await waitFor(() => registrations === 1 && polls === 1);
    assert.equal(registrations, 1);
    assert.equal(polls, 1);
    assert.equal(outstanding, 1);
    assert.equal(await Promise.race([running.then(() => "settled"), Promise.resolve("pending")]), "pending");

    firstPoll.resolve(response(null));
    await waitFor(() => polls === 2);
    assert.equal(outstanding, 1);

    secondPoll.resolve(response(delivery));
    const result = await running;
    assert.deepEqual(result, delivery);
    assert.doesNotMatch(JSON.stringify(result), /admin-secret|worker-secret/);
    const files = await readdir(join(actualRoot, ".relay", "agent-leases"));
    assert.deepEqual(files, [Buffer.from(delivery.leaseId).toString("base64url") + ".json"]);
    const authority = JSON.parse(await readFile(leasePath(actualRoot), "utf8")) as Record<string, unknown>;
    assert.deepEqual(authority, { version: 1, relayId: relayId(runtime.token), workerId: delivery.workerId, leaseId: delivery.leaseId, eventId: delivery.event.id, token: "worker-secret" });
    assert.equal((await stat(join(actualRoot, ".relay", "agent-leases"))).mode & 0o777, 0o700);
    assert.equal((await stat(leasePath(actualRoot))).mode & 0o777, 0o600);
  } finally {
    await rm(actualRoot, { recursive: true, force: true });
  }
});
test("pollAgent does not abort a server timeout response at the 30-second boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-session-"));
  const originalSetTimeout = globalThis.setTimeout;
  let polls = 0;
  let firstPollAborted = false;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) =>
    originalSetTimeout(handler, delay === 30_000 ? 0 : delay, ...args)) as typeof setTimeout;
  try {
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/workers/register")) return response({ workerId: capabilities.workerId, token: "worker-secret" }, 201);
      assert.equal(url, "http://127.0.0.1:4321/v1/agent/poll");
      polls += 1;
      if (polls === 1) {
        return await new Promise<Response>((resolve) => {
          originalSetTimeout(() => {
            firstPollAborted = init?.signal?.aborted === true;
            resolve(response(null));
          }, 10);
        });
      }
      return response(delivery);
    };
    assert.deepEqual(await pollAgent({ root, runtime, capabilities, timeoutMs: 1_000, fetch }), delivery);
    assert.equal(polls, 2);
    assert.equal(firstPollAborted, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await rm(root, { recursive: true, force: true });
  }
});


test("pollAgent rejects an active worker lease and removes stale runtime lease files", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-session-"));
  try {
    await seedLease(root, { version: 1, relayId: relayId(runtime.token), workerId: delivery.workerId, leaseId: delivery.leaseId, eventId: delivery.event.id, token: "worker-secret" });
    await assert.rejects(() => pollAgent({ root, runtime, capabilities, fetch: async () => response({}) }), /active delivery must be settled before polling: lease\/1/);

    await rm(leasePath(root), { force: true });
    await seedLease(root, { version: 1, relayId: "stale-runtime", workerId: delivery.workerId, leaseId: "stale-lease", eventId: "stale-event", token: "old-worker-secret" });
    const fetch = async (input: string | URL | Request): Promise<Response> => String(input).endsWith("/register")
      ? response({ workerId: capabilities.workerId, token: "worker-secret" }, 201)
      : response(delivery);
    const result = await pollAgent({ root, runtime, capabilities, timeoutMs: 100, fetch });
    assert.deepEqual(result, delivery);
    assert.equal(await stat(join(root, ".relay", "agent-leases", "c3RhbGUtbGVhc2U.json")).then(() => true).catch(() => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replyAgent uses the stored worker token and removes terminal authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-session-"));
  try {
    await seedLease(root, { version: 1, relayId: relayId(runtime.token), workerId: delivery.workerId, leaseId: delivery.leaseId, eventId: delivery.event.id, token: "worker-secret" });
    let seenAuthorization = "";
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      assert.equal(String(input), "http://127.0.0.1:4321/v1/deliveries/lease%2F1/complete");
      seenAuthorization = String((init?.headers as Record<string, string>).Authorization);
      return response({ ok: true });
    };
    assert.deepEqual(await replyAgent({ root, runtime, leaseId: delivery.leaseId, action: "complete", body: { result: { reply: "done" }, effects: [] }, fetch }), { ok: true });
    assert.equal(seenAuthorization, "Bearer worker-secret");
    assert.doesNotMatch(seenAuthorization, /admin-secret/);
    await assert.rejects(readFile(leasePath(root), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replyAgent does not expose credentials when runtime authority is stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-agent-session-"));
  try {
    await seedLease(root, { version: 1, relayId: "other-runtime", workerId: delivery.workerId, leaseId: delivery.leaseId, eventId: delivery.event.id, token: "worker-secret" });
    await assert.rejects(() => replyAgent({ root, runtime, leaseId: delivery.leaseId, action: "control" }), (error: unknown) => {
      assert.doesNotMatch(String(error), /admin-secret|worker-secret/);
      return true;
    });
    await assert.rejects(readFile(leasePath(root), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
