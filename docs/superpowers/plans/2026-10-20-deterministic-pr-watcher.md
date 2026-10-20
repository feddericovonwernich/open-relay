# Deterministic PR Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit one deterministic `pr.verification.settled@1` notification from current-head GitHub automation, Check Run, and configured bot-review evidence, then deliver it to one waiting agent through the existing `relay notify` command.

**Architecture:** Extend the existing combined GitHub repository path instead of adding a second aggregator. The connector fetches authoritative review-thread state through GitHub GraphQL, builds one bounded immutable payload with fixed heuristics, observes the payload twice in continuous mode, and emits it through the existing Relay queue. The existing notification-only handler, lease path, and `relay notify` command remain the delivery boundary.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Node built-in test runner, GitHub REST and GraphQL APIs, existing Relay HTTP and SQLite runtime. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-deterministic-pr-watcher-design.md`

## Global Constraints

- The feature is opt-in through `verification` and is valid only when at least one repository uses `configured-tools-and-generic-check-runs`.
- Existing `pr.automation.completed@1`, `pr.automation.settled@1`, and `pr.ci.settled@1` payloads, identities, calls, and failure behavior MUST remain unchanged.
- The unified payload is deterministic. No LLM inference, free-form action text, automatic code modification, GitHub reply, or thread resolution is in scope.
- GitHub Check Run fields, review bodies, paths, URLs, and logins are untrusted data. Never interpolate them into fixed action messages or logs.
- GraphQL or unified-event failures suppress only unified verification. Previously accepted configured-tool and generic-CI events remain accepted.
- Authentication failures remain connector-fatal. Unified Relay `404` and `409` disable only verification for the affected repository and process.
- Continuous mode requires two consecutive identical eligible observations. `--once` emits one eligible observation immediately.
- Final-head verification is REQUIRED before unified emission. Head drift resets the observation and emits nothing.
- Notification delivery remains at-least-once across crashes. Do not alter the existing `handler.kind: "notification"` or `relay notify` lifecycle.
- The generated GitHub project includes the event and schemas but leaves `verification` disabled until the operator supplies reviewer identities.
- Review evidence includes at most 20 findings, 2,000 Unicode code points per body, and 48 KiB of canonical review JSON. The Relay definition keeps `maxPayloadBytes: 65536`.
- Keep the connector dependency-free. Use Node `crypto`, `fetch`, `Buffer.byteLength`, and existing Relay primitives.
- Do not add the deferred `.gitignore`, health/status, Sonar onboarding, credential-refresh, daemon, or generic aggregation workstreams.
- Before each behavior change, write one focused failing test. Do not pin incidental implementation details or duplicate the same behavior at multiple layers.
- Run tests/builds only at task checkpoints. Commit only source, tests, docs, examples, and actual `npm run build` output.

## File and interface map

- `src/connectors/github/types.ts`: normalized configuration, GraphQL evidence, and unified payload types.
- `src/connectors/github/config.ts`: trust-boundary validation, URL defaults, reviewer identity rules, and deep freezing.
- `src/connectors/github/client.ts`: existing REST transport plus the GraphQL review-thread query and strict decoder.
- `src/connectors/github/verification.ts`: new pure evidence normalization and fixed heuristic analyzer.
- `src/connectors/github/emitter.ts`: unified payload identity and Relay emission.
- `src/connectors/github/runner.ts`: eligibility, observation state, final-head fence, isolation, and operability logs.
- `src/init.ts` and `examples/github-pr-automation/.relay/`: dormant generated event and schemas.
- `tests/github-config.test.ts`, `tests/github-client.test.ts`, `tests/github-verification.test.ts`, `tests/github-emitter.test.ts`, `tests/github-runner.test.ts`, `tests/onboarding.test.ts`: focused contracts.
- `tests/pr-verification-e2e.test.ts`: fake REST/GraphQL plus real Relay and real `relay notify` lifecycle.
- `README.md` and `docs/agent-quickstart.md`: operator configuration and process-supervision sequence.

## Execution order

1. Complete Tasks 1, 2, 3, and 4 in order because they extend shared types and generated contracts.
2. Complete Task 5 after Tasks 2 and 3.
3. Complete Task 6 after all earlier tasks.

---

### Task 1: Add the verification configuration contract

**Files:**
- Modify: `src/connectors/github/types.ts:1-24`
- Modify: `src/connectors/github/config.ts:24-49,144-165,188-195,256-325`
- Test: `tests/github-config.test.ts`

**Interfaces:**
- Consumes: existing `GitHubConnectorConfig`, `TriggerConfig`, `emit()`, `apiUrl()`, `freeze()`, and combined repository mode.
- Produces:

```ts
export type VerificationProvider = "cursor-bugbot" | "copilot-review";

export interface GitHubVerificationConfig {
  id: string;
  emit: { type: string; version: number };
  reviewers: {
    "cursor-bugbot"?: string[];
    "copilot-review"?: string[];
  };
}

