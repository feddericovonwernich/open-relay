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
const skillNames = [
  "using-open-relay",
  "setting-up-open-relay",
  "waiting-for-open-relay-events",
  "automating-github-prs-with-open-relay",
  "recovering-open-relay",
] as const;
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
  ".relay/events/pr-ci-settled.v1.json",
  ".relay/events/pr-verification-settled.v1.json",
  ".relay/schemas/pr-automation-completed.json",
  ".relay/schemas/pr-automation-settled.json",
  ".relay/schemas/pr-automation-result.json",
  ".relay/schemas/pr-ci-settled.json",
  ".relay/schemas/pr-verification-settled.json",
  ".relay/schemas/notification-delivered.json",
  ".relay/handlers/pr-automation-completed.md",
  ".relay/handlers/pr-automation-settled.md",
  ".relay/handlers/pr-ci-settled.md",
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

function mutatePath(value: unknown, path: readonly (string | number)[], replacement: unknown): unknown {
  const copy = structuredClone(value) as Record<string | number, any>;
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, any>;
  target[path[path.length - 1]] = replacement;
  return copy;
}

function removePath(value: unknown, path: readonly (string | number)[]): unknown {
  const copy = structuredClone(value) as Record<string | number, any>;
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, any>;
  delete target[path[path.length - 1]];
  return copy;
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
    assert.deepEqual(config.repositories, [{ name: "owner/repository", mode: "configured-tools" }]);
    assert.deepEqual(config.aggregate, {
      id: "pr-automation-settled-v1",
      emit: { type: "pr.automation.settled", version: 1 },
    });
    assert.equal(config.verification, undefined);
    const registry = loadRegistry(directory, ".relay/events");
    assert.equal(registry.resolve("pr.automation.completed", 1).definition.type, "pr.automation.completed");
    assert.equal(registry.resolve("pr.automation.settled", 1).definition.type, "pr.automation.settled");
    assert.equal(registry.resolve("pr.ci.settled", 1).definition.type, "pr.ci.settled");
    const verification = registry.resolve("pr.verification.settled", 1);
    assert.deepEqual(verification.definition.handler, { kind: "notification" });
    assert.equal(verification.definition.requires.maxPayloadBytes, 65_536);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, ".relay/schemas/notification-delivered.json"), "utf8")),
      {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { delivered: { const: true } },
        required: ["delivered"],
        additionalProperties: false,
      },
    );
    await assert.rejects(stat(join(directory, ".relay/handlers/pr-verification-settled.md")), { code: "ENOENT" });

    const validPayload = {
      schemaVersion: 1,
      provider: "github",
      repository: { id: 7, fullName: "owner/repository" },
      pullRequest: {
        number: 12,
        url: "https://github.com/owner/repository/pull/12",
        headSha: "head-1",
        baseRef: "main",
      },
      verdict: "action_required",
      automation: {
        artifacts: [{
          triggerId: "cursor-bugbot-completed-v1",
          provider: "cursor-bugbot",
          kind: "check_run",
          id: "2",
          name: "Cursor Bugbot",
          completion: "completed",
          conclusion: null,
          completedAt: "2026-09-08T01:00:00Z",
          detailsUrl: null,
        }],
      },
      ci: {
        outcome: "success",
        checks: [{
          id: "2",
          name: "build",
          conclusion: null,
          completedAt: "2026-09-08T01:00:00Z",
          detailsUrl: null,
        }],
        failingCheckNames: [],
      },
      reviews: {
        unresolvedCount: 1,
        includedCount: 1,
        totalReplyCount: 2,
        truncated: false,
        evidenceDigest: "0".repeat(64),
        findings: [{
          provider: "cursor-bugbot",
          threadId: "thread-1",
          rootCommentId: "comment-1",
          authorLogin: "bugbot[bot]",
          url: "https://github.com/owner/repository/pull/12#discussion_r1",
          path: "src/app.ts",
          startLine: null,
          line: 10,
          isOutdated: false,
          body: "Please fix this.",
          bodyTruncated: false,
          replyCount: 2,
        }],
      },
      actions: [
        {
          code: "investigate_ci_failures",
          checkNames: ["build"],
          message: "Investigate the failed CI checks. Fix failures caused by the change when possible. Otherwise report the cause and why it could not be fixed automatically.",
        },
        {
          code: "resolve_review_findings",
          providers: ["cursor-bugbot"],
          findingCount: 1,
          message: "Review the unresolved Bugbot/Copilot comments. If a finding is valid, implement a fix. In every case, reply with the result and resolve the thread when addressed.",
        },
        {
          code: "verify_review_result",
          provider: "cursor-bugbot",
          checkName: "Cursor Bugbot",
          message: "Verify the completed neutral Bugbot result. Confirm whether the run contains findings, cancellation, or an internal error before treating the review as successful.",
        },
      ],
    };
    assert.equal(verification.validateInput(validPayload), true);
    assert.equal(verification.validateOutput({ delivered: true }), true);

    const requiredPaths: ReadonlyArray<readonly (string | number)[]> = [
      ["schemaVersion"], ["provider"], ["repository"], ["pullRequest"], ["verdict"], ["automation"], ["ci"], ["reviews"], ["actions"],
      ["repository", "id"], ["repository", "fullName"],
      ["pullRequest", "number"], ["pullRequest", "url"], ["pullRequest", "headSha"], ["pullRequest", "baseRef"],
      ["automation", "artifacts", 0, "triggerId"], ["automation", "artifacts", 0, "provider"],
      ["automation", "artifacts", 0, "kind"], ["automation", "artifacts", 0, "id"],
      ["automation", "artifacts", 0, "name"], ["automation", "artifacts", 0, "completion"],
      ["automation", "artifacts", 0, "conclusion"], ["automation", "artifacts", 0, "completedAt"],
      ["automation", "artifacts", 0, "detailsUrl"],
      ["ci", "outcome"], ["ci", "checks", 0, "id"], ["ci", "checks", 0, "name"],
      ["ci", "checks", 0, "conclusion"], ["ci", "checks", 0, "completedAt"], ["ci", "checks", 0, "detailsUrl"],
      ["ci", "failingCheckNames"],
      ["reviews", "unresolvedCount"], ["reviews", "includedCount"], ["reviews", "totalReplyCount"],
      ["reviews", "truncated"], ["reviews", "evidenceDigest"], ["reviews", "findings"],
      ["reviews", "findings", 0, "provider"], ["reviews", "findings", 0, "threadId"],
      ["reviews", "findings", 0, "rootCommentId"], ["reviews", "findings", 0, "authorLogin"],
      ["reviews", "findings", 0, "url"], ["reviews", "findings", 0, "path"],
      ["reviews", "findings", 0, "startLine"], ["reviews", "findings", 0, "line"],
      ["reviews", "findings", 0, "isOutdated"], ["reviews", "findings", 0, "body"],
      ["reviews", "findings", 0, "bodyTruncated"], ["reviews", "findings", 0, "replyCount"],
      ["actions", 0, "code"], ["actions", 0, "checkNames"], ["actions", 0, "message"],
      ["actions", 1, "code"], ["actions", 1, "providers"], ["actions", 1, "findingCount"], ["actions", 1, "message"],
      ["actions", 2, "code"], ["actions", 2, "provider"], ["actions", 2, "checkName"], ["actions", 2, "message"],
    ];
    for (const path of requiredPaths) {
      assert.equal(verification.validateInput(removePath(validPayload, path)), false, `required ${path.join(".")}`);
    }

    const closedObjectCases: ReadonlyArray<readonly (string | number)[]> = [
      ["repository"], ["pullRequest"], ["automation"], ["automation", "artifacts", 0],
      ["ci"], ["ci", "checks", 0], ["reviews"], ["reviews", "findings", 0],
      ["actions", 0], ["actions", 1], ["actions", 2],
    ];
    for (const path of closedObjectCases) {
      assert.equal(
        verification.validateInput(mutatePath(validPayload, path.concat("unexpected"), true)),
        false,
        `closed ${path.join(".")}`,
      );
    }
    assert.equal(verification.validateInput(mutatePath(validPayload, ["unexpected"], true)), false, "closed root");

    const enumCases: ReadonlyArray<readonly [(string | number)[], unknown]> = [
      [["provider"], "gitlab"],
      [["verdict"], "blocked"],
      [["automation", "artifacts", 0, "kind"], "workflow"],
      [["automation", "artifacts", 0, "completion"], "queued"],
      [["reviews", "findings", 0, "provider"], "human"],
      [["actions", 0, "code"], "other"],
      [["actions", 0, "message"], "other"],
      [["actions", 1, "providers", 0], "other"],
      [["actions", 1, "code"], "other"],
      [["actions", 2, "provider"], "copilot-review"],
      [["actions", 2, "code"], "other"],
      [["actions", 2, "message"], "other"],
    ];
    for (const [path, replacement] of enumCases) {
      assert.equal(verification.validateInput(mutatePath(validPayload, path, replacement)), false, `enum ${path.join(".")}`);
    }
    assert.equal(verification.validateInput(mutatePath(validPayload, ["automation", "artifacts", 0, "detailsUrl"], 42)), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["ci", "checks", 0, "conclusion"], 42)), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["reviews", "findings", 0, "startLine"], "10")), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["reviews", "findings", 0, "line"], "10")), false);

    for (const [path, replacement] of [
      [["reviews", "unresolvedCount"], -1],
      [["reviews", "includedCount"], -1],
      [["reviews", "totalReplyCount"], -1],
      [["reviews", "findings", 0, "replyCount"], -1],
      [["actions", 1, "findingCount"], -1],
    ] as const) {
      assert.equal(verification.validateInput(mutatePath(validPayload, path, replacement)), false, `minimum ${path.join(".")}`);
    }
    assert.equal(verification.validateInput(mutatePath(validPayload, ["reviews", "findings", 0, "body"], "x".repeat(2_001))), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["reviews", "evidenceDigest"], "0".repeat(63))), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["reviews", "evidenceDigest"], "G".repeat(64))), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["automation", "artifacts"], [])), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["ci", "checks"], [])), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["reviews", "findings"], Array.from({ length: 21 }, () => validPayload.reviews.findings[0]))), false);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["reviews", "findings"], [])), true);
    assert.equal(verification.validateInput(mutatePath(validPayload, ["actions"], [])), true);
    await assertMatchesExample(directory, "github-pr-automation", [...basicPaths, ...githubPaths]);
  });
});

