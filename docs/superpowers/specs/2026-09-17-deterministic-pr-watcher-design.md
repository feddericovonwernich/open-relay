# Deterministic PR Watcher Design

**Date:** 2026-09-17

**Architecture and sequence diagrams:** [`../../architecture/pr-watcher/README.md`](../../architecture/pr-watcher/README.md)

## Purpose

Add one high-fidelity, deterministic pull-request notification that tells a coding agent:

1. whether current-head verification has settled;
2. whether action is required;
3. which CI checks or unresolved configured bot-review threads require attention; and
4. what bounded next action to take.

The notification is not LLM-generated. The GitHub connector derives it from current-head GitHub Check Runs, existing configured automation artifacts, and authoritative GitHub GraphQL review-thread state. A new `relay notify` command delivers exactly one matching work item to one consumer while hiding the lease lifecycle.

Existing low-level GitHub events remain unchanged and continue to emit. The analyzed notification is additive and opt-in.

## Goals

- Emit one `pr.verification.settled@1` event after configured automation, current-head Check Runs, and configured bot-review evidence have settled.
- Preserve raw GitHub conclusions and review evidence.
- Derive `success` or `action_required` through fixed, reviewable heuristics.
- Include bounded actionable details so an agent does not query GitHub merely to discover what failed or what a bot reported.
- Use authoritative `PullRequestReviewThread.isResolved` state from GitHub GraphQL.
- Deliver one notification to one consumer through `relay notify` without exposing worker registration, lease IDs, start, or completion commands.
- Preserve existing configured-tool, generic Check Run, combined-mode, event, idempotency, and replay behavior.
- Leave an explicit extension seam for future Relay aggregation families without implementing a generic aggregation engine now.

## Non-goals

- No LLM inference in the connector, Relay core, or `relay notify`.
- No automatic source-code modification, GitHub comment reply, or thread resolution.
- No legacy commit-status polling; CI scope remains modern GitHub Check Runs.
- No replacement or suppression of `pr.automation.completed@1`, `pr.automation.settled@1`, or `pr.ci.settled@1`.
- No generic rules DSL or general-purpose Relay aggregation-family runtime in this implementation.
- No daemon mode, health endpoint, `relay status`, Sonar onboarding redesign, or connector credential refresh in this implementation. Those remain separate operational workstreams from the reviewed feedback.
- No promise of exactly-once delivery to stdout. Notification delivery is at-least-once across crashes.

## Terminology

- **Verification:** The combined factual state of configured automation, current-head Check Runs, and configured bot-review threads.
- **Finding:** One unresolved GitHub review thread whose root comment author matches a configured Bugbot or Copilot login.
- **Action:** A deterministic instruction selected from a closed set of action codes.
- **Notification definition:** An event definition with `handler.kind: "notification"`; only the notification acquisition path can claim it.
- **Analyzed notification:** The deterministic `pr.verification.settled@1` payload. “Analyzed” does not imply model inference.

## Architecture

```mermaid
flowchart LR
    REST[GitHub REST] --> CONNECTOR[GitHub connector]
    GQL[GitHub GraphQL] --> CONNECTOR
    CONNECTOR --> LOW[Existing low-level events]
    CONNECTOR --> VERIFY[pr.verification.settled@1]
    VERIFY --> STORE[Durable Relay queue]
    STORE --> NOTIFY[relay notify]
    NOTIFY --> AGENT[Coding agent]
```

The connector is the first producer of the unified notification because it already owns GitHub authentication, current-head discovery, Check Run snapshots, configured recognizers, final-head fencing, and per-PR observation state. A separate aggregator would duplicate these concerns and need its own durable cross-event state.

`relay notify` is a narrow convenience wrapper over Relay’s existing worker authority and lease transitions. Notification definitions use a distinct handler kind so wildcard agent workers cannot claim them.

## Configuration

The top-level GitHub connector configuration gains optional `graphqlUrl` and `verification` fields. The relevant fragment is:

```json
{
  "connector": "github",
  "apiBaseUrl": "https://api.github.com",
  "graphqlUrl": "https://api.github.com/graphql",
  "repositories": [
    {
      "name": "owner/repository",
      "mode": "configured-tools-and-generic-check-runs"
    }
  ],
  "verification": {
    "id": "pr-verification-settled-v1",
    "emit": {
      "type": "pr.verification.settled",
      "version": 1
    },
    "reviewers": {
      "cursor-bugbot": ["cursor[bot]"],
      "copilot-review": ["copilot-pull-request-reviewer[bot]"]
    }
  }
}
```