export interface GitHubConnectorConfig {
  connector: "github";
  apiBaseUrl: string;
  graphqlUrl?: string;
  apiVersion: string;
  tokenEnv: string;
  pollIntervalMs: number;
  lookbackHours: number;
  repositories: GitHubRepositoryConfig[];
  triggers: TriggerConfig[];
  aggregate?: {
    id: string;
    emit: { type: string; version: number };
  };
  verification?: GitHubVerificationConfig;
}
```

- Later tasks rely on reviewer logins being lowercase, unique across both provider lists, deeply frozen, and present only for configured providers.

- [ ] **Step 1: Add failing acceptance and defaulting tests**

Add a `verificationConfig()` fixture that starts from `validConfig()`, switches its repository to combined mode, and adds:

```ts
verification: {
  id: "pr-verification-settled-v1",
  emit: { type: "pr.verification.settled", version: 1 },
  reviewers: {
    "cursor-bugbot": ["Cursor[bot]"],
    "copilot-review": ["Copilot-Pull-Request-Reviewer[bot]"],
  },
}
```

Assert that `validateGitHubConnectorConfig()`:

```ts
assert.equal(config.graphqlUrl, "https://api.github.com/graphql");
assert.deepEqual(config.verification?.reviewers, {
  "cursor-bugbot": ["cursor[bot]"],
  "copilot-review": ["copilot-pull-request-reviewer[bot]"],
});
assert.equal(Object.isFrozen(config.verification), true);
assert.equal(Object.isFrozen(config.verification?.reviewers["cursor-bugbot"]), true);
```

Also assert that a verification-disabled default configuration has neither an own `graphqlUrl` nor an own `verification` property.

- [ ] **Step 2: Add failing validation-code cases**

Use the existing `errorWithCode()` helper and add one assertion for each exact code:

| Invalid input | Expected code |
|---|---|
| Verification with no combined repository | `verification_mode` |
| Verification ID collides with a trigger or aggregate ID | `verification_id_duplicate` |
| Bugbot trigger exists but Bugbot reviewer list is absent | `verification_reviewer_required` |
| Copilot trigger exists but Copilot reviewer list is absent | `verification_reviewer_required` |
| Reviewer key exists without that provider trigger | `verification_reviewer_unused` |
| A case-insensitive login appears twice within or across provider lists | `verification_reviewer_duplicate` |
| Reviewers is not an object or has an unknown provider key | `verification_reviewers` or existing `unknown_property`, respectively |
| Verification uses a non-default REST URL without `graphqlUrl` | `graphql_url_required` |
| GraphQL URL uses credentials, query, fragment, non-HTTPS, or non-loopback HTTP | `graphql_url` |

Use `allowLoopbackHttp: true` for valid local REST and GraphQL URL tests. Keep the existing `secret_key` traversal assertion active inside `verification.reviewers`.

- [ ] **Step 3: Run the config test and verify RED**

Run:

```bash
node --test tests/github-config.test.ts
```

Expected: the new top-level keys are rejected with `unknown_property` and `config.verification` does not exist.

- [ ] **Step 4: Add the normalized types and parser**

Extend `TOP_LEVEL_KEYS` with `graphqlUrl` and `verification`. Generalize the trusted URL validator to accept a field name and error code without changing `apiBaseUrl` behavior:

```ts
function trustedUrl(
  value: unknown,
  field: "apiBaseUrl" | "graphqlUrl",
  code: "api_url" | "graphql_url",
  options: GitHubConfigValidationOptions,
): string
```

Parse `verification` only when present. Apply these rules in this order:

1. Parse repositories and triggers as today.
2. Parse explicit `graphqlUrl` with `trustedUrl()`.
3. Parse `verification.id` with `TRIGGER_ID` and `verification.emit` with existing `emit()`.
4. Require at least one combined repository.
5. Reject ID collision with any trigger or aggregate ID.
6. Accept only `cursor-bugbot` and `copilot-review` reviewer keys.
7. Lowercase each login, reject empty values, and reject duplicates across both lists.
8. Require a reviewer list for each matching configured trigger and reject lists for absent providers.
9. When verification is enabled, default the exact REST base `https://api.github.com` to `https://api.github.com/graphql`; otherwise require explicit `graphqlUrl`.
10. Include `graphqlUrl` in normalized output only when explicit or required by verification. Include `verification` only when configured.
11. Return the existing recursive `freeze(normalized)` result.

Do not add a separate configuration format or per-repository verification mapping.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --test tests/github-config.test.ts tests/cli.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass. Existing configured-only and generic-only fixtures remain valid without new fields.

- [ ] **Step 6: Commit the configuration contract**

```bash
git add src/connectors/github/types.ts src/connectors/github/config.ts tests/github-config.test.ts
git commit -m "feat(github): add verification configuration"
```

---

### Task 2: Fetch authoritative review-thread evidence through GraphQL

**Files:**
- Modify: `src/connectors/github/types.ts`
- Modify: `src/connectors/github/client.ts:1-20,176-318`
- Test: `tests/github-client.test.ts`

**Interfaces:**
- Consumes: normalized `GitHubConnectorConfig.graphqlUrl`, existing `GitHubClientOptions` transport hooks, `GitHubClientError`, rate-limit delay, abort behavior, and secret redaction.
- Produces:

```ts
export interface GitHubReviewComment {
  id: string;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
}

export interface GitHubReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  commentCount: number;
  rootComment: GitHubReviewComment;
}

export interface GitHubClientOptions {
  baseUrl: string;
  graphqlUrl?: string;
  apiVersion: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
}

GitHubClient.listReviewThreads(
  repository: string,
  pullRequestNumber: number,
  signal?: AbortSignal,
): Promise<GitHubReviewThread[]>;
```

- [ ] **Step 1: Add a failing exact-request and pagination test**

Construct `GitHubClient` with an injected `fetch` and `graphqlUrl: "https://api.github.test/graphql"`. Capture every request body and return two pages. Assert:

