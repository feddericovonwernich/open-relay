import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(projectRoot, "scripts", "notification-demo.mjs");
const cli = join(projectRoot, "src", "cli.ts");

// This integration spans OS processes and sockets, so a deterministic clock cannot bound a hung child.
test("notification demo commands deliver one payload and remove the demo", { timeout: 10_000 }, async () => {
  const statePath = join(tmpdir(), `open-relay-notification-demo-test-${process.pid}.json`);
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    OPEN_RELAY_CLI: cli,
    OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath,
  };
  let notify: ChildProcess | undefined;

  try {
    const setup = await execFileAsync(process.execPath, [script, "setup"], { cwd: projectRoot, env, encoding: "utf8" });
    assert.match(setup.stdout, /Agent command:\n.* notify .*--definitions notification\.demo@1 .*--correlation-id demo:agent:1/);

    const stateValue: unknown = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(stateValue !== null && typeof stateValue === "object" && "root" in stateValue && typeof stateValue.root === "string");
    const demoRoot = stateValue.root;

    notify = spawn(process.execPath, [
      cli,
      "notify",
      "--project-root", demoRoot,
      "--definitions", "notification.demo@1",
      "--correlation-id", "demo:agent:1",
    ], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    notify.stdout?.on("data", (value) => { stdout += value; });
    notify.stderr?.on("data", (value) => { stderr += value; });
    const notified = once(notify, "exit");

    const emitted = await execFileAsync(process.execPath, [script, "emit"], { cwd: projectRoot, env, encoding: "utf8" });
    const eventId = /Emitted event: ([0-9a-f-]{36})/.exec(emitted.stdout)?.[1];
    assert.ok(eventId);
    assert.equal((await notified)[0], 0);
    assert.equal(stderr, "");
    assert.equal(stdout, "{\"message\":\"PR 197 is ready. One review thread remains unresolved.\"}\n");

    const observed = await execFileAsync(process.execPath, [cli, "get", eventId, "--project-root", demoRoot], { cwd: projectRoot, env, encoding: "utf8" });
    const event: unknown = JSON.parse(observed.stdout);
    assert.ok(event !== null && typeof event === "object" && "state" in event);
    assert.equal(event.state, "completed");
  } finally {
    if (notify?.exitCode === null) notify.kill("SIGTERM");
    await execFileAsync(process.execPath, [script, "cleanup"], { cwd: projectRoot, env, encoding: "utf8" }).catch(() => undefined);
  }

  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
});

test("cleanup rejects a state root that resolves outside the demo directory", async () => {
  const target = await mkdtemp(join(tmpdir(), "open-relay-notification-safety-"));
  const statePath = join(tmpdir(), `open-relay-notification-demo-safety-${process.pid}.json`);
  const sentinel = join(target, "keep.txt");
  await writeFile(sentinel, "keep");
  await writeFile(statePath, JSON.stringify({
    root: `${join(tmpdir(), "open-relay-notify-demo-escape")}/../${basename(target)}`,
    relayPid: 2_147_483_647,
  }));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [script, "cleanup"], {
        cwd: projectRoot,
        env: { ...process.env, OPEN_RELAY_CLI: cli, OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath },
        encoding: "utf8",
      }),
      /demo state is invalid/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(statePath, { force: true });
  }
});


