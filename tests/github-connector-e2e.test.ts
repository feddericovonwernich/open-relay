import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CredentialStore } from "../src/auth.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { loadRegistry } from "../src/registry.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { openStore, type Store } from "../src/store.ts";
import { GitHubClient } from "../src/connectors/github/client.ts";
import { GitHubRelayEmitter } from "../src/connectors/github/emitter.ts";
import { runGitHubConnector } from "../src/connectors/github/runner.ts";
import { runCli } from "../src/cli.ts";
import type { GitHubConnectorConfig } from "../src/connectors/github/types.ts";

const repo = "octo/repo";
const eventType = "pr.automation.completed";
const secret = "github-test-token";

function pr(number: number, state: "open" | "closed", sha: string, updated = "2026-09-08T00:00:00Z"): Record<string, unknown> {
  return { number, html_url: `https://github.com/${repo}/pull/${number}`, head: { sha }, base: { ref: "main", repo: { id: 42, full_name: repo } }, state, updated_at: updated };
}

function check(id: number, name: string, sha: string, appId: number, slug: string, conclusion: string | null = "success"): Record<string, unknown> {
  return { id, name, status: "completed", conclusion, head_sha: sha, completed_at: "2026-09-08T01:00:00Z", details_url: `https://github.test/check/${id}`, app: { id: appId, slug }, pull_requests: [{ number: 1 }] };
}

function review(id: number, sha: string): Record<string, unknown> {
  return { id, user: { id: 77, login: "github-copilot[bot]", type: "Bot", html_url: "https://github.com/apps/copilot" }, commit_id: sha, submitted_at: "2026-09-08T01:00:00Z", html_url: `https://github.test/review/${id}` };
}

interface RelayHarness {
  root: string;
  store: Store;
  server: RelayServer;
  base: string;
  close(): Promise<void>;
}

async function relayHarness(): Promise<RelayHarness> {
  const root = await mkdtemp(join(tmpdir(), "relay-github-e2e-"));
  await mkdir(join(root, "events"), { recursive: true });
  await mkdir(join(root, "schemas"), { recursive: true });
  await mkdir(join(root, "handlers"), { recursive: true });
  await writeFile(join(root, "handlers", "completion.md"), "completion");
  await writeFile(join(root, "schemas", "payload.json"), JSON.stringify({ type: "object", additionalProperties: true }));
  await writeFile(join(root, "schemas", "result.json"), JSON.stringify({ type: "object", additionalProperties: true }));
  await writeFile(join(root, "schemas", "settled-result.json"), JSON.stringify({
    type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false,
  }));
  const eventDefinition = {
    inputSchema: "schemas/payload.json", effectPolicy: "retry-safe", timeoutMs: 1000, hardDeadlineMs: 2000,
    retry: { maxAttempts: 1, backoffMs: [], retryableCodes: [] },
    requires: { tools: [], structuredOutput: true, minContextTokens: 0, maxInputTokens: 4000, maxOutputTokens: 1000, maxPayloadBytes: 65536 },
    handler: { kind: "agent", instructions: "handlers/completion.md" },
  };
  await writeFile(join(root, "events", "pr-automation.v1.json"), JSON.stringify({
    type: eventType, version: 1, outputSchema: "schemas/result.json", ...eventDefinition,
  }));
  await writeFile(join(root, "events", "pr-automation-settled.v1.json"), JSON.stringify({
    type: "pr.automation.settled", version: 1, outputSchema: "schemas/settled-result.json", ...eventDefinition,
  }));
  const registry = loadRegistry(root, "events");
  const store = openStore(join(root, "relay.sqlite"));
  store.installRevisions(registry.revisions());
  const credentials = new CredentialStore();
  const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: 20 });
  const server = createRelayServer({ store, registry, credentials, dispatcher, projectRoot: root, definitionsDir: "events", closeStore: false }) as RelayServer;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    root, store, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