- method is `POST`;
- headers contain bearer authorization, `application/json`, `X-GitHub-Api-Version`, and the existing user agent;
- query is named `PullRequestReviewThreads` and requests exactly the fields in the spec;
- first variables are `{ owner: "octo", name: "repo", number: 7, after: null }`;
- second variables use the returned `endCursor`;
- the result preserves `commentCount` and the first comment as `rootComment`.

Use this response shape:

```ts
{
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [{
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
          }],
        },
      },
    },
  },
}
```

- [ ] **Step 2: Add failing malformed, error, redaction, rate-limit, and abort cases**

Cover these observable boundaries:

- `data.repository`, `pullRequest`, a thread, `comments.totalCount`, an empty `comments.nodes`, or any root-comment field is missing: reject with `GitHubClientError.code === "github_protocol_error"`.
- A GraphQL top-level error with `type: "RATE_LIMITED"` maps to `github_transient_error`; any other top-level `errors` response maps to `github_protocol_error`. Neither message contains the token, GraphQL response body, or comment text.
- HTTP `401` maps to `github_auth_failed`.
- A GraphQL HTTP `404` maps to `github_protocol_error`, not the REST-only `github_not_found`; it never reaches the repository-level disable path.
- HTTP `403`/`429` with `Retry-After` or rate-limit reset uses the injected `sleep`, then retries.
- HTTP `5xx` and network failures map to `github_transient_error` with token redaction.
- Aborting the signal during fetch or retry preserves an `AbortError`.
- `hasNextPage: true` with a missing/empty cursor is a protocol error.
- Calling `listReviewThreads()` without `graphqlUrl` is a protocol error and makes no request.

- [ ] **Step 3: Run the client test and verify RED**

Run:

```bash
node --test tests/github-client.test.ts
```

Expected: `graphqlUrl` and `listReviewThreads()` do not exist.

- [ ] **Step 4: Implement the GraphQL query and strict decoder in `client.ts`**

Keep the REST methods byte-for-byte behaviorally unchanged. Add one module-level query constant using the exact query from the spec. Split `owner/repository` at the already validated slash and POST one JSON body per page.

Decode every thread atomically. Do not use the REST diagnostic buffer for malformed GraphQL nodes: one malformed thread makes the entire review evidence unavailable for that cycle. Require at least one root comment. Preserve `comments.totalCount` as `commentCount`; do not paginate replies because only the root body and total reply count are required.

Reuse the existing HTTP error taxonomy, retry timing, abort conversion, and `safeMessage()` token redaction, with one isolation exception: GraphQL `404` becomes `github_protocol_error` rather than the REST `github_not_found`. Decode `errors[].type === "RATE_LIMITED"` as `github_transient_error`. Do not add GraphQL response caching.

- [ ] **Step 5: Run client and config tests**

Run:

```bash
node --test tests/github-client.test.ts tests/github-config.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 6: Commit GraphQL evidence acquisition**

```bash
git add src/connectors/github/types.ts src/connectors/github/client.ts tests/github-client.test.ts
git commit -m "feat(github): fetch review thread evidence"
```

---

### Task 3: Build the bounded deterministic verification payload and emitter

**Files:**
- Create: `src/connectors/github/verification.ts`
- Create: `tests/github-verification.test.ts`
- Modify: `src/connectors/github/types.ts`
- Modify: `src/connectors/github/emitter.ts:1-4,97-124,237-314`
- Test: `tests/github-emitter.test.ts`

**Interfaces:**
- Consumes: `GitHubVerificationConfig`, `GitHubReviewThread`, `PrSnapshot`, recognized `CompletionCandidate[]`, terminal current-head `GitHubCheckRun[]`, existing `normalizeSettled()`, `normalizeCiSettled()`, `pullRequestCorrelationId()`, and emitter `postSettled()`.
- Produces:

```ts
export type VerificationAction =
  | { code: "investigate_ci_failures"; checkNames: string[]; message: "Investigate the failed CI checks. Fix failures caused by the change when possible. Otherwise report the cause and why it could not be fixed automatically." }
  | { code: "resolve_review_findings"; providers: VerificationProvider[]; findingCount: number; message: "Review the unresolved Bugbot/Copilot comments. If a finding is valid, implement a fix. In every case, reply with the result and resolve the thread when addressed." }
  | { code: "verify_review_result"; provider: "cursor-bugbot"; checkName: string; message: "Verify the completed neutral Bugbot result. Confirm whether the run contains findings, cancellation, or an internal error before treating the review as successful." };

export interface PrVerificationSettled {
  schemaVersion: 1;
  provider: "github";
  repository: { id: number; fullName: string };
  pullRequest: {
    number: number;
    url: string;
    headSha: string;
    baseRef: string;
  };
  verdict: "success" | "action_required";
  automation: {
    artifacts: Array<{
      triggerId: string;
      provider: string;
      kind: "check_run" | "pull_request_review";
      id: string;
      name: string;
      completion: "completed" | "submitted";
      conclusion: string | null;
      completedAt: string;
      detailsUrl: string | null;
    }>;
  };
  ci: {
    outcome: "success" | "failure";
    checks: Array<{
      id: string;
      name: string;
      conclusion: string | null;
      completedAt: string;
      detailsUrl: string | null;
    }>;
    failingCheckNames: string[];
  };
  reviews: {
    unresolvedCount: number;
    includedCount: number;
    totalReplyCount: number;
    truncated: boolean;
    evidenceDigest: string;
    findings: Array<{
      provider: VerificationProvider;
      threadId: string;
      rootCommentId: string;
      authorLogin: string;
      url: string;
      path: string;
      startLine: number | null;
      line: number | null;
      isOutdated: boolean;
      body: string;
      bodyTruncated: boolean;
      replyCount: number;
    }>;
  };
  actions: VerificationAction[];
}