test("cleanup rejects a nested state root that traverses a symlink", async () => {
  const container = await mkdtemp(join(tmpdir(), "open-relay-notify-demo-"));
  const target = await mkdtemp(join(tmpdir(), "open-relay-notification-symlink-target-"));
  const victim = join(target, "victim");
  const sentinel = join(victim, "keep.txt");
  const statePath = join(tmpdir(), `open-relay-notification-demo-symlink-${process.pid}.json`);
  await mkdir(victim);
  await writeFile(sentinel, "keep");
  await symlink(target, join(container, "link"), "dir");
  await writeFile(statePath, JSON.stringify({ root: join(container, "link", "victim"), relayPid: 2_147_483_647 }));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [script, "cleanup"], {
        cwd: projectRoot,
        env: { ...process.env, OPEN_RELAY_CLI: cli, OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath },
        encoding: "utf8",
      }),
      /demo state is invalid/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(container, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(statePath, { force: true });
    await rm(`${statePath}.lock`, { force: true });
  }
});
test("cleanup rejects a published demo while setup still owns the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-relay-notify-demo-"));
  const statePath = join(tmpdir(), `open-relay-notification-demo-live-lock-${process.pid}.json`);
  const lockPath = `${statePath}.lock`;
  const sentinel = join(root, "keep.txt");
  await writeFile(sentinel, "keep");
  await writeFile(statePath, JSON.stringify({ root, relayPid: 2_147_483_647 }));
  await writeFile(lockPath, String(process.pid));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [script, "cleanup"], {
        cwd: projectRoot,
        env: { ...process.env, OPEN_RELAY_CLI: cli, OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath },
        encoding: "utf8",
      }),
      /notification demo operation is already running/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(statePath, { force: true });
    await rm(lockPath, { force: true });
  }
});

// This integration coordinates real child processes through file-system events.
test("setup cannot start while cleanup owns the demo lifecycle", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "open-relay-notify-demo-"));
  const statePath = join(tmpdir(), `open-relay-notification-demo-operation-lock-${process.pid}.json`);
  const marker = join(root, "cleanup-started");
  const release = join(root, "release-cleanup");
  const fakeCli = join(root, "blocking-cli.mjs");
  await writeFile(statePath, JSON.stringify({ root, relayPid: 2_147_483_647 }));
  await writeFile(fakeCli, `
import { watch } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
const statePath = process.env.OPEN_RELAY_NOTIFICATION_DEMO_STATE;
const marker = process.env.OPEN_RELAY_NOTIFICATION_DEMO_RACE_MARKER;
const release = process.env.OPEN_RELAY_NOTIFICATION_DEMO_RACE_RELEASE;
const savedState = await readFile(statePath, "utf8");
await rm(statePath, { force: true });
const watcher = watch(dirname(release));
const { promise: released, resolve: releaseCleanup } = Promise.withResolvers();
watcher.on("change", (_event, name) => {
  if (String(name) === basename(release)) {
    watcher.close();
    releaseCleanup();
  }
});
await writeFile(marker, "ready");
await released;
await writeFile(statePath, savedState);
`);
  const cleanupEnv = {
    ...process.env,
    OPEN_RELAY_CLI: fakeCli,
    OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath,
    OPEN_RELAY_NOTIFICATION_DEMO_RACE_MARKER: marker,
    OPEN_RELAY_NOTIFICATION_DEMO_RACE_RELEASE: release,
  };
  const rootWatcher = watch(root);
  const markerSeen = once(rootWatcher, "change");
  const cleanup = execFileAsync(process.execPath, [script, "cleanup"], { cwd: projectRoot, env: cleanupEnv, encoding: "utf8" });
  let setupAttempt: PromiseSettledResult<{ stdout: string; stderr: string }> | undefined;
  try {
    const [, changed] = await markerSeen;
    rootWatcher.close();
    assert.equal(String(changed), basename(marker));
    [setupAttempt] = await Promise.allSettled([
      execFileAsync(process.execPath, [script, "setup"], {
        cwd: projectRoot,
        env: { ...process.env, NODE_NO_WARNINGS: "1", OPEN_RELAY_CLI: cli, OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath },
        encoding: "utf8",
      }),
    ]);
    await writeFile(release, "go");
    await cleanup;
    assert.equal(setupAttempt.status, "rejected");
  } finally {
    rootWatcher.close();
    await writeFile(release, "go").catch(() => undefined);
    await cleanup.catch(() => undefined);
    if (setupAttempt?.status === "fulfilled") {
      const startedRoot = /--project-root '([^']+)'/.exec(setupAttempt.value.stdout)?.[1];
      if (startedRoot) {
        await execFileAsync(process.execPath, [cli, "stop", "--project-root", startedRoot], { cwd: projectRoot, encoding: "utf8" }).catch(() => undefined);
        await rm(startedRoot, { recursive: true, force: true });
      }
    }
    await rm(root, { recursive: true, force: true });
    await rm(statePath, { force: true });
    await rm(`${statePath}.lock`, { force: true });
  }
});

