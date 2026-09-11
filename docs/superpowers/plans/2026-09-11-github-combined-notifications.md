# GitHub Combined Tool and Check-Run Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit repository mode that emits the existing SonarQube, Cursor Bugbot, and Copilot completion events while also emitting the existing aggregate event when every current-head GitHub Check Run is terminal.

**Architecture:** Add one third repository mode, `configured-tools-and-generic-check-runs`, without replacing the existing configuration shape. In that mode the runner keeps the configured recognizer snapshot and generic current-check snapshot separate, processes configured notifications first, and then applies the existing generic two-observation state machine. Reuse every existing recognizer, normalizer, emitter, event definition, idempotency key, and head fence.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Node test runner, GitHub REST API.

**Spec:** Approved in-chat design from 2026-09-11; no separate specification file.

## Global Constraints

- Preserve `configured-tools` and `generic-check-runs` behavior exactly.
- The new mode string is exactly `configured-tools-and-generic-check-runs`.
- A combined repository requires configured triggers and may use the existing optional configured aggregate mapping.
- For exactly four notification events, configure SonarQube, Copilot, and Bugbot triggers and omit `aggregate`; the fourth event is `pr.ci.settled@1`.
- Configured SonarQube and Bugbot recognition keeps using `/check-runs?status=completed&filter=all&per_page=100`; generic settlement keeps using `/check-runs?filter=latest&per_page=100`.
- Copilot remains a pull-request review and is not included in the generic Check Run aggregate.
- A pending generic Check Run suppresses only `pr.ci.settled@1`; completed configured tools still emit.
- `ci_invalid` or `ci_drift` disables only generic CI settlement for a combined repository; configured notifications continue.
- Trigger or configured-aggregate drift must not disable generic CI settlement.
- Combined `--discover` reports configured recognizer identities, performs no generic observation mutation or emission, and skips the unneeded current-check request.
- Combined `--once` evaluates both configured notifications and the terminal generic snapshot immediately.
- Keep the connector dependency-free. Do not add event definitions, payload types, schemas, normalizers, emitters, CLI flags, or persistent state.
- The generated GitHub configuration remains `configured-tools` by default.

---

### Task 1: Extend the repository mode contract

**Files:**
- Modify: `src/connectors/github/types.ts:3-6`
- Modify: `src/connectors/github/config.ts:237-249,277-299`
- Test: `tests/github-config.test.ts:166-241`

**Interfaces:**
- Consumes: Existing `GitHubRepositoryConfig`, `validateGitHubConnectorConfig()`, `repository_mode`, `triggers_required`, `triggers_unused`, and `aggregate_unused` contracts.
- Produces: `GitHubRepositoryConfig.mode` accepting `"configured-tools-and-generic-check-runs"`; normalized combined repository objects remain deeply frozen.

- [ ] **Step 1: Add failing combined-mode validation tests**

Add these cases to `tests/github-config.test.ts` beside the existing repository-mode and conditional-trigger tests:

```ts
test("accepts and freezes combined configured-tool and generic Check Run mode", () => {
  const config = validateGitHubConnectorConfig({
    ...validConfig(),
    repositories: [{
      name: "owner/repository",
      mode: "configured-tools-and-generic-check-runs",
    }],
    aggregate: {
      id: "settled-v1",
      emit: { type: "pr.automation.settled", version: 1 },
    },
  });

  assert.deepEqual(config.repositories, [{
    name: "owner/repository",
    mode: "configured-tools-and-generic-check-runs",
  }]);
  assert.equal(Object.isFrozen(config.repositories[0]), true);
  assert.deepEqual(config.aggregate, {
    id: "settled-v1",
    emit: { type: "pr.automation.settled", version: 1 },
  });
});

test("combined mode requires configured triggers", () => {
  assert.throws(
    () => validateGitHubConnectorConfig({
      ...validConfig(),
      repositories: [{
        name: "owner/repository",
        mode: "configured-tools-and-generic-check-runs",
      }],
      triggers: [],
    }),
    errorWithCode("triggers_required"),
  );
});
```

