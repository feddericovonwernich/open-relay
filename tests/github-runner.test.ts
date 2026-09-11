import assert from "node:assert/strict";
import test from "node:test";
import { runGitHubConnector, runGitHubCycle, type ConnectorSummary } from "../src/connectors/github/runner.ts";
import { GitHubRelayEmitterError, settledKey } from "../src/connectors/github/emitter.ts";
import { GitHubClientError } from "../src/connectors/github/client.ts";
import type { GitHubConnectorConfig, GitHubPullRequest, PrSnapshot, CompletionCandidate, TriggerConfig, GitHubCheckRun } from "../src/connectors/github/types.ts";

const trigger = {
  id: "sonar-v1",
  recognizer: "sonarqube" as const,
  match: { checkNames: ["SonarCloud Code Analysis"], appIds: [42], appSlugs: [] },
  emit: { type: "pr.automation.completed", version: 1 },
};
const config: GitHubConnectorConfig = {
  connector: "github",
  apiBaseUrl: "https://api.github.com",
  apiVersion: "2026-03-10",
  tokenEnv: "GITHUB_TOKEN",
  pollIntervalMs: 5_000,
  lookbackHours: 24,
  repositories: [{ name: "octo/repo", mode: "configured-tools" }],
  triggers: [trigger],
};
const aggregateTrigger: TriggerConfig = {
  id: "bugbot-v1",
  recognizer: "cursor-bugbot",
  match: { checkNames: ["Cursor Bugbot"], appIds: [43], appSlugs: [] },
  emit: { type: "pr.automation.completed", version: 1 },
};
const aggregateConfig: GitHubConnectorConfig = {
  ...config,
  triggers: [trigger, aggregateTrigger],
  aggregate: { id: "settled-v1", emit: { type: "pr.automation.settled", version: 1 } },
};
const pullRequest: GitHubPullRequest = {
  number: 7,
  url: "https://github.com/octo/repo/pull/7",
  headSha: "abc",
  baseRef: "main",
  state: "open",
  updatedAt: new Date().toISOString(),
  repositoryId: 99,
  repositoryFullName: "octo/repo",
};
const snapshot: PrSnapshot = {
  repository: { id: 99, fullName: "octo/repo" },
  pullRequest: { number: 7, url: pullRequest.url, headSha: "abc", baseRef: "main", updatedAt: pullRequest.updatedAt },
  checkRuns: [{ id: 1, name: "SonarCloud Code Analysis", status: "completed", conclusion: "success", headSha: "abc", completedAt: new Date().toISOString(), detailsUrl: "https://sonar", app: { id: 42, slug: "sonarcloud" }, pullRequests: [{ number: 7 }] }],
  reviews: [],
};

function clientFor(currentHead = "abc") {
  return {
    listOpenPullRequests: async () => [pullRequest],
    listRecentClosedPullRequests: async () => [],
    listReviews: async () => [],
    listCompletedCheckRuns: async () => [...snapshot.checkRuns],
    listCurrentCheckRuns: async () => [...snapshot.checkRuns],
    getPullRequest: async () => ({ ...pullRequest, headSha: currentHead }),
  };
}

function summary(overrides: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return { repositories: 1, pullRequests: 0, candidates: 0, emitted: 0, replayed: 0, stale: 0, errors: [], ...overrides };
}

const genericConfig: GitHubConnectorConfig = {
  ...config,
  repositories: [{ name: "octo/repo", mode: "generic-check-runs" }],
  triggers: [],
};
const combinedConfig: GitHubConnectorConfig = {
  ...config,
  repositories: [{
    name: "octo/repo",
    mode: "configured-tools-and-generic-check-runs",
  }],
};

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
test("continuous combined mode emits configured output before stable generic CI", async () => {
  const state = new Map();
  let configured = 0;
  let ci = 0;
  const emitter = {
    emit: async () => { configured += 1; return "emitted" as const; },
    emitAggregate: async () => "emitted" as const,
    emitCiSettled: async () => { ci += 1; return "emitted" as const; },
  };
  const cycle = () => runGitHubCycle({
    config: combinedConfig,
    client: { ...clientFor(), listCurrentCheckRuns: async () => [checkRun(23)] },
    emitter,
    state,
    verifyCurrentHead: async () => true,
  });

  const first = await cycle();
  assert.equal(first.emitted, 1);
  assert.equal(configured, 1);
  assert.equal(ci, 0);
  const second = await cycle();
  assert.equal(second.emitted, 2);
  assert.equal(configured, 2);
  assert.equal(ci, 1);
});

