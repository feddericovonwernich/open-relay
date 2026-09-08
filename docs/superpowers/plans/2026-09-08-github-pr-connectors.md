# GitHub PR Automation Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local GitHub polling connector that recognizes completed SonarQube, GitHub Copilot, and Cursor Bugbot PR automation artifacts and emits normalized, idempotent Open Relay events.

**Architecture:** A separate foreground connector process polls GitHub REST using conditional requests and bounded concurrency. Pure provider recognizers produce normalized candidates, a trigger mapper creates one stable completion payload, and a Relay emitter uses repository-scoped producer credentials plus deterministic idempotency keys. GitHub and Open Relay remain the durable sources; the connector retains only in-memory response/ETag caches.

**Tech Stack:** Node 22.19+, TypeScript 5.9, native `fetch`, `node:test`, existing Ajv 8, existing Open Relay HTTP/client modules. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-08-github-pr-connectors-design.md`

## Global Constraints

- The feature is named the **GitHub connector**; provider matchers are **recognizers**; configured mappings are **triggers**.
- Run as a separate foreground local process through `relay connect github`.
- Poll GitHub REST; do not add a public webhook server, tunnel, or hosted GitHub App.
- Read the GitHub token only from the configured environment variable.
- Request read-only Checks, Pull requests, and Metadata permissions.
- GitHub and Relay bearer tokens stay in `Authorization` headers and never enter URLs, events, configuration, errors, or logs.
- One normalized `PrAutomationCompleted` payload serves all providers.
- Emit one event per provider artifact; do not aggregate all providers.
- Use deterministic Relay idempotency; do not add a connector database.
- Watch every open PR regardless of age and only recently updated closed/merged PRs.
- A PR-list `304` reuses the cached list but still polls artifact endpoints.
- Re-fetch the PR head immediately before emission and suppress stale candidates.
- No review body, comment, source, or provider log enters Relay events.
- SonarQube emission requires exact check name and operator-pinned app identity.
- Copilot completion is a submitted review, not a success judgment.
- Bugbot `neutral` remains neutral and `Cursor Bugbot Autofix` never matches.
- No generic rules engine, new runtime dependency, distributed scheduler, or cross-event ordering.

## Planned file structure

```text
src/connectors/github/types.ts                    Connector, GitHub artifact, candidate, and normalized payload types
src/connectors/github/config.ts                   Config parsing, defaults, validation, secret-key rejection
src/connectors/github/client.ts                   GitHub REST auth, pagination, ETags, decoding, rate-limit policy
src/connectors/github/poller.ts                   Open/recent PR discovery, snapshots, concurrency, head recheck
src/connectors/github/recognizers/check-run.ts    Shared exact check/app/PR matcher
src/connectors/github/recognizers/sonarqube.ts    SonarCloud/SonarQube completion recognition
src/connectors/github/recognizers/copilot.ts      Submitted Copilot review recognition
src/connectors/github/recognizers/bugbot.ts       Cursor Bugbot completion recognition
src/connectors/github/normalize.ts                Stable normalized payload construction
src/connectors/github/emitter.ts                  Stable producer credentials and Relay idempotent acceptance
src/connectors/github/runner.ts                   Poll cycle, backoff isolation, discovery and continuous modes
src/cli.ts                                        `relay connect github` command integration
tests/github-helpers.ts                           Narrow GitHub fixtures and local fake GitHub API server
tests/github-config.test.ts                       Configuration trust-boundary coverage
tests/github-client.test.ts                       Pagination, ETag, rate-limit, abort, redaction coverage
tests/github-poller.test.ts                       Open/recent discovery, shared snapshots, stale-head coverage
tests/github-sonarqube.test.ts                    Sonar recognition matrix
tests/github-copilot.test.ts                      Copilot recognition matrix
tests/github-bugbot.test.ts                       Bugbot recognition matrix
tests/github-emitter.test.ts                      Normalization, producer identity, idempotency, drift coverage
tests/github-runner.test.ts                       Cycle isolation, discovery, shutdown, CLI integration
tests/github-connector-e2e.test.ts                Fake GitHub plus real Open Relay acceptance
```

---

### Task 1: Connector contracts and configuration

**Files:**
- Create: `src/connectors/github/types.ts`
- Create: `src/connectors/github/config.ts`
- Create: `tests/github-config.test.ts`

**Interfaces:**
- Produces: `RecognizerId`, `GitHubConnectorConfig`, `TriggerConfig`, `PrSnapshot`, `CompletionCandidate`, `PrAutomationCompleted`.
- Produces: `loadGitHubConnectorConfig(path: string, options?: { discover?: boolean }): Promise<GitHubConnectorConfig>`.
- Produces: `validateGitHubConnectorConfig(value: unknown, options?: { discover?: boolean }): GitHubConnectorConfig`.

- [ ] **Step 1: Define the failing configuration matrix**

Create `tests/github-config.test.ts`. Use temporary JSON files and assert:

```ts
test("loads a valid three-recognizer connector", async () => {
  const config = await loadConfig(validConfig());
  assert.equal(config.connector, "github");
  assert.deepEqual(config.repositories, ["owner/repository"]);
  assert.deepEqual(config.triggers.map((trigger) => trigger.recognizer), [
    "sonarqube",
    "copilot-review",
    "cursor-bugbot",
  ]);
});