Extend the unsupported-mode loop to keep proving arbitrary strings use `repository_mode`; do not change the existing all-pure-generic `triggers_unused` and `aggregate_unused` assertions.

- [ ] **Step 2: Run the focused tests and verify the new mode is rejected**

Run:

```bash
node --test tests/github-config.test.ts
```

Expected: the acceptance test fails with `repository_mode`; existing tests remain green.

- [ ] **Step 3: Extend the normalized type and parser**

Change `GitHubRepositoryConfig` in `src/connectors/github/types.ts` to:

```ts
export interface GitHubRepositoryConfig {
  name: string;
  mode:
    | "configured-tools"
    | "generic-check-runs"
    | "configured-tools-and-generic-check-runs";
}
```

Change the exact mode check in `repository()` to:

```ts
const mode = record.mode;
if (
  mode !== "configured-tools"
  && mode !== "generic-check-runs"
  && mode !== "configured-tools-and-generic-check-runs"
) invalid("repository_mode");
return { name: repositoryName, mode };
```

Keep the current conditional validation semantics by naming the actual capability:

```ts
const hasConfiguredRepositories = repositories.some(
  (entry) => entry.mode !== "generic-check-runs",
);

const rawTriggers = array(record.triggers, "triggers");
if (rawTriggers.length === 0 && hasConfiguredRepositories) {
  invalid("triggers_required");
}
if (rawTriggers.length > 0 && !hasConfiguredRepositories) {
  invalid("triggers_unused");
}
```

Replace the aggregate guard with:

```ts
if (!hasConfiguredRepositories && record.aggregate !== undefined) {
  invalid("aggregate_unused");
}
```

Do not modify duplicate detection, trigger parsing, aggregate parsing, or `freeze()`.

- [ ] **Step 4: Run configuration and CLI tests**

Run:

```bash
node --test tests/github-config.test.ts tests/cli.test.ts
```

Expected: all tests pass, including existing pure-mode validation and targeted selector behavior.

- [ ] **Step 5: Commit the configuration contract**

```bash
git add src/connectors/github/types.ts src/connectors/github/config.ts tests/github-config.test.ts
git commit -m "feat(github): add combined repository mode"
```

---

### Task 2: Route combined repositories through both existing paths

**Files:**
- Modify: `src/connectors/github/runner.ts:201-398`
- Test: `tests/github-runner.test.ts:14-198,316-420`

**Interfaces:**
- Consumes: `loadPrSnapshot()`, `deriveSnapshotRequirements()`, `settledCheckRuns()`, `normalizeCiSettled()`, `ciSettledKey()`, `emit()`, `emitAggregate()`, `emitCiSettled()`, and `GitHubRunnerState.ciObservations` unchanged.
- Produces: Combined-mode routing that uses separate configured and generic `PrSnapshot` values for the same pull request.

- [ ] **Step 1: Add a combined-mode fixture and failing dual-path test**

Add this fixture after `genericConfig` in `tests/github-runner.test.ts`:

```ts
const combinedConfig: GitHubConnectorConfig = {
  ...config,
  repositories: [{
    name: "octo/repo",
    mode: "configured-tools-and-generic-check-runs",
  }],
};
```

Add a test proving both endpoints and both emitters run:

```ts
test("combined mode emits configured tools and generic CI independently", async () => {
  const calls: string[] = [];
  const emissions: string[] = [];
  const client = {
    ...clientFor(),
    listCompletedCheckRuns: async () => {
      calls.push("completed");
      return [...snapshot.checkRuns];
    },
    listCurrentCheckRuns: async () => {
      calls.push("current");
      return [checkRun(20, { name: "Build" })];
    },
  };

  const result = await runGitHubCycle({
    config: combinedConfig,
    client,
    emitter: {
      emit: async () => {
        emissions.push("configured");
        return "emitted";
      },
      emitAggregate: async () => "emitted",
      emitCiSettled: async () => {
        emissions.push("ci");
        return "emitted";
      },
    },
    once: true,
    verifyCurrentHead: async () => true,
  });

  assert.deepEqual(calls, ["completed", "current"]);
  assert.deepEqual(emissions, ["configured", "ci"]);
  assert.equal(result.emitted, 2);
});
```

