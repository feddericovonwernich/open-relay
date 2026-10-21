import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, GitHubClientError } from "../src/connectors/github/client.ts";
import { fakeGitHubServer, json } from "./github-helpers.ts";

const graphqlResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const reviewThread = () => ({
  id: "thread-1",
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 10,
  startLine: 8,
  comments: {
    totalCount: 2,
    nodes: [{
      id: "comment-1",
      url: "https://github.test/comment/1",
      body: "finding",
      createdAt: "2026-09-17T00:00:00Z",
      updatedAt: "2026-09-17T00:01:00Z",
      author: { login: "cursor[bot]" },
    }],
  },
});

const reviewPage = (hasNextPage = false, endCursor: string | null = null, nodes = [reviewThread()]) => ({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    },
  },
});
type MutableReviewBody = {
  data: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes: Array<{
            id?: string;
            comments?: {
              totalCount?: number;
              nodes: Array<{ author?: { login?: string } }>;
            };
          }>;
        };
      };
    };
  };
};

 

const repo = "octo/repo";
const pr = (number: number, state: "open" | "closed" = "open", updated = "2026-09-08T00:00:00Z") => ({
  number,
  html_url: `https://github.com/${repo}/pull/${number}`,
  head: { sha: `sha-${number}` },
  base: { ref: "main", repo: { id: 42, full_name: repo } },
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
test("paginates current check runs with the latest filter and decodes every status", async () => {
  const currentPath = "/repos/octo/repo/commits/sha/check-runs?filter=latest&per_page=100";
  const page2 = `${currentPath}&page=2`;
  const checkRuns = [
    { id: 1, name: "queued", status: "queued", conclusion: null, head_sha: "sha", completed_at: null, details_url: "", app: null, pull_requests: [] },
    { id: 2, name: "running", status: "in_progress", conclusion: null, head_sha: "sha", completed_at: null, details_url: null, app: null, pull_requests: [] },
    { id: 3, name: "done", status: "completed", conclusion: "neutral", head_sha: "sha", completed_at: "2026-09-08T00:00:00Z", details_url: "https://details", app: null, pull_requests: [] },
  ];
  const server = await fakeGitHubServer({
    [currentPath]: json({ total_count: 3, check_runs: checkRuns.slice(0, 2) }, { link: `<${page2}>; rel="next"` }),
    [page2]: json({ total_count: 1, check_runs: [checkRuns[2]] }),
  });
  try {
    const api = client(server.url);
    const result = await api.listCurrentCheckRuns(repo, "sha");
    assert.deepEqual(result.map((check) => [check.id, check.status, check.conclusion]), [
      [1, "queued", null],
      [2, "in_progress", null],
      [3, "completed", "neutral"],
    ]);
    assert.deepEqual(server.requests.map((request) => request.url), [currentPath, page2]);
  } finally { await server.close(); }
});

test("caches current and completed check-run endpoints independently", async () => {
  const currentPath = "/repos/octo/repo/commits/sha/check-runs?filter=latest&per_page=100";
  const completedPath = "/repos/octo/repo/commits/sha/check-runs?status=completed&filter=all&per_page=100";
  const currentBody = { total_count: 1, check_runs: [{ id: 1, name: "current", status: "in_progress", conclusion: null, head_sha: "sha", completed_at: null, details_url: null, app: null, pull_requests: [] }] };
  const completedBody = { total_count: 1, check_runs: [{ id: 2, name: "completed", status: "completed", conclusion: "success", head_sha: "sha", completed_at: "2026-09-08T00:00:00Z", details_url: null, app: null, pull_requests: [] }] };
  const server = await fakeGitHubServer({
    [currentPath]: [json(currentBody, { etag: "current-v1" }), { status: 304, headers: { etag: "current-v1" } }],
    [completedPath]: [json(completedBody, { etag: "completed-v1" }), { status: 304, headers: { etag: "completed-v1" } }],
  });
  try {
    const api = client(server.url);
    assert.equal((await api.listCurrentCheckRuns(repo, "sha"))[0]?.id, 1);
    assert.equal((await api.listCompletedCheckRuns(repo, "sha"))[0]?.id, 2);
    assert.equal((await api.listCurrentCheckRuns(repo, "sha"))[0]?.id, 1);
    assert.equal((await api.listCompletedCheckRuns(repo, "sha"))[0]?.id, 2);
    const requests = server.requests.filter((request) => request.url === currentPath || request.url === completedPath);
    assert.equal(requests.length, 4);
    assert.equal(requests[0]?.headers["if-none-match"], undefined);
    assert.equal(requests[1]?.headers["if-none-match"], undefined);
    assert.equal(requests[2]?.headers["if-none-match"], "current-v1");
    assert.equal(requests[3]?.headers["if-none-match"], "completed-v1");
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
    const headers = server.requests[0]?.headers;
    assert.equal(headers?.authorization?.slice(0, "Bearer ".length), "Bearer ");
    assert.equal(headers?.authorization?.length, "Bearer ".length + "top-secret".length);
    assert.equal(headers?.accept, "application/vnd.github+json");
    assert.equal(headers?.["x-github-api-version"], "2026-03-10");
    assert.equal(headers?.["user-agent"], "open-relay-github-connector");
  } finally { await server.close(); }
});

test("requires repository identity in pull-request responses", async () => {
  const malformed = { ...pr(9), base: { ref: "main" } };
  const server = await fakeGitHubServer({ "/repos/octo/repo/pulls/9": json(malformed) });
  try {
    const api = client(server.url);
    await assert.rejects(api.getPullRequest(repo, 9), (error: unknown) => error instanceof Error && error.message.includes("malformed"));
  } finally { await server.close(); }
});

test("preserves abort when response JSON is interrupted", async () => {
  const abort = new AbortController();
  const fetcher: typeof fetch = async (_input, init) => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: async () => await new Promise<unknown>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  } as Response);
  const api = client("http://127.0.0.1:1", { fetch: fetcher });
  const pending = api.getPullRequest(repo, 9, abort.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
});
test("fetches review threads with the exact GraphQL request and pagination variables", async () => {
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const secondThread = {
    ...reviewThread(),
    id: "thread-2",
    comments: {
      totalCount: 1,
      nodes: [{ ...reviewThread().comments.nodes[0], id: "comment-2", body: "second finding" }],
    },
  };
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    return graphqlResponse(requests.length === 1 ? reviewPage(true, "cursor-1") : reviewPage(false, null, [secondThread]));
  };
  const api = client("https://api.github.test", { graphqlUrl: "https://api.github.test/graphql", fetch: fetcher });
  const result = await api.listReviewThreads(repo, 7);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ input }) => String(input)), ["https://api.github.test/graphql", "https://api.github.test/graphql"]);
  const bodies = requests.map(({ init }) => JSON.parse(String(init?.body)) as { query: string; variables: unknown });
  const expectedQuery = `query PullRequestReviewThreads(
  $owner: String!
  $name: String!
  $number: Int!
  $after: String
) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 100) {
            totalCount
            nodes {
              id
              url
              body
              createdAt
              updatedAt
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}`;
  assert.deepEqual(bodies.map(({ query }) => query.replace(/\s+/g, " ").trim()), [expectedQuery.replace(/\s+/g, " ").trim(), expectedQuery.replace(/\s+/g, " ").trim()]);
  assert.deepEqual(bodies.map(({ variables }) => variables), [
    { owner: "octo", name: "repo", number: 7, after: null },
    { owner: "octo", name: "repo", number: 7, after: "cursor-1" },
  ]);
  for (const { init } of requests) {
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer top-secret");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
    assert.equal(headers.get("user-agent"), "open-relay-github-connector");
  }
  assert.equal(result.length, 2);
  assert.equal(result[0]?.commentCount, 2);
  assert.deepEqual(result[0]?.rootComment, {
    id: "comment-1",
    url: "https://github.test/comment/1",
    body: "finding",
    createdAt: "2026-09-17T00:00:00Z",
    updatedAt: "2026-09-17T00:01:00Z",
    authorLogin: "cursor[bot]",
  });
  assert.equal(result[1]?.id, "thread-2");
});