The fragment omits required connector fields and trigger bodies; a valid combined configuration still requires the configured SonarQube, Copilot, and Cursor Bugbot triggers.

### Validation rules

- `verification` is optional.
- If absent, no GraphQL review-thread request or unified event occurs.
- `verification` is valid only when at least one repository uses `configured-tools-and-generic-check-runs`.
- `verification.id` follows the existing trigger/aggregate ID syntax and cannot collide with trigger or configured-aggregate IDs.
- `verification.emit` follows the existing event mapping syntax.
- `verification.reviewers` accepts only `cursor-bugbot` and `copilot-review` keys.
- Reviewer logins are normalized case-insensitively, must be nonempty strings, and must not contain duplicates after normalization.
- When a Cursor Bugbot trigger exists, `cursor-bugbot` reviewer logins are required.
- When a Copilot trigger exists, `copilot-review` reviewer logins are required even if the trigger itself matches reviews through user ID or app URL.
- Reviewer entries for providers without a corresponding trigger are rejected as unused configuration.
- For `https://api.github.com`, omitted `graphqlUrl` defaults to `https://api.github.com/graphql`.
- When verification is enabled with any other `apiBaseUrl`, `graphqlUrl` is required because GitHub Enterprise GraphQL URLs cannot be derived safely from arbitrary REST base URLs.
- `graphqlUrl` uses the existing HTTPS/credential/query/fragment trust-boundary rules. Loopback HTTP remains test-only.
- All normalized verification objects and arrays are deeply frozen.

The generated GitHub project includes the fixed event definition, schemas, and handler file but does not enable `verification`. Existing initialization behavior remains dormant until the operator supplies verified reviewer logins and enables the block.

## GitHub GraphQL review evidence

### Query

For each current-head pull request in an enabled combined repository, query:

```graphql
query PullRequestReviewThreads(
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
}
```

Paginate `reviewThreads` until `hasNextPage` is false. A thread must contain at least one comment. The first comment is the root finding. Replies do not change provider ownership.

### Provider matching

A thread belongs to a configured provider when the root comment author login matches that provider’s configured login list case-insensitively.

Human-authored threads and threads from unconfigured bots remain outside this event. An unresolved human thread does not block verification settlement.

### Resolution semantics

- `isResolved: false` means the finding is unresolved, including outdated threads.
- `isResolved: true` excludes the thread from unresolved findings.
- `isOutdated` is preserved in included finding evidence but does not suppress an unresolved finding.
- A same-head thread resolution, new provider thread, root-comment edit, or provider reassignment changes the canonical verification identity and may produce a new notification after stability requirements are met.

### Evidence bounds

The connector reads all matching thread identities needed for accurate unresolved counts and identity calculation, but the wire payload is bounded:

- At most 20 findings include bodies.
- Root comment bodies are truncated to 2,000 Unicode code points.
- Included findings are sorted by provider, path, line, then thread ID.
- Review evidence has a 48 KiB canonical JSON budget before the rest of the event payload.
- If the count or byte budget is exceeded, stop adding finding bodies deterministically and set `truncated: true`.
- Preserve `unresolvedCount`, `includedCount`, and `totalReplyCount` even when findings are omitted. Each included finding also preserves its own `replyCount`.
- `evidenceDigest` is SHA-256 over every matching unresolved thread’s provider, thread ID, resolution/outdated state, path, line range, root comment ID, author login, `updatedAt`, and full root body hash. Changes outside the included body subset still change event identity.

All comment strings are untrusted data. They are never interpreted as instructions by Relay.

## Unified payload

```ts
interface PrVerificationSettled {
  schemaVersion: 1;
  provider: "github";
  repository: {
    id: number;
    fullName: string;
  };
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
      provider: "cursor-bugbot" | "copilot-review";
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

type VerificationAction =
  | {
      code: "resolve_review_findings";
      providers: Array<"cursor-bugbot" | "copilot-review">;
      findingCount: number;
      message: "Review the unresolved Bugbot/Copilot comments. If a finding is valid, implement a fix. In every case, reply with the result and resolve the thread when addressed.";
    }
  | {
      code: "investigate_ci_failures";
      checkNames: string[];
      message: "Investigate the failed CI checks. Fix failures caused by the change when possible. Otherwise report the cause and why it could not be fixed automatically.";
    }
  | {
      code: "verify_review_result";
      provider: "cursor-bugbot";
      checkName: string;
      message: "Verify the completed neutral Bugbot result. Confirm whether the run contains findings, cancellation, or an internal error before treating the review as successful.";
    };
```

