import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../src/registry.ts";
import { fixtureProject } from "./helpers.ts";

test("definition digest includes referenced schema and instruction bytes", async () => {
  const root = await fixtureProject();
  const first = loadRegistry(root, "events").resolve("ui.variant.requested", 1);
  await writeFile(join(root, "handlers", "ui-variant.md"), "changed instructions");
  const second = loadRegistry(root, "events").resolve("ui.variant.requested", 1);
  assert.notEqual(first.digest, second.digest);
  assert.equal(first.validateInput({ variant: "dark" }), true);
  assert.equal(first.validateInput({ variant: 42 }), false);
  assert.equal(first.validateOutput({ ok: true }), true);
  assert.equal(first.validateOutput({ ok: "yes" }), false);
  assert.equal(Object.isFrozen(first.definition.retry), true);
  const inputProperties = Object.getOwnPropertyDescriptor(first.inputSchema, "properties")?.value;
  const outputProperties = Object.getOwnPropertyDescriptor(first.outputSchema, "properties")?.value;
  assert.ok(inputProperties && typeof inputProperties === "object");
  assert.ok(outputProperties && typeof outputProperties === "object");
  assert.equal(Object.isFrozen(inputProperties), true);
  assert.equal(Object.isFrozen(outputProperties), true);
  assert.throws(() => {
    first.definition.retry.maxAttempts = 99;
  }, TypeError);
  assert.throws(() => {
    Object.defineProperty(inputProperties, "variant", { value: {} });
  }, TypeError);
  assert.throws(() => {
    Object.defineProperty(outputProperties, "ok", { value: {} });
  }, TypeError);
});

test("definition digest includes referenced schema bytes", async () => {
  const root = await fixtureProject();
  const active = loadRegistry(root, "events");
  const first = active.resolve("ui.variant.requested", 1);
  await writeFile(join(root, "schemas", "request.json"), "{\"type\":\"string\"}");
  const second = loadRegistry(root, "events").resolve("ui.variant.requested", 1);
  assert.notEqual(first.digest, second.digest);
  assert.throws(() => loadRegistry(root, "events", active), /version must increase/);
});

test("reload rejects changed content under an existing type and version", async () => {
  const root = await fixtureProject();
  const active = loadRegistry(root, "events");
  await writeFile(join(root, "handlers", "ui-variant.md"), "changed instructions");
  assert.throws(() => loadRegistry(root, "events", active), /version must increase/);
  assert.equal(active.resolve("ui.variant.requested", 1).digest, active.revisions()[0].digest);
});

test("process definitions reject absolute commands outside the project root", async () => {
  const root = await fixtureProject();
  await writeFile(
    join(root, "events", "process.json"),
    JSON.stringify({
      type: "process.example",
      version: 1,
      inputSchema: "schemas/request.json",
      outputSchema: "schemas/result.json",
      effectPolicy: "retry-safe",
      timeoutMs: 1000,
      hardDeadlineMs: 2000,
      retry: { maxAttempts: 1, backoffMs: [], retryableCodes: [] },
      requires: {
        tools: [],
        structuredOutput: false,
        minContextTokens: 0,
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxPayloadBytes: 1000
      },
      handler: { kind: "process", command: "/bin/sh", args: [], env: [] }
    }),
  );
  assert.throws(() => loadRegistry(root, "events"), { code: "definition_path_escape" });
});

test("process definitions reject relative commands that symlink outside the project root", async () => {
  const root = await fixtureProject();
  const outside = await mkdtemp(join(tmpdir(), "open-relay-external-"));
  const external = join(outside, "plugin.mjs");
  await writeFile(external, "process.stdout.write('ok')");
  await mkdir(join(root, "plugins"));
  await symlink(external, join(root, "plugins", "plugin.mjs"));
  await writeFile(
    join(root, "events", "process.json"),
    JSON.stringify({
      type: "process.example",
      version: 1,
      inputSchema: "schemas/request.json",
      outputSchema: "schemas/result.json",
      effectPolicy: "retry-safe",
      timeoutMs: 1000,
      hardDeadlineMs: 2000,
      retry: { maxAttempts: 1, backoffMs: [], retryableCodes: [] },
      requires: {
        tools: [],
        structuredOutput: false,
        minContextTokens: 0,
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxPayloadBytes: 1000
      },
      handler: { kind: "process", command: "plugins/plugin.mjs", args: [], env: [] }
    }),
  );
  assert.throws(() => loadRegistry(root, "events"), { code: "definition_path_escape" });
});

test("process command bytes are part of the immutable revision digest", async () => {
  const root = await fixtureProject();
  await mkdir(join(root, "plugins"));
  const command = join(root, "plugins", "plugin.mjs");
  await writeFile(command, "#!/usr/bin/env node\nprocess.stdout.write('first')\n");
  await chmod(command, 0o755);
  await writeFile(
    join(root, "events", "process.json"),
    JSON.stringify({
      type: "process.example",
      version: 1,
      inputSchema: "schemas/request.json",
      outputSchema: "schemas/result.json",
      effectPolicy: "retry-safe",
      timeoutMs: 1000,
      hardDeadlineMs: 2000,
      retry: { maxAttempts: 1, backoffMs: [], retryableCodes: [] },
      requires: {
        tools: [],
        structuredOutput: false,
        minContextTokens: 0,
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxPayloadBytes: 1000
      },
      handler: { kind: "process", command: "plugins/plugin.mjs", args: [], env: [] }
    }),
  );
  const active = loadRegistry(root, "events");
  const first = active.resolve("process.example", 1);
  await writeFile(command, "#!/usr/bin/env node\nprocess.stdout.write('changed')\n");
  const second = loadRegistry(root, "events").resolve("process.example", 1);
  assert.notEqual(first.digest, second.digest);
  assert.throws(() => loadRegistry(root, "events", active), /version must increase/);
});
