export type RecognizerId = "sonarqube" | "copilot-review" | "cursor-bugbot";

export interface GitHubConnectorConfig {
  connector: "github";
  apiBaseUrl: string;
  apiVersion: string;
  tokenEnv: string;
  pollIntervalMs: number;
  lookbackHours: number;
  repositories: string[];
  triggers: TriggerConfig[];
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