test("requires pinned Sonar identity outside discovery", () => {
  assert.throws(
    () => validateGitHubConnectorConfig(configWithUnpinnedSonar()),
    errorWithCode("sonar_identity_required"),
  );
  assert.doesNotThrow(() =>
    validateGitHubConnectorConfig(configWithUnpinnedSonar(), { discover: true }),
  );
});
```

Add explicit siblings for embedded `token`/`secret` keys, HTTP non-loopback API URL, invalid repository, duplicate trigger ID, unknown recognizer, invalid poll/lookback bounds, and missing provider identity.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/github-config.test.ts`  
Expected: FAIL because connector config modules do not exist.

- [ ] **Step 3: Implement exact types**

In `types.ts`, define the spec contracts. Trigger matching is a discriminated union:

```ts
export type TriggerConfig =
  | {
      id: string;
      recognizer: "sonarqube";
      match: { checkNames: string[]; appIds: number[]; appSlugs: string[] };
      emit: { type: string; version: number };
    }
  | {
      id: string;
      recognizer: "copilot-review";
      match: { userIds: number[]; appUrls: string[]; logins: string[] };
      emit: { type: string; version: number };
    }
  | {
      id: string;
      recognizer: "cursor-bugbot";
      match: { checkNames: string[]; appIds: number[]; appSlugs: string[] };
      emit: { type: string; version: number };
    };
```

`PrAutomationCompleted.artifact.detailsUrl` is `string | null`. Provider is a string; the three built-ins supply fixed values.

- [ ] **Step 4: Implement config parsing and validation**

Use `readFile` and `JSON.parse`; do not add a config dependency. Validate every property explicitly and freeze the returned object recursively. Defaults:

```ts
apiBaseUrl = "https://api.github.com"
apiVersion = "2026-03-10"
tokenEnv = "GITHUB_TOKEN"
pollIntervalMs = 15_000
lookbackHours = 24
```

Reject any recursively discovered key matching `/token|credential|secret/i` except exact key `tokenEnv`. Validate HTTPS, with loopback HTTP allowed only when `NODE_ENV === "test"` or an injected validation option explicitly permits it.

- [ ] **Step 5: Run focused verification**

Run:

```bash
node --test tests/github-config.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/connectors/github/types.ts src/connectors/github/config.ts tests/github-config.test.ts
git commit -m "feat: define GitHub connector configuration"
```

---

### Task 2: GitHub REST client

**Files:**
- Create: `src/connectors/github/client.ts`
- Create: `tests/github-helpers.ts`
- Create: `tests/github-client.test.ts`

**Interfaces:**
- Consumes: narrow GitHub artifact types from Task 1.
- Produces: `GitHubClient`.
- Produces: `GitHubClient.listOpenPullRequests(repository, signal)`.
- Produces: `GitHubClient.listRecentClosedPullRequests(repository, cutoff, signal)`.
- Produces: `GitHubClient.getPullRequest(repository, number, signal)`.
- Produces: `GitHubClient.listCompletedCheckRuns(repository, headSha, signal)`.
- Produces: `GitHubClient.listReviews(repository, number, signal)`.

