import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = resolve(process.env.OPEN_RELAY_CLI ?? join(projectRoot, "dist", "src", "cli.js"));
const demoParent = resolve(tmpdir());
const demoNamePrefix = "open-relay-notify-demo-";
const demoPrefix = join(demoParent, demoNamePrefix);
const statePath = resolve(process.env.OPEN_RELAY_NOTIFICATION_DEMO_STATE ?? join(tmpdir(), `open-relay-notification-demo-${process.getuid?.() ?? "user"}.json`));
const lockPath = `${statePath}.lock`;
const correlationId = "demo:agent:1";
const definition = "notification.demo@1";
const payload = { message: "PR 197 is ready. One review thread remains unresolved." };

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function state(required = true) {
  let value;
  try {
    value = object(JSON.parse(await readFile(statePath, "utf8")), "demo state");
  } catch (error) {
    if (!required && error?.code === "ENOENT") return undefined;
    if (error?.code === "ENOENT") throw new Error("notification demo is not set up; run npm run demo:notify:setup");
    throw error;
  }
  if (typeof value.root !== "string" || !Number.isInteger(value.relayPid) || value.relayPid < 1) throw new Error("demo state is invalid");
  const root = resolve(value.root);
  if (root !== value.root || dirname(root) !== demoParent || !basename(root).startsWith(demoNamePrefix)) throw new Error("demo state is invalid");
  let rootInfo;
  let canonicalRoot;
  try {
    [rootInfo, canonicalRoot] = await Promise.all([lstat(root), realpath(root)]);
  } catch {
    throw new Error("demo state is invalid");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || canonicalRoot !== root) throw new Error("demo state is invalid");
  return { root, relayPid: value.relayPid };
}

async function acquireOperationLock() {
  while (true) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerPid;
      try {
        ownerPid = Number(await readFile(lockPath, "utf8"));
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (Number.isInteger(ownerPid) && processIsRunning(ownerPid)) throw new Error("notification demo operation is already running");
      throw new Error(`notification demo operation lock is stale; remove ${quote(lockPath)} and rerun the command`);
    }
  }
}

