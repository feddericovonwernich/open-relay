import { GitHubClient, GitHubClientError } from "./client.ts";
import { GitHubRelayEmitter, GitHubRelayEmitterError } from "./emitter.ts";
import { discoverPullRequests, deriveSnapshotRequirements, loadPrSnapshot, mapConcurrent, verifyCurrentHead } from "./poller.ts";
import { recognizeSonarQube } from "./recognizers/sonarqube.ts";
import { recognizeCopilotReviews } from "./recognizers/copilot.ts";
import { recognizeCursorBugbot } from "./recognizers/bugbot.ts";
import type { GitHubConnectorConfig, CompletionCandidate, PrSnapshot, TriggerConfig, RecognizerId } from "./types.ts";

export interface ConnectorSummary {
  repositories: number;
  pullRequests: number;
  candidates: number;
  emitted: number;
  replayed: number;
  stale: number;
  errors: string[];
}

type Client = Pick<GitHubClient, "listOpenPullRequests" | "listRecentClosedPullRequests" | "listCompletedCheckRuns" | "listReviews" | "getPullRequest">;
type Emitter = Pick<GitHubRelayEmitter, "emit">;
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type Log = (value: string) => void;
type HeadVerifier = (candidate: { repository: string; pullRequestNumber: number; artifactHeadSha: string }, signal?: AbortSignal) => Promise<boolean>;
type Recognizer = (snapshot: PrSnapshot, trigger: TriggerConfig) => readonly CompletionCandidate[];

export interface GitHubRunnerState {
  transientDelay: number;
  disabled: boolean;
}

type RepositoryState = GitHubRunnerState;

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
  state?: Map<string, RepositoryState>;
  disabledTriggers?: Set<string>;
  headVerifier?: HeadVerifier;
  verifyCurrentHead?: HeadVerifier;
  recognizers?: Partial<Record<RecognizerId, Recognizer>>;
}

export interface GitHubConnectorRunOptions extends GitHubCycleOptions {
  once?: boolean;
}

const recognizers = {
  sonarqube: recognizeSonarQube,
  "copilot-review": recognizeCopilotReviews,
  "cursor-bugbot": recognizeCursorBugbot,
} as const;

export { recognizers };

const DEFAULT_SLEEP: Sleep = (milliseconds, signal) => new Promise<void>((resolve, reject) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
    resolve();
  };
  const aborted = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
    reject(new DOMException("The operation was aborted", "AbortError"));
  };
  if (signal.aborted) {
    aborted();
    return;
  }
  timer = setTimeout(done, Math.max(0, milliseconds));
  signal.addEventListener("abort", aborted, { once: true });
});

