export type RecognizerId = "sonarqube" | "copilot-review" | "cursor-bugbot";

export interface GitHubRepositoryConfig {
  name: string;
  mode:
    | "configured-tools"
    | "generic-check-runs"
    | "configured-tools-and-generic-check-runs";
}

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

export interface GitHubPullRequest {
  number: number;
  url: string;
  headSha: string;
  baseRef: string;
  state: "open" | "closed";
  updatedAt: string;
  repositoryId: number;
  repositoryFullName: string;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  completedAt: string | null;
  detailsUrl: string | null;
  app: { id: number | null; slug: string | null } | null;
  pullRequests: readonly { number: number }[];
}

export interface GitHubPullRequestReview {
  id: number;
  user: { id: number | null; login: string; type: string; htmlUrl: string | null } | null;
  commitId: string;
  submittedAt: string | null;
  htmlUrl: string | null;
}
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

export interface PrSnapshot {
  repository: {
    id: number;
    fullName: string;
  };
  pullRequest: {
    number: number;
    url: string;
    headSha: string;
    baseRef: string;
    updatedAt: string;
  };
  checkRuns: readonly GitHubCheckRun[];
  reviews: readonly GitHubPullRequestReview[];
}

export interface CompletionCandidate {
  provider: string;
  triggerId: string;
  repositoryId: number;
  pullRequestNumber: number;
  artifactKind: "check_run" | "pull_request_review";
  artifactId: string;
  artifactHeadSha: string;
  artifact: {
    name: string;
    completion: "completed" | "submitted";
    conclusion: string | null;
    completedAt: string;
    detailsUrl: string | null;
  };
}

export interface PrAutomationCompleted {
  schemaVersion: 1;
  provider: string;
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
  artifact: {
    kind: "check_run" | "pull_request_review";
    id: string;
    name: string;
    completion: "completed" | "submitted";
    conclusion: string | null;
    completedAt: string;
    detailsUrl: string | null;
  };
}
export interface PrAutomationSettledArtifact {
  triggerId: string;
  provider: string;
  kind: "check_run" | "pull_request_review";
  id: string;
  name: string;
  completion: "completed" | "submitted";
  conclusion: string | null;
  completedAt: string;
  detailsUrl: string | null;
}

export interface PrAutomationSettled {
  schemaVersion: 1;
  provider: "github";
  repository: { id: number; fullName: string };
  pullRequest: { number: number; url: string; headSha: string; baseRef: string };
  artifacts: PrAutomationSettledArtifact[];
}
export interface PrCiSettledCheck {
  id: string;
  name: string;
  conclusion: string | null;
  completedAt: string;
  detailsUrl: string | null;
}

export interface PrCiSettled {
  schemaVersion: 1;
  provider: "github";
  repository: { id: number; fullName: string };
  pullRequest: { number: number; url: string; headSha: string; baseRef: string };
  outcome: "success" | "failure";
  checks: PrCiSettledCheck[];
}

export type VerificationAction =
  | {
      code: "investigate_ci_failures";
      checkNames: string[];
      message: "Investigate the failed CI checks. Fix failures caused by the change when possible. Otherwise report the cause and why it could not be fixed automatically.";
    }
  | {
      code: "resolve_review_findings";
      providers: VerificationProvider[];
      findingCount: number;
      message: "Review the unresolved Bugbot/Copilot comments. If a finding is valid, implement a fix. In every case, reply with the result and resolve the thread when addressed.";
    }
  | {
      code: "verify_review_result";
      provider: "cursor-bugbot";
      checkName: string;
      message: "Verify the completed neutral Bugbot result. Confirm whether the run contains findings, cancellation, or an internal error before treating the review as successful.";
    };

export interface PrVerificationFinding {
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
}

export interface PrVerificationSettled {
  schemaVersion: 1;
  provider: "github";
  repository: { id: number; fullName: string };
  pullRequest: { number: number; url: string; headSha: string; baseRef: string };
  verdict: "success" | "action_required";
  automation: { artifacts: PrAutomationSettledArtifact[] };
  ci: { outcome: "success" | "failure"; checks: PrCiSettledCheck[]; failingCheckNames: string[] };
  reviews: {
    unresolvedCount: number;
    includedCount: number;
    totalReplyCount: number;
    truncated: boolean;
    evidenceDigest: string;
    findings: PrVerificationFinding[];
  };
  actions: VerificationAction[];
}
