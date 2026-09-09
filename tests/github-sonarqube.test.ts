import assert from "node:assert/strict";
import test from "node:test";
import { matchCompletedCheckRun } from "../src/connectors/github/recognizers/check-run.ts";
import { recognizeSonarQube } from "../src/connectors/github/recognizers/sonarqube.ts";
import type { GitHubCheckRun, PrSnapshot, TriggerConfig } from "../src/connectors/github/types.ts";

const trigger: Extract<TriggerConfig, { recognizer: "sonarqube" }> = {
  id: "sonar-v1",
  recognizer: "sonarqube",
  match: {
    checkNames: ["SonarCloud Code Analysis", "SonarQube Code Analysis"],
    appIds: [123456],
    appSlugs: ["sonarqube"],
  },
  emit: { type: "pr.automation.completed", version: 1 },
};

function check(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id: 42,
    name: "SonarCloud Code Analysis",
    status: "completed",
    conclusion: "success",
    headSha: "head-1",
    completedAt: "2026-09-08T00:00:00Z",
    detailsUrl: "https://github.com/example/repo/runs/42",
    app: { id: 123456, slug: "sonarqube" },
    pullRequests: [],
    ...overrides,
  };
}

function snapshot(runs: readonly GitHubCheckRun[] = [check()]): PrSnapshot {
  return {
    repository: { id: 7, fullName: "example/repo" },
    pullRequest: {
      number: 12,
      url: "https://github.com/example/repo/pull/12",
      headSha: "head-1",
      baseRef: "main",
      updatedAt: "2026-09-08T00:00:00Z",
    },
    checkRuns: runs,
    reviews: [],
  };
}

function candidates(run: GitHubCheckRun) {
  return recognizeSonarQube(snapshot([run]), trigger);
}

test("recognizes the two documented Sonar check names", () => {
  assert.equal(candidates(check({ name: "SonarCloud Code Analysis" })).length, 1);
  const [sonarqube] = candidates(check({ id: 43, name: "SonarQube Code Analysis" }));
  assert.equal(sonarqube?.artifact.name, "SonarQube Code Analysis");
});

test("requires completed status, pinned app identity, and current head", () => {
  const cases: Array<[string, Partial<GitHubCheckRun>]> = [
    ["queued", { status: "queued" }],
    ["in progress", { status: "in_progress" }],
    ["wrong app id", { app: { id: 999, slug: null } }],
    ["wrong app slug", { app: { id: null, slug: "other-app" } }],
    ["wrong name", { name: "SonarCloud Code Analysis (legacy)" }],
    ["stale head", { headSha: "head-0" }],
  ];

  for (const [label, overrides] of cases) {
    assert.deepEqual(candidates(check(overrides)), [], label);
  }
});

test("requires completed_at and a positive check id", () => {
  assert.deepEqual(candidates(check({ completedAt: null })), []);
  assert.deepEqual(candidates(check({ id: 0 })), []);
  assert.deepEqual(candidates(check({ id: -1 })), []);
});

test("requires PR association only when GitHub supplies associations", () => {
  assert.equal(candidates(check({ pullRequests: [] })).length, 1);
  assert.equal(candidates(check({ pullRequests: [{ number: 12 }] })).length, 1);
  assert.deepEqual(candidates(check({ pullRequests: [{ number: 99 }] })), []);
});

test("preserves raw conclusions and stable candidate fields", () => {
  for (const conclusion of ["neutral", "failure", null] as const) {
    const [candidate] = candidates(check({ id: 123, conclusion }));
    assert.equal(candidate?.artifact.conclusion, conclusion);
  }

  const [candidate] = candidates(check({ id: 123 }));
  assert.deepEqual(candidate, {
    provider: "sonarqube",
    triggerId: "sonar-v1",
    repositoryId: 7,
    pullRequestNumber: 12,
    artifactKind: "check_run",
    artifactId: "123",
    artifactHeadSha: "head-1",
    artifact: {
      name: "SonarCloud Code Analysis",
      completion: "completed",
      conclusion: "success",
      completedAt: "2026-09-08T00:00:00Z",
      detailsUrl: "https://github.com/example/repo/runs/42",
    },
  });
});

test("shared matcher accepts app IDs or slugs and uses the requested provider", () => {
  const slugRun = check({ id: 124, app: { id: null, slug: "sonarqube" } });
  const [candidate] = matchCompletedCheckRun(snapshot([slugRun]), trigger, "test-provider");
  assert.equal(candidate?.provider, "test-provider");
});