async function setup() {
  await acquireOperationLock();
  let root;
  let relay;
  let signalExitCode;
  let statePublished = false;
  const initController = new AbortController();
  let initPromise;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    if (initPromise) {
      initController.abort();
      await initPromise.catch(() => undefined);
    }
    if (relay?.pid && relay.exitCode === null && relay.signalCode === null) {
      relay.ref();
      const exited = once(relay, "exit");
      if (relay.kill("SIGTERM")) await exited;
    }
    if (statePublished) await rm(statePath, { force: true });
    if (root) await rm(root, { recursive: true, force: true });
  })();
  const terminate = (exitCode) => {
    if (signalExitCode) return;
    signalExitCode = exitCode;
    void (async () => {
      try {
        await cleanup();
      } finally {
        await rm(lockPath, { force: true });
        process.exit(exitCode);
      }
    })();
  };
  const interrupt = () => terminate(130);
  const terminateProcess = () => terminate(143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminateProcess);
  try {
    if (await state(false)) throw new Error("notification demo already exists; run npm run demo:notify:cleanup first");
    root = await mkdtemp(demoPrefix);
    initPromise = execFileAsync(process.execPath, [cli, "init", "--project-root", root], {
      cwd: projectRoot,
      env: process.env,
      signal: initController.signal,
    });
    await initPromise;
    initPromise = undefined;
    await writeFile(join(root, ".relay", "schemas", "notification-delivered.json"), JSON.stringify({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { delivered: { const: true } },
      required: ["delivered"],
      additionalProperties: false,
    }, null, 2));
    await writeFile(join(root, ".relay", "events", "notification-demo.v1.json"), JSON.stringify({
      type: "notification.demo",
      version: 1,
      inputSchema: ".relay/schemas/example-request.json",
      outputSchema: ".relay/schemas/notification-delivered.json",
      effectPolicy: "retry-safe",
      timeoutMs: 30_000,
      hardDeadlineMs: 60_000,
      retry: { maxAttempts: 3, backoffMs: [1_000, 5_000], retryableCodes: ["temporarily_unavailable"] },
      requires: { tools: [], structuredOutput: false, minContextTokens: 0, maxInputTokens: 0, maxOutputTokens: 0, maxPayloadBytes: 65_536 },
      handler: { kind: "notification" },
    }, null, 2));

    const logPath = join(root, "relay.log");
    const log = openSync(logPath, "a", 0o600);
    relay = spawn(process.execPath, [cli, "start", "--project-root", root, "--port", "0", "--poll-timeout", "20"], {
      cwd: projectRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    relay.unref();

    const runtimePath = join(root, ".relay", "runtime.json");
    const deadline = Date.now() + 5_000;
    let runtime;
    while (Date.now() < deadline) {
      try {
        runtime = object(JSON.parse(await readFile(runtimePath, "utf8")), "Relay runtime");
        if (typeof runtime.pid === "number") break;
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      if (relay.exitCode !== null) throw new Error(`Relay failed to start; inspect ${logPath}`);
      await delay(25);
    }
    if (typeof runtime?.pid !== "number") throw new Error(`Relay did not start; inspect ${logPath}`);

    await writeFile(statePath, JSON.stringify({ root, relayPid: runtime.pid }), { mode: 0o600 });
    statePublished = true;
    process.stdout.write([
      "Notification demo ready.",
      "Agent command:",
      `${quote(process.execPath)} ${quote(cli)} notify --project-root ${quote(root)} --definitions ${definition} --correlation-id ${correlationId}`,
      "",
      "After the agent starts waiting, run:",
      "npm run demo:notify:emit",
      "",
    ].join("\n"));
  } catch (error) {
    await cleanup();
    if (!signalExitCode) throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminateProcess);
    if (!signalExitCode) await rm(lockPath, { force: true });
  }
}

async function emit() {
  const current = await state();
  const runtime = object(JSON.parse(await readFile(join(current.root, ".relay", "runtime.json"), "utf8")), "Relay runtime");
  if (typeof runtime.port !== "number" || typeof runtime.token !== "string") throw new Error("Relay runtime is invalid");

  const credentialResponse = await fetch(`http://127.0.0.1:${runtime.port}/v1/credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "producer", subjectId: "demo:producer" }),
  });
  if (!credentialResponse.ok) throw new Error(`producer credential failed: HTTP ${credentialResponse.status}`);
  const credential = object(await credentialResponse.json(), "producer credential");
  if (typeof credential.token !== "string") throw new Error("producer credential is invalid");

  const eventResponse = await fetch(`http://127.0.0.1:${runtime.port}/v1/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "notification.demo",
      version: 1,
      idempotencyKey: `demo:${randomUUID()}`,
      correlationId,
      payload,
    }),
  });
  if (!eventResponse.ok) throw new Error(`event emission failed: HTTP ${eventResponse.status}`);
  const accepted = object(await eventResponse.json(), "accepted event");
  const event = object(accepted.event, "accepted event");
  if (typeof event.id !== "string") throw new Error("accepted event has no id");
  process.stdout.write(`Emitted event: ${event.id}\nExpected agent payload: ${JSON.stringify(payload)}\n`);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanup() {
  await acquireOperationLock();
  try {
    const current = await state(false);
    if (!current) {
      process.stdout.write("No notification demo to clean up.\n");
      return;
    }
    try {
      await execFileAsync(process.execPath, [cli, "stop", "--project-root", current.root], { cwd: projectRoot, env: process.env });
    } catch (error) {
      if (processIsRunning(current.relayPid)) throw error;
    }
    await rm(current.root, { recursive: true, force: true });
    await unlink(statePath);
    process.stdout.write("Notification demo removed.\n");
  } finally {
    await rm(lockPath, { force: true });
  }
}

try {
  const action = process.argv[2];
  if (action === "setup") await setup();
  else if (action === "emit") await emit();
  else if (action === "cleanup") await cleanup();
  else throw new Error("usage: notification-demo.mjs <setup|emit|cleanup>");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
