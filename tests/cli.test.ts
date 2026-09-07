import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RelayBrowserClient } from "../src/browser.ts";
import { isCliEntrypoint, parseArgs } from "../src/cli.ts";

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
test("CLI parser exposes emit version, JSON, and idempotency flags", () => {
  assert.deepEqual(parseArgs(["emit", "ui.variant.requested", "--version", "2", "--json", "{\"text\":\"A\"}", "--idempotency-key", "go:42"]), {
    command: "emit",
    args: ["ui.variant.requested"],
    options: { version: "2", json: "{\"text\":\"A\"}", "idempotency-key": "go:42" },
  });
});
test("stream cancels the response body when the consumer stops early", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("id: 1\nevent: queued\ndata: {}\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const transport = { request: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }) };
  const client = new RelayBrowserClient(transport, { baseUrl: "http://relay.test", token: "observer-secret" });
  for await (const _event of client.stream({ maxEvents: 1 })) break;
  assert.equal(cancelled, true);
});
test("recovery resolve accepts the --as flag", () => {
  assert.deepEqual(parseArgs(["recovery", "resolve", "event-1", "--as", "completed", "--evidence", "{}"]), {
    command: "recovery",
    args: ["resolve", "event-1"],
    options: { as: "completed", evidence: "{}" },
  });
});

test("CLI entrypoint detection resolves npm-style symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-cli-"));
  const target = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const link = join(directory, "relay");
  try {
    await symlink(target, link);
    assert.equal(isCliEntrypoint(link, target), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("stream removes reconnect abort listeners after cancellation", async () => {
  const listeners = new Set<() => void>();
  let adds = 0;
  let removes = 0;
  const signal = {
    aborted: false,
    addEventListener(_type: string, listener: EventListener) {
      adds += 1;
      listeners.add(listener as unknown as () => void);
    },
    removeEventListener(_type: string, listener: EventListener) {
      removes += 1;
      listeners.delete(listener as unknown as () => void);
    },
  } as unknown as AbortSignal;
  const transport = { request: async () => new Response(null, { headers: { "Content-Type": "text/event-stream" } }) };
  const client = new RelayBrowserClient(transport, { baseUrl: "http://relay.test", token: "observer-secret", reconnectDelayMs: 1000 });
  const next = client.stream({ signal })[Symbol.asyncIterator]().next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  (signal as unknown as { aborted: boolean }).aborted = true;
  for (const listener of listeners) listener();
  await next;
  assert.equal(adds, removes);
});
