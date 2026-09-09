import assert from "node:assert/strict";
import test from "node:test";
import { recognizeCopilotReviews } from "../src/connectors/github/recognizers/copilot.ts";
import type { GitHubPullRequestReview, PrSnapshot, TriggerConfig } from "../src/connectors/github/types.ts";

const trigger: Extract<TriggerConfig, { recognizer: "copilot-review" }> = {
  id: "copilot-v1",
  recognizer: "copilot-review",
  match: {
    userIds: [175728472],
    appUrls: ["https://github.com/apps/copilot-pull-request-reviewer"],
    logins: ["copilot-pull-request-reviewer[bot]"],
  },
  emit: { type: "pr.automation.completed", version: 1 },
};

function review(overrides: Partial<GitHubPullRequestReview> = {}): GitHubPullRequestReview {
  return {
    id: 42,
    user: {
      id: 175728472,
      login: "copilot-pull-request-reviewer[bot]",
      type: "Bot",
      htmlUrl: "https://github.com/apps/copilot-pull-request-reviewer",
    },
    commitId: "head-1",
    submittedAt: "2026-09-08T00:00:00Z",
    htmlUrl: "https://github.com/example/repo/pull/12#pullrequestreview-42",
    ...overrides,
  };
}

function snapshot(reviews: readonly GitHubPullRequestReview[] = [review()]): PrSnapshot {
  return {
    repository: { id: 7, fullName: "example/repo" },
    pullRequest: {
      number: 12,
      url: "https://github.com/example/repo/pull/12",
      headSha: "head-1",
      baseRef: "main",
      updatedAt: "2026-09-08T00:00:00Z",
    },
    checkRuns: [],
    reviews,
  };
}

function candidates(item: GitHubPullRequestReview, configured = trigger) {
  return recognizeCopilotReviews(snapshot([item]), configured);
}

test("recognizes a submitted current-head Copilot Bot review by user ID", () => {
  assert.equal(candidates(review()).length, 1);
});

test("matches configured app URL and normalized login identities", () => {
  const appUrlTrigger = {
    ...trigger,
    match: { userIds: [], appUrls: trigger.match.appUrls, logins: [] },
  } satisfies typeof trigger;
  assert.equal(candidates(review({ user: { ...review().user!, id: 999 } }), appUrlTrigger).length, 1);

  const loginTrigger = {
    ...trigger,
    match: { userIds: [], appUrls: [], logins: ["CoPilot-Pull-Request-Reviewer[bot]"] },
  } satisfies typeof trigger;
  assert.equal(candidates(review({ user: { ...review().user!, id: 999, htmlUrl: null, login: "COPILOT-PULL-REQUEST-REVIEWER" } }), loginTrigger).length, 1);
});

test("requires submitted current-head Bot review with a configured identity", () => {
  const cases: Array<[string, Partial<GitHubPullRequestReview>]> = [
    ["non-Bot", { user: { ...review().user!, type: "User" } }],
    ["missing submitted_at", { submittedAt: null }],
    ["stale commit", { commitId: "head-0" }],
    ["wrong identity", { user: { ...review().user!, id: 999, htmlUrl: "https://github.com/other", login: "other[bot]" } }],
    ["missing review URL", { htmlUrl: null }],
    ["non-positive review ID", { id: 0 }],
  ];

  for (const [label, overrides] of cases) {
    assert.deepEqual(candidates(review(overrides)), [], label);
  }
});

test("does not recognize review-requested data or inline comments without a submitted review", () => {
  assert.deepEqual(recognizeCopilotReviews(snapshot([]), trigger), []);
  const snapshotWithComment = { ...snapshot([]), comments: [{ body: "Copilot reviewed this" }] } as PrSnapshot & { comments: unknown[] };
  assert.deepEqual(recognizeCopilotReviews(snapshotWithComment, trigger), []);
});

test("emits stable submitted candidate fields without body or mutable review state", () => {
  const submittedError = {
    ...review(),
    body: "Copilot errored internally",
    state: "dismissed",
  } as GitHubPullRequestReview & { body: string; state: string };
  const [candidate] = candidates(submittedError);
  assert.deepEqual(candidate, {
    provider: "copilot-review",
    triggerId: "copilot-v1",
    repositoryId: 7,
    pullRequestNumber: 12,
    artifactKind: "pull_request_review",
    artifactId: "42",
    artifactHeadSha: "head-1",
    artifact: {
      name: "GitHub Copilot review",
      completion: "submitted",
      conclusion: "submitted",
      completedAt: "2026-09-08T00:00:00Z",
      detailsUrl: "https://github.com/example/repo/pull/12#pullrequestreview-42",
    },
  });
  assert.equal("body" in candidate!.artifact, false);
  assert.equal("state" in candidate!.artifact, false);
});
