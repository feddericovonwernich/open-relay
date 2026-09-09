import type { CompletionCandidate, PrSnapshot, TriggerConfig } from "../types.ts";

type CopilotReviewTrigger = Extract<TriggerConfig, { recognizer: "copilot-review" }>;

/** Match submitted Copilot reviews for the current pull-request head. */
export function recognizeCopilotReviews(
  snapshot: PrSnapshot,
  trigger: CopilotReviewTrigger,
): CompletionCandidate[] {
  const candidates: CompletionCandidate[] = [];
  const configuredLogins = trigger.match.logins.map((login) => login.toLowerCase().replace(/\[bot\]$/, ""));

  for (const review of snapshot.reviews) {
    const user = review.user;
    const login = user?.login.toLowerCase().replace(/\[bot\]$/, "");
    const identityMatches = user !== null && user !== undefined && user.type === "Bot" && (
      (user.id !== null && trigger.match.userIds.includes(user.id)) ||
      (user.htmlUrl !== null && trigger.match.appUrls.includes(user.htmlUrl)) ||
      (login !== undefined && configuredLogins.includes(login))
    );
    if (
      !identityMatches ||
      !Number.isSafeInteger(review.id) ||
      review.id <= 0 ||
      review.submittedAt === null ||
      review.submittedAt.length === 0 ||
      review.commitId !== snapshot.pullRequest.headSha ||
      review.htmlUrl === null ||
      review.htmlUrl.length === 0
    ) {
      continue;
    }

    candidates.push({
      provider: "copilot-review",
      triggerId: trigger.id,
      repositoryId: snapshot.repository.id,
      pullRequestNumber: snapshot.pullRequest.number,
      artifactKind: "pull_request_review",
      artifactId: String(review.id),
      artifactHeadSha: review.commitId,
      artifact: {
        name: "GitHub Copilot review",
        completion: "submitted",
        conclusion: "submitted",
        completedAt: review.submittedAt,
        detailsUrl: review.htmlUrl,
      },
    });
  }

  return candidates;
}
