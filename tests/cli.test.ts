import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RelayBrowserClient } from "../src/browser.ts";
import { isCliEntrypoint, parseArgs, runCli, withoutSecrets } from "../src/cli.ts";

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

test("CLI argument parser supports nested agent poll and reply commands", () => {
  assert.deepEqual(parseArgs(["agent", "poll", "worker-1", "--definitions", "example.requested@1", "--structured-output", "--timeout", "5000", "--correlation-id", "github:octo/repo:pull-request:197"]), {
    command: "agent",
    args: ["poll", "worker-1"],
    options: { definitions: "example.requested@1", "structured-output": true, timeout: "5000", "correlation-id": "github:octo/repo:pull-request:197" },
  });
  assert.deepEqual(parseArgs(["agent", "reply", "lease-1", "complete", "--json", "{\"result\":{\"ok\":true},\"effects\":[]}"]), {
    command: "agent",
    args: ["reply", "lease-1", "complete"],
    options: { json: "{\"result\":{\"ok\":true},\"effects\":[]}" },
  });
});

test("agent poll rejects valueless capability options and surplus positionals", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-cli-agent-"));
  try {
    for (const optionName of ["definitions", "tools", "context-tokens", "system-reserve", "correlation-id"]) {
      let stderr = "";
      const code = await runCli(["agent", "poll", "worker-1", `--${optionName}`], {
        cwd: root,
        stdout: { write: () => undefined },
        stderr: { write: (value) => { stderr += value; } },
      });
      assert.equal(code, 1);
      assert.equal(stderr, `relay: --${optionName} requires a value\n`);
    }
    for (const [argv, message] of [
      [["agent", "poll", "worker-1", "extra"], "agent poll accepts exactly one worker id"],
      [["agent", "reply", "lease-1", "control", "extra"], "agent reply accepts exactly a lease id and action"],
    ] as const) {
      let stderr = "";
      const code = await runCli(argv, {
        cwd: root,
        stdout: { write: () => undefined },
        stderr: { write: (value) => { stderr += value; } },
      });
      assert.equal(code, 1);
      assert.equal(stderr, `relay: ${message}\n`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("agent poll rejects an empty correlation id", async () => {
  let stderr = "";
  const code = await runCli(["agent", "poll", "worker-1", "--correlation-id="], {
    cwd: await mkdtemp(join(tmpdir(), "relay-cli-agent-")),
    stdout: { write: () => undefined },
    stderr: { write: (value) => { stderr += value; } },
  });
  assert.equal(code, 1);
  assert.equal(stderr, "relay: correlation id must be a non-empty string\n");
});


test("agent poll validates timeout bounds and preserves relay error output", async () => {
  for (const timeout of ["0", "600001", "1.5"]) {
    let stderr = "";
    const code = await runCli(["agent", "poll", "worker-1", "--timeout", timeout], {
      cwd: await mkdtemp(join(tmpdir(), "relay-cli-agent-")),
      stdout: { write: () => undefined },
      stderr: { write: (value) => { stderr += value; } },
    });
    assert.equal(code, 1);
    assert.match(stderr, /^relay: timeout must be an integer from 1 through 600000\n$/);
  }
});

test("agent poll prints exactly one JSON timeout line and sends correlation capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-cli-agent-"));
  await mkdir(join(root, ".relay"), { recursive: true });
  await writeFile(join(root, ".relay", "runtime.json"), JSON.stringify({ port: 4_321, token: "admin-secret" }));
  const previousFetch = globalThis.fetch;
  let registrationBody: unknown;
  globalThis.fetch = async (input, init): Promise<Response> => {
    if (String(input).endsWith("/v1/workers/register")) {
      registrationBody = JSON.parse(String(init?.body));
      return jsonResponse({ workerId: "worker-1", token: "worker-secret" }, 201);
    }
    return jsonResponse(null);
  };
  let stdout = "";
  let stderr = "";
  try {
    const code = await runCli(["agent", "poll", "worker-1", "--timeout", "1", "--correlation-id", "github:octo/repo:pull-request:197"], {
      cwd: root,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });
    assert.deepEqual(registrationBody, {
      workerId: "worker-1", allowedDefinitions: ["*"], tools: [], structuredOutput: false,
      contextTokens: 0, systemReserveTokens: 0, maxConcurrent: 1,
      correlationId: "github:octo/repo:pull-request:197",
    });
    assert.doesNotMatch(JSON.stringify(registrationBody), /admin-secret|worker-secret/);
    assert.equal(code, 0);
    assert.equal(stdout, "{\"type\":\"timeout\"}\n");
    assert.equal(stderr, "");
    assert.doesNotMatch(stdout, /admin-secret|worker-secret/);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("agent reply prints a successful control result as exactly one JSON line", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-cli-agent-"));
  await mkdir(join(root, ".relay", "agent-leases"), { recursive: true });
  await writeFile(join(root, ".relay", "runtime.json"), JSON.stringify({ port: 4_321, token: "admin-secret" }));
  await writeFile(join(root, ".relay", "agent-leases", "bGVhc2UtMQ.json"), JSON.stringify({
    version: 1,
    relayId: createHash("sha256").update("admin-secret").digest("hex"),
    workerId: "worker-1",
    leaseId: "lease-1",
    eventId: "event-1",
    token: "worker-secret",
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init): Promise<Response> => {
    assert.equal(String(input), "http://127.0.0.1:4321/v1/deliveries/lease-1/control");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer worker-secret");
    return jsonResponse({ status: "timeout" });
  };
  let stdout = "";
  let stderr = "";
  try {
    const code = await runCli(["agent", "reply", "lease-1", "control"], {
      cwd: root,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    });
    assert.equal(code, 0);
    assert.equal(stdout, "{\"status\":\"timeout\"}\n");
    assert.equal(stderr, "");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("agent reply rejects unknown actions through the standard relay error path", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-cli-agent-"));
  await mkdir(join(root, ".relay"), { recursive: true });
  await writeFile(join(root, ".relay", "runtime.json"), JSON.stringify({ port: 4_321, token: "admin-secret" }));
  let stderr = "";
  try {
    const code = await runCli(["agent", "reply", "lease-1", "explode"], {
      cwd: root,
      stdout: { write: () => undefined },
      stderr: { write: (value) => { stderr += value; } },
    });
    assert.equal(code, 1);
    assert.equal(stderr, "relay: unknown agent action: explode\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("parses positional GitHub connector flags", () => {
  assert.deepEqual(parseArgs(["connect", "github", "--config", "config.json", "--pull-request", "197", "--once", "--discover", "--project-root", "/tmp/project"]), {
    command: "connect",
    args: ["github"],
    options: { config: "config.json", "pull-request": "197", once: true, discover: true, "project-root": "/tmp/project" },
  });
});

test("targeted GitHub connector rejects invalid selectors with exact errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-cli-github-"));
  await mkdir(join(root, ".relay", "connectors"), { recursive: true });
  await writeFile(join(root, ".relay", "connectors", "github.json"), JSON.stringify({
    connector: "github",
    repositories: ["octo/repo"],
    triggers: [{ id: "sonar-v1", recognizer: "sonarqube", match: { checkNames: ["SonarCloud Code Analysis"], appIds: [42], appSlugs: [] }, emit: { type: "x", version: 1 } }],
  }));
  try {
    for (const [argv, message] of [
      [["connect", "github", "--pull-request"], "--pull-request requires a value"],
      [["connect", "github", "--pull-request=0"], "--pull-request must be a positive integer"],
      [["connect", "github", "--pull-request=-1"], "--pull-request must be a positive integer"],
      [["connect", "github", "--pull-request=1.5"], "--pull-request must be a positive integer"],
      [["connect", "github", "--pull-request=1e3"], "--pull-request must be a positive integer"],
      [["connect", "github", "--pull-request=abc"], "--pull-request must be a positive integer"],
      [["connect", "github", "--pull-request=9007199254740992"], "--pull-request must be a positive integer"],
      [["connect", "github", "--pull-request", "197", "198"], "--pull-request accepts exactly one value"],
    ] as const) {
      let stderr = "";
      const code = await runCli([...argv, "--project-root", root], {
        cwd: root,
        stdout: { write: () => undefined },
        stderr: { write: (value) => { stderr += value; } },
      });
      assert.equal(code, 1);
      assert.equal(stderr, `relay: ${message}\n`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("targeted GitHub connector checks repository count before token or runtime access", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-cli-github-"));
  await mkdir(join(root, ".relay", "connectors"), { recursive: true });
  await writeFile(join(root, ".relay", "connectors", "github.json"), JSON.stringify({
    connector: "github",
    repositories: ["octo/repo", "octo/other"],
    triggers: [{ id: "sonar-v1", recognizer: "sonarqube", match: { checkNames: ["SonarCloud Code Analysis"], appIds: [42], appSlugs: [] }, emit: { type: "x", version: 1 } }],
  }));
  let stderr = "";
  try {
    const code = await runCli(["connect", "github", "--pull-request", "197", "--project-root", root], {
      cwd: root,
      stdout: { write: () => undefined },
      stderr: { write: (value) => { stderr += value; } },
    });
    assert.equal(code, 1);
    assert.equal(stderr, "relay: --pull-request requires exactly one configured repository\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe CLI output keeps app identities while removing secrets", () => {
  assert.deepEqual(withoutSecrets({ appId: 123, appSlug: "cursor", token: "secret", nested: { credential: "hidden", value: "ok" } }), {
    appId: 123,
    appSlug: "cursor",
    nested: { value: "ok" },
  });
});
