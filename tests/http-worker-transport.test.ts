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
