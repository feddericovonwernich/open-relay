import assert from "node:assert/strict";
import test from "node:test";
import { recognizeCursorBugbot } from "../src/connectors/github/recognizers/bugbot.ts";
import type { GitHubCheckRun, PrSnapshot, TriggerConfig } from "../src/connectors/github/types.ts";

const trigger: Extract<TriggerConfig, { recognizer: "cursor-bugbot" }> = {
  id: "bugbot-v1",
  recognizer: "cursor-bugbot",
  match: {
    checkNames: ["Cursor Bugbot"],
    appIds: [1210556],
    appSlugs: ["cursor"],
  },
  emit: { type: "pr.automation.completed", version: 1 },
};

function check(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id: 42,
    name: "Cursor Bugbot",
    status: "completed",
    conclusion: "success",
    headSha: "head-1",
    completedAt: "2026-09-08T00:00:00Z",
    detailsUrl: "https://github.com/example/repo/runs/42",
    app: { id: 1210556, slug: "cursor" },
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

function candidates(run: GitHubCheckRun, reviews: PrSnapshot["reviews"] = []) {
  return recognizeCursorBugbot({ ...snapshot([run]), reviews }, trigger);
}

test("recognizes exact Cursor Bugbot with Cursor app id or slug", () => {
  assert.equal(candidates(check({ app: { id: 1210556, slug: null } })).length, 1);
  assert.equal(candidates(check({ id: 43, app: { id: null, slug: "cursor" } })).length, 1);
});

test("excludes Autofix, substring names, and wrong app identity", () => {
  const cases: Array<[string, Partial<GitHubCheckRun>]> = [
    ["Autofix", { name: "Cursor Bugbot Autofix" }],
    ["substring name", { name: "Cursor Bugbot review" }],
    ["wrong app id", { app: { id: 999, slug: null } }],
    ["wrong app slug", { app: { id: null, slug: "other-app" } }],
  ];

  for (const [label, overrides] of cases) {
    assert.deepEqual(candidates(check(overrides)), [], label);
  }
});

test("requires a completed check on the current head", () => {
  const cases: Array<[string, Partial<GitHubCheckRun>]> = [
    ["queued", { status: "queued" }],
    ["in progress", { status: "in_progress" }],
    ["stale head", { headSha: "head-0" }],
  ];

  for (const [label, overrides] of cases) {
    assert.deepEqual(candidates(check(overrides)), [], label);
  }
});

test("preserves success, neutral, and failure conclusions", () => {
  for (const conclusion of ["success", "neutral", "failure"] as const) {
    const [candidate] = candidates(check({ id: conclusion.length, conclusion }));
    assert.equal(candidate?.artifact.conclusion, conclusion);
  }
});

test("does not inspect review comments or logins", () => {
  const [candidate] = candidates(check(), [{
    id: 99,
    user: { id: 1, login: "cursor[bot]", type: "Bot", htmlUrl: null },
    commitId: "head-1",
    submittedAt: "2026-09-08T00:00:00Z",
    htmlUrl: "https://github.com/example/repo/pull/12#pullrequestreview-99",
  }]);
  assert.equal(candidate?.provider, "cursor-bugbot");
});
