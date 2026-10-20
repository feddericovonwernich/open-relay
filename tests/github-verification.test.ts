import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRelayEmitter } from "../src/connectors/github/emitter.ts";
import { GitHubVerificationError, normalizeVerification, verificationKey } from "../src/connectors/github/verification.ts";
import type {
  CompletionCandidate,
  GitHubCheckRun,
  GitHubReviewThread,
  GitHubVerificationConfig,
  PrSnapshot,
} from "../src/connectors/github/types.ts";
import type { PrVerificationSettled } from "../src/connectors/github/types.ts";

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

const verification: GitHubVerificationConfig = {
  id: "pr-verification-v1",
  emit: { type: "pr.verification.settled", version: 1 },
  reviewers: {
    "cursor-bugbot": ["bugbot[bot]"],
    "copilot-review": ["copilot[bot]"],
  },
};

const messages = {
  investigate_ci_failures: "Investigate the failed CI checks. Fix failures caused by the change when possible. Otherwise report the cause and why it could not be fixed automatically.",
  resolve_review_findings: "Review the unresolved Bugbot/Copilot comments. If a finding is valid, implement a fix. In every case, reply with the result and resolve the thread when addressed.",
  verify_review_result: "Verify the completed neutral Bugbot result. Confirm whether the run contains findings, cancellation, or an internal error before treating the review as successful.",
} as const;

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

function candidate(overrides: Partial<CompletionCandidate> = {}): CompletionCandidate {
  return {
    provider: "cursor-bugbot",
    triggerId: "bugbot-v1",
    repositoryId: 7,
    pullRequestNumber: 12,
    artifactKind: "check_run",
    artifactId: "2",
    artifactHeadSha: "head-1",
    artifact: {
      name: "Bugbot",
      completion: "completed",
      conclusion: "success",
      completedAt: "2026-09-08T01:00:00Z",
      detailsUrl: "https://ci.example/bugbot/2",
    },
    ...overrides,
  };
}

function thread(overrides: Partial<GitHubReviewThread> = {}): GitHubReviewThread {
  return {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/app.ts",
    startLine: null,
    line: 10,
    commentCount: 3,
    rootComment: {
      id: "comment-1",
      url: "https://github.com/example/repo/pull/12#discussion_r1",
      body: "Please fix this.",
      createdAt: "2026-09-08T02:00:00Z",
      updatedAt: "2026-09-08T02:01:00Z",
      authorLogin: "bugbot[bot]",
    },
    ...overrides,
  };
}

function withRoot(value: GitHubReviewThread, overrides: Partial<GitHubReviewThread["rootComment"]>): GitHubReviewThread {
  return { ...value, rootComment: { ...value.rootComment, ...overrides } };
}

function normalize(
  candidates: readonly CompletionCandidate[] = [candidate()],
  checks: readonly GitHubCheckRun[] = [check()],
  threads: readonly GitHubReviewThread[] = [],
): PrVerificationSettled {
  return normalizeVerification(snapshot, candidates, checks, threads, verification);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  if (Array.isArray(value)) for (const child of value) assertDeepFrozen(child, seen);
  else for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function requestUrl(input: URL | RequestInfo): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
}