test("combined discovery loads configured checks and reviews but skips current checks and state", async () => {
  const calls: string[] = [];
  const state = new Map();
  const identities: Record<string, unknown>[] = [];
  const copilotTrigger: TriggerConfig = {
    id: "copilot-v1",
    recognizer: "copilot-review",
    match: { checkNames: [], appIds: [], appSlugs: [] },
    emit: { type: "pr.automation.completed", version: 1 },
  };
  const client = {
    ...clientFor(),
    listCompletedCheckRuns: async () => { calls.push("completed"); return [...snapshot.checkRuns]; },
    listCurrentCheckRuns: async () => { calls.push("current"); return [checkRun(24)]; },
    listReviews: async () => { calls.push("reviews"); return []; },
  };
  const result = await runGitHubCycle({
    config: { ...combinedConfig, triggers: [trigger, copilotTrigger] },
    client,
    state,
    discover: true,
    once: true,
    onDiscovery: (identity) => identities.push(identity),
  });

  assert.equal(result.emitted, 0);
  assert.deepEqual(calls, ["completed", "reviews"]);
  assert.equal(identities.some((identity) => identity.kind === "check_run"), true);
  assert.equal(state.get("octo/repo")?.ciObservations.size ?? 0, 0);
});

test("configured trigger drift does not suppress combined generic CI settlement", async () => {
  let ci = 0;
  const result = await runGitHubCycle({
    config: combinedConfig,
    client: { ...clientFor(), listCurrentCheckRuns: async () => [checkRun(25)] },
    emitter: {
      emit: async () => { throw new GitHubRelayEmitterError("trigger_invalid", "missing trigger", 404); },
      emitAggregate: async () => "emitted",
      emitCiSettled: async () => { ci += 1; return "emitted"; },
    },
    once: true,
    verifyCurrentHead: async () => true,
  });

  assert.equal(ci, 1);
  assert.equal(result.emitted, 1);
  assert.deepEqual(result.errors, ["trigger_invalid: missing trigger"]);
});

test("stale configured aggregate verification does not suppress combined generic CI", async () => {
  let verifications = 0;
  let ci = 0;
  const combinedAggregateConfig: GitHubConnectorConfig = {
    ...combinedConfig,
    aggregate: aggregateConfig.aggregate,
  };
  const result = await runGitHubCycle({
    config: combinedAggregateConfig,
    client: { ...clientFor(), listCurrentCheckRuns: async () => [checkRun(26)] },
    recognizers: { sonarqube: () => [candidateFor("sonar-v1", "sonar-26")] },
    emitter: {
      emit: async () => "emitted",
      emitAggregate: async () => "emitted",
      emitCiSettled: async () => { ci += 1; return "emitted"; },
    },
    once: true,
    verifyCurrentHead: async () => {
      verifications += 1;
      return verifications !== 2;
    },
  });

  assert.equal(result.emitted, 2);
  assert.equal(verifications, 3);
});

function checkRun(id: number, overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id,
    name: `CI ${id}`,
    status: "completed",
    conclusion: "success",
    headSha: "abc",
    completedAt: "2026-01-01T00:00:00.000Z",
    detailsUrl: `https://checks/${id}`,
    app: null,
    pullRequests: [{ number: 7 }],
    ...overrides,
  };
}

function genericClient(
  current: () => readonly GitHubCheckRun[],
  repositories: readonly string[] = ["octo/repo"],
) {
  return {
    listOpenPullRequests: async (repository: string) => repositories.includes(repository) ? [{ ...pullRequest, repositoryFullName: repository }] : [],
    listRecentClosedPullRequests: async () => [],
    listCompletedCheckRuns: async () => [],
    listCurrentCheckRuns: async (_repository: string, _headSha: string) => [...current()],
    listReviews: async () => [],
    getPullRequest: async (_repository: string, number: number) => ({ ...pullRequest, number }),
  };
}

function genericEmitter(
  ci: Array<{ repository: string; checks: readonly GitHubCheckRun[] }> = [],
  result: "emitted" | "replayed" = "emitted",
) {
  return {
    emit: async () => { throw new Error("configured emit must not run"); },
    emitAggregate: async () => { throw new Error("configured aggregate must not run"); },
    emitCiSettled: async (snapshot: PrSnapshot, checks: readonly GitHubCheckRun[]) => {
      ci.push({ repository: snapshot.repository.fullName, checks });
      return result;
    },
  };
}

test("generic mode bypasses configured recognizers and aggregate", async () => {
  const emitted: Array<{ repository: string; checks: readonly GitHubCheckRun[] }> = [];
  const calls: string[] = [];
  const client = {
    ...genericClient(() => [checkRun(2, { name: "SonarCloud Code Analysis", app: { id: 42, slug: "sonarcloud" } })]),
    listCompletedCheckRuns: async () => { calls.push("completed"); throw new Error("completed endpoint must not run"); },
    listCurrentCheckRuns: async () => { calls.push("current"); return [checkRun(2, { name: "SonarCloud Code Analysis", app: { id: 42, slug: "sonarcloud" } })]; },
    listReviews: async () => { calls.push("reviews"); return []; },
  };
  const result = await runGitHubCycle({
    config: { ...genericConfig, triggers: [trigger], aggregate: aggregateConfig.aggregate },
    client,
    recognizers: { sonarqube: () => { throw new Error("configured recognizer must not run"); } },
    emitter: genericEmitter(emitted),
    once: true,
    verifyCurrentHead: async () => true,
  });
  assert.equal(result.candidates, 1);
  assert.equal(result.emitted, 1);
  assert.equal(emitted.length, 1);
  assert.deepEqual(calls, ["current"]);
});

