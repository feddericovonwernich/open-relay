import { createHash } from "node:crypto";
import { normalizeCompletion, normalizeSettled } from "./normalize.js";
export class GitHubRelayEmitterError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.name = "GitHubRelayEmitterError";
        this.code = code;
        this.status = status;
    }
}
const SECRET_KEY = /token|credential|secret|authorization/i;
const REDACTED = "[REDACTED]";
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function redact(value, secrets, key) {
    if (key !== undefined && SECRET_KEY.test(key))
        return REDACTED;
    if (typeof value === "string") {
        let clean = value;
        for (const secret of secrets) {
            if (secret.length > 0)
                clean = clean.split(secret).join(REDACTED);
        }
        return clean;
    }
    if (Array.isArray(value))
        return value.map((child) => redact(child, secrets));
    if (isObject(value)) {
        const result = {};
        for (const [childKey, child] of Object.entries(value))
            result[childKey] = redact(child, secrets, childKey);
        return result;
    }
    return value;
}
function safeText(value, secrets) {
    const clean = redact(value, secrets);
    if (typeof clean === "string")
        return clean;
    try {
        return JSON.stringify(clean);
    }
    catch {
        return "[unavailable]";
    }
}
function absoluteUrl(baseUrl, path) {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}
async function responseBody(response) {
    try {
        return await response.clone().json();
    }
    catch {
        return undefined;
    }
}
function relayError(body) {
    if (!isObject(body) || !isObject(body.error))
        return {};
    return {
        code: typeof body.error.code === "string" ? body.error.code : undefined,
        message: typeof body.error.message === "string" ? body.error.message : undefined,
    };
}
function isAbortError(value) {
    return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}
function abortable(promise, signal) {
    if (!signal)
        return promise;
    if (signal.aborted)
        return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        };
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then((value) => {
            cleanup();
            resolve(value);
        }, (error) => {
            cleanup();
            reject(error);
        });
    });
}
export function completionKey(candidate) {
    return `github:${candidate.repositoryId}:${candidate.triggerId}:${candidate.artifactKind}:${candidate.artifactId}`;
}
export function pullRequestCorrelationId(repositoryFullName, pullRequestNumber) {
    return `github:${repositoryFullName.toLowerCase()}:pull-request:${pullRequestNumber}`;
}
export function settledKey(aggregate, snapshot, candidates) {
    const members = candidates
        .map((candidate) => `${candidate.triggerId}\0${candidate.artifactKind}\0${candidate.artifactId}`)
        .sort()
        .join("\0");
    const hash = createHash("sha256").update(members).digest("hex");
    return `github:${snapshot.repository.id}:aggregate:${aggregate.id}:pull-request:${snapshot.pullRequest.number}:head:${snapshot.pullRequest.headSha}:members:${hash}`;
}
export class GitHubRelayEmitter {
    baseUrl;
    adminToken;
    fetcher;
    lifetimeSignal;
    producerTokens = new Map();
    constructor(options) {
        this.baseUrl = options.baseUrl;
        this.adminToken = options.adminToken;
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.lifetimeSignal = options.lifetimeSignal;
    }
    async request(path, token, init) {
        try {
            return await this.fetcher(absoluteUrl(this.baseUrl, path), {
                ...init,
                headers: {
                    ...(init.headers ?? {}),
                    Authorization: `Bearer ${token}`,
                },
            });
        }
        catch (error) {
            if (init.signal?.aborted || isAbortError(error))
                throw error;
            const message = safeText(error instanceof Error ? error.message : error, [this.adminToken, token]);
            throw new GitHubRelayEmitterError("relay_unavailable", message);
        }
    }
    producerToken(repositoryId, signal) {
        const existing = this.producerTokens.get(repositoryId);
        if (existing)
            return abortable(existing, signal);
        const pending = this.issueProducerToken(repositoryId, this.lifetimeSignal);
        this.producerTokens.set(repositoryId, pending);
        void pending.catch(() => {
            if (this.producerTokens.get(repositoryId) === pending)
                this.producerTokens.delete(repositoryId);
        });
        return abortable(pending, signal);
    }
    async preflight(signal) {
        const response = await this.request("/v1/credentials", this.adminToken, {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scope: "observer", subjectId: "connector:github:preflight" }),
        });
        if (response.ok)
            return;
        const body = await responseBody(response);
        const error = relayError(body);
        const message = safeText(error.message ?? body ?? `relay request failed (${response.status})`, [this.adminToken]);
        throw new GitHubRelayEmitterError(error.code ?? "relay_auth_failed", message, response.status);
    }
    async issueProducerToken(repositoryId, signal) {
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
        if (!token)
            throw new GitHubRelayEmitterError("credential_failed", "relay credential response did not include a token", response.status);
        return token;
    }
    /** Emit one candidate, preserving the source snapshot needed for normalization. */
    async emit(trigger, snapshot, candidate, signal) {
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
        if (response.status === 201)
            return "emitted";
        if (response.status === 200)
            return "replayed";
        const body = await responseBody(response);
        const error = relayError(body);
        const secrets = [this.adminToken, producerToken];
        if (error.code === "idempotency_conflict" || response.status === 409) {
            throw new GitHubRelayEmitterError("trigger_drift", `trigger ${trigger.id} drifted for repository ${snapshot.repository.id}`, response.status);
        }
        if (error.code === "definition_not_found" || response.status === 404) {
            throw new GitHubRelayEmitterError("trigger_invalid", `trigger ${trigger.id} references an unknown definition for repository ${snapshot.repository.id}`, response.status);
        }
        const message = safeText(error.message ?? body ?? `relay request failed (${response.status})`, secrets);
        throw new GitHubRelayEmitterError(error.code ?? "relay_failed", message, response.status);
    }
    async emitAggregate(aggregate, snapshot, candidates, signal) {
        const producerToken = await this.producerToken(snapshot.repository.id, signal);
        const payload = normalizeSettled(snapshot, candidates);
        const idempotencyKey = settledKey(aggregate, snapshot, candidates);
        const response = await this.request("/v1/events", producerToken, {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
            body: JSON.stringify({
                type: aggregate.emit.type,
                version: aggregate.emit.version,
                payload,
                idempotencyKey,
                correlationId: pullRequestCorrelationId(snapshot.repository.fullName, snapshot.pullRequest.number),
            }),
        });
        if (response.status === 201)
            return "emitted";
        if (response.status === 200)
            return "replayed";
        const body = await responseBody(response);
        const error = relayError(body);
        const secrets = [this.adminToken, producerToken];
        if (error.code === "idempotency_conflict" || response.status === 409) {
            throw new GitHubRelayEmitterError("aggregate_drift", `aggregate ${aggregate.id} drifted for repository ${snapshot.repository.id}`, response.status);
        }
        if (error.code === "definition_not_found" || response.status === 404) {
            throw new GitHubRelayEmitterError("aggregate_invalid", `aggregate ${aggregate.id} references an unknown definition for repository ${snapshot.repository.id}`, response.status);
        }
        const message = safeText(error.message ?? body ?? `relay request failed (${response.status})`, secrets);
        throw new GitHubRelayEmitterError(error.code ?? "relay_failed", message, response.status);
    }
}
