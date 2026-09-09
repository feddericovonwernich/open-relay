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
import { fakeGitHubServer, json, type FakeGitHubServer } from "./github-helpers.ts";

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
  await writeFile(join(root, "events", "pr-automation.v1.json"), JSON.stringify({
    type: eventType, version: 1, inputSchema: "schemas/payload.json", outputSchema: "schemas/result.json",
    effectPolicy: "retry-safe", timeoutMs: 1000, hardDeadlineMs: 2000,
    retry: { maxAttempts: 1, backoffMs: [], retryableCodes: [] },
    requires: { tools: [], structuredOutput: true, minContextTokens: 0, maxInputTokens: 4000, maxOutputTokens: 1000, maxPayloadBytes: 65536 },
    handler: { kind: "agent", instructions: "handlers/completion.md" },
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

function config(apiBaseUrl: string, emitType = eventType) {
  return {
    connector: "github" as const, apiBaseUrl, apiVersion: "2026-03-10", tokenEnv: "GITHUB_TOKEN",
    pollIntervalMs: 5000, lookbackHours: 720, repositories: [repo],
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