test("mixed repositories keep generic and configured paths independent", async () => {
  const mixed: GitHubConnectorConfig = {
    ...config,
    repositories: [
      { name: "octo/generic", mode: "generic-check-runs" },
      { name: "octo/configured", mode: "configured-tools" },
    ],
  };
  const calls: string[] = [];
  const client = {
    ...genericClient(() => [checkRun(3)] , ["octo/generic", "octo/configured"]),
    listCompletedCheckRuns: async (repository: string) => {
      calls.push(`completed:${repository}`);
      return repository === "octo/configured"
        ? [{ ...checkRun(4), name: "SonarCloud Code Analysis", app: { id: 42, slug: "sonarcloud" } }]
        : [];
    },
    listCurrentCheckRuns: async (repository: string) => {
      calls.push(`current:${repository}`);
      return repository === "octo/generic" ? [checkRun(3)] : [];
    },
  };
  let ci = 0;
  let configured = 0;
  const result = await runGitHubCycle({
    config: mixed,
    client,
    emitter: {
      emit: async () => { configured += 1; return "emitted"; },
      emitAggregate: async () => "emitted",
      emitCiSettled: async () => { ci += 1; return "emitted"; },
    },
    once: true,
    verifyCurrentHead: async () => true,
  });
  assert.equal(ci, 1);
  assert.equal(configured, 1);
  assert.deepEqual(calls.sort(), ["completed:octo/configured", "current:octo/generic"]);
  assert.equal(result.emitted, 2);
});

test("generic continuous mode requires two identical terminal observations and deduplicates the third", async () => {
  const state = new Map();
  const checks = [checkRun(5)];
  let calls = 0;
  const result = [];
  const emitter = genericEmitter();
  emitter.emitCiSettled = async () => { calls += 1; return "emitted"; };
  for (let cycle = 0; cycle < 3; cycle += 1) {
    result.push(await runGitHubCycle({
      config: genericConfig,
      client: genericClient(() => checks),
      emitter,
      state,
      verifyCurrentHead: async () => true,
    }));
  }
  assert.deepEqual(result.map((entry) => [entry.candidates, entry.emitted, entry.replayed]), [[1, 0, 0], [1, 1, 0], [1, 0, 0]]);
  assert.equal(calls, 1);
});

test("empty or pending generic observations reset stability state", async () => {
  const state = new Map();
  let checks: readonly GitHubCheckRun[] = [checkRun(6)];
  let calls = 0;
  const emitter = genericEmitter();
  emitter.emitCiSettled = async () => { calls += 1; return "emitted"; };
  const cycle = () => runGitHubCycle({ config: genericConfig, client: genericClient(() => checks), emitter, state, verifyCurrentHead: async () => true });
  await cycle();
  checks = [];
  const empty = await cycle();
  assert.equal(empty.candidates, 0);
  assert.equal(state.get("octo/repo")?.ciObservations.size, 0);
  checks = [checkRun(6, { status: "in_progress", completedAt: null })];
  const pending = await cycle();
  assert.equal(pending.candidates, 0);
  assert.equal(state.get("octo/repo")?.ciObservations.size, 0);
  checks = [checkRun(6)];
  await cycle();
  assert.equal(calls, 0);
});

test("generic once emits immediately while once plus discover only reports identities", async () => {
  const onceCalls: Array<readonly GitHubCheckRun[]> = [];
  const once = await runGitHubCycle({
    config: genericConfig,
    client: genericClient(() => [checkRun(7)]),
    emitter: { ...genericEmitter(), emitCiSettled: async (_snapshot, checks) => { onceCalls.push(checks); return "emitted"; } },
    once: true,
    verifyCurrentHead: async () => true,
  });
  assert.equal(once.emitted, 1);
  assert.equal(onceCalls.length, 1);
  const state = new Map();
  const identities: Record<string, unknown>[] = [];
  const discovered = await runGitHubCycle({
    config: genericConfig,
    client: genericClient(() => [checkRun(7)]),
    emitter: { ...genericEmitter(), emitCiSettled: async () => { throw new Error("discover must not emit"); } },
    state,
    once: true,
    discover: true,
    onDiscovery: (identity) => identities.push(identity),
  });
  assert.equal(discovered.emitted, 0);
  assert.equal(identities.length, 1);
  assert.equal(state.get("octo/repo")?.ciObservations.size ?? 0, 0);
});

