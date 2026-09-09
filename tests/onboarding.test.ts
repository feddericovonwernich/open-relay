import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  ".relay/schemas/pr-automation-completed.json",
  ".relay/schemas/pr-automation-result.json",
  ".relay/handlers/pr-automation-completed.md",
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
    assert.deepEqual(config.repositories, ["owner/repository"]);
    assert.deepEqual(config.triggers.map(({ recognizer }) => recognizer), ["sonarqube", "copilot-review", "cursor-bugbot"]);
    assert.equal(config.triggers.some((trigger) => "appIds" in trigger.match && trigger.match.appIds.length === 0), true);

    const registry = loadRegistry(directory, ".relay/events");
    assert.equal(registry.resolve("pr.automation.completed", 1).definition.type, "pr.automation.completed");
    await assertMatchesExample(directory, "github-pr-automation", [...basicPaths, ...githubPaths]);
  });
});

test("the packed package runs the documented init, start, emit, get, and stop flow", { timeout: 20_000 }, async () => {
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
    await exec(relay, ["init"], { cwd: project });
    const server = spawn(relay, ["start", "--port", "0"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
    let serverOutput = "";
    try {
      await new Promise<void>((resolveStarted, reject) => {
        server.stdout.setEncoding("utf8");
        server.stdout.on("data", (chunk: string) => {
          serverOutput += chunk;
          if (serverOutput.includes("relay started on")) resolveStarted();
        });
        server.once("error", reject);
        server.once("exit", (code) => reject(new Error(`relay exited before startup with ${code}`)));
      });
      const { stdout: emitted } = await exec(relay, [
        "emit",
        "example.requested",
        "--version",
        "1",
        "--idempotency-key",
        "onboarding-1",
        "--json",
        "{\"message\":\"hello\"}",
      ], { cwd: project });
      const event: unknown = JSON.parse(emitted);
      assert(event !== null && typeof event === "object" && "id" in event && typeof event.id === "string");
      const eventId = event.id;
      const { stdout: retrieved } = await exec(relay, ["get", eventId], { cwd: project });
      const retrievedEvent: unknown = JSON.parse(retrieved);
      assert(retrievedEvent !== null && typeof retrievedEvent === "object" && "id" in retrievedEvent);
      assert.equal(retrievedEvent.id, eventId);

      const stopped = once(server, "exit");
      await exec(relay, ["stop"], { cwd: project });
      const [exitCode] = await stopped;
      assert.equal(exitCode, 0);
    } finally {
      if (server.exitCode === null) server.kill("SIGTERM");
    }
  });
});
