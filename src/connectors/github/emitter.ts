import { normalizeCompletion } from "./normalize.ts";
import type { CompletionCandidate, PrSnapshot, TriggerConfig } from "./types.ts";

export interface GitHubRelayEmitterOptions {
  baseUrl: string;
  adminToken: string;
  fetch?: typeof globalThis.fetch;
  lifetimeSignal?: AbortSignal;
}

export class GitHubRelayEmitterError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "GitHubRelayEmitterError";
    this.code = code;
    this.status = status;
  }
}

const SECRET_KEY = /token|credential|secret|authorization/i;
const REDACTED = "[REDACTED]";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redact(value: unknown, secrets: readonly string[], key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === "string") {
    let clean = value;
    for (const secret of secrets) {
      if (secret.length > 0) clean = clean.split(secret).join(REDACTED);
    }
    return clean;
  }
  if (Array.isArray(value)) return value.map((child) => redact(child, secrets));
  if (isObject(value)) {
    const result: JsonObject = {};
    for (const [childKey, child] of Object.entries(value)) result[childKey] = redact(child, secrets, childKey);
    return result;
  }
  return value;
}

function safeText(value: unknown, secrets: readonly string[]): string {
  const clean = redact(value, secrets);
  if (typeof clean === "string") return clean;
  try { return JSON.stringify(clean); } catch { return "[unavailable]"; }
}

function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function responseBody(response: Response): Promise<unknown> {
  try { return await response.clone().json(); } catch { return undefined; }
}

function relayError(body: unknown): { code?: string; message?: string } {
  if (!isObject(body) || !isObject(body.error)) return {};
  return {
    code: typeof body.error.code === "string" ? body.error.code : undefined,
    message: typeof body.error.message === "string" ? body.error.message : undefined,
  };
}
function isAbortError(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}


export function completionKey(candidate: CompletionCandidate): string {
  return `github:${candidate.repositoryId}:${candidate.triggerId}:${candidate.artifactKind}:${candidate.artifactId}`;
}

export function pullRequestCorrelationId(repositoryFullName: string, pullRequestNumber: number): string {
  return `github:${repositoryFullName.toLowerCase()}:pull-request:${pullRequestNumber}`;
}

export class GitHubRelayEmitter {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly lifetimeSignal?: AbortSignal;
  private readonly producerTokens = new Map<number, Promise<string>>();

  constructor(options: GitHubRelayEmitterOptions) {
    this.baseUrl = options.baseUrl;
    this.adminToken = options.adminToken;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.lifetimeSignal = options.lifetimeSignal;
  }

  private async request(path: string, token: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(absoluteUrl(this.baseUrl, path), {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      if (init.signal?.aborted || isAbortError(error)) throw error;
      const message = safeText(error instanceof Error ? error.message : error, [this.adminToken, token]);
      throw new GitHubRelayEmitterError("relay_unavailable", message);
    }
  }

  private producerToken(repositoryId: number, signal?: AbortSignal): Promise<string> {
    const existing = this.producerTokens.get(repositoryId);
    if (existing) return abortable(existing, signal);
    const pending = this.issueProducerToken(repositoryId, this.lifetimeSignal);
    this.producerTokens.set(repositoryId, pending);
    void pending.catch(() => {
      if (this.producerTokens.get(repositoryId) === pending) this.producerTokens.delete(repositoryId);
    });
    return abortable(pending, signal);
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    const response = await this.request("/v1/credentials", this.adminToken, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "observer", subjectId: "connector:github:preflight" }),
    });
    if (response.ok) return;
    const body = await responseBody(response);
    const error = relayError(body);
    const message = safeText(error.message ?? body ?? `relay request failed (${response.status})`, [this.adminToken]);
    throw new GitHubRelayEmitterError(error.code ?? "relay_auth_failed", message, response.status);
  }

  private async issueProducerToken(repositoryId: number, signal?: AbortSignal): Promise<string> {
    const response = await this.request("/v1/credentials", this.adminToken, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "producer", subjectId: `connector:github:${repositoryId}` }),
    });
    const body = await responseBody(response);
    if (!response.ok) {
      const error = relayError(body);
      const message = safeText(error.message ?? body ?? `relay request failed (${response.status})`, [this.adminToken]);
      throw new GitHubRelayEmitterError(error.code ?? "credential_failed", message, response.status);
    }
    const token = isObject(body) && typeof body.token === "string" ? body.token : undefined;
    if (!token) throw new GitHubRelayEmitterError("credential_failed", "relay credential response did not include a token", response.status);
    return token;
  }

  /** Emit one candidate, preserving the source snapshot needed for normalization. */
  async emit(trigger: TriggerConfig, snapshot: PrSnapshot, candidate: CompletionCandidate, signal?: AbortSignal): Promise<"emitted" | "replayed"> {
    const producerToken = await this.producerToken(snapshot.repository.id, signal);
    const payload = normalizeCompletion(snapshot, candidate);
    const idempotencyKey = completionKey(candidate);
    const response = await this.request("/v1/events", producerToken, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        type: trigger.emit.type,
        version: trigger.emit.version,
        payload,
        idempotencyKey,
        correlationId: pullRequestCorrelationId(snapshot.repository.fullName, snapshot.pullRequest.number),
      }),
    });
    if (response.status === 201) return "emitted";
    if (response.status === 200) return "replayed";

    const body = await responseBody(response);
    const error = relayError(body);
    const secrets = [this.adminToken, producerToken];
    if (error.code === "idempotency_conflict" || response.status === 409) {
      throw new GitHubRelayEmitterError(
        "trigger_drift",
        `trigger ${trigger.id} drifted for repository ${snapshot.repository.id}`,
        response.status,
      );
    }
    if (error.code === "definition_not_found" || response.status === 404) {
      throw new GitHubRelayEmitterError(
        "trigger_invalid",
        `trigger ${trigger.id} references an unknown definition for repository ${snapshot.repository.id}`,
        response.status,
      );
    }
    const message = safeText(error.message ?? body ?? `relay request failed (${response.status})`, secrets);
    throw new GitHubRelayEmitterError(error.code ?? "relay_failed", message, response.status);
  }
}