test("generic head changes reset stability and stale final fence drops the observation", async () => {
  const state = new Map();
  let head = "abc";
  const checks = () => [checkRun(8, { headSha: head })];
  let verify = true;
  let calls = 0;
  const emitter = genericEmitter();
  emitter.emitCiSettled = async () => { calls += 1; return "emitted"; };
  const cycle = () => runGitHubCycle({
    config: genericConfig,
    client: { ...genericClient(checks), listOpenPullRequests: async () => [{ ...pullRequest, headSha: head }] },
    emitter,
    state,
    verifyCurrentHead: async () => verify,
  });
  await cycle();
  head = "def";
  await cycle();
  assert.equal(state.get("octo/repo")?.ciObservations.get(7)?.consecutive, 1);
  verify = false;
  const stale = await cycle();
  assert.equal(stale.emitted, 0);
  assert.equal(calls, 0);
  assert.equal(state.get("octo/repo")?.ciObservations.size, 0);
  verify = true;
  await cycle();
  await cycle();
  assert.equal(calls, 1);
});

test("late additions, disappearance, conclusions, and timestamps restart stability", async () => {
  const state = new Map();
  let checks: readonly GitHubCheckRun[] = [checkRun(9)];
  let calls = 0;
  const emitter = genericEmitter();
  emitter.emitCiSettled = async () => { calls += 1; return "emitted"; };
  const cycle = () => runGitHubCycle({ config: genericConfig, client: genericClient(() => checks), emitter, state, verifyCurrentHead: async () => true });
  await cycle();
  await cycle();
  for (const next of [
    [checkRun(9), checkRun(10)],
    [checkRun(9), checkRun(10)],
    [checkRun(9)],
    [checkRun(9)],
    [checkRun(9, { conclusion: "failure" })],
    [checkRun(9, { conclusion: "failure" })],
    [checkRun(9, { conclusion: "failure", completedAt: "2026-01-02T00:00:00.000Z" })],
    [checkRun(9, { conclusion: "failure", completedAt: "2026-01-02T00:00:00.000Z" })],
  ] as const) {
    checks = next;
    await cycle();
  }
  assert.equal(calls, 4);
});
test("retained identities survive A to A+B to A transitions", async () => {
  const state = new Map();
  let checks: readonly GitHubCheckRun[] = [checkRun(11)];
  const emitted: string[] = [];
  const emitter = genericEmitter();
  emitter.emitCiSettled = async (_snapshot, observed) => { emitted.push(observed.map((run) => run.id).join(",")); return "emitted"; };
  const cycle = () => runGitHubCycle({ config: genericConfig, client: genericClient(() => checks), emitter, state, verifyCurrentHead: async () => true });
  await cycle();
  await cycle();
  checks = [checkRun(11), checkRun(12)];
  await cycle();
  await cycle();
  checks = [checkRun(11)];
  await cycle();
  await cycle();
  assert.deepEqual(emitted, ["11", "11,12"]);
});

test("ordinary generic Relay failures remain eligible for retry", async () => {
  const state = new Map();
  let attempts = 0;
  const emitter = genericEmitter();
  emitter.emitCiSettled = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary relay failure");
    return "emitted";
  };
  const cycle = () => runGitHubCycle({ config: genericConfig, client: genericClient(() => [checkRun(13)]), emitter, state, verifyCurrentHead: async () => true });
  const first = await cycle();
  const second = await cycle();
  const third = await cycle();
  assert.equal(first.errors.length, 0);
  assert.match(second.errors[0] ?? "", /temporary relay failure/);
  assert.equal(third.emitted, 1);
  assert.equal(attempts, 2);
});

test("ci_invalid disables only the affected generic repository", async () => {
  const configWithTwo: GitHubConnectorConfig = {
    ...genericConfig,
    repositories: [
      { name: "octo/bad", mode: "generic-check-runs" },
      { name: "octo/good", mode: "generic-check-runs" },
    ],
  };
  const disabled = new Set<string>();
  let calls = 0;
  const emitter = {
    ...genericEmitter(),
    emitCiSettled: async (snapshot: PrSnapshot) => {
      calls += 1;
      if (snapshot.repository.fullName === "octo/bad") throw new GitHubRelayEmitterError("ci_invalid", "missing definition", 404);
      return "emitted" as const;
    },
  };
  const cycle = () => runGitHubCycle({
    config: configWithTwo,
    client: genericClient(() => [checkRun(14)], ["octo/bad", "octo/good"]),
    emitter,
    state: new Map(),
    disabledCiRepositories: disabled,
    once: true,
    verifyCurrentHead: async () => true,
  });
  const result = await cycle();
  assert.deepEqual([...disabled], ["octo/bad"]);
  assert.equal(calls, 2);
  assert.equal(result.errors.filter((error) => error.startsWith("ci_invalid:")).length, 1);
  await cycle();
  assert.equal(calls, 3);
});