test("verification heuristic table emits exact actions, verdict, and CI failure names", () => {
  const cases: Array<{
    name: string;
    candidates?: CompletionCandidate[];
    checks?: GitHubCheckRun[];
    threads?: GitHubReviewThread[];
    actions: PrVerificationSettled["actions"];
    verdict: PrVerificationSettled["verdict"];
    outcome: "success" | "failure";
    failing: string[];
  }> = [
    { name: "passing checks, no findings", actions: [], verdict: "success", outcome: "success", failing: [] },
    {
      name: "failed checks only",
      checks: [check({ id: 3, name: "z-test", conclusion: "failure" }), check({ id: 4, name: "a-build", conclusion: "cancelled" }), check({ id: 5, name: "z-test", conclusion: null })],
      actions: [{ code: "investigate_ci_failures", checkNames: ["a-build", "z-test"], message: messages.investigate_ci_failures }],
      verdict: "action_required",
      outcome: "failure",
      failing: ["a-build", "z-test"],
    },
    {
      name: "unresolved Bugbot only",
      threads: [thread()],
      actions: [{ code: "resolve_review_findings", providers: ["cursor-bugbot"], findingCount: 1, message: messages.resolve_review_findings }],
      verdict: "action_required",
      outcome: "success",
      failing: [],
    },
    {
      name: "unresolved Copilot only",
      threads: [withRoot(thread({ id: "copilot-thread" }), { authorLogin: "COPILOT[BOT]" })],
      actions: [{ code: "resolve_review_findings", providers: ["copilot-review"], findingCount: 1, message: messages.resolve_review_findings }],
      verdict: "action_required",
      outcome: "success",
      failing: [],
    },
    {
      name: "both providers sorted",
      threads: [thread({ id: "bug-thread" }), withRoot(thread({ id: "copilot-thread" }), { authorLogin: "copilot[bot]" })],
      actions: [{ code: "resolve_review_findings", providers: ["copilot-review", "cursor-bugbot"], findingCount: 2, message: messages.resolve_review_findings }],
      verdict: "action_required",
      outcome: "success",
      failing: [],
    },
    {
      name: "failed checks and findings",
      checks: [check({ name: "lint", conclusion: "failure" })],
      threads: [thread()],
      actions: [
        { code: "investigate_ci_failures", checkNames: ["lint"], message: messages.investigate_ci_failures },
        { code: "resolve_review_findings", providers: ["cursor-bugbot"], findingCount: 1, message: messages.resolve_review_findings },
      ],
      verdict: "action_required",
      outcome: "failure",
      failing: ["lint"],
    },
    {
      name: "neutral Bugbot without Bugbot thread",
      candidates: [candidate({ artifact: { ...candidate().artifact, name: "Bugbot neutral", conclusion: "neutral" } })],
      actions: [{ code: "verify_review_result", provider: "cursor-bugbot", checkName: "Bugbot neutral", message: messages.verify_review_result }],
      verdict: "action_required",
      outcome: "success",
      failing: [],
    },
    {
      name: "neutral Bugbot with unresolved Copilot thread",
      candidates: [candidate({ artifact: { ...candidate().artifact, name: "Bugbot neutral", conclusion: "neutral" } })],
      threads: [withRoot(thread({ id: "copilot-thread" }), { authorLogin: "COPILOT[BOT]" })],
      actions: [
        { code: "resolve_review_findings", providers: ["copilot-review"], findingCount: 1, message: messages.resolve_review_findings },
        { code: "verify_review_result", provider: "cursor-bugbot", checkName: "Bugbot neutral", message: messages.verify_review_result },
      ],
      verdict: "action_required",
      outcome: "success",
      failing: [],
    },
    {
      name: "neutral Bugbot with unresolved Bugbot thread",
      candidates: [candidate({ artifact: { ...candidate().artifact, conclusion: "neutral" } })],
      threads: [thread()],
      actions: [{ code: "resolve_review_findings", providers: ["cursor-bugbot"], findingCount: 1, message: messages.resolve_review_findings }],
      verdict: "action_required",
      outcome: "success",
      failing: [],
    },
  ];

  for (const entry of cases) {
    const payload = normalize(entry.candidates ?? [candidate()], entry.checks ?? [check()], entry.threads ?? []);
    assert.deepEqual(payload.actions, entry.actions, entry.name);
    assert.equal(payload.verdict, entry.verdict, entry.name);
    assert.equal(payload.ci.outcome, entry.outcome, entry.name);
    assert.deepEqual(payload.ci.failingCheckNames, entry.failing, entry.name);
  }
});

test("only exact success, neutral, and skipped conclusions pass terminal checks", () => {
  for (const conclusion of ["success", "neutral", "skipped"] as const) {
    assert.equal(normalize([candidate()], [check({ conclusion })]).ci.outcome, "success", conclusion);
  }
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "", null] as const) {
    const payload = normalize([candidate()], [check({ conclusion })]);
    assert.equal(payload.ci.outcome, "failure", String(conclusion));
    assert.deepEqual(payload.ci.failingCheckNames, ["build"], String(conclusion));
  }
});