test("rejects every malformed review-thread boundary as a protocol error", async () => {
  const malformedCases: Array<[string, (body: MutableReviewBody) => void]> = [
    ["missing repository", (body) => { delete body.data.repository; }],
    ["missing pull request", (body) => { delete body.data.repository!.pullRequest; }],
    ["malformed thread", (body) => { delete body.data.repository!.pullRequest!.reviewThreads!.nodes[0]!.id; }],
    ["missing comment count", (body) => { delete body.data.repository!.pullRequest!.reviewThreads!.nodes[0]!.comments!.totalCount; }],
    ["empty comments", (body) => { body.data.repository!.pullRequest!.reviewThreads!.nodes[0]!.comments!.nodes = []; }],
    ["missing root comment field", (body) => { delete body.data.repository!.pullRequest!.reviewThreads!.nodes[0]!.comments!.nodes[0]!.author!.login; }],
  ];
  for (const [label, mutate] of malformedCases) {
    const fetcher: typeof fetch = async () => {
      const body = reviewPage();
      mutate(body);
      return graphqlResponse(body);
    };
    const api = client("https://api.github.test", { graphqlUrl: "https://api.github.test/graphql", fetch: fetcher });
    await assert.rejects(api.listReviewThreads(repo, 7), (error: unknown) =>
      error instanceof GitHubClientError && error.code === "github_protocol_error", label);
  }
});

