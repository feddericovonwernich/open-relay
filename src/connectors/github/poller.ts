import type { GitHubClient } from "./client.ts";
import type {
  CompletionCandidate,
  GitHubPullRequest,
  PrSnapshot,
  TriggerConfig,
} from "./types.ts";

export interface SnapshotRequirements {
  checkRuns: "none" | "completed" | "current";
  reviews: boolean;
}

type Client = Pick<
  GitHubClient,
  | "listOpenPullRequests"
  | "listRecentClosedPullRequests"
  | "listCompletedCheckRuns"
  | "listCurrentCheckRuns"
  | "listReviews"
  | "getPullRequest"
>;

export interface CurrentHeadCandidate extends Pick<CompletionCandidate, "pullRequestNumber" | "artifactHeadSha"> {
  repository: string;
}

function assertRepository(pr: GitHubPullRequest, repository: string): void {
  if (pr.repositoryFullName.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`GitHub PR ${pr.number} belongs to ${pr.repositoryFullName}, not ${repository}`);
  }
}

export function deriveSnapshotRequirements(triggers: readonly TriggerConfig[]): SnapshotRequirements {
  return {
    checkRuns: triggers.some((trigger) => trigger.recognizer === "sonarqube" || trigger.recognizer === "cursor-bugbot") ? "completed" : "none",
    reviews: triggers.some((trigger) => trigger.recognizer === "copilot-review"),
  };
}
export async function discoverPullRequest(
  client: Pick<GitHubClient, "getPullRequest">,
  repository: string,
  pullRequestNumber: number,
  signal?: AbortSignal,
): Promise<GitHubPullRequest> {
  const pullRequest = await client.getPullRequest(repository, pullRequestNumber, signal);
  assertRepository(pullRequest, repository);
  return pullRequest;
}


export async function discoverPullRequests(
  client: Client,
  repository: string,
  cutoff: number,
  signal?: AbortSignal,
): Promise<GitHubPullRequest[]> {
  const [open, closed] = await Promise.all([
    client.listOpenPullRequests(repository, signal),
    client.listRecentClosedPullRequests(repository, cutoff, signal),
  ]);
  const byNumber = new Map<number, GitHubPullRequest>();
  for (const pullRequest of [...open, ...closed]) {
    assertRepository(pullRequest, repository);
    const previous = byNumber.get(pullRequest.number);
    if (previous === undefined || Date.parse(pullRequest.updatedAt) > Date.parse(previous.updatedAt)) {
      byNumber.set(pullRequest.number, pullRequest);
    }
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

export async function loadPrSnapshot(
  client: Client,
  repository: string,
  pullRequest: GitHubPullRequest,
  requirements: SnapshotRequirements,
  signal?: AbortSignal,
): Promise<PrSnapshot> {
  assertRepository(pullRequest, repository);
  const [checkRuns, reviews] = await Promise.all([
    requirements.checkRuns === "current"
      ? client.listCurrentCheckRuns(repository, pullRequest.headSha, signal)
      : requirements.checkRuns === "completed"
        ? client.listCompletedCheckRuns(repository, pullRequest.headSha, signal)
        : Promise.resolve([]),
    requirements.reviews ? client.listReviews(repository, pullRequest.number, signal) : Promise.resolve([]),
  ]);
  return {
    repository: { id: pullRequest.repositoryId, fullName: pullRequest.repositoryFullName },
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      headSha: pullRequest.headSha,
      baseRef: pullRequest.baseRef,
      updatedAt: pullRequest.updatedAt,
    },
    checkRuns: Object.freeze(checkRuns),
    reviews: Object.freeze(reviews),
  };
}

export async function verifyCurrentHead(
  client: Pick<GitHubClient, "getPullRequest">,
  candidate: CurrentHeadCandidate,
  signal?: AbortSignal,
): Promise<boolean> {
  const current = await client.getPullRequest(candidate.repository, candidate.pullRequestNumber, signal);
  if (current.repositoryFullName.toLowerCase() !== candidate.repository.toLowerCase()) return false;
  return current.headSha === candidate.artifactHeadSha;
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("concurrency limit must be a positive integer");
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
