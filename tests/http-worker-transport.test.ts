import assert from "node:assert/strict";
import test from "node:test";
import { HttpWorkerTransport, HttpWorkerTransportError } from "../src/http-worker-transport.ts";
import type { DeliveryAuthority, EffectEvidence } from "../src/protocol.ts";

const authority: DeliveryAuthority = { workerId: "worker-1", leaseId: "lease/1", eventId: "event-1" };

test("HttpWorkerTransport emits authenticated control requests", async () => {
  let seenSignal: AbortSignal | undefined;
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seenUrl = String(input);
    seenInit = init;
    seenSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ status: "timeout" }), { status: 200 });
  };
  const signal = new AbortController().signal;
  const transport = new HttpWorkerTransport({ baseUrl: "http://relay.test/", token: "secret-token", fetch });

  assert.equal(await transport.control(authority, signal), "timeout");
  assert.equal(seenUrl, "http://relay.test/v1/deliveries/lease%2F1/control");
  assert.equal(seenInit?.method, "GET");
  assert.equal(seenSignal, signal);
  assert.deepEqual(seenInit?.headers, { Authorization: "Bearer secret-token", "Content-Type": "application/json" });
});

test("HttpWorkerTransport posts unchanged cancellation evidence and effect payloads", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init! });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const transport = new HttpWorkerTransport({ baseUrl: "http://relay.test", token: "secret-token", fetch });
  const effects: readonly EffectEvidence[] = [{ effectKey: "charge", status: "started", idempotencyBoundaryConfirmed: true }];

  await transport.cancelled(authority, effects);
  await transport.recordEffectIntent(authority, "charge", true);
  await transport.confirmEffect(authority, "charge", "external-ref");

  assert.deepEqual(calls.map(({ url, init }) => ({
    url,
    method: init.method,
    headers: init.headers,
    body: JSON.parse(String(init.body)),
  })), [
    { url: "http://relay.test/v1/deliveries/lease%2F1/cancelled", method: "POST", headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: { effects } },
    { url: "http://relay.test/v1/deliveries/lease%2F1/effect-intent", method: "POST", headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: { effectKey: "charge", idempotencyBoundaryConfirmed: true } },
    { url: "http://relay.test/v1/deliveries/lease%2F1/effect-confirmation", method: "POST", headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: { effectKey: "charge", externalRef: "external-ref" } },
  ]);
});

test("HttpWorkerTransport redacts bearer token from failed requests", async () => {
  let seenUrl = "";
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    seenUrl = String(input);
    return new Response("nope", { status: 503 });
  };
  const transport = new HttpWorkerTransport({ baseUrl: "http://relay.test", token: "secret-token", fetch });

  await assert.rejects(() => transport.recordEffectIntent(authority, "charge", true), (error: unknown) => {
    assert.ok(error instanceof HttpWorkerTransportError);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
  assert.doesNotMatch(seenUrl, /secret-token/);
});

test("HttpWorkerTransport rejects malformed control responses", async () => {
  const fetch = async (): Promise<Response> => new Response(JSON.stringify({ status: "unexpected" }), { status: 200 });
  const transport = new HttpWorkerTransport({ baseUrl: "http://relay.test", token: "secret-token", fetch });
  await assert.rejects(() => transport.control(authority, new AbortController().signal), HttpWorkerTransportError);
});

test("HttpWorkerTransport treats a null poll response as no delivery", async () => {
  const fetch = async (): Promise<Response> => new Response("null", { status: 200 });
  const transport = new HttpWorkerTransport({ baseUrl: "http://relay.test", token: "worker-secret", fetch });
  assert.equal(await transport.poll(new AbortController().signal), undefined);
});
test("HttpWorkerTransport polls and sends every lease lifecycle payload unchanged", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const delivery = {
    event: { id: "event-1" },
    attempt: 1,
    workerId: "worker-1",
    leaseId: "lease/1",
    leaseExpiresAt: "2026-09-09T00:00:30.000Z",
    hardDeadlineAt: "2026-09-09T00:10:00.000Z",
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init! });
    return new Response(JSON.stringify(String(input).endsWith("/poll") ? delivery : { ok: true }), { status: 200 });
  };
  const signal = new AbortController().signal;
  const transport = new HttpWorkerTransport({ baseUrl: "http://relay.test", token: "worker-secret", fetch });

  assert.deepEqual(await transport.poll(signal), delivery);
  await transport.start(authority);
  await transport.renew(authority, "2026-09-09T00:01:00.000Z");
  await transport.progress(authority, { phase: "working", count: 2 });
  await transport.complete(authority, { reply: "done" }, [{ effectKey: "charge", status: "confirmed" }]);
  await transport.fail(authority, { code: "worker_error", effectStatus: "unknown" });

  assert.deepEqual(calls.map(({ url, init }) => ({
    url,
    method: init.method,
    body: JSON.parse(String(init.body)),
  })), [
    { url: "http://relay.test/v1/agent/poll", method: "POST", body: {} },
    { url: "http://relay.test/v1/deliveries/lease%2F1/start", method: "POST", body: {} },
    { url: "http://relay.test/v1/deliveries/lease%2F1/renew", method: "POST", body: { leaseExpiresAt: "2026-09-09T00:01:00.000Z" } },
    { url: "http://relay.test/v1/deliveries/lease%2F1/progress", method: "POST", body: { data: { phase: "working", count: 2 } } },
    { url: "http://relay.test/v1/deliveries/lease%2F1/complete", method: "POST", body: { result: { reply: "done" }, effects: [{ effectKey: "charge", status: "confirmed" }] } },
    { url: "http://relay.test/v1/deliveries/lease%2F1/fail", method: "POST", body: { code: "worker_error", effectStatus: "unknown" } },
  ]);
  assert.equal(calls[0]?.init.signal, signal);
});

test("HttpWorkerTransport rejects malformed poll deliveries without leaking bearer data", async () => {
  const malformed = [
    {},
    { event: { id: 7 }, workerId: "worker-1", leaseId: "lease-1", leaseExpiresAt: "expiry", hardDeadlineAt: "deadline" },
    { event: { id: "event-1" }, workerId: 7, leaseId: "lease-1", leaseExpiresAt: "expiry", hardDeadlineAt: "deadline" },
    { event: { id: "event-1" }, workerId: "worker-1", leaseId: 7, leaseExpiresAt: "expiry", hardDeadlineAt: "deadline" },
    { event: { id: "event-1" }, workerId: "worker-1", leaseId: "lease-1", leaseExpiresAt: 1, hardDeadlineAt: "deadline" },
    { event: { id: "event-1" }, workerId: "worker-1", leaseId: "lease-1", leaseExpiresAt: "expiry", hardDeadlineAt: 1 },
  ];
  for (const value of malformed) {
    const fetch = async (): Promise<Response> => new Response(JSON.stringify(value), { status: 200 });
    const transport = new HttpWorkerTransport({ baseUrl: "http://relay.test", token: "worker-secret", fetch });
    await assert.rejects(() => transport.poll(new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof HttpWorkerTransportError);
      assert.doesNotMatch(error.message, /worker-secret/);
      return true;
    });
  }
});