test("filters configured bot roots case-insensitively and canonicalizes review evidence", () => {
  const payload = normalize([candidate()], [check()], [
    thread({ id: "human", rootComment: { ...thread().rootComment, authorLogin: "human" } }),
    thread({ id: "unconfigured", rootComment: { ...thread().rootComment, authorLogin: "other[bot]" } }),
    thread({ id: "resolved", isResolved: true }),
    thread({ id: "bug-z", path: "z.ts", line: 2, rootComment: { ...thread().rootComment, authorLogin: "BUGBOT[BOT]" } }),
    thread({ id: "copilot-a", path: "a.ts", line: 1, rootComment: { ...thread().rootComment, authorLogin: "COPILOT[BOT]" } }),
    thread({ id: "bug-a", path: "a.ts", line: 1, isOutdated: true }),
  ]);
  assert.deepEqual(payload.reviews.findings.map(({ provider, path, line, threadId }) => ({ provider, path, line, threadId })), [
    { provider: "copilot-review", path: "a.ts", line: 1, threadId: "copilot-a" },
    { provider: "cursor-bugbot", path: "a.ts", line: 1, threadId: "bug-a" },
    { provider: "cursor-bugbot", path: "z.ts", line: 2, threadId: "bug-z" },
  ]);
  assert.equal(payload.reviews.unresolvedCount, 3);
  assert.equal(payload.reviews.includedCount, 3);
  assert.equal(payload.reviews.findings[0].replyCount, 2);
  assert.equal(payload.reviews.findings[1].isOutdated, true);
});

test("truncates root bodies by Unicode code points and excludes comment timestamps and full body", () => {
  const fullBody = `${"😀".repeat(2_000)}FULL_UNTRUNCATED_BODY`;
  const payload = normalize([candidate()], [check()], [withRoot(thread(), {
    body: fullBody,
    createdAt: "COMMENT_CREATED_SHOULD_NOT_WIRE",
    updatedAt: "COMMENT_UPDATED_SHOULD_NOT_WIRE",
  })]);
  const finding = payload.reviews.findings[0];
  assert.equal(finding.body, "😀".repeat(2_000));
  assert.equal(Array.from(finding.body).length, 2_000);
  assert.equal(finding.bodyTruncated, true);
  const wire = JSON.stringify(payload);
  assert.equal(wire.includes("FULL_UNTRUNCATED_BODY"), false);
  assert.equal(wire.includes("COMMENT_CREATED_SHOULD_NOT_WIRE"), false);
  assert.equal(wire.includes("COMMENT_UPDATED_SHOULD_NOT_WIRE"), false);
});

test("preserves total unresolved and replies while limiting findings to twenty", () => {
  const threads = Array.from({ length: 21 }, (_, index) => thread({
    id: `thread-${String(index).padStart(2, "0")}`,
    commentCount: index - 1,
    line: index + 1,
  }));
  const payload = normalize([candidate()], [check()], threads);
  assert.equal(payload.reviews.unresolvedCount, 21);
  assert.equal(payload.reviews.includedCount, 20);
  assert.equal(payload.reviews.totalReplyCount, threads.reduce((sum, value) => sum + Math.max(0, value.commentCount - 1), 0));
  assert.equal(payload.reviews.truncated, true);
  assert.equal(payload.reviews.findings.length, 20);
});

test("applies the final canonical UTF-8 48 KiB review budget", () => {
  const threads = Array.from({ length: 20 }, (_, index) => withRoot(thread({
    id: `large-${String(index).padStart(2, "0")}`,
    line: index + 1,
  }), { body: "é".repeat(2_000) }));
  const payload = normalize([candidate()], [check()], threads);
  assert.ok(Buffer.byteLength(JSON.stringify(payload.reviews), "utf8") <= 48 * 1024);
  assert.ok(payload.reviews.includedCount < 20);
  assert.equal(payload.reviews.truncated, true);
});

test("digest covers every matching unresolved thread, including omitted evidence", () => {
  const threads = Array.from({ length: 20 }, (_, index) => withRoot(thread({
    id: `digest-${String(index).padStart(2, "0")}`,
    line: index + 1,
  }), { body: "é".repeat(2_000) }));
  const first = normalize([candidate()], [check()], threads);
  const changed = [...threads.slice(0, 19), withRoot(threads[19], { body: "CHANGED_OMITTED_BODY" })];
  const second = normalize([candidate()], [check()], changed);
  assert.equal(first.reviews.includedCount < first.reviews.unresolvedCount, true);
  assert.notEqual(first.reviews.evidenceDigest, second.reviews.evidenceDigest);
});