export function normalizeVerification(
  snapshot: PrSnapshot,
  candidates: readonly CompletionCandidate[],
  checks: readonly GitHubCheckRun[],
  threads: readonly GitHubReviewThread[],
  verification: GitHubVerificationConfig,
): PrVerificationSettled;

export function verificationKey(payload: PrVerificationSettled): string;

export class GitHubVerificationError extends Error {
  readonly code = "verification_payload_too_large";

  constructor() {
    super("verification payload exceeds 65536 bytes");
    this.name = "GitHubVerificationError";
  }
}

GitHubRelayEmitter.emitVerification(
  verification: GitHubVerificationConfig,
  snapshot: PrSnapshot,
  payload: PrVerificationSettled,
  signal?: AbortSignal,
): Promise<"emitted" | "replayed">;
```

- [ ] **Step 1: Write table-driven failing heuristic tests**

Create immutable `snapshot`, configured automation candidates, current Check Runs, thread, and verification fixtures. Assert the complete `actions`, `verdict`, `ci.outcome`, and `ci.failingCheckNames` for:

| Evidence | Expected actions in exact order |
|---|---|
| Passing checks, no unresolved findings | `[]` |
| Failed checks only | `investigate_ci_failures` |
| Unresolved Bugbot only | `resolve_review_findings` |
| Unresolved Copilot only | `resolve_review_findings` |
| Both providers unresolved | one `resolve_review_findings` with providers sorted |
| Failed checks and unresolved findings | `investigate_ci_failures`, then `resolve_review_findings` |
| Neutral Bugbot and no unresolved Bugbot thread | `verify_review_result` |
| Neutral Bugbot with unresolved Bugbot thread | `resolve_review_findings` only |

Passing conclusions are exactly `success`, `neutral`, and `skipped`. Every other terminal conclusion, including `null`, is failing. Failing names are unique and lexicographically sorted. Fixed messages must equal the literal strings above.

- [ ] **Step 2: Add failing evidence canonicalization and bounds tests**

Assert that normalization:

- matches the root author case-insensitively against configured reviewer logins;
- ignores human and unconfigured-bot threads;
- excludes `isResolved: true` and includes unresolved outdated threads;
- sorts findings by provider, path, line, then thread ID;
- computes `replyCount` as `Math.max(0, commentCount - 1)`;
- truncates a body after 2,000 Unicode code points without splitting a surrogate pair and sets `bodyTruncated: true`;
- includes at most 20 findings;
- stops before `Buffer.byteLength(JSON.stringify(reviews), "utf8")` exceeds `48 * 1024`;
- sets `totalReplyCount` to the sum of `Math.max(0, commentCount - 1)` across every matching unresolved thread, including findings omitted by count or byte limits; preserves total `unresolvedCount`, actual `includedCount`, each included finding's `replyCount`, and `truncated: true` when findings are omitted;
- computes `evidenceDigest` over every matching unresolved thread using provider, thread ID, resolution/outdated state, path, line range, root comment ID, author login, `updatedAt`, and SHA-256 of the full untruncated root body;
- changes `evidenceDigest` when an omitted body changes;
- deep-freezes every payload object and array;
- rejects a complete payload larger than 65,536 UTF-8 bytes through `GitHubVerificationError.code === "verification_payload_too_large"` before any Relay request.
- never copies comment `createdAt`, `updatedAt`, or the full untruncated body into the wire payload.

Measure the 48 KiB limit against the final canonical `reviews` object, including counts, digest, finding metadata, escaped JSON, and UTF-8 bytes. Add a candidate only when the resulting canonical object remains within the limit.

- [ ] **Step 3: Add failing identity and emitter tests**

Assert:

```ts
assert.match(
  verificationKey(payload),
  /^github:7:verification-settled:pull-request:12:head:head-1:payload:[a-f0-9]{64}$/,
);
```

Provide at least two neutral Cursor Bugbot candidates with reversed input order. Assert both runs select the first neutral Bugbot artifact from canonical artifact order, produce one `verify_review_result` action, use the same `checkName`, and produce the same payload identity.

Reordering input candidates, checks, or threads must not change normalized JSON or the key. Changing a conclusion, timestamp, URL, automation artifact, thread resolution, root edit, or omitted evidence must change the key.

Add an emitter test that captures `/v1/events` and asserts:

```ts
{
  type: "pr.verification.settled",
  version: 1,
  payload,
  idempotencyKey: verificationKey(payload),
  correlationId: "github:example/repo:pull-request:12",
}
```

Create an oversized payload by using many long Check Run names/URLs or configured artifacts. Assert `verificationKey()` throws `verification_payload_too_large` and `emitVerification()` makes zero fetch calls.

Assert `201 -> "emitted"`, `200 -> "replayed"`, `404 -> verification_invalid`, and `409 -> verification_drift` without secrets or review bodies in errors.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
node --test tests/github-verification.test.ts tests/github-emitter.test.ts
```

Expected: `verification.ts`, payload types, identity, and emitter method do not exist.

- [ ] **Step 5: Implement the minimum pure analyzer**

In `verification.ts`:

1. Map configured reviewer logins to provider once per call.
2. Filter to matching unresolved threads and construct one canonical digest record per thread. Hash the full body before any wire truncation.
3. Sort canonical records before hashing and sort candidate findings by provider, path, nullable line (`null` last), then thread ID.
4. Build finding bodies using Unicode code points, then apply the count and canonical UTF-8 budget.
5. Reuse `normalizeSettled(snapshot, candidates).artifacts` for automation ordering.
6. Reuse `normalizeCiSettled(snapshot, checks)` for check ordering and outcome, then derive unique failing names.
7. Build actions in fixed CI, review, neutral-Bugbot order. For `verify_review_result`, filter canonical normalized automation artifacts to neutral `cursor-bugbot` Check Runs and select exactly the first artifact; input order never chooses the action.
8. Set `verdict` from `actions.length` and recursively freeze the complete payload.

Do not add a rules engine, strategy interface, provider registry, or configurable messages.

- [ ] **Step 6: Implement identity and emission**

Serialize the complete payload once inside `verificationKey()`. Before hashing, reject UTF-8 payloads larger than 65,536 bytes with `new GitHubVerificationError()`. Otherwise hash the same serialized bytes with SHA-256. `emitVerification()` calls this gate before credential acquisition or `/v1/events`, then reuses `postSettled()` so correlation, aborts, response decoding, and redaction stay unchanged. Pass error codes `{ drift: "verification_drift", invalid: "verification_invalid" }`.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
node --test tests/github-verification.test.ts tests/github-emitter.test.ts tests/github-ci.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass; existing normalizers and keys remain unchanged.

- [ ] **Step 8: Commit deterministic analysis and emission**

```bash
git add src/connectors/github/types.ts src/connectors/github/verification.ts src/connectors/github/emitter.ts tests/github-verification.test.ts tests/github-emitter.test.ts
git commit -m "feat(github): derive verification notifications"
```

---

### Task 4: Generate the dormant notification definition and schemas

**Files:**
- Modify: `src/init.ts:50-269`
- Modify: `tests/onboarding.test.ts:16-34,98-113`
- Create: `examples/github-pr-automation/.relay/events/pr-verification-settled.v1.json`
- Create: `examples/github-pr-automation/.relay/schemas/pr-verification-settled.json`
- Create: `examples/github-pr-automation/.relay/schemas/notification-delivered.json`

**Interfaces:**
- Consumes: existing `handler.kind: "notification"`, generated-file equality test, payload contract from Task 3, and the existing `githubFiles()` generator.
- Produces: a generated but disabled `pr.verification.settled@1` definition and strict input/output schemas. It does not generate an analysis handler Markdown file.

- [ ] **Step 1: Extend the failing onboarding contract**

Add the three paths to `githubPaths`. After `relay init --github`, assert:

```ts
assert.equal(config.verification, undefined);
const definition = registry.resolve("pr.verification.settled", 1).definition;
assert.deepEqual(definition.handler, { kind: "notification" });
assert.equal(definition.requires.maxPayloadBytes, 65_536);
```

Read the generated output schema and assert it is exactly:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": { "delivered": { "const": true } },
  "required": ["delivered"],
  "additionalProperties": false
}
```

Assert that `.relay/handlers/pr-verification-settled.md` does not exist.

- [ ] **Step 2: Run onboarding and verify RED**

Run:

```bash
node --test tests/onboarding.test.ts
```

Expected: generated paths and registry definition are missing.

- [ ] **Step 3: Add the generated event definition**

Add this exact definition to `githubFiles()`:

```json
{
  "type": "pr.verification.settled",
  "version": 1,
  "inputSchema": ".relay/schemas/pr-verification-settled.json",
  "outputSchema": ".relay/schemas/notification-delivered.json",
  "effectPolicy": "retry-safe",
  "timeoutMs": 30000,
  "hardDeadlineMs": 60000,
  "retry": {
    "maxAttempts": 3,
    "backoffMs": [1000, 5000],
    "retryableCodes": ["temporarily_unavailable"]
  },
  "requires": {
    "tools": [],
    "structuredOutput": true,
    "minContextTokens": 0,
    "maxInputTokens": 0,
    "maxOutputTokens": 0,
    "maxPayloadBytes": 65536
  },
  "handler": { "kind": "notification" }
}
```

- [ ] **Step 4: Add the strict input and output schemas**

Translate `PrVerificationSettled` from the spec and Task 3 exactly. Every object level uses `additionalProperties: false`. Required arrays and fields are:

- root: `schemaVersion`, `provider`, `repository`, `pullRequest`, `verdict`, `automation`, `ci`, `reviews`, `actions`;
- repository: `id`, `fullName`;
- pull request: `number`, `url`, `headSha`, `baseRef`;
- automation: `artifacts`; each artifact requires `triggerId`, `provider`, `kind`, `id`, `name`, `completion`, `conclusion`, `completedAt`, `detailsUrl`;
- CI: `outcome`, `checks`, `failingCheckNames`; each check requires `id`, `name`, `conclusion`, `completedAt`, `detailsUrl`;
- reviews: `unresolvedCount`, `includedCount`, `totalReplyCount`, `truncated`, `evidenceDigest`, `findings`; each finding requires `provider`, `threadId`, `rootCommentId`, `authorLogin`, `url`, `path`, `startLine`, `line`, `isOutdated`, `body`, `bodyTruncated`, and `replyCount`;
- actions: `oneOf` the three closed action shapes, each with a constant `code`, constant `message`, exact required fields, and no extra properties.

Use `const` for `schemaVersion`, provider, action codes/messages, and notification result. Use the exact enums and nullable fields from the spec. Do not relax the schema with `additionalProperties: true`.
Set `minimum: 0` on counts, `minItems: 1` on automation artifacts and CI checks, `maxItems: 20` on findings, `maxLength: 2000` on finding bodies, and `pattern: "^[a-f0-9]{64}$"` on `evidenceDigest`. Keep findings and actions optional in cardinality: both arrays can be empty.

- [ ] **Step 5: Regenerate the checked-in example and verify equality**

Generate a temporary GitHub project with `relay init --github owner/repository`, copy only the three new generated files into `examples/github-pr-automation/.relay/`, and run:

```bash
node --test tests/onboarding.test.ts tests/registry.test.ts
npm run typecheck
```

Expected: registry loading and byte-for-byte example equality pass. Existing generated configuration remains configured-only and has no `verification` field.

- [ ] **Step 6: Commit generated contracts**

```bash
git add src/init.ts tests/onboarding.test.ts examples/github-pr-automation/.relay/events/pr-verification-settled.v1.json examples/github-pr-automation/.relay/schemas/pr-verification-settled.json examples/github-pr-automation/.relay/schemas/notification-delivered.json
git commit -m "feat(init): generate verification notification contracts"
```

---

### Task 5: Integrate verification settlement into the combined runner

**Files:**
- Modify: `src/connectors/github/runner.ts:1-101,188-438,449-515`
- Modify: `src/cli.ts:402-430`
- Test: `tests/github-runner.test.ts`

**Interfaces:**
- Consumes: `GitHubClient.listReviewThreads()`, `normalizeVerification()`, `verificationKey()`, `GitHubRelayEmitter.emitVerification()`, existing recognized candidate maps, generic current Check Run snapshots, head verification, and repository/process-scoped disable sets.
- Produces:

```ts
export interface GitHubVerificationObservationState {
  headSha: string;
  identity: string;
  consecutive: number;
  emittedIdentities: Set<string>;
}

