import assert from "node:assert/strict";
import test from "node:test";
import { runGitHubConnector, runGitHubCycle, type ConnectorSummary } from "../src/connectors/github/runner.ts";
import type { GitHubConnectorConfig, GitHubPullRequest, PrSnapshot } from "../src/connectors/github/types.ts";

const trigger = {
  id: "sonar-v1",
  recognizer: "sonarqube" as const,
  match: { checkNames: ["SonarCloud Code Analysis"], appIds: [42], appSlugs: [] },
  emit: { type: "pr.automation.completed", version: 1 },
};
const config: GitHubConnectorConfig = {
  connector: "github",
  apiBaseUrl: "https://api.github.com",
  apiVersion: "2026-03-10",
  tokenEnv: "GITHUB_TOKEN",
  pollIntervalMs: 5_000,
  lookbackHours: 24,
  repositories: ["octo/repo"],
  triggers: [trigger],
};
const pullRequest: GitHubPullRequest = {
  number: 7,
  url: "https://github.com/octo/repo/pull/7",
  headSha: "abc",
  baseRef: "main",
  state: "open",
  updatedAt: new Date().toISOString(),
  repositoryId: 99,
  repositoryFullName: "octo/repo",
};
const snapshot: PrSnapshot = {
  repository: { id: 99, fullName: "octo/repo" },
  pullRequest: { number: 7, url: pullRequest.url, headSha: "abc", baseRef: "main", updatedAt: pullRequest.updatedAt },
  checkRuns: [{ id: 1, name: "SonarCloud Code Analysis", status: "completed", conclusion: "success", headSha: "abc", completedAt: new Date().toISOString(), detailsUrl: "https://sonar", app: { id: 42, slug: "sonarcloud" }, pullRequests: [{ number: 7 }] }],
  reviews: [],
};

function clientFor(currentHead = "abc") {
  return {
    listOpenPullRequests: async () => [pullRequest],
    listRecentClosedPullRequests: async () => [],
    listReviews: async () => [],
    listCompletedCheckRuns: async () => [...snapshot.checkRuns],
    getPullRequest: async () => ({ ...pullRequest, headSha: currentHead }),
  };
}

function summary(overrides: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return { repositories: 1, pullRequests: 0, candidates: 0, emitted: 0, replayed: 0, stale: 0, errors: [], ...overrides };
}

test("one-shot runner recognizes and emits a current candidate", async () => {
  const calls: unknown[] = [];
  const result = await runGitHubConnector({
    config,
    client: clientFor(),
    emitter: { emit: async (...args) => { calls.push(args); return "emitted"; } },
    once: true,
    clock: () => Date.now(),
  });
  assert.deepEqual(result, summary({ pullRequests: 1, candidates: 1, emitted: 1 }));
  assert.equal(calls.length, 1);
});

test("stale candidates are counted but never emitted", async () => {
  let emitted = false;
  const result = await runGitHubCycle({
    config,
    client: clientFor("new-head"),
    emitter: { emit: async () => { emitted = true; return "emitted"; } },
  });
  assert.deepEqual(result, summary({ pullRequests: 1, candidates: 1, stale: 1 }));
  assert.equal(emitted, false);
});

test("discovery reports identities without emission", async () => {
  const identities: Record<string, unknown>[] = [];
  const result = await runGitHubConnector({ config, client: clientFor(), once: true, discover: true, onDiscovery: (identity) => identities.push(identity) });
  assert.equal(result.emitted, 0);
  assert.equal(result.replayed, 0);
  assert.equal(identities[0]?.appId, 42);
});

test("recognizer failures are isolated", async () => {
  const result = await runGitHubCycle({
    config,
    client: clientFor(),
    recognizers: { sonarqube: () => { throw new Error("broken recognizer"); } },
  });
  assert.deepEqual(result, summary({ pullRequests: 1, errors: ["recognizer sonar-v1: broken recognizer"] }));
});
