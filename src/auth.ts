import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type Scope = "producer" | "observer" | "worker" | "admin";

export interface Principal {
  scope: Scope;
  subjectId: string;
  grants: readonly string[];
  expiresAt?: number;
}

export class AuthError extends Error {
  readonly code: "unauthorized" | "forbidden" | "invalid_credential";
  constructor(code: "unauthorized" | "forbidden" | "invalid_credential", message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

type Clock = (() => number) | { now(): number };
interface CredentialOptions {
  now?: Clock;
  workerTtlMs?: number;
  ttlMs?: number;
}
interface CredentialRecord extends Principal {
  digest: Buffer;
}

function readNow(clock: Clock): number { return typeof clock === "function" ? clock() : clock.now(); }
function digest(token: string): Buffer { return createHash("sha256").update(token).digest(); }

export class CredentialStore {
  private readonly records = new Map<string, CredentialRecord>();
  private readonly now: () => number;
  private readonly workerTtlMs: number;
  private readonly ttlMs?: number;

  constructor(options: CredentialOptions = {}) {
    this.now = () => readNow(options.now ?? (() => Date.now()));
    this.workerTtlMs = options.workerTtlMs ?? 15 * 60_000;
    this.ttlMs = options.ttlMs;
  }

  issue(scope: Scope, subjectId: string, grants: string[] = []): string {
    if (!subjectId) throw new AuthError("invalid_credential", "credential subject is required");
    const token = randomBytes(32).toString("base64url");
    const tokenDigest = digest(token);
    const ttl = scope === "worker" ? this.workerTtlMs : this.ttlMs;
    const expiresAt = ttl === undefined ? undefined : this.now() + ttl;
    this.records.set(tokenDigest.toString("hex"), { digest: tokenDigest, scope, subjectId, grants: [...grants], ...(expiresAt === undefined ? {} : { expiresAt }) });
    return token;
  }

  verify(token: string, scope: Scope): Principal {
    if (typeof token !== "string" || !token) throw new AuthError("unauthorized", "credential is invalid");
    const tokenDigest = digest(token);
    let record: CredentialRecord | undefined;
    for (const candidate of this.records.values()) {
      if (timingSafeEqual(candidate.digest, tokenDigest)) { record = candidate; break; }
    }
    if (!record) throw new AuthError("unauthorized", "credential is invalid");
    if (record.expiresAt !== undefined && record.expiresAt <= this.now()) {
      this.records.delete(record.digest.toString("hex"));
      throw new AuthError("unauthorized", "credential has expired");
    }
    if (record.scope !== scope) throw new AuthError("forbidden", "credential scope is not permitted");
    return { scope: record.scope, subjectId: record.subjectId, grants: [...record.grants], ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }) };
  }

  revoke(token: string): void {
    if (typeof token !== "string" || !token) return;
    this.records.delete(digest(token).toString("hex"));
  }
}
