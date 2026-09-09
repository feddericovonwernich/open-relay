import type { CompletionCandidate, PrSnapshot, TriggerConfig } from "../types.ts";

type CheckRunTrigger = Extract<TriggerConfig, { match: { checkNames: string[] } }>;

/** Match terminal check runs without doing any network work. */
export function matchCompletedCheckRun(
  snapshot: PrSnapshot,
  trigger: CheckRunTrigger,
  provider: string,
): CompletionCandidate[] {
  const { pullRequest } = snapshot;
  const candidates: CompletionCandidate[] = [];

  for (const check of snapshot.checkRuns) {
    if (
      check.status !== "completed" ||
      !trigger.match.checkNames.includes(check.name) ||
      check.headSha !== pullRequest.headSha ||
      !Number.isSafeInteger(check.id) ||
      check.id <= 0 ||
      typeof check.completedAt !== "string" ||
      check.completedAt.length === 0
    ) {
      continue;
    }

    const app = check.app;
    const appMatches = app !== null && (
      (app.id !== null && trigger.match.appIds.includes(app.id)) ||
      (app.slug !== null && trigger.match.appSlugs.includes(app.slug))
    );
    if (!appMatches) continue;

    if (check.pullRequests.length > 0 && !check.pullRequests.some((pr) => pr.number === pullRequest.number)) {
      continue;
    }

    candidates.push({
      provider,
      triggerId: trigger.id,
      repositoryId: snapshot.repository.id,
      pullRequestNumber: pullRequest.number,
      artifactKind: "check_run",
      artifactId: String(check.id),
      artifactHeadSha: check.headSha,
      artifact: {
        name: check.name,
        completion: "completed",
        conclusion: check.conclusion,
        completedAt: check.completedAt,
        detailsUrl: check.detailsUrl,
      },
    });
  }

  return candidates;
}
