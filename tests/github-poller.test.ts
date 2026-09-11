import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverPullRequest,
  discoverPullRequests,
  deriveSnapshotRequirements,
  loadPrSnapshot,
  mapConcurrent,
  verifyCurrentHead,
  type SnapshotRequirements,
} from "../src/connectors/github/poller.ts";
import type { GitHubCheckRun, GitHubPullRequest, GitHubPullRequestReview } from "../src/connectors/github/types.ts";
import { deferred } from "./github-helpers.ts";

const repository = "octo/repo";
const pr = (number: number, updatedAt = "2026-09-08T00:00:00Z", headSha = `sha-${number}`, state: "open" | "closed" = "open"): GitHubPullRequest => ({
  number,
  url: `https://github.com/${repository}/pull/${number}`,
  headSha,
  baseRef: "main",
  state,
  updatedAt,
  repositoryId: 42,
  repositoryFullName: repository,
});

function client(overrides: Partial<{
  listOpenPullRequests: (repository: string, signal?: AbortSignal) => Promise<GitHubPullRequest[]>;
  listRecentClosedPullRequests: (repository: string, cutoff: number, signal?: AbortSignal) => Promise<GitHubPullRequest[]>;
  listCompletedCheckRuns: (repository: string, headSha: string, signal?: AbortSignal) => Promise<GitHubCheckRun[]>;
  listReviews: (repository: string, number: number, signal?: AbortSignal) => Promise<GitHubPullRequestReview[]>;
  getPullRequest: (repository: string, number: number, signal?: AbortSignal) => Promise<GitHubPullRequest>;
}> = {}) {
  return {
    listOpenPullRequests: async () => [],
    listRecentClosedPullRequests: async () => [],
    listCompletedCheckRuns: async () => [],
    listReviews: async () => [],
    getPullRequest: async (_repository: string, number: number) => pr(number),
    ...overrides,
  };
}

const requirements: SnapshotRequirements = { checkRuns: true, reviews: true };

test("discovers all open and recent closed PRs, deduplicating by latest update", async () => {
  const calls: string[] = [];
  const cutoff = Date.parse("2026-09-01T00:00:00Z");
  const api = client({
    listOpenPullRequests: async (name) => {
      calls.push(`open:${name}`);
      return [pr(7, "2020-01-01T00:00:00Z"), pr(3, "2026-09-07T00:00:00Z")];
    },
    listRecentClosedPullRequests: async (name, receivedCutoff) => {
      calls.push(`closed:${name}:${receivedCutoff}`);
      return [pr(7, "2026-09-08T01:00:00Z", "new-sha-7", "closed"), pr(2, "2026-09-08T00:00:00Z", "sha-2", "closed")];
    },
  });
  const result = await discoverPullRequests(api, repository, cutoff);
  assert.deepEqual(result.map((item) => [item.number, item.headSha]), [[2, "sha-2"], [3, "sha-3"], [7, "new-sha-7"]]);
  assert.deepEqual(calls, [`open:${repository}`, `closed:${repository}:${cutoff}`]);
});
test("directly discovers one old or closed pull request without list calls", async () => {
  const calls: string[] = [];
  const target = pr(197, "2020-01-01T00:00:00Z", "old-head", "closed");
  const api = client({
    listOpenPullRequests: async () => { calls.push("open"); throw new Error("list endpoint must not be called"); },
    listRecentClosedPullRequests: async () => { calls.push("closed"); throw new Error("list endpoint must not be called"); },
    getPullRequest: async (name, number) => { calls.push(`get:${name}:${number}`); return target; },
  });
  assert.deepEqual(await discoverPullRequest(api, repository, 197), target);
  assert.deepEqual(calls, [`get:${repository}:197`]);
});

test("direct discovery retains repository identity validation", async () => {
  await assert.rejects(
    discoverPullRequest(client({ getPullRequest: async () => ({ ...pr(197), repositoryFullName: "other/repo" }) }), repository, 197),
    /belongs to other\/repo/,
  );
});

test("passes the cutoff to closed discovery so old closed pages can stop", async () => {
  let receivedCutoff = 0;
  const api = client({ listRecentClosedPullRequests: async (_name, cutoff) => { receivedCutoff = cutoff; return []; } });
  const cutoff = Date.parse("2026-09-01T00:00:00Z");
  await discoverPullRequests(api, repository, cutoff);
  assert.equal(receivedCutoff, cutoff);
});

test("derives shared snapshot requirements from active recognizers", () => {
  assert.deepEqual(deriveSnapshotRequirements([]), { checkRuns: false, reviews: false });
  assert.deepEqual(deriveSnapshotRequirements([{ id: "sonar", recognizer: "sonarqube", match: { checkNames: [], appIds: [], appSlugs: [] }, emit: { type: "x", version: 1 } }]), { checkRuns: true, reviews: false });
  assert.deepEqual(deriveSnapshotRequirements([{ id: "copilot", recognizer: "copilot-review", match: { userIds: [], appUrls: [], logins: [] }, emit: { type: "x", version: 1 } }]), { checkRuns: false, reviews: true });
});

test("loads shared check runs once and only fetches reviews when required", async () => {

  let checks = 0;
  let reviews = 0;
  const checkRuns: GitHubCheckRun[] = [];
  const reviewList: GitHubPullRequestReview[] = [];
  const api = client({
    listCompletedCheckRuns: async () => { checks++; return checkRuns; },
    listReviews: async () => { reviews++; return reviewList; },
  });
  const snapshot = await loadPrSnapshot(api, repository, pr(7), requirements);
  assert.equal(checks, 1);
  assert.equal(reviews, 1);
  assert.strictEqual(snapshot.checkRuns, checkRuns);
  assert.strictEqual(snapshot.reviews, reviewList);
  assert.equal(Object.isFrozen(snapshot.checkRuns), true);
  assert.equal(Object.isFrozen(snapshot.reviews), true);

  await loadPrSnapshot(api, repository, pr(8), { checkRuns: true, reviews: false });
  assert.equal(checks, 2);
  assert.equal(reviews, 1);
});

test("rejects pull requests whose decoded repository differs from the configured repository", async () => {
  const api = client({ listOpenPullRequests: async () => [{ ...pr(1), repositoryFullName: "other/repo" }] });
  await assert.rejects(discoverPullRequests(api, repository, Date.now()), /belongs to other\/repo/);
});

test("caps mapConcurrent at four in-flight requests and preserves order", async () => {
  const gates = Array.from({ length: 9 }, () => deferred<number>());
  let active = 0;
  let peak = 0;
  const running = mapConcurrent(gates, 4, async (gate) => {
    active++;
    peak = Math.max(peak, active);
    const result = await gate.promise;
    active--;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 4);
  assert.equal(peak, 4);
  gates.forEach((gate, index) => gate.resolve(index));
  assert.deepEqual(await running, Array.from({ length: 9 }, (_, index) => index));
});

test("verifies the current head immediately before emitting a candidate", async () => {
  let reads = 0;
  const api = client({
    getPullRequest: async () => {
      reads++;
      return pr(7, "2026-09-08T00:00:00Z", reads === 1 ? "sha-7" : "new-head");
    },
  });
  const candidate = { repository, pullRequestNumber: 7, artifactHeadSha: "sha-7" };
  assert.equal(await verifyCurrentHead(api, candidate), true);
  assert.equal(await verifyCurrentHead(api, candidate), false);
});
