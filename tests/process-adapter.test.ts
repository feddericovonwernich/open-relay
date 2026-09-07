import assert from "node:assert/strict";
import test from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialStore } from "../src/auth.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { ProcessAdapter, ProcessAdapterError, type ProcessAdapterOptions } from "../src/process-adapter.ts";
import { openStore } from "../src/store.ts";
import type { Delivery } from "../src/protocol.ts";
import type { DefinitionRevision } from "../src/registry.ts";

const root = dirname(fileURLToPath(import.meta.url));
const plugins = join(root, "fixtures", "plugins");
const clock = { now: () => Date.now() };

function revision(plugin: string, overrides: Partial<DefinitionRevision["definition"]> = {}): DefinitionRevision {
  const definition = {
    type: "plugin.test",
    version: 1,
    inputSchema: "request",
    outputSchema: "result",
    effectPolicy: "retry-safe" as const,
    timeoutMs: 500,
    hardDeadlineMs: 2_000,
    retry: { maxAttempts: 1, backoffMs: [], retryableCodes: ["plugin_crash", "plugin_protocol_error", "plugin_timeout", "plugin_output_overflow"] },
    requires: { tools: [], structuredOutput: false, minContextTokens: 0, maxInputTokens: 0, maxOutputTokens: 0, maxPayloadBytes: 1_000 },
    handler: { kind: "process" as const, command: plugin, args: [], env: ["PATH"] },
    ...overrides,
  };
  return { digest: `digest:${plugin}`, definition, inputSchema: {}, outputSchema: {}, resolvedCommand: join(plugins, plugin), validateInput: () => true, validateOutput: (value) => Boolean(value && typeof value === "object" && (value as { ok?: boolean }).ok === true) };
}

function delivery(revisionValue: DefinitionRevision): Delivery {
  return {
    event: { id: "event-1", producerId: "browser:test", idempotencyKey: "key-1", type: revisionValue.definition.type, version: 1, definitionRevision: revisionValue.digest, payload: { input: true }, payloadDigest: "digest", emittedAt: new Date().toISOString() },
    attempt: 1,
    workerId: "relay:process",
    leaseId: "lease-1",
    leaseExpiresAt: new Date(Date.now() + 400).toISOString(),
    hardDeadlineAt: new Date(Date.now() + 2_000).toISOString(),
  };
}

function errorCode(error: unknown): string { return error instanceof ProcessAdapterError ? error.code : ""; }

function adapter(options: Partial<Omit<ProcessAdapterOptions, "projectRoot">> = {}): ProcessAdapter {
  return new ProcessAdapter({ projectRoot: root, gracePeriodMs: 25, ...options });
}

test("plugin receives one immutable delivery and completes", async () => {
  const rev = revision("complete.mjs");
  const outcome = await adapter().run(delivery(rev), rev, AbortSignal.timeout(1_000));
  assert.deepEqual(outcome, { type: "complete", result: { ok: true }, effects: [] });
});

test("malformed stdout is a protocol failure", async () => {
  const rev = revision("malformed.mjs");
  await assert.rejects(adapter().run(delivery(rev), rev, AbortSignal.timeout(1_000)), (error) => errorCode(error) === "plugin_protocol_error");
});

test("malformed output kills a child that remains alive", async () => {
  const rev = revision("malformed-then-hang.mjs");
  const started = Date.now();
  await assert.rejects(adapter().run(delivery(rev), rev, AbortSignal.timeout(1_000)), (error) => errorCode(error) === "plugin_protocol_error");
  assert.ok(Date.now() - started < 800);
});

test("effect protocol messages become immutable evidence", async () => {
  const rev = revision("complete.mjs", { handler: { kind: "process", command: "complete.mjs", args: ["effects"], env: ["PATH"] } });
  const outcome = await adapter().run(delivery(rev), rev, AbortSignal.timeout(1_000));
  assert.deepEqual(outcome, {
    type: "complete",
    result: { ok: true },
    effects: [
      { effectKey: "charge", status: "started", idempotencyBoundaryConfirmed: true },
      { effectKey: "charge", status: "confirmed", externalRef: "ref-1" },
    ],
  });
});