test("deep-freezes every payload object and array", () => {
  assertDeepFrozen(normalize([candidate()], [check()], [thread()]));
});

test("verification identity is canonical and has the required envelope", () => {
  const candidates = [candidate(), candidate({ triggerId: "copilot-v1", provider: "copilot-review", artifactKind: "pull_request_review", artifactId: "1", artifact: { ...candidate().artifact, name: "Copilot", completion: "submitted", conclusion: "submitted" } })];
  const checks = [check({ id: 2, name: "build" }), check({ id: 1, name: "lint" })];
  const threads = [thread({ id: "b" }), thread({ id: "a", line: 2 })];
  const first = normalize(candidates, checks, threads);
  const second = normalize([...candidates].reverse(), [...checks].reverse(), [...threads].reverse());
  assert.deepEqual(first, second);
  assert.equal(verificationKey(first), verificationKey(second));
  assert.match(verificationKey(first), /^github:7:verification-settled:pull-request:12:head:head-1:payload:[a-f0-9]{64}$/);

  const mutations: Array<[string, PrVerificationSettled]> = [
    ["conclusion", normalize(candidates, [check({ conclusion: "failure" })], threads)],
    ["timestamp", normalize(candidates, [check({ completedAt: "2026-09-09T01:00:00Z" })], threads)],
    ["url", normalize(candidates, [check({ detailsUrl: "https://ci.example/changed" })], threads)],
    ["automation", normalize([{ ...candidates[0], artifact: { ...candidates[0].artifact, name: "Changed automation" } }, candidates[1]], checks, threads)],
    ["resolution", normalize(candidates, checks, [thread({ id: "b", isResolved: true }), threads[1]])],
    ["root edit", normalize(candidates, checks, [withRoot(threads[0], { body: "edited" }), threads[1]])],
  ];
  for (const [label, mutated] of mutations) assert.notEqual(verificationKey(mutated), verificationKey(first), label);
});

test("selects the first neutral Bugbot artifact from canonical artifact order", () => {
  const z = candidate({ triggerId: "z-trigger", artifactId: "9", artifact: { ...candidate().artifact, name: "bugbot-z", conclusion: "neutral" } });
  const a = candidate({ triggerId: "a-trigger", artifactId: "1", artifact: { ...candidate().artifact, name: "bugbot-a", conclusion: "neutral" } });
  const first = normalize([z, a], [check()], []);
  const second = normalize([a, z], [check()], []);
  assert.deepEqual(first.actions, [{ code: "verify_review_result", provider: "cursor-bugbot", checkName: "bugbot-a", message: messages.verify_review_result }]);
  assert.deepEqual(second.actions, first.actions);
  assert.equal(verificationKey(second), verificationKey(first));
});

test("changes identity for omitted evidence as well as included payload fields", () => {
  const threads = Array.from({ length: 20 }, (_, index) => withRoot(thread({ id: `omitted-${index}`, line: index }), { body: "é".repeat(2_000) }));
  const first = normalize([candidate()], [check()], threads);
  const changed = [...threads.slice(0, 19), withRoot(threads[19], { body: "an omitted body changed" })];
  assert.notEqual(verificationKey(normalize([candidate()], [check()], changed)), verificationKey(first));
});

test("rejects complete payloads over 65,536 UTF-8 bytes before Relay", async () => {
  const checks = Array.from({ length: 20 }, (_, id) => check({ id, name: `check-${id}-${"x".repeat(4_000)}`, detailsUrl: `https://ci.example/${"u".repeat(1_000)}` }));
  const payload = normalize([candidate()], checks, []);
  assert.throws(() => verificationKey(payload), (error: unknown) => {
    assert.equal(error instanceof GitHubVerificationError, true);
    assert.equal((error as { code?: string }).code, "verification_payload_too_large");
    return true;
  });

  let fetchCalls = 0;
  const emitter = new GitHubRelayEmitter({
    baseUrl: "https://relay.test",
    adminToken: "admin-secret",
    fetch: async () => {
      fetchCalls += 1;
      return response(201, { event: { id: "never" } });
    },
  });
  await assert.rejects(emitter.emitVerification(verification, snapshot, payload), (error: unknown) => (error as { code?: string }).code === "verification_payload_too_large");
  assert.equal(fetchCalls, 0);
});

