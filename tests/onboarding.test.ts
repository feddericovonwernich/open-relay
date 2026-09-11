import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { loadGitHubConnectorConfig } from "../src/connectors/github/config.ts";
import { loadRegistry } from "../src/registry.ts";

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const basicPaths = [
  ".relay/events/example.v1.json",
  ".relay/schemas/example-request.json",
  ".relay/schemas/example-result.json",
  ".relay/handlers/example.md",
] as const;
const githubPaths = [
  ".relay/connectors/github.json",
  ".relay/events/pr-automation-completed.v1.json",
  ".relay/events/pr-automation-settled.v1.json",
  ".relay/schemas/pr-automation-completed.json",
  ".relay/schemas/pr-automation-settled.json",
  ".relay/schemas/pr-automation-result.json",
  ".relay/handlers/pr-automation-completed.md",
  ".relay/handlers/pr-automation-settled.md",
] as const;

async function assertMatchesExample(directory: string, example: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    assert.equal(
      await readFile(join(directory, path), "utf8"),
      await readFile(join(projectRoot, "examples", example, path), "utf8"),
      path,
    );
  }
}

async function inTemporaryProject(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "open-relay-onboarding-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function capture(): { output: string[]; stream: { write(value: string): void } } {
  const output: string[] = [];
  return { output, stream: { write: (value) => output.push(value) } };
}

