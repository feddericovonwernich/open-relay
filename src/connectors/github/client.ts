import type { GitHubCheckRun, GitHubPullRequest, GitHubPullRequestReview } from "./types.ts";

export interface GitHubClientOptions {
  baseUrl: string;
  apiVersion: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
}

export interface GitHubDecodeDiagnostic {
  url: string;
  index: number;
  reason: string;
}

type ClientErrorCode = "github_auth_failed" | "github_protocol_error" | "github_not_found" | "github_transient_error";

export class GitHubClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status?: number;

  constructor(code: ClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GitHubClientError";
    this.code = code;
    this.status = status;
  }
}

type CachedPage = {
  etag?: string;
  body: unknown;
  nextUrl?: string;
};

type Decoder<T> = (body: unknown, url: string) => T[];

const DEFAULT_USER_AGENT = "open-relay-github-connector";
const MAX_DIAGNOSTICS = 100;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): value is string {
  return typeof value === "string";
}

function integerField(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function protocol(message: string): GitHubClientError {
  return new GitHubClientError("github_protocol_error", message);
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function parseLinkNext(header: string | null, currentUrl: string, baseUrl: URL): string | undefined {
  if (header === null) return undefined;
  for (const match of header.matchAll(/<([^>]+)>\s*;\s*rel\s*=\s*(?:"([^"]+)"|([^,\s]+))/gi)) {
    const relation = (match[2] ?? match[3] ?? "").split(/\s+/).includes("next");
    if (!relation) continue;
    try {
      const next = new URL(match[1], currentUrl);
      if (next.origin !== baseUrl.origin) return undefined;
      const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
      if (next.pathname !== baseUrl.pathname && !next.pathname.startsWith(basePath)) return undefined;
      return next.href;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function decodePullRequest(value: unknown): GitHubPullRequest | undefined {
  const item = recordOf(value);
  const head = recordOf(item?.head);
  const base = recordOf(item?.base);
  const repository = recordOf(base?.repo);
  if (
    !item ||
    !integerField(item.number) ||
    !stringField(item.html_url) ||
    !head ||
    !stringField(head.sha) ||
    !base ||
    !stringField(base.ref) ||
    !repository ||
    !integerField(repository.id) ||
    !stringField(repository.full_name) ||
    (item.state !== "open" && item.state !== "closed") ||
    !stringField(item.updated_at)
  ) return undefined;
  return {
    number: item.number,
    url: item.html_url,
    headSha: head.sha,
    baseRef: base.ref,
    state: item.state,
    updatedAt: item.updated_at,
    repositoryId: repository.id,
    repositoryFullName: repository.full_name,
  };
}

function decodeCheckRun(value: unknown): GitHubCheckRun | undefined {
  const item = recordOf(value);
  const app = item ? item.app : undefined;
  const appRecord = app === null ? null : recordOf(app);
  const pullRequests = item?.pull_requests;
  if (!item || !integerField(item.id) || !stringField(item.name) || !stringField(item.status) || !nullableString(item.conclusion) || !stringField(item.head_sha) || !nullableString(item.completed_at) || !nullableString(item.details_url) || (app !== null && !appRecord) || (appRecord && (!((appRecord.id === null || integerField(appRecord.id))) || !(appRecord.slug === null || stringField(appRecord.slug)))) || !Array.isArray(pullRequests)) return undefined;
  const decodedPullRequests: { number: number }[] = [];
  for (const pullRequest of pullRequests) {
    const record = recordOf(pullRequest);
    if (!record || !integerField(record.number)) return undefined;
    decodedPullRequests.push({ number: record.number });
  }
  return {
    id: item.id,
    name: item.name,
    status: item.status,
    conclusion: item.conclusion,
    headSha: item.head_sha,
    completedAt: item.completed_at,
    detailsUrl: item.details_url,
    app: appRecord ? { id: appRecord.id as number | null, slug: appRecord.slug as string | null } : null,
    pullRequests: decodedPullRequests,
  };
}

function decodeReview(value: unknown): GitHubPullRequestReview | undefined {
  const item = recordOf(value);
  const user = item?.user;
  const userRecord = user === null ? null : recordOf(user);
  if (!item || !integerField(item.id) || (user !== null && !userRecord) || (userRecord && (!((userRecord.id === null || integerField(userRecord.id))) || !stringField(userRecord.login) || !stringField(userRecord.type) || !nullableString(userRecord.html_url))) || !stringField(item.commit_id) || !nullableString(item.submitted_at) || !nullableString(item.html_url)) return undefined;
  const reviewId = userRecord?.id;
  const login = userRecord?.login;
  const type = userRecord?.type;
  const reviewHtmlUrl = userRecord?.html_url;
  return {
    id: item.id,
    user: userRecord ? { id: reviewId as number | null, login: login as string, type: type as string, htmlUrl: reviewHtmlUrl as string | null } : null,
    commitId: item.commit_id,
    submittedAt: item.submitted_at,
    htmlUrl: item.html_url,
  };
}

function listDecoder<T>(body: unknown, url: string, decode: (value: unknown) => T | undefined, diagnostics: GitHubDecodeDiagnostic[], field?: string): T[] {
  const values = field === undefined ? body : recordOf(body)?.[field];
  if (!Array.isArray(values)) throw protocol(`GitHub response at ${url} is malformed`);
  const result: T[] = [];
  values.forEach((value, index) => {
    const decoded = decode(value);
    if (decoded !== undefined) result.push(decoded);
    else if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push({ url, index, reason: "malformed item" });
  });
  return result;
}

export class GitHubClient {
  private readonly apiBaseUrl: URL;
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly jitter: () => number;
  private readonly cache = new Map<string, CachedPage>();
  private readonly diagnosticBuffer: GitHubDecodeDiagnostic[] = [];

  constructor(options: GitHubClientOptions) {
    this.apiBaseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.token = options.token;
    this.apiVersion = options.apiVersion;
    this.requestFetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(abortError("The operation was aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }));
    this.now = options.now ?? Date.now;
    this.jitter = options.jitter ?? (() => 0);
  }

  get diagnostics(): readonly GitHubDecodeDiagnostic[] {
    return this.diagnosticBuffer;
  }

  async listOpenPullRequests(repository: string, signal?: AbortSignal): Promise<GitHubPullRequest[]> {
    return this.paginate(this.endpoint(`/repos/${repository}/pulls?state=open&per_page=100`), (body, url) => listDecoder(body, url, decodePullRequest, this.diagnosticBuffer), signal);
  }

  async listRecentClosedPullRequests(repository: string, cutoff: number, signal?: AbortSignal): Promise<GitHubPullRequest[]> {
    const pulls = await this.paginate(this.endpoint(`/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`), (body, url) => listDecoder(body, url, decodePullRequest, this.diagnosticBuffer), signal, (page) => page.some((pull) => Date.parse(pull.updatedAt) < cutoff));
    return pulls.filter((pull) => Date.parse(pull.updatedAt) >= cutoff);
  }

  async getPullRequest(repository: string, number: number, signal?: AbortSignal): Promise<GitHubPullRequest> {
    const url = this.endpoint(`/repos/${repository}/pulls/${number}`);
    const body = await this.getPage(url, signal);
    const decoded = decodePullRequest(body);
    if (decoded === undefined) throw protocol(`GitHub response at ${url} is malformed`);
    return decoded;
  }

  async listCompletedCheckRuns(repository: string, headSha: string, signal?: AbortSignal): Promise<GitHubCheckRun[]> {
    return this.paginate(this.endpoint(`/repos/${repository}/commits/${headSha}/check-runs?status=completed&filter=all&per_page=100`), (body, url) => listDecoder(body, url, decodeCheckRun, this.diagnosticBuffer, "check_runs"), signal);
  }
  async listCurrentCheckRuns(repository: string, headSha: string, signal?: AbortSignal): Promise<GitHubCheckRun[]> {
    return this.paginate(this.endpoint(`/repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=100`), (body, url) => listDecoder(body, url, decodeCheckRun, this.diagnosticBuffer, "check_runs"), signal);
  }

  async listReviews(repository: string, number: number, signal?: AbortSignal): Promise<GitHubPullRequestReview[]> {
    return this.paginate(this.endpoint(`/repos/${repository}/pulls/${number}/reviews?per_page=100`), (body, url) => listDecoder(body, url, decodeReview, this.diagnosticBuffer), signal);
  }

  private endpoint(path: string): string {
    return new URL(path.replace(/^\//, ""), this.apiBaseUrl).href;
  }

  private async paginate<T>(firstUrl: string, decode: Decoder<T>, signal?: AbortSignal, stop?: (page: T[]) => boolean): Promise<T[]> {
    const result: T[] = [];
    let nextUrl: string | undefined = firstUrl;
    while (nextUrl !== undefined) {
      const currentUrl: string = nextUrl;
      const page = decode(await this.getPage(currentUrl, signal), currentUrl);
      result.push(...page);
      if (stop?.(page)) break;
      nextUrl = this.cache.get(currentUrl)?.nextUrl;
    }
    return result;
  }

  private async getPage(url: string, signal?: AbortSignal): Promise<unknown> {
    const cached = this.cache.get(url);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": DEFAULT_USER_AGENT,
    };
    if (cached?.etag !== undefined) headers["If-None-Match"] = cached.etag;
    while (true) {
      if (signal?.aborted) throw abortError("The operation was aborted");
      let response: Response;
      try {
        response = await this.requestFetch(url, { headers, signal });
      } catch (error) {
        if (isAbort(error) || signal?.aborted) throw abortError("The operation was aborted");
        throw new GitHubClientError("github_transient_error", this.safeMessage(error));
      }
      if (response.status === 304) {
        if (cached === undefined) throw protocol(`GitHub returned 304 without cached data for ${url}`);
        return cached.body;
      }
      if (response.status === 401) throw new GitHubClientError("github_auth_failed", "GitHub authentication failed", 401);
      if (response.status === 404) throw new GitHubClientError("github_not_found", `GitHub resource was not found (${url})`, 404);
      const retryMs = this.rateLimitDelay(response);
      if (retryMs !== undefined) {
        await this.sleep(retryMs, signal ?? new AbortController().signal);
        continue;
      }
      if (response.status >= 500) throw new GitHubClientError("github_transient_error", `GitHub server error (${response.status})`, response.status);
      if (!response.ok) throw new GitHubClientError("github_protocol_error", `GitHub request failed (${response.status})`, response.status);
      let body: unknown;
      try { body = await response.json(); } catch (error) {
        if (isAbort(error) || signal?.aborted) throw abortError("The operation was aborted");
        throw protocol(`GitHub response at ${url} is not valid JSON`);
      }
      const nextUrl = parseLinkNext(response.headers.get("link"), url, this.apiBaseUrl);
      this.cache.set(url, { etag: response.headers.get("etag") ?? undefined, body, nextUrl });
      return body;
    }
  }

  private rateLimitDelay(response: Response): number | undefined {
    const retryAfter = response.headers.get("retry-after");
    if ((response.status === 403 || response.status === 429) && retryAfter !== null) {
      const seconds = Number(retryAfter);
      const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - this.now());
      return delay + this.jitter();
    }
    if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - this.now()) + this.jitter();
    }
    return undefined;
  }

  private safeMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replaceAll(this.token, "[REDACTED]").replace(/Bearer\s+[^\s)]+/gi, "Bearer [REDACTED]");
  }
}