test("successful generic discovery removes observations for missing pull requests", async () => {
  const state = new Map();
  let pullRequests: readonly GitHubPullRequest[] = [pullRequest];
  const client = {
    ...genericClient(() => [checkRun(16)]),
    listOpenPullRequests: async () => [...pullRequests],
  };
  await runGitHubCycle({
    config: genericConfig,
    client,
    state,
    verifyCurrentHead: async () => true,
  });
  assert.equal(state.get("octo/repo")?.ciObservations.has(7), true);
  pullRequests = [];
  await runGitHubCycle({
    config: genericConfig,
    client,
    state,
    verifyCurrentHead: async () => true,
  });
  assert.equal(state.get("octo/repo")?.ciObservations.size, 0);
});
test("targeted generic mode retains only the selected pull request observation", async () => {
  const state = new Map();
  const client = genericClient(() => [checkRun(17)]);
  const emitter = genericEmitter();
  await runGitHubCycle({ config: genericConfig, client, emitter, state, pullRequestNumber: 7 });
  const repositoryState = state.get("octo/repo");
  repositoryState?.ciObservations.set(8, repositoryState.ciObservations.get(7));
  await runGitHubCycle({ config: genericConfig, client, emitter, state, pullRequestNumber: 7 });
  assert.deepEqual([...repositoryState.ciObservations.keys()], [7]);
});
test("fresh generic state accepts a Relay replay without creating another event", async () => {
  let calls = 0;
  const result = await runGitHubCycle({
    config: genericConfig,
    client: genericClient(() => [checkRun(15)]),
    emitter: { ...genericEmitter(), emitCiSettled: async () => { calls += 1; return "replayed"; } },
    once: true,
    verifyCurrentHead: async () => true,
  });
  assert.equal(result.emitted, 0);
  assert.equal(result.replayed, 1);
  assert.equal(calls, 1);
});

test("one-shot runner recognizes and emits a current candidate", async () => {
  const calls: unknown[] = [];
  const result = await runGitHubConnector({
    config,
    client: clientFor(),
    emitter: { emit: async (...args) => { calls.push(args); return "emitted"; }, emitAggregate: async () => "emitted", emitCiSettled: async () => "emitted" },
    once: true,
    clock: () => Date.now(),
  });
  assert.deepEqual(result, summary({ pullRequests: 1, candidates: 1, emitted: 1 }));
  assert.equal(calls.length, 1);
});
test("targeted cycle directly loads only the selected pull request", async () => {
  const calls: string[] = [];
  const target = { ...pullRequest, number: 197, headSha: "target-head", url: "https://github.com/octo/repo/pull/197" };
  const result = await runGitHubCycle({
    config,
    client: {
      listOpenPullRequests: async () => { calls.push("list-open"); throw new Error("list endpoint must not be called"); },
      listRecentClosedPullRequests: async () => { calls.push("list-closed"); throw new Error("list endpoint must not be called"); },
      listCompletedCheckRuns: async (_repository, headSha) => { calls.push(`checks:${headSha}`); return []; },
      listCurrentCheckRuns: async (_repository, headSha) => { calls.push(`current-checks:${headSha}`); return []; },
      listReviews: async () => [],
      getPullRequest: async (_repository, number) => { calls.push(`get:${number}`); return target; },
    },
    pullRequestNumber: 197,
    discover: true,
  });
  assert.equal(result.pullRequests, 1);
  assert.deepEqual(calls, ["get:197", "checks:target-head"]);
});

test("both runner entry points validate targeted selection before repository access", async () => {
  const calls: string[] = [];
  const client = {
    listOpenPullRequests: async () => { calls.push("list"); return []; },
    listRecentClosedPullRequests: async () => [],
    listCompletedCheckRuns: async () => [],
    listCurrentCheckRuns: async () => [],
    listReviews: async () => [],
    getPullRequest: async () => { calls.push("get"); return pullRequest; },
  };
  await assert.rejects(runGitHubCycle({ config, client, pullRequestNumber: 0 }), /positive safe integer/);
  const multiConfig = {
    ...config,
    repositories: [
      { name: "octo/repo", mode: "configured-tools" as const },
      { name: "octo/other", mode: "configured-tools" as const },
    ],
  };
  await assert.rejects(runGitHubConnector({ config: multiConfig, client, pullRequestNumber: 1 }), /exactly one configured repository/);
  await assert.rejects(runGitHubCycle({ config: multiConfig, client, pullRequestNumber: 1 }), /exactly one configured repository/);
  assert.deepEqual(calls, []);
});