test("the packed package runs the documented parked agent delivery lifecycle", { timeout: 40_000 }, async () => {
  await inTemporaryProject(async (directory) => {
    const { stdout: packageName } = await exec("npm", ["pack", "--pack-destination", directory, "--silent"], { cwd: projectRoot });
    const prefix = join(directory, "prefix");
    const home = join(directory, "home");
    const installEnvironment = {
      ...process.env,
      HOME: home,
      npm_config_cache: join(directory, "npm-cache"),
    };
    await mkdir(home);
    await exec("npm", ["install", "--global", "--prefix", prefix, join(directory, packageName.trim()), "--silent"], {
      env: installEnvironment,
    });
    const relay = join(prefix, "bin", "relay");
    const { stdout: help, stderr } = await exec(relay, ["--help"]);
    assert.match(help, /relay init/);
    assert.equal(stderr, "");
    const installedSkillsRoot = join(home, ".agents", "skills");
    const installedSkillContents: Record<string, string> = {};
    for (const name of skillNames) {
      const contents = await readFile(join(installedSkillsRoot, name, "SKILL.md"), "utf8");
      installedSkillContents[name] = contents;
      assert.equal(contents, await readFile(join(projectRoot, "skills", name, "SKILL.md"), "utf8"), name);
    }
    const manifestContents = await readFile(join(installedSkillsRoot, ".open-relay-manifest.json"), "utf8");
    const skillManifest = JSON.parse(manifestContents) as {
      schemaVersion: number;
      skills: Record<string, { sha256: string }>;
      skipped: Record<string, unknown>;
    };
    assert.equal(skillManifest.schemaVersion, 1);
    assert.deepEqual(Object.keys(skillManifest.skills).sort(), [...skillNames].sort());
    assert.deepEqual(skillManifest.skipped, {});
    await exec("npm", ["install", "--global", "--prefix", prefix, join(directory, packageName.trim()), "--silent"], {
      env: installEnvironment,
    });
    for (const name of skillNames) {
      assert.equal(await readFile(join(installedSkillsRoot, name, "SKILL.md"), "utf8"), installedSkillContents[name], name);
    }
    const secondManifestContents = await readFile(join(installedSkillsRoot, ".open-relay-manifest.json"), "utf8");
    assert.equal(secondManifestContents, manifestContents);
    const secondSkillManifest = JSON.parse(secondManifestContents) as typeof skillManifest;
    assert.deepEqual(Object.keys(secondSkillManifest.skills).sort(), [...skillNames].sort());
    assert.equal(secondSkillManifest.schemaVersion, 1);
    assert.deepEqual(secondSkillManifest.skipped, {});

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
