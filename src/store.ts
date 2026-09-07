import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { compileRevision, type DefinitionRevision, type StoredDefinitionRevision } from "./registry.ts";
import type { Delivery, ProcessWorker, WorkerCapabilities } from "./protocol.ts";

export interface Clock { now(): number; }

export interface AcceptInput {
  producerId: string;
  idempotencyKey: string;
  payload: unknown;
  revision: DefinitionRevision;
  correlationId?: string;
  id?: string;
}

export interface StoredEvent {
  id: string;
  producerId: string;
  idempotencyKey: string;
  type: string;
  version: number;
  definitionRevision: string;
  payload: unknown;
  payloadDigest: string;
  emittedAt: string;
  correlationId?: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  availableAt: number;
  workerId?: string;
  leaseId?: string;
  leaseExpiresAt?: number;
  hardDeadlineAt?: number;
  cancelRequestedAt?: number;
  effectPolicy: string;
  recoveryReason?: string;
  result?: unknown;
  error?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AcceptResult { event: StoredEvent; created: boolean; }

export interface UpdateRecord {
  sequence: number;
  eventId: string;
  kind: string;
  attempt?: number;
  workerId?: string;
  leaseId?: string;
  data: unknown;
  createdAt: number;
}

export interface DeliveryAuthority { eventId?: string; workerId: string; leaseId: string; }

export interface FailureEvidence {
  code: string;
  effectStatus?: "none" | "started" | "unknown" | "confirmed" | "cancelled";
  error?: unknown;
  [key: string]: unknown;
}

export interface EffectEvidence {
  effectKey?: string;
  status?: "none" | "started" | "unknown" | "confirmed" | "cancelled";
  effectStatus?: "none" | "started" | "unknown" | "confirmed" | "cancelled";
  idempotencyBoundaryConfirmed?: boolean;
  externalRef?: string;
  [key: string]: unknown;
}

export interface RecoveryResolution {
  as?: "completed" | "failed" | "cancelled";
  state?: "completed" | "failed" | "cancelled";
  resolution?: "completed" | "failed" | "cancelled";
  evidence: unknown;
  admin?: boolean;
  role?: string;
  scope?: string;
  actor?: string;
  [key: string]: unknown;
}

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export type Store = {
  installRevisions(revisions: readonly DefinitionRevision[]): void;
  accept(input: AcceptInput): AcceptResult;
  getEvent(id: string): StoredEvent | undefined;
  listUpdatesAfter(cursor: number, eventId?: string): UpdateRecord[];
  getRevision(digest: string): DefinitionRevision;
  countEvents(): number;
  acquireAgent(worker: WorkerCapabilities, now: number): Delivery | undefined;
  acquireProcess(worker: ProcessWorker, now: number): Delivery | undefined;
  blockUnmatched?(workers: readonly WorkerCapabilities[], now: number): void;
  start(authority: DeliveryAuthority): void;
  renew(authority: DeliveryAuthority, newExpiry: number): void;
  progress(authority: DeliveryAuthority, data: unknown): void;
  fail(authority: DeliveryAuthority, failure: FailureEvidence): StoredEvent;
  complete(authority: DeliveryAuthority, result: unknown, effects: EffectEvidence[]): StoredEvent;
  recordEffectIntent(authority: DeliveryAuthority, effectKey: string, idempotencyBoundaryConfirmed: boolean): void;
  confirmEffect(authority: DeliveryAuthority, effectKey: string, externalRef: string): void;
  requestCancel(eventId: string): StoredEvent;
  acknowledgeCancel(authority: DeliveryAuthority, evidence: EffectEvidence[]): StoredEvent;
  resolveRecovery(eventId: string, resolution: RecoveryResolution): StoredEvent;
  expireLeases(now: number): readonly StoredEvent[];
  nextLeaseDeadline(): number | undefined;
  watchLeases?(listener: () => void): () => void;
  close(): void;
};

type EventRow = Record<string, unknown>;
type RevisionRow = Record<string, unknown>;
type UpdateRow = Record<string, unknown>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function json(value: unknown, field: string): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(stableValue(value)); }
  catch (error) { throw new StoreError("invalid_json", `${field} is not JSON serializable: ${String(error)}`); }
  if (encoded === undefined) throw new StoreError("invalid_json", `${field} is not JSON serializable`);
  return encoded;
}

function digest(value: unknown): string { return createHash("sha256").update(json(value, "payload")).digest("hex"); }
function nullableString(value: unknown): string | undefined { return value == null ? undefined : String(value); }

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the transaction error */ }
    throw error;
  }
}