test("stale candidates are counted but never emitted", async () => {
  let emitted = false;
  const result = await runGitHubCycle({
    config,
    client: clientFor("new-head"),
    emitter: { emit: async () => { emitted = true; return "emitted"; }, emitAggregate: async () => "emitted", emitCiSettled: async () => "emitted" },
  });
  assert.deepEqual(result, summary({ pullRequests: 1, candidates: 1, stale: 1 }));
  assert.equal(emitted, false);
});

test("discovery reports identities without emission", async () => {
  const identities: Record<string, unknown>[] = [];
  const result = await runGitHubConnector({ config, client: clientFor(), once: true, discover: true, onDiscovery: (identity) => identities.push(identity) });
  assert.equal(result.emitted, 0);
  assert.equal(result.replayed, 0);
  assert.equal(identities[0]?.appId, 42);
});

test("recognizer failures are isolated", async () => {
  const result = await runGitHubCycle({
    config,
    client: clientFor(),
    recognizers: { sonarqube: () => { throw new Error("broken recognizer"); } },
  });
  assert.deepEqual(result, summary({ pullRequests: 1, errors: ["recognizer sonar-v1: broken recognizer"] }));
});

test("trigger drift disables only that trigger for later cycles", async () => {
  const controller = new AbortController();
  let sleeps = 0;
  let emissions = 0;
  const result = await runGitHubConnector({
    config,
    client: clientFor(),
    emitter: {
      emit: async () => {
        emissions += 1;
        throw new GitHubRelayEmitterError("trigger_drift", "drift");
      },
      emitAggregate: async () => "emitted",
      emitCiSettled: async () => "emitted",
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) controller.abort();
    },
    signal: controller.signal,
  });
  assert.equal(emissions, 1);
  assert.equal(result.candidates, 1);
  assert.equal(result.errors.length, 1);
});

function candidate(id: string): CompletionCandidate {
  return {
    provider: "sonarqube",
    triggerId: trigger.id,
    repositoryId: 99,
    pullRequestNumber: 7,
    artifactKind: "check_run",
    artifactId: id,
    artifactHeadSha: "abc",
    artifact: { name: "Sonar", completion: "completed", conclusion: "success", completedAt: new Date().toISOString(), detailsUrl: null },
  };
}

function candidateFor(triggerId: string, artifactId: string, provider = "sonarqube"): CompletionCandidate {
  return { ...candidate(artifactId), triggerId, provider, artifact: { ...candidate(artifactId).artifact, name: provider } };
}

test("all GitHub requests share a global concurrency ceiling of four", async () => {
  const repositories = Array.from({ length: 6 }, (_, index) => `octo/repo-${index}`);
  const activeByRequest = { active: 0, maximum: 0 };
  const request = async (): Promise<void> => {
    activeByRequest.active += 1;
    activeByRequest.maximum = Math.max(activeByRequest.maximum, activeByRequest.active);
    await Promise.resolve();
    activeByRequest.active -= 1;
  };
  const client = {
    listOpenPullRequests: async (repository: string) => { await request(); return [{ ...pullRequest, repositoryFullName: repository }]; },
    listRecentClosedPullRequests: async () => { await request(); return []; },
    listCompletedCheckRuns: async () => { await request(); return []; },
    listCurrentCheckRuns: async () => { await request(); return []; },
    listReviews: async () => { await request(); return []; },
    getPullRequest: async () => { await request(); return pullRequest; },
  };
  const result = await runGitHubCycle({ config: { ...config, repositories: repositories.map((name) => ({ name, mode: "configured-tools" as const })) }, client, discover: true });
  assert.equal(result.pullRequests, repositories.length);
  assert.equal(activeByRequest.maximum, 4);
});

test("fatal GitHub auth aborts sibling repository requests", async () => {
  let siblingAborted = false;
  const waitForAbort = async (signal?: AbortSignal): Promise<never> => {
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => { siblingAborted = true; resolve(); }, { once: true }));
    throw new DOMException("aborted", "AbortError");
  };
  const client = {
    listOpenPullRequests: async (repository: string, signal?: AbortSignal) => repository === "octo/repo" ? (() => { throw new GitHubClientError("github_auth_failed", "bad token", 401); })() : waitForAbort(signal),
    listRecentClosedPullRequests: async (_repository: string, _cutoff: number, signal?: AbortSignal) => waitForAbort(signal),
    listCompletedCheckRuns: async () => [],
    listCurrentCheckRuns: async () => [],
    listReviews: async () => [],
    getPullRequest: async () => pullRequest,
  };
  await assert.rejects(runGitHubCycle({
    config: {
      ...config,
      repositories: [
        { name: "octo/repo", mode: "configured-tools" as const },
        { name: "octo/other", mode: "configured-tools" as const },
      ],
    },
    client,
  }), /bad token/);
  assert.equal(siblingAborted, true);
});