Constructor:

```ts
interface GitHubClientOptions {
  baseUrl: string;
  apiVersion: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
}
```

- [ ] **Step 1: Build a local fake GitHub API helper**

In `tests/github-helpers.ts`, create a loopback `node:http` server that records method, URL, and headers; can page through `Link`, return ETags/304, return rate-limit headers, delay until abort, and expose scripted JSON responses. Never inspect authorization values in assertion failure strings.

- [ ] **Step 2: Write failing client tests**

Cover:

```ts
test("paginates open PRs and recent closed PRs independently", async () => { /* two endpoint scripts; assert merged calls */ });
test("PR list 304 reuses cached body without suppressing later artifact calls", async () => { /* warm list cache, then 304, then changed checks */ });
test("paginates check runs and reviews", async () => { /* Link chain */ });
test("honors Retry-After and rate-limit reset with injected sleep", async () => { /* assert delay */ });
test("aborts in-flight fetch and redacts bearer from errors", async () => { /* abort controller */ });
```

Also assert exact headers: bearer authorization, GitHub API version, media type, user agent.

- [ ] **Step 3: Run the focused test and verify failure**

Run: `node --test tests/github-client.test.ts`  
Expected: FAIL because `GitHubClient` is missing.

- [ ] **Step 4: Implement paginated conditional GET**

Use an in-memory cache keyed by absolute URL:

```ts
type CachedPage = {
  etag?: string;
  body: unknown;
  nextUrl?: string;
};
```

A `304` without cached data is `github_protocol_error`. Cache the parsed body and next-link together. Reuse cached pages but continue the caller’s normal flow; never treat a PR-list 304 as proof artifact endpoints are unchanged.

Parse RFC 5988 `Link` conservatively and follow only URLs under configured `apiBaseUrl`.

- [ ] **Step 5: Implement narrow response decoders**

Validate only fields consumed by the connector:

```ts
GitHubPullRequest: number, html_url, head.sha, base.ref, state, updated_at
GitHubCheckRun: id, name, status, conclusion, head_sha, completed_at, details_url, app, pull_requests
GitHubPullRequestReview: id, user, commit_id, submitted_at, html_url
```

Malformed items are returned as bounded decode diagnostics and omitted; a malformed entire response is `github_protocol_error`.

- [ ] **Step 6: Implement rate-limit policy**

- `401`: throw `github_auth_failed`, non-retryable.
- `403`/`429` with `Retry-After`: sleep seconds plus jitter.
- exhausted `X-RateLimit-Remaining`: sleep to reset epoch plus jitter.
- `5xx`/network: throw a typed transient error; the runner owns cycle backoff.
- successful response resets no global state inside the client.

- [ ] **Step 7: Run focused verification**

Run:

```bash
node --test tests/github-client.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/connectors/github/client.ts tests/github-helpers.ts tests/github-client.test.ts
git commit -m "feat: add conditional GitHub REST client"
```

---

### Task 3: Pull-request discovery and snapshots

**Files:**
- Create: `src/connectors/github/poller.ts`
- Create: `tests/github-poller.test.ts`
- Modify: `tests/github-helpers.ts`

**Interfaces:**
- Consumes: `GitHubClient`, config, `PrSnapshot`.
- Produces: `discoverPullRequests(client, repository, cutoff, signal): Promise<GitHubPullRequest[]>`.
- Produces: `loadPrSnapshot(client, repository, pr, requirements, signal): Promise<PrSnapshot>`.
- Produces: `verifyCurrentHead(client, candidate, signal): Promise<boolean>`.
- Produces: `mapConcurrent<T, R>(items, limit, mapper): Promise<R[]>`, fixed caller limit `4`.

- [ ] **Step 1: Write failing discovery tests**

Cover:

- old open PR remains included;
- recently closed PR included;
- closed PR older than cutoff stops closed pagination;
- open/closed duplicate PR number is deduplicated;
- check runs fetched once when Sonar and Bugbot are both configured;
- reviews omitted when Copilot trigger absent;
- four-request concurrency ceiling;
- candidate suppressed when final PR head changed.