function revisionMaterial(revision: DefinitionRevision): StoredDefinitionRevision & { type: string; version: number } {
  return {
    digest: revision.digest,
    definition: revision.definition,
    inputSchema: revision.inputSchema,
    outputSchema: revision.outputSchema,
    instructions: revision.instructions,
    resolvedCommand: revision.resolvedCommand,
    type: revision.definition.type,
    version: revision.definition.version,
  };
}

function effectStatus(effect: EffectEvidence): string | undefined { return effect.status ?? effect.effectStatus; }
function evidenceMayHaveEffect(evidence: readonly EffectEvidence[]): boolean {
  return evidence.some((entry) => {
    const status = effectStatus(entry);
    return status === "started" || status === "unknown" || status === "confirmed";
  });
}
function evidenceIsUnknown(evidence: readonly EffectEvidence[]): boolean {
  return evidence.some((entry) => {
    const status = effectStatus(entry);
    return status === "started" || status === "unknown";
  });
}

class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly findRevision: StatementSync;
  private readonly findRevisionKey: StatementSync;
  private readonly insertRevision: StatementSync;
  private readonly findEventByKey: StatementSync;
  private readonly findEvent: StatementSync;
  private readonly insertEvent: StatementSync;
  private readonly insertUpdate: StatementSync;
  private readonly countEventRows: StatementSync;
  private readonly readUpdates: StatementSync;
  private readonly leaseListeners = new Set<() => void>();
  private readonly readEventUpdates: StatementSync;
  private readonly nextDeadline: StatementSync;
  private readonly activeCount: StatementSync;
  private readonly queuedEvents: StatementSync;
  private readonly effectRows: StatementSync;

  constructor(path: string, clock: Clock) {
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2500;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS definition_revisions (
        digest TEXT PRIMARY KEY, type TEXT NOT NULL, version INTEGER NOT NULL,
        definition_json TEXT NOT NULL, input_schema_json TEXT NOT NULL,
        output_schema_json TEXT NOT NULL, instructions_text TEXT,
        resolved_command TEXT, created_at INTEGER NOT NULL, UNIQUE(type, version)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, producer_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL, version INTEGER NOT NULL,
        definition_revision TEXT NOT NULL REFERENCES definition_revisions(digest),
        payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, correlation_id TEXT,
        state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
        available_at INTEGER NOT NULL, worker_id TEXT, lease_id TEXT,
        lease_expires_at INTEGER, hard_deadline_at INTEGER, cancel_requested_at INTEGER,
        effect_policy TEXT NOT NULL, recovery_reason TEXT, result_json TEXT, error_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(producer_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS updates (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, attempt INTEGER, worker_id TEXT, lease_id TEXT,
        data_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effect_intents (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        effect_key TEXT NOT NULL, status TEXT NOT NULL,
        idempotency_boundary_confirmed INTEGER NOT NULL DEFAULT 0,
        external_ref TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, effect_key)
      );
      CREATE INDEX IF NOT EXISTS events_queue ON events(state, available_at, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS updates_replay ON updates(event_id, sequence);
    `);
    this.findRevision = this.db.prepare("SELECT * FROM definition_revisions WHERE digest = ?");
    this.findRevisionKey = this.db.prepare("SELECT * FROM definition_revisions WHERE type = ? AND version = ?");
    this.insertRevision = this.db.prepare(`INSERT INTO definition_revisions
      (digest, type, version, definition_json, input_schema_json, output_schema_json, instructions_text, resolved_command, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.findEventByKey = this.db.prepare("SELECT * FROM events WHERE producer_id = ? AND idempotency_key = ?");
    this.findEvent = this.db.prepare("SELECT * FROM events WHERE id = ?");
    this.insertEvent = this.db.prepare(`INSERT INTO events
      (id, producer_id, idempotency_key, type, version, definition_revision, payload_json, payload_digest,
       correlation_id, state, attempt, max_attempts, available_at, effect_policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`);
    this.insertUpdate = this.db.prepare(`INSERT INTO updates
      (event_id, kind, attempt, worker_id, lease_id, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.countEventRows = this.db.prepare("SELECT COUNT(*) AS count FROM events");
    this.readUpdates = this.db.prepare("SELECT * FROM updates WHERE sequence > ? ORDER BY sequence ASC");
    this.readEventUpdates = this.db.prepare("SELECT * FROM updates WHERE sequence > ? AND event_id = ? ORDER BY sequence ASC");
    this.nextDeadline = this.db.prepare("SELECT MIN(CASE WHEN lease_expires_at < hard_deadline_at OR hard_deadline_at IS NULL THEN lease_expires_at ELSE hard_deadline_at END) AS deadline FROM events WHERE state IN ('leased', 'running', 'cancel_requested') AND lease_expires_at IS NOT NULL");
    this.activeCount = this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE worker_id = ? AND state IN ('leased', 'running', 'cancel_requested')");
    this.queuedEvents = this.db.prepare(`SELECT * FROM events
      WHERE (state = 'queued' OR state = 'blocked' OR (state = 'retry_wait' AND available_at <= ?))
        AND cancel_requested_at IS NULL ORDER BY created_at ASC, id ASC`);
    this.effectRows = this.db.prepare("SELECT * FROM effect_intents WHERE event_id = ?");
  }

  installRevisions(revisions: readonly DefinitionRevision[]): void {
    transaction(this.db, () => { for (const revision of revisions) this.installRevision(revision); });
  }

  accept(input: AcceptInput): AcceptResult {
    if (!input.revision.validateInput(input.payload)) throw new StoreError("invalid_input", `payload does not match ${input.revision.definition.type}@${input.revision.definition.version}`);
    const payloadJson = json(input.payload, "payload");
    const payloadDigest = digest(input.payload);
    return transaction(this.db, () => {
      this.installRevision(input.revision);
      const existing = this.findEventByKey.get(input.producerId, input.idempotencyKey);
      if (existing) {
        const event = this.rowToEvent(existing);
        if (event.type !== input.revision.definition.type || event.version !== input.revision.definition.version || event.definitionRevision !== input.revision.digest || event.payloadDigest !== payloadDigest) throw new StoreError("idempotency_conflict", `idempotency key already belongs to ${event.id}`);
        return { event, created: false };
      }
      const now = this.clock.now();
      const id = input.id ?? randomUUID();
      const event = this.insertEventAndRead({
        id, producerId: input.producerId, idempotencyKey: input.idempotencyKey,
        type: input.revision.definition.type, version: input.revision.definition.version,
        definitionRevision: input.revision.digest, payload: input.payload, payloadJson,
        payloadDigest, correlationId: input.correlationId, emittedAt: new Date(now).toISOString(),
        state: "queued", attempt: 0, maxAttempts: input.revision.definition.retry.maxAttempts,
        availableAt: now, effectPolicy: input.revision.definition.effectPolicy, createdAt: now, updatedAt: now,
      });
      this.insertUpdateRecord(id, { kind: "queued", attempt: 0, data: {}, createdAt: now });
      return { event, created: true };
    });
  }

  getEvent(id: string): StoredEvent | undefined {
    const row = this.findEvent.get(id);
    return row ? this.rowToEvent(row) : undefined;
  }

  listUpdatesAfter(cursor: number, eventId?: string): UpdateRecord[] {
    const rows = (eventId === undefined ? this.readUpdates.all(cursor) : this.readEventUpdates.all(cursor, eventId)) as UpdateRow[];
    return rows.map((row) => ({
      sequence: Number(row.sequence), eventId: String(row.event_id), kind: String(row.kind),
      ...(row.attempt == null ? {} : { attempt: Number(row.attempt) }),
      ...(row.worker_id == null ? {} : { workerId: String(row.worker_id) }),
      ...(row.lease_id == null ? {} : { leaseId: String(row.lease_id) }),
      data: JSON.parse(String(row.data_json)), createdAt: Number(row.created_at),
    }));
  }

  getRevision(digestValue: string): DefinitionRevision {
    const row = this.findRevision.get(digestValue) as RevisionRow | undefined;
    if (!row) throw new StoreError("revision_not_found", `definition revision not found: ${digestValue}`);
    return compileRevision({ digest: String(row.digest), definition: String(row.definition_json), inputSchema: String(row.input_schema_json), outputSchema: String(row.output_schema_json), instructions: nullableString(row.instructions_text), resolvedCommand: nullableString(row.resolved_command) });
  }

  countEvents(): number { return Number((this.countEventRows.get() as EventRow).count); }

  acquireAgent(worker: WorkerCapabilities, now: number): Delivery | undefined {
    return this.acquire(worker, now, "agent");
  }

  acquireProcess(worker: ProcessWorker, now: number): Delivery | undefined {
    if (worker.workerId !== "relay:process") return undefined;
    return this.acquire(worker, now, "process");
  }
  blockUnmatched(workers: readonly WorkerCapabilities[], now: number): void {
    transaction(this.db, () => {
      const rows = this.queuedEvents.all(now) as EventRow[];
      for (const row of rows) {
        const revision = this.getRevision(String(row.definition_revision));
        if (workers.some((worker) => this.agentMatches(revision, worker))) continue;
        const eventId = String(row.id);
        this.db.prepare("UPDATE events SET state = 'blocked', updated_at = ? WHERE id = ? AND state <> 'blocked'").run(now, eventId);
        if (String(row.state) !== "blocked") this.insertUpdateRecord(eventId, { kind: "blocked", attempt: Number(row.attempt), data: {}, createdAt: now });
      }
    });
  }


  start(authority: DeliveryAuthority): void {
    this.transition(authority, ["leased"], "running", { kind: "started", data: {} });
  }
  renew(authority: DeliveryAuthority, newExpiry: number): void {
    transaction(this.db, () => {
      const row = this.authorize(authority, ["leased", "running"]);
      const now = this.clock.now();
      const hard = Number(row.hard_deadline_at);
      if (!Number.isFinite(newExpiry) || newExpiry <= now || newExpiry > hard) throw new StoreError("invalid_expiry", "lease expiry must be in the future and before the hard deadline");
      this.db.prepare("UPDATE events SET lease_expires_at = ?, updated_at = ? WHERE id = ?").run(newExpiry, now, String(row.id));
      this.insertUpdateRecord(String(row.id), { kind: "lease_renewed", attempt: Number(row.attempt), workerId: authority.workerId, leaseId: authority.leaseId, data: { leaseExpiresAt: newExpiry }, createdAt: now });
    });
    this.notifyLeaseListeners();
  }

  progress(authority: DeliveryAuthority, data: unknown): void {
    this.transition(authority, ["leased", "running"], undefined, { kind: "progress", data });
  }

  fail(authority: DeliveryAuthority, failure: FailureEvidence): StoredEvent {
    return transaction(this.db, () => {
      const row = this.authorize(authority, ["leased", "running"]);
      const eventId = String(row.id);
      const revision = this.getRevision(String(row.definition_revision));
      const now = this.clock.now();
      const attempt = Number(row.attempt);
      const effectConfirmed = failure.effectStatus === "confirmed" || this.persistedEffectConfirmed(eventId);
      const unknown = failure.effectStatus === "unknown" || failure.effectStatus === "started" || this.persistedEffectMayExist(eventId);
      const effectBearing = unknown || effectConfirmed;
      const retryable = revision.definition.retry.retryableCodes.includes(failure.code) && attempt < Number(row.max_attempts);
      const canRetryEffects = row.effect_policy === "retry-safe" || (row.effect_policy === "idempotency-required" && this.idempotencyBoundaryConfirmed(eventId));
      let state: string;
      let updateKind: string;
      let availableAt = now;
      if ((effectBearing && row.effect_policy === "manual-recovery") || (unknown && !canRetryEffects)) {
        state = "recovery_required"; updateKind = "recovery_required";
      } else if (retryable) {
        state = "retry_wait"; updateKind = "retry_wait";
        const backoff = revision.definition.retry.backoffMs[Math.min(Math.max(attempt - 1, 0), Math.max(revision.definition.retry.backoffMs.length - 1, 0))] ?? 0;
        availableAt = now + backoff;
      } else {
        state = "failed"; updateKind = "failed";
      }
      this.db.prepare(`UPDATE events SET state = ?, available_at = ?, worker_id = NULL, lease_id = NULL,
        lease_expires_at = NULL, hard_deadline_at = NULL, result_json = NULL, error_json = ?,
        recovery_reason = ?, updated_at = ? WHERE id = ?`).run(state, availableAt, json(failure, "failure"), state === "recovery_required" ? failure.code : null, now, eventId);
      this.insertUpdateRecord(eventId, { kind: updateKind, attempt, workerId: authority.workerId, leaseId: authority.leaseId, data: { ...failure, ...(state === "retry_wait" ? { availableAt } : {}) }, createdAt: now });
      return this.rowToEvent(this.findEvent.get(eventId) as EventRow);
    });
  }

  complete(authority: DeliveryAuthority, result: unknown, effects: EffectEvidence[]): StoredEvent {
    return transaction(this.db, () => {
      const row = this.authorize(authority, ["leased", "running"]);
      const revision = this.getRevision(String(row.definition_revision));
      if (!revision.validateOutput(result)) throw new StoreError("invalid_output", `result does not match ${revision.definition.type}@${revision.definition.version}`);
      const eventId = String(row.id);
      const now = this.clock.now();
      const unknown = evidenceIsUnknown(effects) || (row.effect_policy !== "retry-safe" && this.persistedEffectMayExist(eventId) && !this.idempotencyBoundaryConfirmed(eventId));
      if (unknown && row.effect_policy !== "retry-safe") {
        this.db.prepare(`UPDATE events SET state = 'recovery_required', worker_id = NULL, lease_id = NULL,
          lease_expires_at = NULL, hard_deadline_at = NULL, result_json = ?, error_json = ?,
          recovery_reason = 'UNKNOWN_EFFECT', updated_at = ? WHERE id = ?`).run(json(result, "result"), json({ code: "UNKNOWN_EFFECT", effects }, "effects"), now, eventId);
        this.insertUpdateRecord(eventId, { kind: "recovery_required", attempt: Number(row.attempt), workerId: authority.workerId, leaseId: authority.leaseId, data: { code: "UNKNOWN_EFFECT", effects }, createdAt: now });
      } else {
        this.db.prepare(`UPDATE events SET state = 'completed', worker_id = NULL, lease_id = NULL,
          lease_expires_at = NULL, hard_deadline_at = NULL, result_json = ?, error_json = NULL,
          recovery_reason = NULL, updated_at = ? WHERE id = ?`).run(json(result, "result"), now, eventId);
        this.insertUpdateRecord(eventId, { kind: "completed", attempt: Number(row.attempt), workerId: authority.workerId, leaseId: authority.leaseId, data: { result, effects }, createdAt: now });
      }
      return this.rowToEvent(this.findEvent.get(eventId) as EventRow);
    });
  }

  recordEffectIntent(authority: DeliveryAuthority, effectKey: string, idempotencyBoundaryConfirmed: boolean): void {
    this.effectTransition(authority, ["leased", "running"], () => {
      const row = this.findByAuthority(authority);
      const now = this.clock.now();
      this.db.prepare(`INSERT INTO effect_intents(event_id, effect_key, status, idempotency_boundary_confirmed, updated_at)
        VALUES (?, ?, 'started', ?, ?) ON CONFLICT(event_id, effect_key) DO UPDATE SET
          status = CASE WHEN effect_intents.status = 'confirmed' THEN 'confirmed' ELSE 'started' END,
          idempotency_boundary_confirmed = MAX(effect_intents.idempotency_boundary_confirmed, excluded.idempotency_boundary_confirmed),
          updated_at = excluded.updated_at`).run(String(row.id), effectKey, idempotencyBoundaryConfirmed ? 1 : 0, now);
    }, { kind: "effect_started", data: { effectKey, idempotencyBoundaryConfirmed } });
  }

  confirmEffect(authority: DeliveryAuthority, effectKey: string, externalRef: string): void {
    if (!externalRef) throw new StoreError("invalid_effect", "external reference is required");
    this.effectTransition(authority, ["leased", "running"], () => {
      const row = this.findByAuthority(authority);
      const now = this.clock.now();
      const result = this.db.prepare(`UPDATE effect_intents SET status = 'confirmed', external_ref = ?, updated_at = ? WHERE event_id = ? AND effect_key = ?`).run(externalRef, now, String(row.id), effectKey);
      if (Number(result.changes) !== 1) throw new StoreError("effect_not_started", `effect intent not found: ${effectKey}`);
    }, { kind: "effect_confirmed", data: { effectKey, externalRef } });
  }

  requestCancel(eventId: string): StoredEvent {
    const existing = this.getEvent(eventId);
    if (!existing) throw new StoreError("event_not_found", `event not found: ${eventId}`);
    if (["completed", "failed", "cancelled", "recovery_required", "cancel_requested"].includes(existing.state)) return existing;
    return transaction(this.db, () => {
      const row = this.findEvent.get(eventId) as EventRow;
      const now = this.clock.now();
      const state = ["leased", "running"].includes(String(row.state)) ? "cancel_requested" : "cancelled";
      this.db.prepare(`UPDATE events SET state = ?, cancel_requested_at = ?, worker_id = CASE WHEN ? = 'cancelled' THEN NULL ELSE worker_id END,
        lease_id = CASE WHEN ? = 'cancelled' THEN NULL ELSE lease_id END,
        lease_expires_at = CASE WHEN ? = 'cancelled' THEN NULL ELSE lease_expires_at END,
        hard_deadline_at = CASE WHEN ? = 'cancelled' THEN NULL ELSE hard_deadline_at END, updated_at = ? WHERE id = ?`).run(state, now, state, state, state, state, now, eventId);
      this.insertUpdateRecord(eventId, { kind: state, attempt: Number(row.attempt), workerId: nullableString(row.worker_id), leaseId: nullableString(row.lease_id), data: { requestedAt: now }, createdAt: now });
      return this.rowToEvent(this.findEvent.get(eventId) as EventRow);
    });
  }

  acknowledgeCancel(authority: DeliveryAuthority, evidence: EffectEvidence[]): StoredEvent {
    return transaction(this.db, () => {
      const row = this.authorize(authority, ["cancel_requested"]);
      const eventId = String(row.id);
      const now = this.clock.now();
      const recovery = evidenceMayHaveEffect(evidence) || this.persistedEffectMayExist(eventId) || this.persistedEffectConfirmed(eventId);
      const state = recovery ? "recovery_required" : "cancelled";
      this.db.prepare(`UPDATE events SET state = ?, worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
        hard_deadline_at = NULL, result_json = ?, error_json = ?, recovery_reason = ?, updated_at = ? WHERE id = ?`).run(
        state, state === "cancelled" ? json({ evidence }, "evidence") : null,
        state === "recovery_required" ? json({ code: "UNKNOWN_EFFECT", evidence }, "evidence") : null,
        state === "recovery_required" ? "UNKNOWN_EFFECT" : null, now, eventId,
      );
      this.insertUpdateRecord(eventId, { kind: state, attempt: Number(row.attempt), workerId: authority.workerId, leaseId: authority.leaseId, data: { evidence }, createdAt: now });
      return this.rowToEvent(this.findEvent.get(eventId) as EventRow);
    });
  }

  resolveRecovery(eventId: string, resolution: RecoveryResolution): StoredEvent {
    const admin = resolution.admin === true || resolution.role === "admin" || resolution.scope === "admin" || resolution.actor === "admin";
    if (!admin) throw new StoreError("forbidden", "recovery resolution requires admin authority");
    const state = resolution.as ?? resolution.state ?? resolution.resolution;
    if (!state || !["completed", "failed", "cancelled"].includes(state)) throw new StoreError("invalid_resolution", "resolution must be completed, failed, or cancelled");
    return transaction(this.db, () => {
      const row = this.findEvent.get(eventId) as EventRow | undefined;
      if (!row) throw new StoreError("event_not_found", `event not found: ${eventId}`);
      if (String(row.state) !== "recovery_required") throw new StoreError("invalid_state", "event is not awaiting recovery");
      const now = this.clock.now();
      const evidenceJson = json(resolution.evidence, "recovery evidence");
      this.db.prepare(`UPDATE events SET state = ?, worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
        hard_deadline_at = NULL, result_json = ?, error_json = ?, recovery_reason = NULL, updated_at = ? WHERE id = ?`).run(
        state, state === "completed" || state === "cancelled" ? evidenceJson : null,
        state === "failed" ? evidenceJson : null, now, eventId,
      );
      this.insertUpdateRecord(eventId, { kind: "recovery_resolved", attempt: Number(row.attempt), data: { state, evidence: resolution.evidence }, createdAt: now });
      return this.rowToEvent(this.findEvent.get(eventId) as EventRow);
    });
  }

  expireLeases(now: number): readonly StoredEvent[] {
    return transaction(this.db, () => {
      const rows = this.db.prepare(`SELECT * FROM events WHERE state IN ('leased', 'running', 'cancel_requested')
        AND lease_expires_at IS NOT NULL AND (lease_expires_at <= ? OR hard_deadline_at <= ?)
        ORDER BY lease_expires_at ASC`).all(now, now) as EventRow[];
      const expired: StoredEvent[] = [];
      for (const row of rows) {
        const eventId = String(row.id);
        const retrySafe = String(row.effect_policy) === "retry-safe";
        const idempotent = String(row.effect_policy) === "idempotency-required" && this.idempotencyBoundaryConfirmed(eventId);
        const attempt = Number(row.attempt);
        const revision = this.getRevision(String(row.definition_revision));
        const canRetry = (retrySafe || idempotent) && attempt < Number(row.max_attempts);
        let state: string;
        let availableAt = now;
        if (canRetry) {
          state = "retry_wait";
          const backoff = revision.definition.retry.backoffMs[Math.min(Math.max(attempt - 1, 0), Math.max(revision.definition.retry.backoffMs.length - 1, 0))] ?? 0;
          availableAt += backoff;
        } else state = "recovery_required";
        this.db.prepare(`UPDATE events SET state = ?, available_at = ?, worker_id = NULL, lease_id = NULL,
          lease_expires_at = NULL, hard_deadline_at = NULL, cancel_requested_at = NULL, error_json = ?, recovery_reason = ?, updated_at = ? WHERE id = ?`).run(
          state, availableAt, json({ code: "WORKER_LOST", effectStatus: "unknown" }, "expiry"), state === "recovery_required" ? "WORKER_LOST" : null, now, eventId,
        );
        this.insertUpdateRecord(eventId, { kind: state, attempt, workerId: nullableString(row.worker_id), leaseId: nullableString(row.lease_id), data: { code: "WORKER_LOST", effectStatus: "unknown", ...(state === "retry_wait" ? { availableAt } : {}) }, createdAt: now });
        expired.push(this.rowToEvent(this.findEvent.get(eventId) as EventRow));
      }
      return expired;
    });
  }

  nextLeaseDeadline(): number | undefined {
    const value = (this.nextDeadline.get() as EventRow).deadline;
    return value == null ? undefined : Number(value);
  }

  watchLeases(listener: () => void): () => void {
    this.leaseListeners.add(listener);
    return () => { this.leaseListeners.delete(listener); };
  }

  close(): void { this.db.close(); }

  private acquire(worker: WorkerCapabilities | ProcessWorker, now: number, kind: "agent" | "process"): Delivery | undefined {
    const delivery = transaction(this.db, () => {
      const workerId = worker.workerId;
      const maxConcurrent = worker.maxConcurrent;
      if (Number((this.activeCount.get(workerId) as EventRow).count) >= maxConcurrent) return undefined;
      const rows = this.queuedEvents.all(now) as EventRow[];
      for (const row of rows) {
        const revision = this.getRevision(String(row.definition_revision));
        const handler = revision.definition.handler;
        if (handler.kind !== kind) continue;
        if (kind === "agent" && !this.agentMatches(revision, worker as WorkerCapabilities)) continue;
        const leaseId = randomUUID();
        const attempt = Number(row.attempt) + 1;
        const leaseExpiresAt = now + revision.definition.timeoutMs;
        const hardDeadlineAt = now + revision.definition.hardDeadlineMs;
        this.db.prepare(`UPDATE events SET state = 'leased', attempt = ?, worker_id = ?, lease_id = ?,
          lease_expires_at = ?, hard_deadline_at = ?, cancel_requested_at = NULL, updated_at = ? WHERE id = ?`).run(
          attempt, workerId, leaseId, leaseExpiresAt, hardDeadlineAt, now, String(row.id),
        );
        this.insertUpdateRecord(String(row.id), { kind: "leased", attempt, workerId, leaseId, data: {}, createdAt: now });
        return this.deliveryFromEvent(this.findEvent.get(String(row.id)) as EventRow);
      }
      return undefined;
    });
    if (delivery) this.notifyLeaseListeners();
    return delivery;
  }

  private agentMatches(revision: DefinitionRevision, worker: WorkerCapabilities): boolean {
    const definition = revision.definition;
    if (definition.handler.kind !== "agent") return false;
    const name = `${definition.type}@${definition.version}`;
    if (!worker.allowedDefinitions.some((entry) => entry === "*" || entry === name || (entry.endsWith(".*") && definition.type.startsWith(entry.slice(0, -1))))) return false;
    if (!definition.requires.tools.every((tool) => worker.tools.includes(tool))) return false;
    if (definition.requires.structuredOutput && !worker.structuredOutput) return false;
    const requiredContext = Math.max(definition.requires.minContextTokens, worker.systemReserveTokens + definition.requires.maxInputTokens + definition.requires.maxOutputTokens);
    return worker.contextTokens >= requiredContext;
  }

  private transition(authority: DeliveryAuthority, states: readonly string[], nextState: string | undefined, update: { kind: string; data: unknown }): void {
    transaction(this.db, () => {
      const row = this.authorize(authority, states);
      const now = this.clock.now();
      if (nextState !== undefined) this.db.prepare("UPDATE events SET state = ?, updated_at = ? WHERE id = ?").run(nextState, now, String(row.id));
      this.insertUpdateRecord(String(row.id), { kind: update.kind, attempt: Number(row.attempt), workerId: authority.workerId, leaseId: authority.leaseId, data: update.data, createdAt: now });
    });
  }

  private effectTransition(authority: DeliveryAuthority, states: readonly string[], mutateEffect: () => void, update: { kind: string; data: unknown }): void {
    transaction(this.db, () => {
      const row = this.authorize(authority, states);
      mutateEffect();
      this.insertUpdateRecord(String(row.id), { kind: update.kind, attempt: Number(row.attempt), workerId: authority.workerId, leaseId: authority.leaseId, data: update.data, createdAt: this.clock.now() });
    });
  }

  private authorize(authority: DeliveryAuthority, states: readonly string[]): EventRow {
    const row = (authority.eventId
      ? this.findEvent.get(authority.eventId)
      : this.db.prepare("SELECT * FROM events WHERE worker_id = ? AND lease_id = ?").get(authority.workerId, authority.leaseId)) as EventRow | undefined;
    if (!row || String(row.worker_id) !== authority.workerId || String(row.lease_id) !== authority.leaseId || !states.includes(String(row.state))) throw new StoreError("stale_delivery", "delivery authority is no longer current");
    const now = this.clock.now();
    if (row.lease_expires_at == null || Number(row.lease_expires_at) <= now || row.hard_deadline_at == null || Number(row.hard_deadline_at) <= now) throw new StoreError("stale_delivery", "delivery lease has expired");
    return row;
  }

  private findByAuthority(authority: DeliveryAuthority): EventRow { return this.authorize(authority, ["leased", "running"]); }

  private persistedEffectMayExist(eventId: string): boolean {
    return (this.effectRows.all(eventId) as EventRow[]).some((row) => String(row.status) === "started");
  }
  private persistedEffectConfirmed(eventId: string): boolean {
    return (this.effectRows.all(eventId) as EventRow[]).some((row) => String(row.status) === "confirmed");
  }

  private notifyLeaseListeners(): void {
    for (const listener of this.leaseListeners) listener();
  }
  private idempotencyBoundaryConfirmed(eventId: string): boolean {
    const rows = this.effectRows.all(eventId) as EventRow[];
    return rows.length > 0 && rows.every((row) => Number(row.idempotency_boundary_confirmed) === 1);
  }

  private installRevision(revision: DefinitionRevision): void {
    const material = revisionMaterial(revision);
    const existing = this.findRevision.get(revision.digest) as RevisionRow | undefined;
    if (existing) {
      if (String(existing.type) !== material.type || Number(existing.version) !== material.version) throw new StoreError("revision_conflict", "digest is already stored for a different definition");
      return;
    }
    const sameKey = this.findRevisionKey.get(material.type, material.version) as RevisionRow | undefined;
    if (sameKey && String(sameKey.digest) !== revision.digest) throw new StoreError("revision_conflict", `definition ${material.type}@${material.version} is immutable`);
    this.insertRevision.run(revision.digest, material.type, material.version, json(revision.definition, "definition"), json(revision.inputSchema, "inputSchema"), json(revision.outputSchema, "outputSchema"), revision.instructions ?? null, revision.resolvedCommand ?? null, this.clock.now());
  }

  private insertEventAndRead(input: { id: string; producerId: string; idempotencyKey: string; type: string; version: number; definitionRevision: string; payload: unknown; payloadJson: string; payloadDigest: string; correlationId?: string; emittedAt: string; state: string; attempt: number; maxAttempts: number; availableAt: number; effectPolicy: string; createdAt: number; updatedAt: number }): StoredEvent {
    this.insertEvent.run(input.id, input.producerId, input.idempotencyKey, input.type, input.version, input.definitionRevision, input.payloadJson, input.payloadDigest, input.correlationId ?? null, input.maxAttempts, input.availableAt, input.effectPolicy, input.createdAt, input.updatedAt);
    return this.rowToEvent(this.findEvent.get(input.id) as EventRow);
  }

  private insertUpdateRecord(eventId: string, update: { kind: string; attempt?: number; workerId?: string; leaseId?: string; data: unknown; createdAt?: number }): void {
    this.insertUpdate.run(eventId, update.kind, update.attempt ?? null, update.workerId ?? null, update.leaseId ?? null, json(update.data, "update"), update.createdAt ?? this.clock.now());
  }

  private deliveryFromEvent(row: EventRow): Delivery {
    return {
      event: {
        id: String(row.id), producerId: String(row.producer_id), idempotencyKey: String(row.idempotency_key),
        type: String(row.type), version: Number(row.version), definitionRevision: String(row.definition_revision),
        payload: JSON.parse(String(row.payload_json)), payloadDigest: String(row.payload_digest),
        emittedAt: new Date(Number(row.created_at)).toISOString(),
        ...(row.correlation_id == null ? {} : { correlationId: String(row.correlation_id) }),
      },
      attempt: Number(row.attempt), workerId: String(row.worker_id), leaseId: String(row.lease_id),
      leaseExpiresAt: new Date(Number(row.lease_expires_at)).toISOString(), hardDeadlineAt: new Date(Number(row.hard_deadline_at)).toISOString(),
    };
  }

  private rowToEvent(row: EventRow): StoredEvent {
    return {
      id: String(row.id), producerId: String(row.producer_id), idempotencyKey: String(row.idempotency_key),
      type: String(row.type), version: Number(row.version), definitionRevision: String(row.definition_revision),
      payload: JSON.parse(String(row.payload_json)), payloadDigest: String(row.payload_digest), emittedAt: new Date(Number(row.created_at)).toISOString(),
      ...(row.correlation_id == null ? {} : { correlationId: String(row.correlation_id) }), state: String(row.state), attempt: Number(row.attempt),
      maxAttempts: Number(row.max_attempts), availableAt: Number(row.available_at),
      ...(row.worker_id == null ? {} : { workerId: String(row.worker_id) }), ...(row.lease_id == null ? {} : { leaseId: String(row.lease_id) }),
      ...(row.lease_expires_at == null ? {} : { leaseExpiresAt: Number(row.lease_expires_at) }), ...(row.hard_deadline_at == null ? {} : { hardDeadlineAt: Number(row.hard_deadline_at) }),
      ...(row.cancel_requested_at == null ? {} : { cancelRequestedAt: Number(row.cancel_requested_at) }), effectPolicy: String(row.effect_policy),
      ...(row.recovery_reason == null ? {} : { recoveryReason: String(row.recovery_reason) }), ...(row.result_json == null ? {} : { result: JSON.parse(String(row.result_json)) }),
      ...(row.error_json == null ? {} : { error: JSON.parse(String(row.error_json)) }), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }
}

export function openStore(path: string, clock: Clock = { now: () => Date.now() }): Store { return new SqliteStore(path, clock); }