function emptySummary(repositories: number): ConnectorSummary {
  return { repositories, pullRequests: 0, candidates: 0, emitted: 0, replayed: 0, stale: 0, errors: [] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function isTransient(error: unknown): boolean {
  return error instanceof GitHubClientError && error.code === "github_transient_error";
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubClientError && error.code === "github_not_found";
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof GitHubClientError && error.code === "github_auth_failed";
}

function discoveryIdentities(snapshot: PrSnapshot): Record<string, unknown>[] {
  const identities: Record<string, unknown>[] = [];
  for (const run of snapshot.checkRuns) {
    identities.push({
      kind: "check_run",
      name: run.name,
      appId: run.app?.id ?? null,
      appSlug: run.app?.slug ?? null,
    });
  }
  for (const review of snapshot.reviews) {
    if (review.user === null) continue;
    identities.push({
      kind: "pull_request_review",
      login: review.user.login,
      userId: review.user.id,
      appUrl: review.user.htmlUrl,
    });
  }
  return identities;
}

function logCandidate(log: Log | undefined, snapshot: PrSnapshot, candidate: CompletionCandidate, result: string): void {
  log?.(JSON.stringify({
    connector: "github",
    "repository.id": snapshot.repository.id,
    "repository.fullName": snapshot.repository.fullName,
    "pullRequest.number": snapshot.pullRequest.number,
    "pullRequest.headSha": snapshot.pullRequest.headSha,
    recognizer: candidate.provider,
    triggerId: candidate.triggerId,
    "artifact.id": candidate.artifactId,
    result,
  }));
}

function stateFor(states: Map<string, RepositoryState>, repository: string): RepositoryState {
  const existing = states.get(repository);
  if (existing !== undefined) return existing;
  const state = { transientDelay: 0, disabled: false };
  states.set(repository, state);
  return state;
}

async function runRepository(
  options: GitHubCycleOptions,
  repository: string,
  summary: ConnectorSummary,
  states: Map<string, RepositoryState>,
  signal: AbortSignal,
  now: () => number,
  sleep: Sleep,
): Promise<void> {
  const state = stateFor(states, repository);
  if (state.disabled || signal.aborted) return;
  try {
    const pullRequests = await discoverPullRequests(options.client, repository, now() - options.config.lookbackHours * 60 * 60 * 1000, signal);
    summary.pullRequests += pullRequests.length;
    state.transientDelay = 0;
    const requirements = deriveSnapshotRequirements(options.config.triggers);
    const snapshots = await mapConcurrent(pullRequests, 4, (pullRequest) => loadPrSnapshot(options.client, repository, pullRequest, requirements, signal));
    for (const snapshot of snapshots) {
      if (options.discover) {
        for (const identity of discoveryIdentities(snapshot)) options.onDiscovery?.({ repository: snapshot.repository.fullName, pullRequest: snapshot.pullRequest.number, ...identity });
      }
      for (const trigger of options.config.triggers) {
        if (options.disabledTriggers?.has(trigger.id)) continue;
        const configuredRecognizers = options.recognizers ?? {};
        const recognizer = configuredRecognizers[trigger.recognizer] ?? recognizers[trigger.recognizer];
        let candidates: readonly CompletionCandidate[];
        try {
          candidates = recognizer(snapshot, trigger as never);
        } catch (error) {
          summary.errors.push(`recognizer ${trigger.id}: ${errorText(error)}`);
          continue;
        }
        for (const candidate of candidates) {
          summary.candidates += 1;
          logCandidate(options.log, snapshot, candidate, "recognized");
          if (options.discover || options.emitter === undefined) continue;
          try {
            const verifyHead = options.headVerifier ?? options.verifyCurrentHead ?? ((candidateToVerify: { repository: string; pullRequestNumber: number; artifactHeadSha: string }, verifySignal?: AbortSignal) => verifyCurrentHead(options.client, candidateToVerify, verifySignal));
            const current = await verifyHead({ repository, pullRequestNumber: candidate.pullRequestNumber, artifactHeadSha: candidate.artifactHeadSha }, signal);
            if (!current) {
              summary.stale += 1;
              logCandidate(options.log, snapshot, candidate, "stale");
              continue;
            }
            const result = await options.emitter.emit(trigger, snapshot, candidate, signal);
            if (result === "emitted") summary.emitted += 1;
            else summary.replayed += 1;
            logCandidate(options.log, snapshot, candidate, result);
          } catch (error) {
            if (isAbort(error, signal)) throw error;
            if (error instanceof GitHubRelayEmitterError && (error.code === "trigger_drift" || error.code === "trigger_invalid")) {
              options.disabledTriggers?.add(trigger.id);
              summary.errors.push(`${error.code}: ${errorText(error)}`);
            } else {
              summary.errors.push(`emission ${candidate.artifactId}: ${errorText(error)}`);
            }
            logCandidate(options.log, snapshot, candidate, "error");
          }
        }
      }
    }
  } catch (error) {
    if (isAbort(error, signal)) return;
    if (isAuthFailure(error)) throw error;
    if (isNotFound(error)) {
      state.disabled = true;
      summary.errors.push(`repository ${repository}: not found`);
      return;
    }
    if (isTransient(error)) {
      state.transientDelay = state.transientDelay === 0 ? options.config.pollIntervalMs : Math.min(options.config.pollIntervalMs * 8, state.transientDelay * 2);
      summary.errors.push(`repository ${repository}: ${errorText(error)}`);
      await sleep(state.transientDelay, signal);
      return;
    }
    summary.errors.push(`repository ${repository}: ${errorText(error)}`);
  }
}

export async function runGitHubCycle(options: GitHubCycleOptions): Promise<ConnectorSummary> {
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now ?? options.clock ?? Date.now;
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const states = options.state ?? new Map<string, RepositoryState>();
  const summary = emptySummary(options.config.repositories.length);
  await mapConcurrent(options.config.repositories, 4, (repository) => runRepository(options, repository, summary, states, signal, now, sleep));
  return summary;

}

export async function runGitHubConnector(options: GitHubConnectorRunOptions): Promise<ConnectorSummary> {
  const signal = options.signal ?? new AbortController().signal;
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const state = options.state ?? new Map<string, RepositoryState>();
  const total = emptySummary(options.config.repositories.length);
  const disabledTriggers = options.disabledTriggers ?? new Set<string>();
  const merge = (summary: ConnectorSummary): void => {
    total.pullRequests += summary.pullRequests;
    total.candidates += summary.candidates;
    total.emitted += summary.emitted;
    total.replayed += summary.replayed;
    total.stale += summary.stale;
    total.errors.push(...summary.errors);
  };
  do {
    if (signal.aborted) break;
    const cycle = await runGitHubCycle({ ...options, signal, sleep, state, disabledTriggers });
    merge(cycle);
    if (options.once || options.discover || signal.aborted) break;
    try { await sleep(options.config.pollIntervalMs, signal); } catch (error) { if (!isAbort(error, signal)) throw error; break; }
  } while (!options.once);
  return total;
}