Use deferred fake-client promises to prove the concurrency ceiling without timing sleeps.

- [ ] **Step 2: Run focused test and verify failure**

Run: `node --test tests/github-poller.test.ts`  
Expected: FAIL because the poller is missing.

- [ ] **Step 3: Implement discovery**

Fetch all open pages and bounded closed pages separately. Deduplicate on PR number, preferring the response with the later `updatedAt`. Stable output ordering: PR number ascending.

- [ ] **Step 4: Implement shared snapshots**

`requirements` is derived once from active trigger IDs:

```ts
interface SnapshotRequirements {
  checkRuns: boolean;
  reviews: boolean;
}
```

Fetch check runs and reviews concurrently for one PR. Freeze arrays before returning the snapshot.

- [ ] **Step 5: Implement final head verification**

Re-fetch the PR immediately before emission. Return true only when the current head SHA equals `candidate.artifactHeadSha`. Do not add `isCurrentHead` to payload.

- [ ] **Step 6: Run focused verification and commit**

```bash
node --test tests/github-poller.test.ts
npm run typecheck
git add src/connectors/github/poller.ts tests/github-poller.test.ts tests/github-helpers.ts
git commit -m "feat: discover GitHub pull request artifacts"
```

---

### Task 4: SonarQube recognizer

**Files:**
- Create: `src/connectors/github/recognizers/check-run.ts`
- Create: `src/connectors/github/recognizers/sonarqube.ts`
- Create: `tests/github-sonarqube.test.ts`

**Interfaces:**
- Produces: `matchCompletedCheckRun(snapshot, trigger, provider): CompletionCandidate[]`.
- Produces: `recognizeSonarQube(snapshot, trigger): CompletionCandidate[]`.

- [ ] **Step 1: Write the failing Sonar matrix**

Table-test:

```text
completed + exact SonarCloud name + pinned app + current head => candidate
completed + exact SonarQube name + pinned app + current head => candidate
queued/in_progress => none
same name + wrong app => none
right app + wrong name => none
stale head => none
non-empty pull_requests excluding PR => none
empty pull_requests + matching head => candidate
missing completed_at/id => none
```

Assert `conclusion` is preserved exactly, including `neutral`, `failure`, and `null`.

- [ ] **Step 2: Run focused test and verify failure**

Run: `node --test tests/github-sonarqube.test.ts`  
Expected: FAIL because recognizer modules are missing.

- [ ] **Step 3: Implement shared check recognition**

Require exact name, terminal status, configured app ID or slug, current head, and PR association only when `pull_requests` is non-empty. Convert numeric ID to decimal string. No login/body matching.

- [ ] **Step 4: Implement Sonar wrapper**

Provider value: `sonarqube`. Artifact name remains the actual documented check name. Completion: `completed`.

- [ ] **Step 5: Run focused verification and commit**

```bash
node --test tests/github-sonarqube.test.ts
npm run typecheck
git add src/connectors/github/recognizers/check-run.ts src/connectors/github/recognizers/sonarqube.ts tests/github-sonarqube.test.ts
git commit -m "feat: recognize completed SonarQube checks"
```

---

### Task 5: GitHub Copilot review recognizer

**Files:**
- Create: `src/connectors/github/recognizers/copilot.ts`
- Create: `tests/github-copilot.test.ts`

**Interfaces:**
- Produces: `recognizeCopilotReviews(snapshot, trigger): CompletionCandidate[]`.

- [ ] **Step 1: Write the failing Copilot matrix**

Cover:

```text
submitted_at + current commit + Bot + configured user id => candidate
configured app URL => candidate
normalized configured login => candidate
non-Bot => none
missing submitted_at => none
stale commit => none
wrong identity => none
review-requested data without review => none
inline review comment without parent review => none
submitted review whose body says Copilot errored => candidate with conclusion submitted
```

Assert review body and mutable state never enter payload/candidate normalized fields.

- [ ] **Step 2: Run focused test and verify failure**

Run: `node --test tests/github-copilot.test.ts`  
Expected: FAIL because recognizer is missing.