Every object level uses `additionalProperties: false` in the JSON Schema. The findings and actions arrays are immutable and deterministically sorted.

## Deterministic analysis rules

### CI classification

A Check Run is passing only when its raw conclusion is exactly one of:

- `success`
- `neutral`
- `skipped`

Every other string or `null` is failing once the Check Run is terminal. `failingCheckNames` contains unique failing names sorted lexicographically.

If `failingCheckNames` is nonempty, add one `investigate_ci_failures` action.

### Review classification

If `reviews.unresolvedCount > 0`, add one `resolve_review_findings` action. Its provider list is unique and sorted; `findingCount` equals the total unresolved configured-provider thread count, including omitted bodies.

If a completed Cursor Bugbot automation artifact has `conclusion: "neutral"` and there are zero unresolved Cursor Bugbot threads, add one `verify_review_result` action. When unresolved Bugbot threads exist, the resolve action already explains the required work and no separate verify action is added.

Copilot’s submitted review conclusion remains `submitted`. Copilot requires action only when configured Copilot review threads are unresolved.

### Verdict

```ts
verdict = actions.length === 0 ? "success" : "action_required";
```

No free-form heuristic output exists beyond the three fixed messages.

## Settlement and replay

Verification is eligible only when all conditions hold for one current-head pull request:

1. every configured trigger has at least one recognized current-head candidate;
2. the current-head Check Run set is nonempty;
3. every current-head Check Run is terminal and valid under the existing generic settlement contract;
4. the GraphQL review-thread query completed successfully; and
5. the final pull-request head fence still matches the snapshot head.

Configured automation and existing generic settlement continue independently when unified verification is not yet eligible.

### Continuous mode

Store per-repository/per-PR verification observation state:

```ts
interface GitHubVerificationObservationState {
  headSha: string;
  identity: string;
  consecutive: number;
  emittedIdentities: Set<string>;
}
```

The canonical payload identity must be observed in two consecutive connector cycles before emission. A head change resets the entire observation. A same-head identity change resets `consecutive` to one but retains previously emitted identities for that head. Empty, pending, invalid, or unavailable evidence deletes the current observation without deleting retained same-head emission history unless the head changed.

`--once` evaluates one eligible snapshot immediately but still applies the final head fence and deterministic idempotency key.

### Identity

Normalize the complete payload once, then compute SHA-256 over `JSON.stringify(payload)`. The idempotency key is:

```text
github:<repositoryId>:verification-settled:pull-request:<number>:head:<headSha>:payload:<sha256>
```

A late Check Run, disappearance, conclusion/timestamp/URL change, automation artifact change, new/resolved/edited provider thread, or changed action changes the identity. Returning to an already accepted same-head identity does not repost within retained process state; after restart Relay returns the deterministic replay rather than creating a duplicate.

### Errors

- GitHub authentication failures remain connector-fatal.
- GraphQL transport, rate-limit, or response errors suppress only unified verification for that cycle. Existing configured and CI events continue.
- Transient GraphQL failures use the existing repository backoff ceiling but must not roll back events already accepted earlier in the cycle.
- Any malformed GraphQL thread or root-comment node makes review evidence ineligible for that cycle and records a bounded connector error; malformed or absent evidence is never interpreted as zero unresolved findings.
- Final head drift deletes the verification observation and emits nothing.
- Unified Relay `404` or `409` disables only the verification mapping for that repository/process and records `verification_invalid` or `verification_drift`; low-level paths continue.
- Ordinary Relay unavailability leaves a stable eligible observation retryable.

## Notification handler kind

Extend the event-definition handler union:

```ts
handler:
  | { kind: "agent"; instructions: string }
  | { kind: "process"; command: string; args: string[]; env: string[] }
  | { kind: "notification" };
```

Notification definitions:

- remain durable, revisioned, schema-validated events;
- enter the normal queued/retry/lease state machine;
- cannot be acquired through `/v1/agent/poll` or the process loop;
- can be acquired only through the notification poll path;
- use existing worker authority, lease expiry, cancellation, and retry-safe completion machinery;
- use the fixed output schema `{ delivered: true }`.

Add a store acquisition boundary equivalent to the existing agent/process separation:

```ts
acquireNotification(worker, now)
```

It matches only `handler.kind === "notification"`, allowed definitions, correlation ID, and single-consumer concurrency. Agent tool/context/structured-output capabilities do not participate.

The generated definition is:

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
  "handler": {
    "kind": "notification"
  }
}
```

The delivery result schema is exactly:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "delivered": { "const": true }
  },
  "required": ["delivered"],
  "additionalProperties": false
}
```

## `relay notify`

Initial CLI contract:

```bash
relay notify \
  --definitions pr.verification.settled@1 \
  --correlation-id github:owner/repo:pull-request:33
```

Both flags are required in the first version. Requiring the correlation ID prevents a watcher from accidentally consuming another pull request’s notification.

### Behavior

1. Read and verify `.relay/runtime.json`.
2. Register an ephemeral single-concurrency worker with a generated `notify:<pid>:<uuid>` identity.
3. Poll the notification-only endpoint repeatedly with no default overall timeout. `SIGINT`/`SIGTERM` abort cleanly.
4. When a matching delivery arrives, persist lease authority using the existing mode-0600 lease file mechanism.
5. Send the internal `start` transition.
6. Write exactly one JSON line containing the event payload to stdout.
7. Wait for the stdout write callback; a closed/broken pipe is a delivery failure and must not acknowledge the event.
8. Complete internally with `{ "result": { "delivered": true }, "effects": [] }`.
9. Remove local lease authority and exit zero.

No lease ID, worker token, start reply, or completion reply is exposed to the caller.

### Delivery guarantee

Printing precedes acknowledgment. A crash after print but before completion may cause the same event to be delivered again after lease expiry. A crash before print does not acknowledge the event. The command therefore provides at-least-once stdout delivery without silent loss.

Two concurrent matching `relay notify` commands race through the existing acquisition transaction; only one acquires each event.

The command does not track or acknowledge later code remediation. Its unit of work is successful notification delivery.

## Generated project

`relay init --github` additionally generates:

- `.relay/events/pr-verification-settled.v1.json`
- `.relay/schemas/pr-verification-settled.json`
- `.relay/schemas/notification-delivered.json`

No analysis handler Markdown file is needed because the notification is deterministic and has no LLM instructions.

The connector configuration remains verification-disabled by default. Documentation explains how to:

1. run discovery and pin Sonar identity;
2. configure combined mode;
3. configure reviewer logins and GraphQL URL;
4. enable verification; and
5. park `relay notify` under harness process supervision.

## Security and trust boundaries

- GitHub Check Run fields, GraphQL bodies, paths, URLs, author logins, and action-adjacent strings remain untrusted data.
- Fixed action messages are trusted program constants; untrusted text is never interpolated into them.
- GraphQL uses the existing GitHub token only in the Authorization header.
- GraphQL and REST errors redact the token and bounded response bodies.
- GraphQL URLs reject credentials, query strings, and fragments.
- Review bodies are never interpreted as instructions by Relay.
- Payload and per-body limits are enforced before Relay acceptance.
- Notification worker tokens and lease files retain mode-0600 authority handling.
- `relay notify` prints the payload only; it never prints runtime or worker credentials.

## Operability

The GitHub connector logs bounded structured milestones for unified verification:

- `verification_pending_automation`
- `verification_pending_checks`
- `verification_pending_stability`
- `verification_emitted`
- `verification_replayed`
- `verification_error`

Logs include repository, pull request number, and head SHA but never comment bodies or tokens.

Long-running connector and notify commands remain foreground processes intended for harness process supervision. This design does not add daemonization.

## Future Relay aggregation families

This connector-owned implementation is intentionally the first concrete producer, not a rejection of generic Relay aggregation.

A future aggregation-family subsystem may define a typed durable projection contract such as:

```ts
interface AggregationFamily<State, Output> {
  id: string;
  inputDefinitions: readonly string[];
  correlationKey(event: StoredEvent): string | undefined;
  reduce(state: State | undefined, event: StoredEvent): State;
  settled(state: State): boolean;
  output(state: State): Output;
  identity(state: State): string;
}
```

