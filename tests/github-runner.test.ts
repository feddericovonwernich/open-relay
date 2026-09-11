import assert from "node:assert/strict";
import test from "node:test";
import { runGitHubConnector, runGitHubCycle, type ConnectorSummary } from "../src/connectors/github/runner.ts";
import { GitHubRelayEmitterError, settledKey } from "../src/connectors/github/emitter.ts";
import { GitHubClientError } from "../src/connectors/github/client.ts";
import type { GitHubConnectorConfig, GitHubPullRequest, PrSnapshot, CompletionCandidate, TriggerConfig } from "../src/connectors/github/types.ts";

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
  repositories: ["octo/repo"],
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
    getPullRequest: async () => ({ ...pullRequest, headSha: currentHead }),
  };
}

function summary(overrides: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return { repositories: 1, pullRequests: 0, candidates: 0, emitted: 0, replayed: 0, stale: 0, errors: [], ...overrides };
}

test("one-shot runner recognizes and emits a current candidate", async () => {
  const calls: unknown[] = [];
  const result = await runGitHubConnector({
    config,
    client: clientFor(),
    emitter: { emit: async (...args) => { calls.push(args); return "emitted"; }, emitAggregate: async () => "emitted" },
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
    listReviews: async () => [],
    getPullRequest: async () => { calls.push("get"); return pullRequest; },
  };
  await assert.rejects(runGitHubCycle({ config, client, pullRequestNumber: 0 }), /positive safe integer/);
  const multiConfig = { ...config, repositories: ["octo/repo", "octo/other"] };
  await assert.rejects(runGitHubConnector({ config: multiConfig, client, pullRequestNumber: 1 }), /exactly one configured repository/);
  await assert.rejects(runGitHubCycle({ config: multiConfig, client, pullRequestNumber: 1 }), /exactly one configured repository/);
  assert.deepEqual(calls, []);
});

test("stale candidates are counted but never emitted", async () => {
  let emitted = false;
  const result = await runGitHubCycle({
    config,
    client: clientFor("new-head"),
    emitter: { emit: async () => { emitted = true; return "emitted"; }, emitAggregate: async () => "emitted" },
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
    listReviews: async () => { await request(); return []; },
    getPullRequest: async () => { await request(); return pullRequest; },
  };
  const result = await runGitHubCycle({ config: { ...config, repositories }, client, discover: true });
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
    listReviews: async () => [],
    getPullRequest: async () => pullRequest,
  };
  await assert.rejects(runGitHubCycle({ config: { ...config, repositories: ["octo/repo", "octo/other"] }, client }), /bad token/);
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
    emitter: { emit: async () => { throw new GitHubRelayEmitterError("credential_failed", "runtime rejected", 401); }, emitAggregate: async () => "emitted" },
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
    listReviews: async () => [],
    getPullRequest: async () => pullRequest,
  };
  const cycleOptions = { config: { ...config, repositories: ["octo/bad", "octo/good"] }, client, state, now: () => now, discover: true };
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
    emitter: { emit: async () => "emitted", emitAggregate: async () => "emitted" },
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
    emitter: { emit: async () => { emissions += 1; throw new GitHubRelayEmitterError("trigger_drift", "drift"); }, emitAggregate: async () => "emitted" },
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
