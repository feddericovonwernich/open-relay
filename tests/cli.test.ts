import assert from "node:assert/strict";
import test from "node:test";
import { RelayBrowserClient } from "../src/browser.ts";
import { parseArgs } from "../src/cli.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("emit retry preserves its idempotency key", async () => {
  const keys: string[] = [];
  const acceptedId = "event-accepted";
  let attempt = 0;
  const transport = {
    async request(_input: string | URL, init?: RequestInit): Promise<Response> {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      attempt += 1;
      if (attempt === 1) throw new TypeError("network down");
      return jsonResponse({ event: { id: acceptedId }, created: true });
    },
  };
  const client = new RelayBrowserClient(transport, { baseUrl: "http://relay.test", token: "observer-token" });
  const event = await client.emit("ui.variant.requested", 2, { text: "A" }, { idempotencyKey: "go:42" });
  assert.deepEqual(keys, ["go:42", "go:42"]);
  assert.equal(event.id, acceptedId);
});

test("stream reconnects with the last event id and keeps bearer out of URL", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  let call = 0;
  const transport = {
    async request(input: string | URL, init?: RequestInit): Promise<Response> {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      call += 1;
      if (call === 1) {
        return new Response("id: 7\nevent: queued\ndata: {\"sequence\":7}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("id: 8\nevent: completed\ndata: {\"sequence\":8}\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  };
  const controller = new AbortController();
  const client = new RelayBrowserClient(transport, { baseUrl: "http://relay.test", token: "observer-secret", reconnectDelayMs: 0 });
  const events = [];
  for await (const event of client.stream({ signal: controller.signal, maxEvents: 2 })) {
    events.push(event);
    if (events.length === 2) controller.abort();
  }
  assert.deepEqual(events.map((event) => event.id), ["7", "8"]);
  assert.equal(requests[0]?.headers.get("Authorization"), "Bearer observer-secret");
  assert.equal(requests[1]?.headers.get("Authorization"), "Bearer observer-secret");
  assert.equal(requests[1]?.headers.get("Last-Event-ID"), "7");
  assert.equal(requests.some(({ url }) => url.includes("observer-secret")), false);
});

test("CLI argument parser supports nested recovery commands", () => {
  assert.deepEqual(parseArgs(["recovery", "resolve", "event-1", "completed", "--evidence", "{\"operator\":true}"]), {
    command: "recovery",
    args: ["resolve", "event-1", "completed"],
    options: { evidence: "{\"operator\":true}" },
  });
});