test("maps GraphQL errors without exposing response or untrusted strings", async () => {
  const commentText = "untrusted comment body marker";
  for (const [type, code] of [["RATE_LIMITED", "github_transient_error"], ["INTERNAL_ERROR", "github_protocol_error"]] as const) {
    const fetcher: typeof fetch = async () => graphqlResponse({
      errors: [{ type, message: `Bearer top-secret ${commentText} graphql-response-body-marker` }],
    });
    const api = client("https://api.github.test", { graphqlUrl: "https://api.github.test/graphql", fetch: fetcher });
    await assert.rejects(api.listReviewThreads(repo, 7), (error: unknown) => {
      assert(error instanceof GitHubClientError);
      assert.equal(error.code, code);
      assert(!error.message.includes("top-secret"));
      assert(!error.message.includes(commentText));
      assert(!error.message.includes("graphql-response-body-marker"));
      return true;
    });
  }
});

test("maps GraphQL HTTP authentication and not-found errors distinctly", async () => {
  for (const [status, code] of [[401, "github_auth_failed"], [404, "github_protocol_error"]] as const) {
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount += 1;
      return graphqlResponse({ error: "Bearer top-secret" }, status);
    };
    const api = client("https://api.github.test", { graphqlUrl: "https://api.github.test/graphql", fetch: fetcher });
    await assert.rejects(api.listReviewThreads(repo, 7), (error: unknown) => {
      assert(error instanceof GitHubClientError);
      assert.equal(error.code, code);
      assert.notEqual(error.code, "github_not_found");
      return true;
    });
    assert.equal(requestCount, 1);
  }
});

test("retries GraphQL rate limits using injected delays", async () => {
  const delays: number[] = [];
  let requestCount = 0;
  const fetcher: typeof fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) return graphqlResponse({}, 429, { "retry-after": "2" });
    if (requestCount === 2) return graphqlResponse({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1002" });
    return graphqlResponse(reviewPage());
  };
  const api = client("https://api.github.test", {
    graphqlUrl: "https://api.github.test/graphql",
    fetch: fetcher,
    now: () => 1_000_000,
    jitter: () => 11,
    sleep: async (ms) => { delays.push(ms); },
  });
  await api.listReviewThreads(repo, 7);
  assert.equal(requestCount, 3);
  assert.deepEqual(delays, [2011, 2011]);
});

test("maps GraphQL server and network failures to transient errors with token redaction", async () => {
  const serverFailure = client("https://api.github.test", {
    graphqlUrl: "https://api.github.test/graphql",
    fetch: async () => graphqlResponse({ detail: "Bearer top-secret" }, 503),
  });
  await assert.rejects(serverFailure.listReviewThreads(repo, 7), (error: unknown) => {
    assert(error instanceof GitHubClientError);
    assert.equal(error.code, "github_transient_error");
    assert(!error.message.includes("top-secret"));
    return true;
  });

  const networkFailure = client("https://api.github.test", {
    graphqlUrl: "https://api.github.test/graphql",
    fetch: async () => { throw new Error("Bearer top-secret network failure"); },
  });
  await assert.rejects(networkFailure.listReviewThreads(repo, 7), (error: unknown) => {
    assert(error instanceof GitHubClientError);
    assert.equal(error.code, "github_transient_error");
    assert(!error.message.includes("top-secret"));
    return true;
  });
});

test("preserves AbortError during GraphQL fetch and retry", async () => {
  const fetchAbort = new AbortController();
  const fetcher: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Bearer top-secret", "AbortError")), { once: true });
  });
  const fetchApi = client("https://api.github.test", { graphqlUrl: "https://api.github.test/graphql", fetch: fetcher });
  const fetchPending = fetchApi.listReviewThreads(repo, 7, fetchAbort.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  fetchAbort.abort();
  await assert.rejects(fetchPending, (error: unknown) => error instanceof Error && error.name === "AbortError" && !error.message.includes("top-secret"));

  const retryAbort = new AbortController();
  const retryApi = client("https://api.github.test", {
    graphqlUrl: "https://api.github.test/graphql",
    fetch: async () => graphqlResponse({}, 429, { "retry-after": "1" }),
    sleep: async (_ms, signal) => await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const retryPending = retryApi.listReviewThreads(repo, 7, retryAbort.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  retryAbort.abort();
  await assert.rejects(retryPending, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("rejects missing or empty GraphQL pagination cursors", async () => {
  for (const endCursor of [null, ""]) {
    const api = client("https://api.github.test", {
      graphqlUrl: "https://api.github.test/graphql",
      fetch: async () => graphqlResponse(reviewPage(true, endCursor)),
    });
    await assert.rejects(api.listReviewThreads(repo, 7), (error: unknown) =>
      error instanceof GitHubClientError && error.code === "github_protocol_error");
  }
});

test("requires graphqlUrl before making a review-thread request", async () => {
  let requestCount = 0;
  const api = client("https://api.github.test", {
    fetch: async () => {
      requestCount += 1;
      return graphqlResponse(reviewPage());
    },
  });
  await assert.rejects(api.listReviewThreads(repo, 7), (error: unknown) =>
    error instanceof GitHubClientError && error.code === "github_protocol_error");
  assert.equal(requestCount, 0);
});