// This integration sends a real signal while setup owns an ordinary child process.
test("interrupted setup stops initialization and removes unpublished resources", { timeout: 10_000 }, async () => {
  const coordination = await mkdtemp(join(tmpdir(), "open-relay-notification-init-interrupt-"));
  const fakeCli = join(coordination, "fake-cli.mjs");
  const marker = join(coordination, "init-started.json");
  const statePath = join(tmpdir(), `open-relay-notification-demo-init-interrupt-${process.pid}.json`);
  await writeFile(fakeCli, `
import { once } from "node:events";
import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
const root = process.argv[process.argv.indexOf("--project-root") + 1];
const server = createServer();
const listening = Promise.withResolvers();
server.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const temporaryMarker = root + "/init-marker.json";
await writeFile(temporaryMarker, JSON.stringify({ pid: process.pid, root }));
await rename(temporaryMarker, process.env.OPEN_RELAY_NOTIFICATION_DEMO_INTERRUPT_MARKER);
await once(process, "SIGTERM");
const closed = Promise.withResolvers();
server.close(closed.resolve);
await closed.promise;
`);
  const env = {
    ...process.env,
    OPEN_RELAY_CLI: fakeCli,
    OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath,
    OPEN_RELAY_NOTIFICATION_DEMO_INTERRUPT_MARKER: marker,
  };
  const markerWatcher = watch(coordination);
  const markerCreated = once(markerWatcher, "change");
  const setup = spawn(process.execPath, [script, "setup"], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const setupExited = once(setup, "exit");
  let initPid: number | undefined;
  let demoRoot: string | undefined;
  try {
    const [, changed] = await markerCreated;
    markerWatcher.close();
    assert.equal(String(changed), basename(marker));
    const markerValue: unknown = JSON.parse(await readFile(marker, "utf8"));
    assert.ok(markerValue !== null && typeof markerValue === "object"
      && "pid" in markerValue && typeof markerValue.pid === "number"
      && "root" in markerValue && typeof markerValue.root === "string");
    const startedInitPid = markerValue.pid;
    initPid = startedInitPid;
    demoRoot = markerValue.root;
    setup.kill("SIGTERM");
    await setupExited;
    await assert.rejects(readFile(`${statePath}.lock`, "utf8"), { code: "ENOENT" });
    await assert.rejects(lstat(demoRoot), { code: "ENOENT" });
    assert.throws(() => process.kill(startedInitPid, 0), { code: "ESRCH" });
  } finally {
    markerWatcher.close();
    if (setup.exitCode === null) setup.kill("SIGKILL");
    if (initPid) {
      try { process.kill(initPid, "SIGKILL"); } catch { /* process already stopped */ }
    }
    if (demoRoot) await rm(demoRoot, { recursive: true, force: true });
    await rm(statePath, { force: true });
    await rm(`${statePath}.lock`, { force: true });
    await rm(coordination, { recursive: true, force: true });
  }
});

// This integration sends a real signal to a setup process that owns a detached child.
test("interrupted setup stops Relay and removes unpublished resources", { timeout: 10_000 }, async () => {
  const coordination = await mkdtemp(join(tmpdir(), "open-relay-notification-interrupt-"));
  const fakeCli = join(coordination, "fake-cli.mjs");
  const marker = join(coordination, "relay-started.json");
  const statePath = join(tmpdir(), `open-relay-notification-demo-interrupt-${process.pid}.json`);
  await writeFile(fakeCli, `
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const action = process.argv[2];
const root = process.argv[process.argv.indexOf("--project-root") + 1];
if (action === "init") {
  await mkdir(join(root, ".relay", "events"), { recursive: true });
  await mkdir(join(root, ".relay", "schemas"), { recursive: true });
} else if (action === "start") {
  await writeFile(process.env.OPEN_RELAY_NOTIFICATION_DEMO_INTERRUPT_MARKER, JSON.stringify({ pid: process.pid, root }));
  await once(process, "SIGTERM");
}
`);
  const env = {
    ...process.env,
    OPEN_RELAY_CLI: fakeCli,
    OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath,
    OPEN_RELAY_NOTIFICATION_DEMO_INTERRUPT_MARKER: marker,
  };
  const markerWatcher = watch(coordination);
  const markerCreated = once(markerWatcher, "change");
  const setup = spawn(process.execPath, [script, "setup"], { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const setupExited = once(setup, "exit");
  let relayPid: number | undefined;
  let demoRoot: string | undefined;
  try {
    const [, changed] = await markerCreated;
    markerWatcher.close();
    assert.equal(String(changed), basename(marker));
    const markerValue: unknown = JSON.parse(await readFile(marker, "utf8"));
    assert.ok(markerValue !== null && typeof markerValue === "object"
      && "pid" in markerValue && typeof markerValue.pid === "number"
      && "root" in markerValue && typeof markerValue.root === "string");
    const startedRelayPid = markerValue.pid;
    relayPid = startedRelayPid;
    demoRoot = markerValue.root;
    setup.kill("SIGTERM");
    await setupExited;
    await assert.rejects(readFile(`${statePath}.lock`, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(demoRoot, "relay.log"), "utf8"), { code: "ENOENT" });
    assert.throws(() => process.kill(startedRelayPid, 0), { code: "ESRCH" });
  } finally {
    markerWatcher.close();
    if (setup.exitCode === null) setup.kill("SIGKILL");
    if (relayPid) {
      try { process.kill(relayPid, "SIGKILL"); } catch { /* process already stopped */ }
    }
    if (demoRoot) await rm(demoRoot, { recursive: true, force: true });
    await rm(statePath, { force: true });
    await rm(`${statePath}.lock`, { force: true });
    await rm(coordination, { recursive: true, force: true });
  }
});

test("setup admits only one concurrent notification demo", async () => {
  const statePath = join(tmpdir(), `open-relay-notification-demo-concurrent-${process.pid}.json`);
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    OPEN_RELAY_CLI: cli,
    OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath,
  };
  const attempts = await Promise.allSettled([
    execFileAsync(process.execPath, [script, "setup"], { cwd: projectRoot, env, encoding: "utf8" }),
    execFileAsync(process.execPath, [script, "setup"], { cwd: projectRoot, env, encoding: "utf8" }),
  ]);
  const roots = new Set<string>();
  try {
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  } finally {
    for (const attempt of attempts) {
      if (attempt.status !== "fulfilled") continue;
      const root = /--project-root '([^']+)'/.exec(attempt.value.stdout)?.[1];
      if (root) roots.add(root);
    }
    try {
      const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
      if (value !== null && typeof value === "object" && "root" in value && typeof value.root === "string") roots.add(value.root);
    } catch { /* setup can fail before state publication */ }
    for (const root of roots) {
      await execFileAsync(process.execPath, [cli, "stop", "--project-root", root], { cwd: projectRoot, env, encoding: "utf8" }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
    await rm(statePath, { force: true });
  }
});


test("setup fails closed when the operation lock owner is gone", async () => {
  const statePath = join(tmpdir(), `open-relay-notification-demo-stale-lock-${process.pid}.json`);
  const lockPath = `${statePath}.lock`;
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    OPEN_RELAY_CLI: cli,
    OPEN_RELAY_NOTIFICATION_DEMO_STATE: statePath,
  };
  await writeFile(lockPath, "2147483647");
  const [attempt] = await Promise.allSettled([
    execFileAsync(process.execPath, [script, "setup"], { cwd: projectRoot, env, encoding: "utf8" }),
  ]);
  try {
    assert.equal(attempt.status, "rejected");
    if (attempt.status === "rejected") assert.match(String(attempt.reason), /operation lock is stale/);
  } finally {
    if (attempt.status === "fulfilled") {
      const root = /--project-root '([^']+)'/.exec(attempt.value.stdout)?.[1];
      if (root) {
        await execFileAsync(process.execPath, [cli, "stop", "--project-root", root], { cwd: projectRoot, env, encoding: "utf8" }).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    }
    await rm(statePath, { force: true });
    await rm(lockPath, { force: true });
  }
});