- [ ] **Step 2: Add failing isolation and lifecycle cases**

Add focused runner tests for these observable contracts:

```ts
test("pending generic checks do not suppress configured notifications", async () => {
  let configured = 0;
  let ci = 0;
  const result = await runGitHubCycle({
    config: combinedConfig,
    client: {
      ...clientFor(),
      listCurrentCheckRuns: async () => [checkRun(21, {
        status: "queued",
        conclusion: null,
        completedAt: null,
      })],
    },
    emitter: {
      emit: async () => { configured += 1; return "emitted"; },
      emitAggregate: async () => "emitted",
      emitCiSettled: async () => { ci += 1; return "emitted"; },
    },
    once: true,
    verifyCurrentHead: async () => true,
  });

  assert.equal(configured, 1);
  assert.equal(ci, 0);
  assert.equal(result.emitted, 1);
});

test("CI definition drift disables only combined CI settlement", async () => {
  const disabledCiRepositories = new Set<string>();
  let configured = 0;
  let currentCalls = 0;
  const client = {
    ...clientFor(),
    listCurrentCheckRuns: async () => {
      currentCalls += 1;
      return [checkRun(22)];
    },
  };
  const emitter = {
    emit: async () => { configured += 1; return "emitted" as const; },
    emitAggregate: async () => "emitted" as const,
    emitCiSettled: async () => {
      throw new GitHubRelayEmitterError("ci_invalid", "missing CI definition", 404);
    },
  };

  const first = await runGitHubCycle({
    config: combinedConfig,
    client,
    emitter,
    once: true,
    disabledCiRepositories,
    verifyCurrentHead: async () => true,
  });
  const second = await runGitHubCycle({
    config: combinedConfig,
    client,
    emitter,
    once: true,
    disabledCiRepositories,
    verifyCurrentHead: async () => true,
  });

  assert.deepEqual([...disabledCiRepositories], ["octo/repo"]);
  assert.equal(first.errors.some((error) => error.startsWith("ci_invalid:")), true);
  assert.equal(second.errors.length, 0);
  assert.equal(configured, 2);
  assert.equal(currentCalls, 1);
});
```

Also add cases proving:

- Continuous combined mode emits configured output on cycle one, keeps CI silent on its first identical terminal observation, and emits CI on cycle two.
- Combined `--discover` calls completed checks and required reviews, does not call current checks, does not mutate `ciObservations`, and emits nothing.
- `trigger_invalid` leaves the generic CI path eligible in the same cycle.
- A stale configured aggregate fence does not skip the generic path.
- Existing pure configured and pure generic endpoint assertions remain unchanged.

- [ ] **Step 3: Run the focused tests and verify combined behavior is absent**

Run:

```bash
node --test tests/github-runner.test.ts
```

Expected: the new combined tests fail because the runner currently treats the mode as neither pure generic nor a dual-capability mode.

- [ ] **Step 4: Compute mode capabilities and load separate snapshots**

In `runRepository()`, replace the single `generic` branch decision with:

```ts
const configured = repository.mode !== "generic-check-runs";
const generic = repository.mode !== "configured-tools";
const ciEnabled = generic
  && !options.disabledCiRepositories?.has(repositoryName);
const configuredRequirements = deriveSnapshotRequirements(options.config.triggers);
```

Keep the early repository skip for pure generic repositories whose CI definition is disabled, but do not skip combined repositories:

```ts
|| (
  repository.mode === "generic-check-runs"
  && options.disabledCiRepositories?.has(repositoryName)
)
```

Load snapshots without merging their Check Run arrays:

