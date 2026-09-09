import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
export class AuthError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "AuthError";
        this.code = code;
    }
}
function readNow(clock) { return typeof clock === "function" ? clock() : clock.now(); }
function digest(token) { return createHash("sha256").update(token).digest(); }
export class CredentialStore {
    records = new Map();
    now;
    workerTtlMs;
    ttlMs;
    constructor(options = {}) {
        this.now = () => readNow(options.now ?? (() => Date.now()));
        this.workerTtlMs = options.workerTtlMs ?? 15 * 60_000;
        this.ttlMs = options.ttlMs;
    }
    issue(scope, subjectId, grants = []) {
        if (!subjectId)
            throw new AuthError("invalid_credential", "credential subject is required");
        const token = randomBytes(32).toString("base64url");
        const tokenDigest = digest(token);
        const ttl = scope === "worker" ? this.workerTtlMs : this.ttlMs;
        const expiresAt = ttl === undefined ? undefined : this.now() + ttl;
        this.records.set(tokenDigest.toString("hex"), { digest: tokenDigest, scope, subjectId, grants: [...grants], ...(expiresAt === undefined ? {} : { expiresAt }) });
        return token;
    }
    verify(token, scope) {
        if (typeof token !== "string" || !token)
            throw new AuthError("unauthorized", "credential is invalid");
        const tokenDigest = digest(token);
        let record;
        for (const candidate of this.records.values()) {
            if (timingSafeEqual(candidate.digest, tokenDigest)) {
                record = candidate;
                break;
            }
        }
        if (!record)
            throw new AuthError("unauthorized", "credential is invalid");
        if (record.expiresAt !== undefined && record.expiresAt <= this.now()) {
            this.records.delete(record.digest.toString("hex"));
            throw new AuthError("unauthorized", "credential has expired");
        }
        if (record.scope !== scope)
            throw new AuthError("forbidden", "credential scope is not permitted");
        return { scope: record.scope, subjectId: record.subjectId, grants: [...record.grants], ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }) };
    }
    revoke(token) {
        if (typeof token !== "string" || !token)
            return;
        this.records.delete(digest(token).toString("hex"));
    }
    adopt(token, scope, subjectId, grants = []) {
        if (!token || !subjectId)
            throw new AuthError("invalid_credential", "credential is invalid");
        const tokenDigest = digest(token);
        this.records.set(tokenDigest.toString("hex"), { digest: tokenDigest, scope, subjectId, grants: [...grants] });
    }
}