export interface GitHubRunnerState {
  transientDelay: number;
  nextEligibleAt: number;
  disabled: boolean;
  ciObservations: Map<number, GitHubCiObservationState>;
  verificationTransientDelay: number;
  verificationNextEligibleAt: number;
  verificationObservations: Map<number, GitHubVerificationObservationState>;
}

export interface GitHubCycleOptions {
  config: GitHubConnectorConfig;
  client: Client;
  emitter?: Emitter;
  signal?: AbortSignal;
  now?: () => number;
  clock?: () => number;
  sleep?: Sleep;
  log?: Log;
  onDiscovery?: (identity: Record<string, unknown>) => void;
  discover?: boolean;
  once?: boolean;
  pullRequestNumber?: number;
  state?: Map<string, GitHubRunnerState>;
  disabledTriggers?: Set<string>;
  disabledAggregates?: Set<string>;
  disabledCiRepositories?: Set<string>;
  disabledVerificationRepositories?: Set<string>;
  headVerifier?: HeadVerifier;
  verifyCurrentHead?: HeadVerifier;
  recognizers?: Partial<Record<RecognizerId, Recognizer>>;
}
```

`consecutive === 0` means the current observation was cleared while same-head `emittedIdentities` remain retained.

- [ ] **Step 1: Add failing eligibility and stability tests**

Create `verificationConfig` from `combinedConfig` with both reviewer lists. Extend `clientFor()` with `listReviewThreads`. Extend emitter fakes with `emitVerification`.

Add focused cases proving:

1. Missing any configured trigger candidate clears the current observation, logs `verification_pending_automation`, and does not call GraphQL or emit verification.
2. Empty, queued, in-progress, or invalid current Check Runs clear the current observation and log `verification_pending_checks`.
3. Successful GraphQL evidence followed by the same normalized identity twice emits once in continuous mode.
4. `once: true` emits the first eligible observation immediately.
5. A final-head mismatch clears the observation, increments `summary.stale`, and emits nothing.
6. Returning from identity A to A+B to A does not re-emit A while the head remains unchanged.
7. A head change discards the complete old observation and emitted identity set.
8. Same-head ineligible evidence sets `consecutive` to zero but retains emitted identities.
9. A missing pull request removes its verification observation.

Assert that pure configured, pure generic, combined without `verification`, a configured-only sibling beside a verification-enabled combined repository, and `discover: true` preserve existing REST calls and make zero GraphQL calls for repositories that are not actively verified.

- [ ] **Step 2: Add failing change and isolation tests**

For each mutation below, observe it twice and assert one new identity/emission:

- late or disappeared Check Run;
- changed Check Run conclusion, completion timestamp, or URL;
- changed configured automation artifact;
- new, resolved, or edited configured-provider thread;
- changed action output.

Add isolation cases:

- GraphQL protocol/transient failure after low-level emissions clears the active same-head observation, records bounded `verification_error`, emits no unified event, and leaves configured and CI counts intact.
- A GraphQL HTTP `404` follows the same verification-error path and never sets repository `state.disabled`; a later cycle still runs configured and generic REST emissions.
- `verification_payload_too_large` records a bounded local `verification_error`, sends no Relay request, and leaves low-level emissions intact.
- A GraphQL transient failure updates only `verificationTransientDelay` and `verificationNextEligibleAt`; low-level paths still execute on the next cycle while verification waits. The first successful post-backoff observation has `consecutive === 1`.
- GraphQL authentication failure aborts the connector as fatal.
- `verification_invalid`/`verification_drift` adds only that repository to `disabledVerificationRepositories`; configured and generic emissions continue there and all paths continue for sibling repositories.
- Ordinary Relay failure leaves a stable eligible verification observation retryable.
- `ci_invalid`/`ci_drift` does not disable verification; current checks are still loaded for verification when generic CI emission is disabled.

- [ ] **Step 3: Add failing operability-log tests**

Capture `options.log` and assert bounded JSON records use exactly these `event` values where applicable:

```text
verification_pending_automation
verification_pending_checks
verification_pending_stability
verification_emitted
verification_replayed
verification_error
```

Every record includes repository, pull request number, and head SHA. Assert serialized logs contain no root body, GitHub token, Relay token, or producer token.

- [ ] **Step 4: Run runner tests and verify RED**

Run:

```bash
node --test tests/github-runner.test.ts
```

Expected: client/emitter fakes lack the new methods and no verification observation exists.

- [ ] **Step 5: Extend runner boundaries without changing low-level ordering**

Update the runner `Client` and `Emitter` picks and the request limiter with `listReviewThreads` and `emitVerification`. Pass `config.graphqlUrl` into the `GitHubClient` constructor in `cli.ts`.

For each pull request:
Gate this block to `repository.mode === "configured-tools-and-generic-check-runs"` and a present `config.verification`; configured-only and generic-only repositories never request GraphQL evidence.

1. Load configured and current Check Run snapshots through the existing paths. When generic CI has been disabled but verification is enabled, still load current checks for verification. Discovery never loads review threads and keeps its existing current-check optimization.
2. Recognize and emit configured candidates exactly as today. Retain `recognizedByTrigger`, `erroredTriggers`, and sorted aggregate candidates for verification.
3. Process generic CI exactly as today.
4. Only then evaluate verification, so a GraphQL or unified-emission failure cannot roll back or suppress earlier low-level work from the cycle.
5. Skip GraphQL when verification is disabled for the repository/process, in verification backoff, pending automation, pending checks, discovery mode, or no emitter exists.
6. Fetch review threads, normalize one payload, and compute one identity.
7. Require two identical consecutive identities unless `once` is true. Treat `consecutive === 0` as no active observation.
8. Before emission, call the existing final-head verifier with the payload head.
9. Add identity to `emittedIdentities` only after `emitted` or `replayed` succeeds.

When pending, empty, invalid, malformed, or unavailable evidence breaks continuity on the same head, retain the state object and emitted identity set but set `consecutive = 0`. On head drift or head change, delete/replace the whole observation. Ordinary Relay emission failure is the exception: keep the eligible consecutive observation retryable. This preserves both the two-observation rule and the A → A+B → A suppression contract.

Use verification-specific backoff fields with the existing delay formula:

```ts
nextDelay = previousDelay === 0
  ? config.pollIntervalMs
  : Math.min(config.pollIntervalMs * 8, previousDelay * 2);