test("renew messages are surfaced before terminal completion", async () => {
  const rev = revision("complete.mjs", { handler: { kind: "process", command: "complete.mjs", args: ["renew"], env: ["PATH"] } });
  const messages: string[] = [];
  await adapter().run(delivery(rev), rev, AbortSignal.timeout(1_000), { onMessage: (message) => { messages.push(message.type); } });
  assert.deepEqual(messages, ["started", "renew"]);
});
test("terminal output still obeys timeout until child exits", async () => {
  const rev = revision("terminal-hang.mjs", { timeoutMs: 30, hardDeadlineMs: 100 });
  await assert.rejects(adapter({ gracePeriodMs: 15 }).run(delivery(rev), rev, AbortSignal.timeout(1_000)), (error) => errorCode(error) === "plugin_timeout");
});
test("terminal output still obeys cancellation until child exits", async () => {
  const rev = revision("terminal-hang.mjs", { timeoutMs: 5_000, hardDeadlineMs: 6_000 });
  const controller = new AbortController();
  const pending = adapter({ gracePeriodMs: 15 }).run(delivery(rev), rev, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => errorCode(error) === "plugin_cancelled");
});

test("spawn errors reject without hanging", async () => {
  const rev = revision("missing.mjs");
  const missing = { ...rev, resolvedCommand: join(plugins, "does-not-exist.mjs") };
  await assert.rejects(adapter().run(delivery(missing), missing, AbortSignal.timeout(1_000)), (error) => errorCode(error) === "plugin_spawn_error");
});

test("split UTF-8 sequences remain valid JSONL", async () => {
  const rev = revision("unicode.mjs");
  const messages: unknown[] = [];
  await adapter().run(delivery(rev), rev, AbortSignal.timeout(1_000), { onMessage: (message) => { if (message.type === "progress") messages.push(message.data); } });
  assert.deepEqual(messages, ["€"]);
});

test("stdout line overflow follows the termination ladder", async () => {
  const rev = revision("oversize.mjs");
  await assert.rejects(adapter({ maxLineBytes: 100, maxStdoutBytes: 1_000 }).run(delivery(rev), rev, AbortSignal.timeout(1_000)), (error) => errorCode(error) === "plugin_output_overflow");
});

test("abort terminates a hanging child", async () => {
  const rev = revision("hang.mjs", { timeoutMs: 5_000 });
  const controller = new AbortController();
  const pending = adapter({ gracePeriodMs: 20 }).run(delivery(rev), rev, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error) => errorCode(error) === "plugin_cancelled");
});

test("process loop acquires internal process work and settles it", async () => {
  const rev = revision("complete.mjs");
  const store = openStore(":memory:", clock);
  store.installRevisions([rev]);
  const accepted = store.accept({ producerId: "browser:test", idempotencyKey: "loop-1", payload: { input: true }, revision: rev });
  const dispatcher = new Dispatcher(store, new CredentialStore({ now: clock }), { now: clock, pollTimeoutMs: 20 });
  const controller = new AbortController();
  const loop = dispatcher.runProcessLoop(adapter(), controller.signal);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (store.getEvent(accepted.event.id)?.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await Promise.resolve();
  await Promise.resolve();
  const internals = dispatcher as unknown as { waiters: Map<string, Set<unknown>> };
  assert.equal(internals.waiters.get("relay:process")?.size, 1);
  controller.abort();
  await loop;
  assert.equal(store.getEvent(accepted.event.id)?.state, "completed");
});

test("cancellation race preserves completion effect evidence", async () => {
  const rev = revision("complete.mjs");
  const store = openStore(":memory:", clock);
  store.installRevisions([rev]);
  const accepted = store.accept({ producerId: "browser:test", idempotencyKey: "cancel-race", payload: { input: true }, revision: rev });
  const dispatcher = new Dispatcher(store, new CredentialStore({ now: clock }), { now: clock, pollTimeoutMs: 20 });
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  const fakeAdapter = {
    async run(_delivery: Delivery, _revision: DefinitionRevision, _signal: AbortSignal, hooks?: { onMessage?(message: { type: "started" }): void }): Promise<{ type: "complete"; result: unknown; effects: { effectKey: string; status: "unknown" }[] }> {
      hooks?.onMessage?.({ type: "started" });
      await gate;
      return { type: "complete", result: { ok: true }, effects: [{ effectKey: "charge", status: "unknown" }] };
    },
  };
  const controller = new AbortController();
  const loop = dispatcher.runProcessLoop(fakeAdapter, controller.signal);
  for (let attempt = 0; attempt < 50 && store.getEvent(accepted.event.id)?.state !== "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  dispatcher.requestCancel(accepted.event.id);
  resolveGate();
  for (let attempt = 0; attempt < 50 && store.getEvent(accepted.event.id)?.state !== "recovery_required"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  await loop;
  const event = store.getEvent(accepted.event.id);
  assert.equal(event?.state, "recovery_required");
  assert.deepEqual((event?.error as { evidence?: unknown[] })?.evidence, [{ effectKey: "charge", status: "unknown" }]);
});