Such a subsystem would need:

- durable projection state and replay from Relay’s update log;
- event-order and duplicate handling;
- membership and lateness policies;
- per-correlation state bounds and garbage collection;
- definition revision fencing;
- deterministic output identity;
- recovery after process restart; and
- a security model for combining payloads from multiple producers.

It could eventually consume low-level GitHub events and emit `handler.kind: "notification"` definitions through the same `relay notify` delivery path.

This implementation preserves that option by:

- keeping `pr.verification.settled@1` a normal immutable Relay event;
- keeping its payload independent of connector-internal object identities;
- making notification delivery generic by definition and correlation ID;
- separating factual reduction from delivery; and
- avoiding a GitHub-specific observer transport.

The future family engine is not implemented now because reconstructing review-thread truth from current low-level events is impossible: those events intentionally omit GraphQL thread evidence. Building a generic engine first would still require enriching the connector and would add durable projection complexity before a second aggregation use case exists.

Migration from connector-owned production to a Relay aggregation family must use a new event version or preserve producer/idempotency semantics explicitly; it must not silently create duplicate logical notifications.

## Related feedback deferred to separate work

The reviewed reports also identified independent issues that should not be coupled to this feature:

1. Generate `.relay/.gitignore` for `relay.sqlite*`, `runtime.json`, and `agent-leases/`.
2. Improve discovery-only Sonar template UX without weakening identity pinning.
3. Add defined health/status inspection.
4. Refresh connector runtime/producer credentials after Relay restart.

These are valid follow-up workstreams. None changes the watcher payload or notification contract.

## Verification strategy

### Configuration and GraphQL client

- Exact validation codes for absent/unused reviewers, incompatible repository modes, duplicate logins, and missing enterprise GraphQL URL.
- Deep freezing.
- GraphQL request body, headers, pagination, error decoding, redaction, abort, and rate-limit behavior.
- Provider classification from root-author login and authoritative `isResolved`.
- Deterministic truncation and full evidence digest.

### Heuristic analysis

Table-driven tests cover:

- all passing and no unresolved threads → `success`, no actions;
- failed CI only → one CI action;
- unresolved Bugbot only → one review action;
- unresolved Copilot only → one review action;
- both providers unresolved → one combined review action with sorted providers;
- CI failure plus review findings → both actions in fixed order;
- Bugbot neutral with no unresolved Bugbot threads → verify action;
- Bugbot neutral with unresolved Bugbot threads → review action only;
- multiple neutral Bugbot reruns select one artifact from canonical artifact order;
- late/resolved/edited threads change identity;
- evidence beyond inclusion limits changes the digest and counts, preserves `totalReplyCount`, and keeps review evidence within 48 KiB;
- a complete payload over 65,536 bytes fails locally with a bounded verification error before any Relay request.

### Settlement and regression

- Existing low-level configured and CI events remain byte-identical.
- Unified event waits for configured triggers, terminal nonempty checks, successful review evidence, two stable cycles, and final head verification.
- `--once` emits immediately.
- Same identity replays; changed evidence creates a new event.
- GraphQL or verification emission failure does not suppress existing low-level events.
- Pure configured, pure generic, and combined mode without verification retain existing endpoint calls and behavior.

### Notification delivery

- Agent and process acquisition cannot claim notification definitions.
- Notification acquisition cannot claim agent/process definitions.
- Two notifiers converge on one lease.
- `relay notify` hides credentials and lease IDs.
- Successful stdout write is followed by start/completion and lease-file removal.
- Broken stdout leaves delivery retryable.
- Crash/restart replay is at-least-once.
- Correlation and definition filters prevent cross-PR consumption.

### End to end

A fake GitHub REST/GraphQL plus real Relay scenario proves:

1. configured artifacts finish while one Check Run remains pending → low-level events may emit; unified notification stays silent;
2. checks become terminal and one configured bot thread remains unresolved;
3. identical evidence is observed twice;
4. exactly one `pr.verification.settled@1` with `action_required`, bounded finding evidence, and fixed actions is accepted;
5. `relay notify` for that PR prints the payload once, completes delivery internally, and exits zero;
6. a fresh connector state replays the deterministic event without increasing event count; and
7. resolved thread evidence later produces a distinct same-head notification after stability, with the revised verdict/actions.