- [ ] **Step 3: Implement identity normalization**

Lowercase configured/current login and strip one trailing `[bot]` only for comparison. Require `user.type === "Bot"` and at least one configured identity factor to match. Do not match display names or body markers.

- [ ] **Step 4: Implement candidate construction**

Provider: `copilot-review`. Artifact kind: `pull_request_review`. Artifact head: `commit_id`. Completion/conclusion: `submitted`. Completed time: `submitted_at`. Details URL: `html_url`.

- [ ] **Step 5: Run focused verification and commit**

```bash
node --test tests/github-copilot.test.ts
npm run typecheck
git add src/connectors/github/recognizers/copilot.ts tests/github-copilot.test.ts
git commit -m "feat: recognize submitted Copilot reviews"
```

---

### Task 6: Cursor Bugbot recognizer

**Files:**
- Create: `src/connectors/github/recognizers/bugbot.ts`
- Create: `tests/github-bugbot.test.ts`

**Interfaces:**
- Consumes: shared check recognizer from Task 4.
- Produces: `recognizeCursorBugbot(snapshot, trigger): CompletionCandidate[]`.

- [ ] **Step 1: Write the failing Bugbot matrix**

Cover:

```text
completed Cursor Bugbot + Cursor app id => candidate
completed Cursor Bugbot + cursor slug => candidate
Cursor Bugbot Autofix => none
same name + wrong app => none
queued/in_progress => none
stale head => none
success remains success
neutral remains neutral
failure remains failure
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `node --test tests/github-bugbot.test.ts`  
Expected: FAIL because recognizer is missing.

- [ ] **Step 3: Implement wrapper**

Call shared exact matcher with provider `cursor-bugbot`. Never use substring matching, comment authors, or generic Cursor app identity without the exact check name.

- [ ] **Step 4: Run focused verification and commit**

```bash
node --test tests/github-bugbot.test.ts
npm run typecheck
git add src/connectors/github/recognizers/bugbot.ts tests/github-bugbot.test.ts
git commit -m "feat: recognize completed Cursor Bugbot checks"
```

---

### Task 7: Normalization and Relay emission

**Files:**
- Create: `src/connectors/github/normalize.ts`
- Create: `src/connectors/github/emitter.ts`
- Create: `tests/github-emitter.test.ts`

**Interfaces:**
- Produces: `normalizeCompletion(snapshot, candidate): PrAutomationCompleted`.
- Produces: `GitHubRelayEmitter`.
- Produces: `GitHubRelayEmitter.emit(trigger, candidate, signal): Promise<"emitted" | "replayed">`.

Constructor:

```ts
interface GitHubRelayEmitterOptions {
  baseUrl: string;
  adminToken: string;
  fetch?: typeof globalThis.fetch;
}
```

- [ ] **Step 1: Write failing normalization tests**

Assert exact payload shape and absence of mutable/private fields:

```ts
const payload = normalizeCompletion(snapshot, candidate);
assert.equal(JSON.stringify(payload).includes("review body"), false);
assert.equal("observedAt" in payload, false);
assert.equal("isCurrentHead" in payload, false);
assert.equal(payload.artifact.detailsUrl, null);
```

- [ ] **Step 2: Write failing emitter tests**

Use fake fetch to assert:

1. admin credential issues producer scope with subject `connector:github:<repository-id>`;
2. producer token is cached per repository for process lifetime;
3. `POST /v1/events` uses trigger type/version, normalized payload, and deterministic key;
4. token is absent from URL/body/error;
5. `201` returns `emitted`; `200` returns `replayed`;
6. idempotency conflict becomes `trigger_drift` and identifies trigger/repository without payload/token;
7. unknown definition becomes `trigger_invalid`.

Deterministic key helper:

```ts
function completionKey(candidate: CompletionCandidate): string {
  return `github:${candidate.repositoryId}:${candidate.triggerId}:${candidate.artifactKind}:${candidate.artifactId}`;
}
```

- [ ] **Step 3: Run focused tests and verify failure**

Run: `node --test tests/github-emitter.test.ts`  
Expected: FAIL because normalizer/emitter are missing.

- [ ] **Step 4: Implement normalization**

Construct a fresh object using only whitelisted fields. Do not spread GitHub objects. Freeze the normalized result.

- [ ] **Step 5: Implement scoped credential and acceptance calls**

Use authenticated fetch directly so the emitter can distinguish Relay `201 created` from `200 replayed`; `RelayBrowserClient.emit` intentionally discards the `created` flag. Redact response/error data recursively by key and exact token values.

- [ ] **Step 6: Run focused verification and commit**

```bash
node --test tests/github-emitter.test.ts
npm run typecheck
git add src/connectors/github/normalize.ts src/connectors/github/emitter.ts tests/github-emitter.test.ts
git commit -m "feat: emit normalized GitHub completions"
```

---

### Task 8: Connector runner and CLI

**Files:**
- Create: `src/connectors/github/runner.ts`
- Modify: `src/cli.ts`
- Create: `tests/github-runner.test.ts`

**Interfaces:**
- Produces: `runGitHubConnector(options: GitHubConnectorRunOptions): Promise<ConnectorSummary>`.
- Produces: `runGitHubCycle(options: GitHubCycleOptions): Promise<ConnectorSummary>`.
- Extends CLI: `relay connect github --config <path> [--once] [--discover]`.

- [ ] **Step 1: Write failing runner tests**

Use fake `GitHubClient`, recognizers, head verifier, emitter, clock, and sleep:

- one cycle processes repositories independently;
- a recognizer exception does not stop siblings;
- a repository 404 disables only that repository;
- a transient repository failure backs off up to `pollIntervalMs × 8`;
- Relay outage retries candidate next cycle;
- current-head false increments stale and never emits;
- continuous cycles never overlap;
- abort stops sleep and in-flight cycle;
- discovery mode prints identities and emits zero;
- once mode returns deterministic summary.

- [ ] **Step 2: Run focused runner test and verify failure**

Run: `node --test tests/github-runner.test.ts`  
Expected: FAIL because runner/CLI branch is missing.

- [ ] **Step 3: Implement recognizer registry**

A constant map owns the three built-ins:

```ts
const recognizers = {
  sonarqube: recognizeSonarQube,
  "copilot-review": recognizeCopilotReviews,
  "cursor-bugbot": recognizeCursorBugbot,
} as const;
```

No dynamic module loading.

- [ ] **Step 4: Implement one poll cycle**

For each repository:

1. discover open and recent closed PRs;
2. load snapshots with fixed concurrency four;
3. run only configured recognizers;
4. final-check current head per candidate;
5. normalize and emit;
6. update summary.

Catch at repository and recognizer boundaries. Logs use the exact bounded fields in the spec.

- [ ] **Step 5: Implement continuous and discovery modes**

Continuous mode awaits a cycle before sleeping; never overlap. Transient backoff is per repository. Discovery uses the same API/client but reports identities instead of calling emitter. Shutdown passes one `AbortSignal` into every request/sleep.

- [ ] **Step 6: Integrate CLI**

In `src/cli.ts`, before generic command rejection:

```ts
if (parsed.command === "connect") {
  const connector = requiredArg(parsed.args, 0, "connector");
  if (connector !== "github") throw new Error(`unknown connector: ${connector}`);
  // Read local runtime, config path, GitHub token env, then run.
}
```

Resolve config relative to `--project-root`. Read Relay runtime using existing helpers. Pass tokens directly; do not print them. `--once` and `--discover` are Boolean flags. `--discover` implies `--once`.

- [ ] **Step 7: Add real CLI parsing tests**

Assert positional `connect github` plus config/once/discover/project-root combinations and unknown connector errors. Ensure `withoutSecrets` removes identity discovery fields only when their names contain actual secret material; app IDs/slugs remain visible.

- [ ] **Step 8: Run focused verification and commit**

```bash
node --test tests/github-runner.test.ts tests/cli.test.ts
npm run typecheck
npm run build
git add src/connectors/github/runner.ts src/cli.ts tests/github-runner.test.ts tests/cli.test.ts
git commit -m "feat: run local GitHub connector"
```

---

### Task 9: End-to-end reconciliation and operational verification

**Files:**
- Create: `tests/github-connector-e2e.test.ts`
- Modify: `tests/github-helpers.ts`
- Modify: `src/connectors/github/runner.ts` only for defects exposed by E2E behavior
- Modify: `src/connectors/github/emitter.ts` only for defects exposed by E2E behavior

**Interfaces:**
- Exercises the complete connector; produces no new public interface.

- [ ] **Step 1: Build a real fake-GitHub/real-Relay harness**

Start two loopback servers:

1. existing `createRelayServer` with an event definition accepting `pr.automation.completed` schema version 1;
2. scripted GitHub server serving open/closed PRs, checks, reviews, ETags, pagination, and mutable head state.

Write a connector config referencing all three recognizers and the fake GitHub loopback URL under explicit test allowance.

- [ ] **Step 2: Write the three-provider completion test**

Return one current-head Sonar check, one submitted Copilot review, and one Bugbot check. Run `--once`. Assert three Relay events exist with:

- one normalized payload shape;
- distinct provider/artifact IDs;
- correct raw conclusions;
- no source/body/comment fields;
- deterministic producer identity and keys.

- [ ] **Step 3: Write restart/idempotency reconciliation test**

Create a new connector instance with empty ETag/token caches and run the same cycle. Assert event count stays three and summary reports three replays.

- [ ] **Step 4: Write stale-head race test**

Change the PR head after snapshot endpoints return but before final PR verification. Assert no candidate emits. On the next cycle, provide new-head artifacts and assert only those emit.

- [ ] **Step 5: Write polling correctness tests**

Prove:

- PR-list 304 still calls check/review endpoints;
- old open PR is polled;
- recently closed PR is polled;
- old closed PR is not;
- Relay outage followed by recovery emits once;
- trigger drift surfaces without stopping sibling trigger.

- [ ] **Step 6: Exercise CLI discovery and once modes**

Call `runCli` with real config/runtime paths:

```text
connect github --config <path> --once --discover
connect github --config <path> --once
```

Capture stdout. Assert discovery emits zero and contains observed check/app/review identities; normal once output contains only the summary and no GitHub/Relay token.

- [ ] **Step 7: Run focused E2E verification**

```bash
node --test tests/github-connector-e2e.test.ts
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 8: Run the complete verification matrix**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all tests pass and both TypeScript commands exit 0.

