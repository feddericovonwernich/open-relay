import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/connectors/github/client.ts";
import { fakeGitHubServer, json } from "./github-helpers.ts";

const repo = "octo/repo";
const pr = (number: number, state: "open" | "closed" = "open", updated = "2026-09-08T00:00:00Z") => ({
  number,
  html_url: `https://github.com/${repo}/pull/${number}`,
  head: { sha: `sha-${number}` },
  base: { ref: "main" },
  state,
  updated_at: updated,
});

function client(baseUrl: string, options: Partial<ConstructorParameters<typeof GitHubClient>[0]> = {}) {
  return new GitHubClient({ baseUrl, apiVersion: "2026-03-10", token: "top-secret", ...options });
}

test("paginates open PRs and recent closed PRs independently", async () => {
  const server = await fakeGitHubServer({
    "/repos/octo/repo/pulls?state=open&per_page=100": json([pr(1)], { etag: "open-1", link: `</repos/octo/repo/pulls?state=open&per_page=100&page=2>; rel="next"` }),
    "/repos/octo/repo/pulls?state=open&per_page=100&page=2": json([pr(2)], { etag: "open-2" }),
    "/repos/octo/repo/pulls?state=closed&sort=updated&direction=desc&per_page=100": json([pr(3, "closed"), pr(4, "closed", "2020-01-01T00:00:00Z")], { etag: "closed-1" }),
  });
  try {
    const api = client(server.url);
    assert.deepEqual((await api.listOpenPullRequests(repo)).map((item) => item.number), [1, 2]);
    assert.deepEqual((await api.listRecentClosedPullRequests(repo, Date.parse("2026-01-01T00:00:00Z"))).map((item) => item.number), [3]);
    assert.deepEqual(server.requests.map((request) => request.url), [
      "/repos/octo/repo/pulls?state=open&per_page=100",
      "/repos/octo/repo/pulls?state=open&per_page=100&page=2",
      "/repos/octo/repo/pulls?state=closed&sort=updated&direction=desc&per_page=100",
    ]);
  } finally { await server.close(); }
});

test("PR list 304 reuses cached body without suppressing later artifact calls", async () => {
  const checksPath = "/repos/octo/repo/commits/sha-1/check-runs?status=completed&filter=all&per_page=100";
  const server = await fakeGitHubServer({
    "/repos/octo/repo/pulls?state=open&per_page=100": [
      json([pr(1)], { etag: "list-1" }),
      { status: 304, headers: { etag: "list-1" } },
    ],
    [checksPath]: [json({ total_count: 1, check_runs: [{ id: 1, name: "check", status: "completed", conclusion: "success", head_sha: "sha-1", completed_at: "2026-09-08T00:00:00Z", details_url: null, app: null, pull_requests: [] }] }), json({ total_count: 1, check_runs: [{ id: 2, name: "changed", status: "completed", conclusion: "failure", head_sha: "sha-1", completed_at: "2026-09-08T00:01:00Z", details_url: null, app: null, pull_requests: [] }] })],
  });
  try {
    const api = client(server.url);
    await api.listOpenPullRequests(repo);
    assert.equal((await api.listCompletedCheckRuns(repo, "sha-1"))[0].id, 1);
    assert.deepEqual((await api.listOpenPullRequests(repo)).map((item) => item.number), [1]);
    assert.equal((await api.listCompletedCheckRuns(repo, "sha-1"))[0].id, 2);
    assert.equal(server.requests.filter((request) => request.url === checksPath).length, 2);
    assert.equal(server.requests[1]?.headers["if-none-match"], undefined);
  } finally { await server.close(); }
});

test("paginates check runs and reviews", async () => {
  const check1 = { id: 1, name: "a", status: "completed", conclusion: "success", head_sha: "sha", completed_at: "2026-09-08T00:00:00Z", details_url: null, app: null, pull_requests: [] };
  const check2 = { ...check1, id: 2, name: "b" };
  const review1 = { id: 3, user: null, commit_id: "sha", submitted_at: "2026-09-08T00:00:00Z", html_url: null };
  const review2 = { ...review1, id: 4 };
  const server = await fakeGitHubServer({
    "/repos/octo/repo/commits/sha/check-runs?status=completed&filter=all&per_page=100": json({ total_count: 2, check_runs: [check1] }, { link: `</repos/octo/repo/commits/sha/check-runs?status=completed&filter=all&per_page=100&page=2>; rel="next"` }),
    "/repos/octo/repo/pulls/7/reviews?per_page=100": json([review1], { link: `</repos/octo/repo/pulls/7/reviews?per_page=100&page=2>; rel="next"` }),
    "/repos/octo/repo/commits/sha/check-runs?status=completed&filter=all&per_page=100&page=2": json({ total_count: 1, check_runs: [check2] }),
    "/repos/octo/repo/pulls/7/reviews?per_page=100&page=2": json([review2]),
  });
  try {
    const api = client(server.url);
    assert.deepEqual((await api.listCompletedCheckRuns(repo, "sha")).map((item) => item.id), [1, 2]);
    assert.deepEqual((await api.listReviews(repo, 7)).map((item) => item.id), [3, 4]);
  } finally { await server.close(); }
});

test("honors Retry-After and rate-limit reset with injected sleep", async () => {
  const delays: number[] = [];
  const server = await fakeGitHubServer({
    "/repos/octo/repo/pulls?state=open&per_page=100": [
      { status: 429, headers: { "retry-after": "2" } },
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1002" } },
      json([]),
    ],
  });
  try {
    const api = client(server.url, { now: () => 1_000_000, jitter: () => 11, sleep: async (ms) => { delays.push(ms); } });
    await api.listOpenPullRequests(repo);
    assert.deepEqual(delays, [2011, 2011]);
  } finally { await server.close(); }
});

test("aborts in-flight fetch and redacts bearer from errors", async () => {
  const abort = new AbortController();
  const fetcher: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Bearer top-secret", "AbortError")), { once: true });
  });
  const api = client("http://127.0.0.1:1", { fetch: fetcher });
  const pending = api.listOpenPullRequests(repo, abort.signal);
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError" && !error.message.includes("top-secret"));
});

test("sends exact GitHub headers", async () => {
  const server = await fakeGitHubServer({ "/repos/octo/repo/pulls/9": json(pr(9)) });
  try {
    const api = client(server.url);
    await api.getPullRequest(repo, 9);
    assert.deepEqual({
      authorization: server.requests[0]?.headers.authorization,
      accept: server.requests[0]?.headers.accept,
      version: server.requests[0]?.headers["x-github-api-version"],
      userAgent: server.requests[0]?.headers["user-agent"],
    }, {
      authorization: "Bearer top-secret",
      accept: "application/vnd.github+json",
      version: "2026-03-10",
      userAgent: "open-relay-github-connector",
    });
  } finally { await server.close(); }
});