test("relay --help works without an initialized project", async () => {
  const stdout = capture();
  const stderr = capture();
  assert.equal(await runCli(["--help"], { stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.match(stdout.output.join(""), /relay init/);
  assert.equal(stderr.output.length, 0);
});

test("relay init creates a runnable project and is idempotent", async () => {
  await inTemporaryProject(async (directory) => {
    const stdout = capture();
    const stderr = capture();
    assert.equal(await runCli(["init"], { cwd: directory, stdout: stdout.stream, stderr: stderr.stream }), 0);
    assert.equal(stderr.output.length, 0);
    assert.match(stdout.output.join(""), /relay start/);

    const registry = loadRegistry(directory, ".relay/events");
    assert.equal(registry.resolve("example.requested", 1).definition.type, "example.requested");
    await assertMatchesExample(directory, "basic", basicPaths);
    const before = await readFile(join(directory, ".relay/handlers/example.md"), "utf8");
    assert.equal(await runCli(["init"], { cwd: directory, stdout: stdout.stream, stderr: stderr.stream }), 0);
    assert.equal(await readFile(join(directory, ".relay/handlers/example.md"), "utf8"), before);
  });
});

test("relay init never overwrites an existing file", async () => {
  await inTemporaryProject(async (directory) => {
    const stderr = capture();
    const path = join(directory, ".relay", "handlers", "example.md");
    await runCli(["init"], { cwd: directory });
    await writeFile(path, "custom instructions\n");

    assert.equal(await runCli(["init"], { cwd: directory, stderr: stderr.stream }), 1);
    assert.match(stderr.output.join(""), /refusing to overwrite/);
    assert.equal(await readFile(path, "utf8"), "custom instructions\n");
  });
});

test("relay init --github creates discovery-ready GitHub configuration", async () => {
  await inTemporaryProject(async (directory) => {
    assert.equal(await runCli(["init", "--github", "owner/repository"], { cwd: directory }), 0);

    const config = await loadGitHubConnectorConfig(join(directory, ".relay/connectors/github.json"), { discover: true });
    assert.deepEqual(config.aggregate, {
      id: "pr-automation-settled-v1",
      emit: { type: "pr.automation.settled", version: 1 },
    });
    const registry = loadRegistry(directory, ".relay/events");
    assert.equal(registry.resolve("pr.automation.completed", 1).definition.type, "pr.automation.completed");
    assert.equal(registry.resolve("pr.automation.settled", 1).definition.type, "pr.automation.settled");
    await assertMatchesExample(directory, "github-pr-automation", [...basicPaths, ...githubPaths]);
  });
});

test("the packed package runs the documented parked agent delivery lifecycle", { timeout: 20_000 }, async () => {
  await inTemporaryProject(async (directory) => {
    const { stdout: packageName } = await exec("npm", ["pack", "--pack-destination", directory, "--silent"], { cwd: projectRoot });
    const prefix = join(directory, "prefix");
    await exec("npm", ["install", "--global", "--prefix", prefix, join(directory, packageName.trim()), "--silent"]);
    const relay = join(prefix, "bin", "relay");
    const { stdout: help, stderr } = await exec(relay, ["--help"]);
    assert.match(help, /relay init/);
    assert.equal(stderr, "");

    const project = join(directory, "project");
    await mkdir(project);
    const { stdout: initialized, stderr: initError } = await exec(relay, ["init"], { cwd: project });
    const server = spawn(relay, ["start", "--port", "0"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    try {
      server.stdout.setEncoding("utf8");
      const [startupChunk] = await once(server.stdout, "data") as [string];
      assert.match(startupChunk, /relay started on/);

      const poll = spawn(relay, [
        "agent",
        "poll",
        "onboarding-agent",
        "--definitions",
        "example.requested@1",
        "--structured-output",
        "--context-tokens",
        "5000",
        "--timeout",
        "5000",
      ], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
      let pollOutput = "";
      let pollError = "";
      poll.stdout.setEncoding("utf8");
      poll.stderr.setEncoding("utf8");
      poll.stdout.on("data", (chunk: string) => { pollOutput += chunk; });
      poll.stderr.on("data", (chunk: string) => { pollError += chunk; });
      const pollExit = once(poll, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
      const { stdout: emitted, stderr: emitError } = await exec(relay, [
        "emit",
        "example.requested",
        "--version",
        "1",
        "--idempotency-key",
        "onboarding-agent-1",
        "--json",
        "{\"message\":\"hello\"}",
      ], { cwd: project });
      assert.equal(emitError, "");
      const event: unknown = JSON.parse(emitted);
      assert(event !== null && typeof event === "object" && "id" in event && typeof event.id === "string");
      const eventId = event.id;

      const [pollCode, pollSignal] = await pollExit;
      assert.equal(pollCode, 0);
      assert.equal(pollSignal, null);
      assert.equal(pollError, "");
      const pollLines = pollOutput.trim().split("\n");
      assert.equal(pollLines.length, 1);
      const delivery: unknown = JSON.parse(pollLines[0] ?? "");
      assert(delivery !== null && typeof delivery === "object" && "event" in delivery && "leaseId" in delivery);
      const deliveryEvent = delivery.event;
      assert(deliveryEvent !== null && typeof deliveryEvent === "object" && "id" in deliveryEvent && typeof deliveryEvent.id === "string");
      assert.equal(deliveryEvent.id, eventId);
      assert(typeof delivery.leaseId === "string");
      const leaseId = delivery.leaseId;

      const runtime: unknown = JSON.parse(await readFile(join(project, ".relay", "runtime.json"), "utf8"));
      assert(runtime !== null && typeof runtime === "object" && "token" in runtime && typeof runtime.token === "string");
      const runtimeToken = runtime.token;
      const leaseDirectory = join(project, ".relay", "agent-leases");
      const leaseFiles = await readdir(leaseDirectory);
      assert.equal(leaseFiles.length, 1);
      const leasePath = join(leaseDirectory, leaseFiles[0] ?? "");
      assert.equal((await stat(leasePath)).mode & 0o777, 0o600);
      const lease: unknown = JSON.parse(await readFile(leasePath, "utf8"));
      assert(lease !== null && typeof lease === "object" && "token" in lease && typeof lease.token === "string" && "leaseId" in lease && typeof lease.leaseId === "string" && "eventId" in lease && typeof lease.eventId === "string");
      assert.equal(lease.leaseId, leaseId);
      assert.equal(lease.eventId, eventId);
      assert.equal(`${pollOutput}${pollError}`.includes(runtimeToken), false);
      assert.equal(`${pollOutput}${pollError}`.includes(lease.token), false);

      const startedReply = await exec(relay, ["agent", "reply", leaseId, "start"], { cwd: project });
      assert.deepEqual(JSON.parse(startedReply.stdout), { ok: true });
      assert.equal(startedReply.stderr, "");
      assert.equal(`${startedReply.stdout}${startedReply.stderr}`.includes(lease.token), false);
      const completed = await exec(relay, [
        "agent",
        "reply",
        leaseId,
        "complete",
        "--json",
        "{\"result\":{\"reply\":\"hello\"},\"effects\":[]}",
      ], { cwd: project });
      assert.deepEqual(JSON.parse(completed.stdout), { ok: true });
      assert.equal(completed.stderr, "");
      assert.equal(`${completed.stdout}${completed.stderr}`.includes(lease.token), false);
      await assert.rejects(readFile(leasePath, "utf8"), { code: "ENOENT" });

      const { stdout: retrieved } = await exec(relay, ["get", eventId], { cwd: project });
      const retrievedEvent: unknown = JSON.parse(retrieved);
      assert(retrievedEvent !== null && typeof retrievedEvent === "object" && "state" in retrievedEvent && "result" in retrievedEvent);
      assert.equal(retrievedEvent.state, "completed");
      assert.deepEqual(retrievedEvent.result, { reply: "hello" });

      const timedOut = await exec(relay, [
        "agent",
        "poll",
        "onboarding-agent",
        "--definitions",
        "example.requested@1",
        "--structured-output",
        "--context-tokens",
        "5000",
        "--timeout",
        "50",
      ], { cwd: project });
      assert.equal(timedOut.stdout, "{\"type\":\"timeout\"}\n");
      assert.equal(timedOut.stderr, "");
      assert.equal([
        initialized,
        initError,
        help,
        stderr,
        emitted,
        emitError,
        pollOutput,
        pollError,
        startedReply.stdout,
        startedReply.stderr,
        completed.stdout,
        completed.stderr,
        retrieved,
        timedOut.stdout,
        timedOut.stderr,
      ].join("").includes(runtimeToken), false);
      assert.equal([
        initialized,
        initError,
        help,
        stderr,
        emitted,
        emitError,
        pollOutput,
        pollError,
        startedReply.stdout,
        startedReply.stderr,
        completed.stdout,
        completed.stderr,
        retrieved,
        timedOut.stdout,
        timedOut.stderr,
      ].join("").includes(lease.token), false);
      const stopped = once(server, "exit");
      const stopResult = await exec(relay, ["stop"], { cwd: project });
      assert.equal(stopResult.stderr, "");
      const [stopCode] = await stopped;
      assert.equal(stopCode, 0);
    } finally {
      if (server.exitCode === null) server.kill("SIGTERM");
    }
  });
});