test("caller abort returns an accumulated summary after in-flight requests stop", async () => {
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const waitForAbort = async (signal?: AbortSignal): Promise<never> => {
    markStarted();
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw new DOMException("aborted", "AbortError");
  };
  const client = {
    listOpenPullRequests: async (_repository: string, signal?: AbortSignal) => waitForAbort(signal),
    listRecentClosedPullRequests: async (_repository: string, _cutoff: number, signal?: AbortSignal) => waitForAbort(signal),
    listCompletedCheckRuns: async () => [],
    listCurrentCheckRuns: async () => [],
    listReviews: async () => [],
    getPullRequest: async () => pullRequest,
  };
  const running = runGitHubCycle({ config, client, signal: controller.signal });
  await started;
  controller.abort();
  const result = await running;
  assert.deepEqual(result.errors, []);
});

test("Relay credential rejection is fatal", async () => {
  await assert.rejects(runGitHubCycle({
    config,
    client: clientFor(),
    emitter: { emit: async () => { throw new GitHubRelayEmitterError("credential_failed", "runtime rejected", 401); }, emitAggregate: async () => "emitted", emitCiSettled: async () => "emitted" },
  }), /runtime rejected/);
});

test("transient backoff skips only an ineligible repository on the next cycle", async () => {
  const state = new Map();
  let now = 0;
  let badCalls = 0;
  let healthyCalls = 0;
  const client = {
    listOpenPullRequests: async (repository: string) => {
      if (repository === "octo/bad") { badCalls += 1; throw new GitHubClientError("github_transient_error", "temporary"); }
      healthyCalls += 1;
      return [{ ...pullRequest, repositoryFullName: repository }];
    },
    listRecentClosedPullRequests: async () => [],
    listCompletedCheckRuns: async () => [],
    listCurrentCheckRuns: async () => [],
    listReviews: async () => [],
    getPullRequest: async () => pullRequest,
  };
  const cycleOptions = {
    config: {
      ...config,
      repositories: [
        { name: "octo/bad", mode: "configured-tools" as const },
        { name: "octo/good", mode: "configured-tools" as const },
      ],
    },
    client,
    state,
    now: () => now,
    discover: true,
  };
  await runGitHubCycle(cycleOptions);
  now = 1000;
  const second = await runGitHubCycle(cycleOptions);
  assert.equal(badCalls, 1);
  assert.equal(healthyCalls, 2);
  assert.equal(second.pullRequests, 1);
});

test("head verification transient failure enters repository backoff", async () => {
  const state = new Map();
  const result = await runGitHubCycle({
    config,
    client: clientFor(),
    state,
    now: () => 0,
    emitter: { emit: async () => "emitted", emitAggregate: async () => "emitted", emitCiSettled: async () => "emitted" },
    verifyCurrentHead: async () => { throw new GitHubClientError("github_transient_error", "head unavailable"); },
  });
  assert.equal(result.emitted, 0);
  assert.equal(state.get("octo/repo")?.nextEligibleAt, 5_000);
});

test("trigger drift stops remaining candidates for that trigger", async () => {
  let emissions = 0;
  const result = await runGitHubCycle({
    config,
    client: clientFor(),
    recognizers: { sonarqube: () => [candidate("one"), candidate("two")] },
    emitter: { emit: async () => { emissions += 1; throw new GitHubRelayEmitterError("trigger_drift", "drift"); }, emitAggregate: async () => "emitted", emitCiSettled: async () => "emitted" },
  });
  assert.equal(emissions, 1);
  assert.equal(result.candidates, 1);
});

test("structured candidate logs include artifact kind", async () => {
  const logs: Record<string, unknown>[] = [];
  await runGitHubCycle({
    config,
    client: clientFor(),
    log: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    discover: true,
  });
  assert.equal(logs[0]?.["artifact.kind"], "check_run");
});
test("emits aggregate only after every trigger has a current-head candidate", async () => {
  let settled = false;
  const aggregates: CompletionCandidate[][] = [];
  const emitter = {
    emit: async () => "emitted" as const,
    emitAggregate: async (_aggregate: unknown, _snapshot: PrSnapshot, candidates: readonly CompletionCandidate[]) => {
      aggregates.push([...candidates]);
      return "emitted" as const;
    },
    emitCiSettled: async () => "emitted" as const,
  };
  const recognizers = {
    sonarqube: () => [candidateFor("sonar-v1", "sonar-1")],
    "cursor-bugbot": () => settled ? [candidateFor("bugbot-v1", "bugbot-1", "cursor-bugbot")] : [],
  };
  const first = await runGitHubCycle({ config: aggregateConfig, client: clientFor(), emitter, recognizers });
  assert.equal(first.emitted, 1);
  assert.equal(aggregates.length, 0);
  settled = true;
  const second = await runGitHubCycle({ config: aggregateConfig, client: clientFor(), emitter, recognizers });
  assert.equal(second.emitted, 3);
  assert.equal(aggregates.length, 1);
  assert.deepEqual(aggregates[0]?.map((entry) => entry.triggerId), ["sonar-v1", "bugbot-v1"]);
});