- [ ] **Step 9: Run an actual one-shot connector smoke**

Use the built `dist/src/cli.js`, the local fake GitHub server fixture, and a real built Relay process. Execute discovery then emission. Observe three normalized events through Relay status/SSE, stop both processes, and confirm token strings do not appear in captured stdout/stderr.

- [ ] **Step 10: Commit Task 9**

```bash
git add tests/github-connector-e2e.test.ts tests/github-helpers.ts src/connectors/github/runner.ts src/connectors/github/emitter.ts
git commit -m "test: verify GitHub connector reconciliation"
```

---

## Final acceptance matrix

Before calling the feature complete:

- Configuration rejects embedded credentials and unpinned Sonar emission.
- Discovery mode can reveal Sonar app identity without emitting.
- Every open PR is watched regardless of age.
- Recently closed PRs remain watched through lookback.
- PR-list 304 never suppresses artifact polling.
- GitHub pagination, ETags, rate limits, retries, and aborts are covered.
- SonarQube exact names require pinned app identity and completed status.
- Copilot requires a submitted current-head Bot review with configured identity.
- Bugbot requires exact `Cursor Bugbot` check plus Cursor identity.
- `Cursor Bugbot Autofix` never emits.
- Copilot error-body submission remains completion=`submitted`.
- Bugbot neutral remains neutral.
- Final PR-head verification suppresses stale artifacts.
- Payload contains no review body, comments, source, logs, token, observation time, or mutable current-head flag.
- Deterministic idempotency survives connector restart without local state.
- Trigger drift surfaces and does not block sibling triggers/repositories.
- GitHub/Relay outages reconcile without duplicate events.
- Continuous cycles do not overlap and shut down cleanly.
- `relay connect github --once --discover` and `--once` work through the built CLI.
- Full suite, typecheck, build, and actual connector smoke pass.
