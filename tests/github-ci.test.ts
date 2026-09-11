import assert from "node:assert/strict";
import test from "node:test";
import { settledCheckRuns } from "../src/connectors/github/ci.ts";
import { normalizeCiSettled } from "../src/connectors/github/normalize.ts";
import type { GitHubCheckRun, PrSnapshot } from "../src/connectors/github/types.ts";

const snapshot: PrSnapshot = {
  repository: { id: 7, fullName: "example/repo" },
  pullRequest: {
    number: 12,
    url: "https://github.com/example/repo/pull/12",
    headSha: "head-1",
    baseRef: "main",
    updatedAt: "2026-09-08T00:00:00Z",
  },
  checkRuns: [],
  reviews: [],
};

function check(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id: 2,
    name: "build",
    status: "completed",
    conclusion: "success",
    headSha: "head-1",
    completedAt: "2026-09-08T01:00:00Z",
    detailsUrl: "https://ci.example/build/2",
    app: null,
    pullRequests: [],
    ...overrides,
  };
}

function withChecks(checkRuns: readonly GitHubCheckRun[]): PrSnapshot {
  return { ...snapshot, checkRuns };
}

test("returns undefined for empty or pending Check Run sets", () => {
  assert.equal(settledCheckRuns(snapshot), undefined);
  assert.equal(settledCheckRuns(withChecks([check({ status: "in_progress" })])), undefined);
  assert.equal(settledCheckRuns(withChecks([check({ status: "queued" })])), undefined);
  assert.equal(settledCheckRuns(withChecks([check({ status: "completed" }), check({ id: 3, status: "queued" })])), undefined);
});

test("rejects checks that are not current-head, timestamped, named, or safely identified", () => {
  const invalid = [
    check({ headSha: "old-head" }),
    check({ completedAt: null }),
    check({ completedAt: "" }),
    check({ name: "" }),
    check({ id: 0 }),
    check({ id: -1 }),
    check({ id: Number.MAX_SAFE_INTEGER + 1 }),
  ];
  for (const candidate of invalid) assert.equal(settledCheckRuns(withChecks([candidate])), undefined);
});

test("rejects snapshots without the required nonempty identity strings", () => {
  const fields: Array<["repository" | "pullRequest", "fullName" | "url" | "headSha" | "baseRef"]> = [
    ["repository", "fullName"],
    ["pullRequest", "url"],
    ["pullRequest", "headSha"],
    ["pullRequest", "baseRef"],
  ];
  for (const [object, field] of fields) {
    const candidate = structuredClone(snapshot) as PrSnapshot;
    (candidate[object] as unknown as Record<string, unknown>)[field] = "";
    assert.ok(settledCheckRuns(withChecks([check()])), "control check remains valid");
    assert.equal(settledCheckRuns({ ...candidate, checkRuns: [check()] }), undefined, `${object}.${field}`);
  }
});

test("returns a frozen numeric-id/name ordered copy without filtering app or PR association", () => {
  const checks = [
    check({ id: 10, name: "z-last", app: { id: 9, slug: "foreign" }, pullRequests: [{ number: 999 }] }),
    check({ id: 2, name: "z-name" }),
    check({ id: 2, name: "a-name" }),
    check({ id: 1, name: "first" }),
  ];
  const result = settledCheckRuns(withChecks(checks));
  assert.ok(result);
  assert.deepEqual(result.map(({ id, name }) => ({ id, name })), [
    { id: 1, name: "first" },
    { id: 2, name: "a-name" },
    { id: 2, name: "z-name" },
    { id: 10, name: "z-last" },
  ]);
  assert.notEqual(result, checks);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
});

test("normalizes a deeply frozen generic payload and preserves raw fields", () => {
  const checks = [
    check({ id: 10, name: "lint", conclusion: "cancelled", completedAt: "2026-09-08T03:00:00Z", detailsUrl: "" }),
    check({ id: 2, name: "build", conclusion: null, completedAt: "2026-09-08T02:00:00Z", detailsUrl: null }),
    check({ id: 1, name: "test", conclusion: "", completedAt: "2026-09-08T01:00:00Z", detailsUrl: "https://ci.example/test/1" }),
  ];
  const payload = normalizeCiSettled(snapshot, checks);
  assert.deepEqual(payload, {
    schemaVersion: 1,
    provider: "github",
    repository: { id: 7, fullName: "example/repo" },
    pullRequest: { number: 12, url: snapshot.pullRequest.url, headSha: "head-1", baseRef: "main" },
    outcome: "failure",
    checks: [
      { id: "1", name: "test", conclusion: "", completedAt: "2026-09-08T01:00:00Z", detailsUrl: "https://ci.example/test/1" },
      { id: "2", name: "build", conclusion: null, completedAt: "2026-09-08T02:00:00Z", detailsUrl: null },
      { id: "10", name: "lint", conclusion: "cancelled", completedAt: "2026-09-08T03:00:00Z", detailsUrl: "" },
    ],
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.repository), true);
  assert.equal(Object.isFrozen(payload.pullRequest), true);
  assert.equal(Object.isFrozen(payload.checks), true);
  assert.equal(Object.isFrozen(payload.checks[0]), true);
});

test("treats success, neutral, and skipped as passing conclusions", () => {
  const checks = [
    check({ id: 1, conclusion: "success" }),
    check({ id: 2, conclusion: "neutral" }),
    check({ id: 3, conclusion: "skipped" }),
  ];
  assert.equal(normalizeCiSettled(snapshot, checks).outcome, "success");
});

test("preserves successful conclusions and makes every other conclusion non-passing", () => {
  for (const conclusion of ["failure", "cancelled", null, ""] as const) {
    const checks = [check({ id: 1, conclusion }), check({ id: 2, conclusion: "success" })];
    const payload = normalizeCiSettled(snapshot, checks);
    assert.equal(payload.outcome, "failure");
    assert.equal(payload.checks[0].conclusion, conclusion);
  }
});