test("suppresses aggregate emission when its final head verification is stale", async () => {
  let verifications = 0;
  let aggregates = 0;
  const emitter = {
    emit: async () => "emitted" as const,
    emitAggregate: async () => {
      aggregates += 1;
      return "emitted" as const;
    },
    emitCiSettled: async () => "emitted" as const,
  };
  const recognizers = {
    sonarqube: () => [candidateFor("sonar-v1", "sonar-1")],
    "cursor-bugbot": () => [candidateFor("bugbot-v1", "bugbot-1", "cursor-bugbot")],
  };
  const result = await runGitHubCycle({
    config: aggregateConfig,
    client: clientFor(),
    emitter,
    recognizers,
    verifyCurrentHead: async () => {
      verifications += 1;
      return verifications < 3;
    },
  });
  assert.equal(verifications, 3);
  assert.equal(result.emitted, 2);
  assert.equal(aggregates, 0);
});

test("aggregate mapping failures disable only aggregate emission across connector cycles", async () => {
  const controller = new AbortController();
  const disabledAggregates = new Set<string>();
  let sleeps = 0;
  let individuals = 0;
  let aggregates = 0;
  const emitter = {
    emit: async () => {
      individuals += 1;
      return "emitted" as const;
    },
    emitAggregate: async () => {
      aggregates += 1;
      throw new GitHubRelayEmitterError("aggregate_invalid", "unknown aggregate", 404);
    },
    emitCiSettled: async () => "emitted" as const,
  };
  const recognizers = {
    sonarqube: () => [candidateFor("sonar-v1", "sonar-1")],
    "cursor-bugbot": () => [candidateFor("bugbot-v1", "bugbot-1", "cursor-bugbot")],
  };
  const result = await runGitHubConnector({
    config: aggregateConfig,
    client: clientFor(),
    emitter,
    recognizers,
    disabledAggregates,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) controller.abort();
    },
    signal: controller.signal,
  });
  assert.equal(aggregates, 1);
  assert.equal(individuals, 4);
  assert.deepEqual([...disabledAggregates], ["settled-v1"]);
  assert.equal(result.errors.filter((error) => error.startsWith("aggregate_invalid:")).length, 1);
});

test("aggregate drift disables aggregate across cycles while individuals continue", async () => {
  const controller = new AbortController();
  const disabledAggregates = new Set<string>();
  let sleeps = 0;
  let individuals = 0;
  let aggregates = 0;
  const emitter = {
    emit: async () => {
      individuals += 1;
      return "emitted" as const;
    },
    emitAggregate: async () => {
      aggregates += 1;
      throw new GitHubRelayEmitterError("aggregate_drift", "mapping drift", 409);
    },
    emitCiSettled: async () => "emitted" as const,
  };
  const recognizers = {
    sonarqube: () => [candidateFor("sonar-v1", "sonar-1")],
    "cursor-bugbot": () => [candidateFor("bugbot-v1", "bugbot-1", "cursor-bugbot")],
  };
  const result = await runGitHubConnector({
    config: aggregateConfig,
    client: clientFor(),
    emitter,
    recognizers,
    disabledAggregates,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) controller.abort();
    },
    signal: controller.signal,
  });
  assert.equal(individuals, 4);
  assert.equal(aggregates, 1);
  assert.deepEqual([...disabledAggregates], ["settled-v1"]);
  assert.deepEqual(result.errors, ["aggregate_drift: mapping drift"]);
});

test("changed same-head aggregate membership produces a new aggregate", async () => {
  let artifactId = "one";
  const members: string[][] = [];
  const keys: string[] = [];
  const emitter = {
    emit: async () => "emitted" as const,
    emitAggregate: async (aggregate: NonNullable<GitHubConnectorConfig["aggregate"]>, snapshot: PrSnapshot, candidates: readonly CompletionCandidate[]) => {
      members.push(candidates.map((entry) => entry.artifactId));
      keys.push(settledKey(aggregate, snapshot, candidates));
      return "emitted" as const;
    },
    emitCiSettled: async () => "emitted" as const,
  };
  const recognizers = {
    sonarqube: () => [candidateFor("sonar-v1", artifactId)],
    "cursor-bugbot": () => [candidateFor("bugbot-v1", "bugbot-1", "cursor-bugbot")],
  };
  await runGitHubCycle({ config: aggregateConfig, client: clientFor(), emitter, recognizers });
  artifactId = "two";
  await runGitHubCycle({ config: aggregateConfig, client: clientFor(), emitter, recognizers });
  assert.deepEqual(members, [["one", "bugbot-1"], ["two", "bugbot-1"]]);
  assert.notEqual(keys[0], keys[1]);
});