```

Do not reuse repository `nextEligibleAt`, because that would suppress low-level paths and violate failure isolation.

- [ ] **Step 6: Persist the process-scoped disable set across continuous cycles**

Mirror the existing CI set handling in `runGitHubConnector()`:

```ts
const disabledVerificationRepositories =
  options.disabledVerificationRepositories ?? new Set<string>();
```

Pass the same set to every `runGitHubCycle()`. Disable only on `verification_invalid` or `verification_drift`; ordinary Relay failures remain retryable.

- [ ] **Step 7: Run focused regression tests and typecheck**

Run:

```bash
node --test tests/github-runner.test.ts tests/github-client.test.ts tests/github-emitter.test.ts tests/github-ci.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass. Existing configured, generic, and combined tests retain their previous event counts and request ordering.

- [ ] **Step 8: Commit runner settlement**

```bash
git add src/connectors/github/runner.ts src/cli.ts tests/github-runner.test.ts
git commit -m "feat(github): settle verification notifications"
```

---

### Task 6: Prove the complete agent notification lifecycle and document operation

**Files:**
- Create: `tests/pr-verification-e2e.test.ts`
- Modify: `README.md`
- Modify: `docs/agent-quickstart.md`
- Verify: `AGENTS.md`
- Verify/update from build only: `dist/src/`

**Interfaces:**
- Consumes: Tasks 1-5, fake GitHub HTTP server, real Relay registry/store/server, real `GitHubClient`, real `GitHubRelayEmitter`, real connector runner, and real `runCli(["notify", ...])`.
- Produces: one executable proof of REST/GraphQL evidence → stable unified event → parked agent payload, plus copy-and-paste operator instructions.

- [ ] **Step 1: Write the failing real-lifecycle test**

Build a dedicated temporary Relay project with:

- real `pr.automation.completed@1`, `pr.ci.settled@1`, and generated `pr.verification.settled@1` definitions;
- a real runtime file, store, dispatcher, loopback server, and emitter;
- a fake GitHub REST/GraphQL server;
- one combined repository with verification enabled for Bugbot and Copilot;
- one correlation-filtered `runCli(["notify", "--definitions", "pr.verification.settled@1", "--correlation-id", "github:octo/repo:pull-request:197", ...])` call started before unified emission.

Drive these observable stages without wall-clock sleeps:

1. Configured artifacts finish while one current Check Run remains queued. Assert low-level events may exist, unified count remains zero, and notify remains parked.
2. Make all checks terminal with one unresolved configured-provider thread.
3. Run one continuous cycle. Assert unified count remains zero because stability is one.
4. Run an identical second cycle. Assert exactly one `pr.verification.settled@1` event exists with `action_required`, bounded finding evidence, fixed actions, and the expected correlation ID.
5. Await the notify command. Assert exit code `0`, stderr empty, and exactly one stdout JSON line equal to the stored payload. Assert the event is completed with `{ delivered: true }` and no lease file remains.
6. Create a fresh client, emitter, and runner state and execute `once: true`. Assert Relay reports replay and event count does not increase.
7. Change the same-head GraphQL thread to `isResolved: true`, run two continuous observations, and assert one distinct second unified event with the revised verdict/actions.