function config(apiBaseUrl: string, emitType = eventType): GitHubConnectorConfig {
  return {
    connector: "github" as const, apiBaseUrl, apiVersion: "2026-03-10", tokenEnv: "GITHUB_TOKEN",
    pollIntervalMs: 5000, lookbackHours: 720, repositories: [{ name: repo, mode: "configured-tools" }],
    triggers: [
      { id: "sonar", recognizer: "sonarqube" as const, match: { checkNames: ["SonarQube Quality Gate"], appIds: [11], appSlugs: ["sonarqube"] }, emit: { type: emitType, version: 1 } },
      { id: "copilot", recognizer: "copilot-review" as const, match: { userIds: [77], appUrls: ["https://github.com/apps/copilot"], logins: ["github-copilot"] }, emit: { type: emitType, version: 1 } },
      { id: "bugbot", recognizer: "cursor-bugbot" as const, match: { checkNames: ["Cursor Bugbot"], appIds: [22], appSlugs: ["cursor"] }, emit: { type: emitType, version: 1 } },
    ],
  };
}

async function githubHarness(): Promise<{ github: FakeGitHubServer; heads: { current: string; staleOnVerify: boolean; outageCandidate: boolean }; client: GitHubClient }> {
  const heads = { current: "sha-1", staleOnVerify: false, outageCandidate: false };
  const openPath = `/repos/${repo}/pulls?state=open&per_page=100`;
  const closedPath = `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
  const scripts: Record<string, ReturnType<typeof json> | ((request: { headers: Record<string, string | string[] | undefined> }, count: number) => ReturnType<typeof json>)> = {
    [openPath]: (request) => {
      if (request.headers["if-none-match"] === "open-1" && heads.current === "sha-1") return { status: 304, headers: { etag: "open-1" } };
      return json([pr(1, "open", heads.current), pr(2, "open", "sha-2", "2020-01-01T00:00:00Z")], { etag: heads.current === "sha-1" ? "open-1" : "open-2" });
    },
    [closedPath]: json([pr(3, "closed", "sha-3"), pr(4, "closed", "sha-4", "2020-01-01T00:00:00Z")], { etag: "closed-1" }),
    [`/repos/${repo}/commits/sha-1/check-runs?status=completed&filter=all&per_page=100`]: json({ total_count: 2, check_runs: [check(101, "SonarQube Quality Gate", "sha-1", 11, "sonarqube"), check(102, "Cursor Bugbot", "sha-1", 22, "cursor", "neutral")] }),
    [`/repos/${repo}/pulls/1/reviews?per_page=100`]: json([review(201, "sha-1")]),
    [`/repos/${repo}/commits/sha-2/check-runs?status=completed&filter=all&per_page=100`]: () => json({
      total_count: heads.outageCandidate ? 2 : 1,
      check_runs: [
        check(301, "SonarQube Quality Gate", "sha-2", 11, "sonarqube"),
        ...(heads.outageCandidate ? [check(302, "SonarQube Quality Gate", "sha-2", 11, "sonarqube")] : []),
      ],
    }),
    [`/repos/${repo}/commits/sha-4/check-runs?status=completed&filter=all&per_page=100`]: json({ total_count: 1, check_runs: [check(401, "SonarQube Quality Gate", "sha-4", 11, "sonarqube")] }),
    [`/repos/${repo}/pulls/1/reviews?per_page=100&page=2`]: json([]),
    [`/repos/${repo}/commits/sha-3/check-runs?status=completed&filter=all&per_page=100`]: json({ total_count: 0, check_runs: [] }),
    [`/repos/${repo}/pulls/3/reviews?per_page=100`]: json([]),
    [`/repos/${repo}/pulls/4/reviews?per_page=100`]: json([]),
    [`/repos/${repo}/pulls/2/reviews?per_page=100`]: json([]),
    [`/repos/${repo}/pulls/1`]: (request, count) => {
      if (heads.staleOnVerify && count === 0) heads.current = "sha-2";
      return json(pr(1, "open", heads.current));
    },
    [`/repos/${repo}/pulls/2`]: json(pr(2, "open", "sha-2", "2020-01-01T00:00:00Z")),
    [`/repos/${repo}/pulls/3`]: json(pr(3, "closed", "sha-3")),
    [`/repos/${repo}/pulls/4`]: json(pr(4, "closed", "sha-4", "2020-01-01T00:00:00Z")),
  };
  const github = await fakeGitHubServer(scripts);
  return { github, heads, client: new GitHubClient({ baseUrl: github.url, apiVersion: "2026-03-10", token: secret }) };
}


test("real fake GitHub and real Relay reconcile all providers and replay after restart", async () => {
  const relay = await relayHarness();
  const { github, client } = await githubHarness();
  try {
    const cfg = config(github.url);
    const emitter = new GitHubRelayEmitter({ baseUrl: relay.base, adminToken: relay.server.adminToken });
    const first = await runGitHubConnector({ config: cfg, client, emitter, once: true });
    assert.equal(first.emitted, 3);
    assert.equal(first.replayed, 0);
    assert.equal(relay.store.countEvents(), 3);
    const events = relay.store.snapshotAtHighWater().snapshot.events;
    const normalized = events.map((event) => event.payload as Record<string, unknown>);
    assert.deepEqual(normalized.map((payload) => (payload.artifact as Record<string, unknown>).id).sort(), ["101", "102", "201"]);
    assert.deepEqual(normalized.map((payload) => payload.provider).sort(), ["copilot-review", "cursor-bugbot", "sonarqube"]);
    assert.deepEqual(normalized.map((payload) => (payload.artifact as Record<string, unknown>).conclusion).sort(), ["neutral", "submitted", "success"]);
    for (const event of events) {
      assert.equal(event.producerId, "connector:github:42");
      assert.match(event.idempotencyKey, /^github:42:(sonar|copilot|bugbot):(check_run|pull_request_review):(101|102|201)$/);
    }
    for (const payload of normalized) {
      assert.deepEqual(Object.keys(payload).sort(), ["artifact", "provider", "pullRequest", "repository", "schemaVersion"]);
      assert.equal(JSON.stringify(payload).includes("source"), false);
      assert.equal(JSON.stringify(payload).includes("body"), false);
      assert.equal(JSON.stringify(payload).includes(secret), false);
    }
    const cached = await runGitHubConnector({ config: cfg, client, emitter, once: true });
    assert.equal(cached.emitted, 0);
    assert.equal(cached.replayed, 3);
    assert.ok(github.requests.some((request) => request.url === `/repos/${repo}/pulls?state=open&per_page=100` && request.headers["if-none-match"] === "open-1"));
    assert.ok(github.count(`/repos/${repo}/commits/sha-1/check-runs?status=completed&filter=all&per_page=100`) >= 2);
    const replay = await runGitHubConnector({ config: cfg, client: new GitHubClient({ baseUrl: github.url, apiVersion: "2026-03-10", token: secret }), emitter: new GitHubRelayEmitter({ baseUrl: relay.base, adminToken: relay.server.adminToken }), once: true });
    assert.equal(replay.emitted, 0);
    assert.equal(replay.replayed, 3);
    assert.equal(relay.store.countEvents(), 3);
    assert.ok(github.count(`/repos/${repo}/pulls?state=open&per_page=100`) >= 3);
    assert.ok(github.count(`/repos/${repo}/commits/sha-2/check-runs?status=completed&filter=all&per_page=100`) >= 1, "old open PR is polled");
    assert.ok(github.count(`/repos/${repo}/commits/sha-3/check-runs?status=completed&filter=all&per_page=100`) >= 1, "recent closed PR is polled");
    assert.equal(github.count(`/repos/${repo}/commits/sha-4/check-runs?status=completed&filter=all&per_page=100`), 0, "old closed PR checks are not polled");
    assert.equal(github.count(`/repos/${repo}/pulls/4/reviews?per_page=100`), 0, "old closed PR reviews are not polled");
    assert.equal(github.count(`/repos/${repo}/pulls/4`), 0, "old closed PR head is not fetched");
  } finally { await github.close(); await relay.close(); }
});

test("targeted continuous GitHub watch settles one PR and parks a correlation-filtered worker", async () => {
  const relay = await relayHarness();
  let cycle = 0;
  const targetedCheck = (id: number, name: string, conclusion: string | null = "success") => ({
    ...check(id, name, "sha-197", name === "SonarQube Quality Gate" ? 11 : 22, name === "SonarQube Quality Gate" ? "sonarqube" : "cursor", conclusion),
    pull_requests: [{ number: 197 }],
  });
  const scripts: Record<string, FakeGitHubScript> = {
    [`/repos/${repo}/pulls/197`]: json(pr(197, "open", "sha-197")),
    [`/repos/${repo}/commits/sha-197/check-runs?status=completed&filter=all&per_page=100`]: () => json({
      total_count: cycle < 1 ? 1 : 2,
      check_runs: [targetedCheck(1971, "SonarQube Quality Gate"), ...(cycle < 1 ? [] : [targetedCheck(1972, "Cursor Bugbot", "failure")])],
    }),
    [`/repos/${repo}/pulls/197/reviews?per_page=100`]: () => json(cycle < 1 ? [] : [review(1973, "sha-197")]),
  };
  const github = await fakeGitHubServer(scripts);
  try {
    const emitter = new GitHubRelayEmitter({ baseUrl: relay.base, adminToken: relay.server.adminToken });
    const snapshot = {
      repository: { id: 42, fullName: repo },
      pullRequest: { number: 100, url: `https://github.com/${repo}/pull/100`, headSha: "sha-100", baseRef: "main", updatedAt: "2026-09-08T00:00:00Z" },
      checkRuns: [], reviews: [],
    } as const;
    const prequeuedCandidate = {
      provider: "sonarqube", triggerId: "sonar", repositoryId: 42, pullRequestNumber: 100,
      artifactKind: "check_run" as const, artifactId: "1001", artifactHeadSha: "sha-100",
      artifact: { name: "SonarQube Quality Gate", completion: "completed" as const, conclusion: "success", completedAt: "2026-09-08T01:00:00Z", detailsUrl: null },
    };
    await emitter.emitAggregate(
      { id: "pr-automation-settled-v1", emit: { type: "pr.automation.settled", version: 1 } },
      snapshot,
      [prequeuedCandidate],
    );
    const targeted = {
      ...config(github.url),
      aggregate: { id: "pr-automation-settled-v1", emit: { type: "pr.automation.settled", version: 1 } },
    };
    const controller = new AbortController();
    const result = await runGitHubConnector({
      config: targeted, client: new GitHubClient({ baseUrl: github.url, apiVersion: "2026-03-10", token: secret }),
      emitter, pullRequestNumber: 197, signal: controller.signal,
      sleep: async () => { cycle += 1; if (cycle >= 2) controller.abort(); },
    });
    assert.equal(cycle, 2);
    assert.equal(result.emitted, 4);
    const allEvents = relay.store.snapshotAtHighWater().snapshot.events;
    const settledEvents = allEvents.filter((event) => event.type === "pr.automation.settled");
    assert.equal(settledEvents.length, 2);
    assert.deepEqual(settledEvents.map((event) => event.correlationId).sort(), ["github:octo/repo:pull-request:100", "github:octo/repo:pull-request:197"]);
    const targetedEvents = allEvents.filter((event) => event.correlationId === "github:octo/repo:pull-request:197");
    assert.equal(targetedEvents.length, 4);
    assert.equal(targetedEvents.every((event) => event.correlationId === "github:octo/repo:pull-request:197"), true);
    const settled = settledEvents.find((event) => event.correlationId === "github:octo/repo:pull-request:197");
    assert.equal(settled?.correlationId, "github:octo/repo:pull-request:197");
    assert.equal(github.count(`/repos/${repo}/pulls/100`), 0);

    const registration = await fetch(`${relay.base}/v1/workers/register`, {
      method: "POST", headers: { Authorization: `Bearer ${relay.server.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "pr-197-agent", allowedDefinitions: ["pr.automation.settled@1"], tools: [],
        structuredOutput: true, contextTokens: 5000, systemReserveTokens: 0, maxConcurrent: 1,
        correlationId: "github:octo/repo:pull-request:197",
      }),
    });
    assert.equal(registration.status, 201);
    const worker = (await registration.json()) as { token: string };
    const polled = await fetch(`${relay.base}/v1/agent/poll`, { method: "POST", headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(polled.status, 200);
    const delivery = await polled.json() as { leaseId: string; outputSchema: { required?: string[] }; event: { correlationId?: string } };
    assert.equal(delivery.event.correlationId, "github:octo/repo:pull-request:197");
    assert.deepEqual(delivery.outputSchema.required, ["summary"]);
    const invalid = await fetch(`${relay.base}/v1/deliveries/${encodeURIComponent(delivery.leaseId)}/complete`, {
      method: "POST", headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ result: { status: "processed" }, effects: [] }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: { code: "invalid_output", message: "result does not match pr.automation.settled@1" } });
    const corrected = await fetch(`${relay.base}/v1/deliveries/${encodeURIComponent(delivery.leaseId)}/complete`, {
      method: "POST", headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ result: { summary: "PR 197 automation settled" }, effects: [] }),
    });
    assert.equal(corrected.status, 200);

    const replay = await runGitHubConnector({
      config: targeted, client: new GitHubClient({ baseUrl: github.url, apiVersion: "2026-03-10", token: secret }),
      emitter: new GitHubRelayEmitter({ baseUrl: relay.base, adminToken: relay.server.adminToken }), pullRequestNumber: 197, once: true,
    });
    assert.equal(replay.emitted, 0);
    assert.equal(replay.replayed, 4);
    assert.equal(relay.store.countEvents(), 5);
  } finally {
    await github.close();
    await relay.close();
  }
});

test("stale head, Relay outage recovery, and trigger drift isolate candidates", async () => {
  const relay = await relayHarness();
  const fixture = await githubHarness();
  try {
    const cfg = config(fixture.github.url);
    fixture.heads.staleOnVerify = true;
    const stale = await runGitHubConnector({ config: cfg, client: fixture.client, emitter: new GitHubRelayEmitter({ baseUrl: relay.base, adminToken: relay.server.adminToken }), once: true });
    assert.equal(stale.emitted, 0);
    assert.equal(stale.stale, 3);
    fixture.heads.staleOnVerify = false;
    const recovered = await runGitHubConnector({ config: cfg, client: new GitHubClient({ baseUrl: fixture.github.url, apiVersion: "2026-03-10", token: secret }), emitter: new GitHubRelayEmitter({ baseUrl: relay.base, adminToken: relay.server.adminToken }), once: true });
    assert.equal(recovered.emitted, 1);
    assert.equal(relay.store.countEvents(), 1);
    fixture.heads.outageCandidate = true;
    const outage = await runGitHubConnector({ config: cfg, client: new GitHubClient({ baseUrl: fixture.github.url, apiVersion: "2026-03-10", token: secret }), emitter: new GitHubRelayEmitter({ baseUrl: "http://127.0.0.1:1", adminToken: "relay-secret" }), once: true });
    assert.equal(outage.emitted, 0);
    assert.equal(relay.store.countEvents(), 1, "Relay outage must not accept the first-seen candidate");
    assert.equal(relay.store.snapshotAtHighWater().snapshot.events.some((event) => String((event.payload as Record<string, unknown>).artifact && ((event.payload as Record<string, unknown>).artifact as Record<string, unknown>).id) === "302"), false);
    const outageRecovery = await runGitHubConnector({ config: cfg, client: fixture.client, emitter: new GitHubRelayEmitter({ baseUrl: relay.base, adminToken: relay.server.adminToken }), once: true });
    assert.equal(outageRecovery.emitted, 1, "first-seen candidate emits once after Relay recovery");
    assert.equal(outageRecovery.replayed, 1);
    assert.equal(relay.store.countEvents(), 2);
    const recoveredIds = relay.store.snapshotAtHighWater().snapshot.events.map((event) => String(((event.payload as Record<string, unknown>).artifact as Record<string, unknown>).id)).sort();
    assert.deepEqual(recoveredIds, ["301", "302"]);
    fixture.heads.outageCandidate = false;
    fixture.heads.current = "sha-1";
    const driftConfig = { ...cfg, triggers: [{ ...cfg.triggers[0], id: "bad", emit: { type: "missing.event", version: 1 } }, cfg.triggers[1], cfg.triggers[2]] };
    const drift = await runGitHubConnector({ config: driftConfig, client: fixture.client, emitter: new GitHubRelayEmitter({ baseUrl: relay.base, adminToken: relay.server.adminToken }), once: true });
    assert.ok(drift.errors.some((error) => error.startsWith("trigger_invalid:")));
    assert.ok(drift.replayed + drift.emitted >= 2, "sibling triggers continue after drift");
  } finally { await fixture.github.close(); await relay.close(); }
});

test("CLI discovery and once output are redacted", async () => {
  const relay = await relayHarness();
  const fixture = await githubHarness();
  const configPath = join(relay.root, "github.json");
  const oldToken = process.env.GITHUB_TOKEN;
  const oldNodeEnv = process.env.NODE_ENV;
  try {
    await writeFile(configPath, JSON.stringify(config(fixture.github.url)));
    process.env.GITHUB_TOKEN = secret;
    process.env.NODE_ENV = "test";
    const discoverOutput: string[] = [];
    const discoverErrors: string[] = [];
    const discoverCode = await runCli(["connect", "github", "--config", configPath, "--once", "--discover"], { cwd: relay.root, stdout: { write: (value) => discoverOutput.push(value) }, stderr: { write: (value) => discoverErrors.push(value) } });
    assert.equal(discoverCode, 0, discoverErrors.join(""));
    assert.ok(discoverOutput.some((line) => line.includes("SonarQube Quality Gate")));
    assert.ok(discoverOutput.some((line) => line.includes("github-copilot")));
    const onceOutput: string[] = [];
    assert.equal(await runCli(["connect", "github", "--config", configPath, "--once"], { cwd: relay.root, stdout: { write: (value) => onceOutput.push(value) } }), 0);
    assert.equal(relay.store.countEvents(), 3);
    assert.equal(onceOutput.length, 1);
    assert.equal(onceOutput[0]?.includes(secret), false);
    assert.equal(onceOutput[0]?.includes("relay-secret"), false);
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = oldToken;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    await fixture.github.close(); await relay.close();
  }
});
test("CLI validates Relay admin access before polling zero candidates", async () => {
  const relay = await relayHarness();
  const github = await fakeGitHubServer({
    [`/repos/${repo}/pulls?state=open&per_page=100`]: json([]),
    [`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`]: json([]),
  });
  const configPath = join(relay.root, "github-empty.json");
  const oldToken = process.env.GITHUB_TOKEN;
  const oldNodeEnv = process.env.NODE_ENV;
  try {
    await writeFile(configPath, JSON.stringify(config(github.url)));
    await writeFile(join(relay.root, ".relay", "runtime.json"), JSON.stringify({ port: (relay.server.address() as { port: number }).port, token: "stale-admin-token" }));
    process.env.GITHUB_TOKEN = secret;
    process.env.NODE_ENV = "test";
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runCli(["connect", "github", "--config", configPath, "--once"], {
      cwd: relay.root,
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
    });
    assert.equal(code, 1);
    assert.equal(github.requests.length, 0);
    assert.equal(output.length, 0);
    assert.equal(errors.join("").includes("stale-admin-token"), false);
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = oldToken;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    await github.close();
    await relay.close();
  }
});

test("CLI fails quickly when Relay is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-github-unavailable-"));
  await mkdir(join(root, ".relay"), { recursive: true });
  const configPath = join(root, "github.json");
  const oldToken = process.env.GITHUB_TOKEN;
  const oldNodeEnv = process.env.NODE_ENV;
  try {
    await writeFile(configPath, JSON.stringify(config("http://127.0.0.1:1")));
    await writeFile(join(root, ".relay", "runtime.json"), JSON.stringify({ port: 1, token: "admin-token" }));
    process.env.GITHUB_TOKEN = secret;
    process.env.NODE_ENV = "test";
    const output: string[] = [];
    const errors: string[] = [];
    const started = Date.now();
    const code = await runCli(["connect", "github", "--config", configPath, "--once"], {
      cwd: root,
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
    });
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(output.length, 0);
    assert.equal(errors.join("").includes("admin-token"), false);
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = oldToken;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    await rm(root, { recursive: true, force: true });
  }
});