```ts
const snapshots = await mapConcurrent(
  pullRequests,
  4,
  async (pullRequest) => {
    const configuredSnapshot = configured
      ? await loadPrSnapshot(
          client,
          repositoryName,
          pullRequest,
          configuredRequirements,
          signal,
        )
      : undefined;
    const genericSnapshot = ciEnabled && (!options.discover || !configured)
      ? await loadPrSnapshot(
          client,
          repositoryName,
          pullRequest,
          { checkRuns: "current", reviews: false },
          signal,
        )
      : undefined;
    return { configuredSnapshot, genericSnapshot };
  },
);
```

For discovery, use the one snapshot containing identities relevant to that mode and exit before mutation or emission:

```ts
if (options.discover) {
  const discoverySnapshot = configuredSnapshot ?? genericSnapshot;
  if (discoverySnapshot !== undefined) {
    for (const identity of discoveryIdentities(discoverySnapshot)) {
      options.onDiscovery?.({
        repository: discoverySnapshot.repository.fullName,
        pullRequest: discoverySnapshot.pullRequest.number,
        ...identity,
      });
    }
  }
  continue;
}
```

- [ ] **Step 5: Gate the existing configured block instead of making it exclusive**

Process the existing recognizer and optional aggregate logic only when `configuredSnapshot` exists. Keep the existing trigger loop, recognizers, candidate normalization, emitters, idempotency, and error codes unchanged.

Wrap the current configured block, from `const recognizedByTrigger` through the configured aggregate handling, in:

```ts
if (configuredSnapshot !== undefined) {
  const snapshot = configuredSnapshot;
  const recognizedByTrigger = new Map<string, CompletionCandidate[]>();
  const erroredTriggers = new Set<string>();
```

Close that block after configured aggregate handling. Move its existing trigger loop without changing recognizers, candidate normalization, emitter calls, idempotency, or error codes.

Inside configured aggregate handling, replace the stale-head `continue` with a positive guard so generic processing can still run:

```ts
if (current) {
  const result = await options.emitter!.emitAggregate(
    aggregate,
    snapshot,
    aggregateCandidates,
    signal,
  );
  if (result === "emitted") summary.emitted += 1;
  else summary.replayed += 1;
}
```

Replace the `aggregate_invalid`/`aggregate_drift` catch branch and its trailing fallback with:

```ts
if (
  error instanceof GitHubRelayEmitterError
  && (error.code === "aggregate_drift" || error.code === "aggregate_invalid")
) {
  options.disabledAggregates?.add(aggregate.id);
  summary.errors.push(`${error.code}: ${errorText(error)}`);
} else {
  summary.errors.push(`aggregate ${aggregate.id}: ${errorText(error)}`);
}
```

The missing `continue` is intentional: aggregate failure remains isolated, then combined mode proceeds to generic settlement.

- [ ] **Step 6: Run the existing generic state machine after configured processing**

After the configured block, use this exact entry into the existing generic observation logic:

```ts
if (genericSnapshot === undefined) continue;
const snapshot = genericSnapshot;
const checks = settledCheckRuns(snapshot);
```

Move the current code following `settledCheckRuns()` through its `emitCiSettled()` catch directly after these lines. Preserve these details:

- Empty or pending checks delete that PR observation.
- Continuous mode requires two identical terminal observations.
- `--once` bypasses only that delay.
- Accepted or replayed identities enter `emittedIdentities` only after Relay returns.
- `ci_invalid` and `ci_drift` populate `disabledCiRepositories` without returning from the repository or skipping configured work already performed.
- Observation cleanup runs when `generic` is true, including combined repositories.

- [ ] **Step 7: Run runner and CLI tests**

Run:

```bash
node --test tests/github-runner.test.ts tests/cli.test.ts
```

Expected: all combined and existing pure-mode tests pass.

- [ ] **Step 8: Commit dual-path routing**

```bash
git add src/connectors/github/runner.ts tests/github-runner.test.ts
git commit -m "feat(github): combine tool and CI notifications"
```