Also assert no payload, log, error, stdout, or idempotency key contains the GitHub token, Relay admin token, producer token, or an omitted full review body.

- [ ] **Step 2: Run the E2E test and verify RED**

Run:

```bash
node --test tests/pr-verification-e2e.test.ts
```

Expected: verification configuration, GraphQL evidence, unified emission, or generated definition is missing until Tasks 1-5 are complete.

- [ ] **Step 3: Complete only the minimum E2E harness needed for real behavior**

Reuse helpers and production classes directly. Do not add a production mock mode, daemon, health endpoint, polling loop, or test-only source hook. Synchronize parked notify through existing registration/store observations or process events; do not use arbitrary delays.

- [ ] **Step 4: Document enablement and supervision**

Add one concise section to `README.md` and one copy-and-paste procedure to `docs/agent-quickstart.md` that covers:

1. run discovery and pin Sonar identity;
2. change the repository mode to `configured-tools-and-generic-check-runs`;
3. add `graphqlUrl` for GitHub Enterprise, or rely on the public GitHub default;
4. add the `verification` block with exact reviewer logins;
5. start Relay;
6. supervise the connector continuously;
7. supervise this exact waiting command:

```bash
relay notify \
  --definitions pr.verification.settled@1 \
  --correlation-id github:owner/repository:pull-request:197
```

State directly that the command waits without an overall timeout, prints one untrusted JSON payload, acknowledges delivery, and exits. State that the connector does not modify code, reply to GitHub, or resolve threads. Keep `AGENTS.md` unchanged if its existing notification command and trust warning remain accurate.

Include this configuration shape with the existing required trigger bodies omitted only where the surrounding text says so:

```json
{
  "graphqlUrl": "https://api.github.com/graphql",
  "repositories": [{
    "name": "owner/repository",
    "mode": "configured-tools-and-generic-check-runs"
  }],
  "verification": {
    "id": "pr-verification-settled-v1",
    "emit": { "type": "pr.verification.settled", "version": 1 },
    "reviewers": {
      "cursor-bugbot": ["cursor[bot]"],
      "copilot-review": ["copilot-pull-request-reviewer[bot]"]
    }
  }
}
```

- [ ] **Step 5: Run focused verification**

Run:

```bash
node --test \
  tests/github-config.test.ts \
  tests/github-client.test.ts \
  tests/github-verification.test.ts \
  tests/github-emitter.test.ts \
  tests/github-runner.test.ts \
  tests/pr-verification-e2e.test.ts \
  tests/notification.test.ts \
  tests/registry.test.ts
npm run typecheck
npm run build
npm run test:onboarding
```

Expected: every command exits zero. `npm run build` regenerates tracked JavaScript; never hand-edit `dist/src`.

- [ ] **Step 6: Smoke the actual generated project and waiting surface**

In one temporary `relay init --github owner/repository` project:

1. load the generated registry and confirm `pr.verification.settled@1` is a notification definition;
2. start Relay;
3. start `relay notify` with one PR correlation ID;
4. emit one schema-valid `pr.verification.settled@1` payload through the real producer API;
5. observe exactly one stdout payload and a completed event;
6. stop Relay and remove the temporary project.

This smoke proves the changed generated surface independently from the mocked connector E2E.

- [ ] **Step 7: Run the repository suite and inspect the final diff**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run test:onboarding
git diff --check
```

Expected: all new and focused tests pass. If the existing date-sensitive `tests/github-connector-e2e.test.ts:184` fixture still fails, report it separately as the known baseline failure; do not change the production feature or pin incidental dates to hide it.

Confirm before completion:

- every affected call site and fake implements `listReviewThreads` and `emitVerification`;
- generated examples equal `relay init` output;
- no obsolete aliases, temporary scripts, credentials, or test scaffolds remain;
- docs match the commands exercised in the smoke run;
- review bodies occur only in bounded payload evidence, never logs or errors.

- [ ] **Step 8: Request code review and resolve all Critical/Important findings**

Use the `superpowers:requesting-code-review` skill with the spec, this plan, commit range, focused test evidence, actual smoke output, and known baseline failure. Re-run affected checks after every accepted fix. Do not finish while a Critical or Important finding remains.

- [ ] **Step 9: Commit E2E proof, docs, and generated build output**

```bash
git add tests/pr-verification-e2e.test.ts README.md docs/agent-quickstart.md dist/src
git commit -m "test(github): prove verification notification lifecycle"
```

## Completion evidence

Implementation is complete only when all of the following are observed:

- A verification-disabled configuration makes no GraphQL request and preserves every existing event path.
- Review-thread evidence is authoritative, bounded, deterministic, and token-safe.
- Continuous mode waits for two stable observations; one-shot mode emits immediately.
- Changed same-head evidence emits a new identity; an already emitted same-head identity does not repost.
- Final-head drift, GraphQL failure, and unified Relay mapping failure remain isolated as specified.
- A real parked `relay notify` receives one payload, completes its lease, and exits zero.
- Fresh connector state replays the deterministic event without increasing Relay event count.
- Generated schemas and checked-in examples are byte-for-byte consistent.
- Focused tests, typecheck, build, onboarding, actual smoke, and final code review are complete.