---

### Task 3: Prove the four-event lifecycle and document configuration

**Files:**
- Modify: `tests/github-connector-e2e.test.ts:81-99,402-480`
- Modify: `README.md:126-164`
- Modify: `docs/agent-quickstart.md:63-98`
- Regenerate: `dist/src/connectors/github/config.js`
- Regenerate: `dist/src/connectors/github/runner.js`

**Interfaces:**
- Consumes: Combined mode from Tasks 1-2; existing real Relay harness; `pr.automation.completed@1`; `pr.ci.settled@1`.
- Produces: End-to-end proof of exactly three configured completion events plus one generic CI-settled event, with deterministic replay after restart.

- [ ] **Step 1: Add a combined E2E configuration helper**

Add beside `genericConfig()` in `tests/github-connector-e2e.test.ts`:

```ts
function combinedConfig(apiBaseUrl: string): GitHubConnectorConfig {
  return {
    ...config(apiBaseUrl),
    repositories: [{
      name: repo,
      mode: "configured-tools-and-generic-check-runs",
    }],
  };
}
```

Do not add `aggregate`; this scenario must create exactly four events.

- [ ] **Step 2: Add the failing real Relay lifecycle test**

Use the existing `relayHarness()`, `fakeGitHubServer()`, `pr()`, `check()`, and `review()` helpers. Add a test with these exact endpoint states and assertions:

```ts
test("combined mode emits three tool events and one all-checks event", async () => {
  const relay = await relayHarness();
  const sha = "sha-combined";
  const openPath = `/repos/${repo}/pulls?state=open&per_page=100`;
  const closedPath = `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
  const completedPath = `/repos/${repo}/commits/${sha}/check-runs?status=completed&filter=all&per_page=100`;
  const currentPath = `/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`;
  const reviewsPath = `/repos/${repo}/pulls/7/reviews?per_page=100`;
  const associated = (value: Record<string, unknown>) => ({
    ...value,
    pull_requests: [{ number: 7 }],
  });
  const sonar = associated(check(
    801,
    "SonarQube Quality Gate",
    sha,
    11,
    "sonarqube",
    "success",
  ));
  const bugbot = associated(check(
    802,
    "Cursor Bugbot",
    sha,
    22,
    "cursor",
    "neutral",
  ));
  const build = associated(check(
    803,
    "Build and test",
    sha,
    33,
    "actions",
    "failure",
  ));
  const pendingBuild = {
    ...build,
    status: "queued",
    conclusion: null,
    completed_at: null,
  };
  const github = await fakeGitHubServer({
    [openPath]: json([pr(7, "open", sha)]),
    [closedPath]: json([]),
    [`/repos/${repo}/pulls/7`]: json(pr(7, "open", sha)),
    [completedPath]: json({
      total_count: 2,
      check_runs: [sonar, bugbot],
    }),
    [reviewsPath]: json([review(804, sha)]),
    [currentPath]: (_request, count) => json({
      total_count: 3,
      check_runs: count === 0
        ? [sonar, bugbot, pendingBuild]
        : [sonar, bugbot, build],
    }),
  });
  const controller = new AbortController();
  let sleeps = 0;

  try {
    const cfg = combinedConfig(github.url);
    const continuous = await runGitHubConnector({
      config: cfg,
      client: new GitHubClient({
        baseUrl: github.url,
        apiVersion: "2026-03-10",
        token: secret,
      }),
      emitter: new GitHubRelayEmitter({
        baseUrl: relay.base,
        adminToken: relay.server.adminToken,
      }),
      signal: controller.signal,
      sleep: async () => {
        sleeps += 1;
        const count = relay.store.countEvents();
        if (sleeps === 1 || sleeps === 2) assert.equal(count, 3);
        if (sleeps === 3) {
          assert.equal(count, 4);
          controller.abort();
        }
      },
    });

    assert.equal(continuous.emitted, 4);
    assert.equal(relay.store.countEvents(), 4);
    const events = relay.store.snapshotAtHighWater().snapshot.events;
    assert.equal(events.filter((event) => event.type === "pr.automation.completed").length, 3);
    assert.equal(events.filter((event) => event.type === "pr.ci.settled").length, 1);
    assert.equal(events.some((event) => event.type === "pr.automation.settled"), false);
    assert.equal(events.every((event) =>
      event.correlationId === "github:octo/repo:pull-request:7"), true);
    const ci = events.find((event) => event.type === "pr.ci.settled");
    const payload = ci?.payload as {
      outcome: string;
      checks: Array<{ name: string; conclusion: string | null }>;
    };
    assert.equal(payload.outcome, "failure");
    assert.deepEqual(
      payload.checks.map(({ name, conclusion }) => ({ name, conclusion })),
      [
        { name: "SonarQube Quality Gate", conclusion: "success" },
        { name: "Cursor Bugbot", conclusion: "neutral" },
        { name: "Build and test", conclusion: "failure" },
      ],
    );

    const replay = await runGitHubConnector({
      config: cfg,
      client: new GitHubClient({
        baseUrl: github.url,
        apiVersion: "2026-03-10",
        token: secret,
      }),
      emitter: new GitHubRelayEmitter({
        baseUrl: relay.base,
        adminToken: relay.server.adminToken,
      }),
      once: true,
    });
    assert.equal(replay.emitted, 0);
    assert.equal(replay.replayed, 4);
    assert.equal(relay.store.countEvents(), 4);
  } finally {
    await github.close();
    await relay.close();
  }
});
```

- [ ] **Step 3: Run the E2E test and verify combined routing is missing**

Run:

```bash
node --test tests/github-connector-e2e.test.ts
```

Expected before Tasks 1-2 implementation: configuration rejects the combined mode. Expected after Tasks 1-2: the new lifecycle passes without changing existing configured and generic E2E scenarios.

- [ ] **Step 4: Document the three repository modes**

Add this table and combined configuration fragment to the GitHub connector section of `README.md` and the GitHub automation section of `docs/agent-quickstart.md`:

```md
Repository modes:

| Mode | Provider completion events | All Check Runs settled event |
|---|---:|---:|
| `configured-tools` | Yes | No |
| `generic-check-runs` | No | Yes |
| `configured-tools-and-generic-check-runs` | Yes | Yes |

To receive SonarQube, Copilot, and Bugbot completion events plus one
`pr.ci.settled@1` event, set the repository mode to
`configured-tools-and-generic-check-runs`. Omit the optional `aggregate`
mapping when exactly four events are required; configuring it also emits
`pr.automation.settled@1`.
```

Add this exact JSON example immediately after the table:

```json
{
  "name": "owner/repository",
  "mode": "configured-tools-and-generic-check-runs"
}
```

State that Copilot is a submitted pull-request review and therefore does not appear in `pr.ci.settled@1.checks`.

Do not change `src/init.ts` or `examples/github-pr-automation/.relay/connectors/github.json`; generated projects remain configured-only by default.

- [ ] **Step 5: Run focused behavior and onboarding tests**

Run:

```bash
node --test tests/github-config.test.ts tests/github-runner.test.ts tests/github-connector-e2e.test.ts tests/onboarding.test.ts
```

Expected: all tests pass; generated examples remain byte-identical.

- [ ] **Step 6: Typecheck and regenerate tracked JavaScript**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands exit 0. Commit only files actually regenerated by `npm run build`; never hand-edit `dist/src`.

- [ ] **Step 7: Run the full verification suite**

Run:

```bash
npm test
npm run test:onboarding
```

Expected: both commands exit 0 with zero failures.

- [ ] **Step 8: Commit E2E proof, guidance, and generated output**

```bash
git add tests/github-connector-e2e.test.ts README.md docs/agent-quickstart.md dist/src
git commit -m "test(github): prove combined notifications"
```
