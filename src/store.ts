import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { compileRevision, type DefinitionRevision, type StoredDefinitionRevision } from "./registry.ts";

export interface Clock {
  now(): number;
}

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

export interface AcceptResult {
  event: StoredEvent;
  created: boolean;
}

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
  try {
    encoded = JSON.stringify(stableValue(value));
  } catch (error) {
    throw new StoreError("invalid_json", `${field} is not JSON serializable: ${String(error)}`);
  }
  if (encoded === undefined) throw new StoreError("invalid_json", `${field} is not JSON serializable`);
  return encoded;
}

function digest(value: unknown): string {
  return createHash("sha256").update(json(value, "payload")).digest("hex");
}

function nullableString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}


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
  private readonly readEventUpdates: StatementSync;

  constructor(path: string, clock: Clock) {
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2500;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS definition_revisions (
        digest TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,
        output_schema_json TEXT NOT NULL,
        instructions_text TEXT,
        resolved_command TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(type, version)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        producer_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_revision TEXT NOT NULL REFERENCES definition_revisions(digest),
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        correlation_id TEXT,
        state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        worker_id TEXT,
        lease_id TEXT,
        lease_expires_at INTEGER,
        hard_deadline_at INTEGER,
        cancel_requested_at INTEGER,
        effect_policy TEXT NOT NULL,
        recovery_reason TEXT,
        result_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(producer_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS updates (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        attempt INTEGER,
        worker_id TEXT,
        lease_id TEXT,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effect_intents (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        effect_key TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_boundary_confirmed INTEGER NOT NULL DEFAULT 0,
        external_ref TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, effect_key)
      );
      CREATE INDEX IF NOT EXISTS events_queue
        ON events(state, available_at, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS updates_replay
        ON updates(event_id, sequence);
    `);

    this.findRevision = this.db.prepare("SELECT * FROM definition_revisions WHERE digest = ?");
    this.findRevisionKey = this.db.prepare("SELECT * FROM definition_revisions WHERE type = ? AND version = ?");
    this.insertRevision = this.db.prepare(`
      INSERT INTO definition_revisions
        (digest, type, version, definition_json, input_schema_json, output_schema_json, instructions_text, resolved_command, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findEventByKey = this.db.prepare("SELECT * FROM events WHERE producer_id = ? AND idempotency_key = ?");
    this.findEvent = this.db.prepare("SELECT * FROM events WHERE id = ?");
    this.insertEvent = this.db.prepare(`
      INSERT INTO events
        (id, producer_id, idempotency_key, type, version, definition_revision, payload_json, payload_digest,
         correlation_id, state, attempt, max_attempts, available_at, effect_policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
    `);
    this.insertUpdate = this.db.prepare(`
      INSERT INTO updates (event_id, kind, attempt, worker_id, lease_id, data_json, created_at)
      VALUES (?, 'queued', 0, NULL, NULL, ?, ?)
    `);
    this.countEventRows = this.db.prepare("SELECT COUNT(*) AS count FROM events");
    this.readUpdates = this.db.prepare("SELECT * FROM updates WHERE sequence > ? ORDER BY sequence ASC");
    this.readEventUpdates = this.db.prepare("SELECT * FROM updates WHERE sequence > ? AND event_id = ? ORDER BY sequence ASC");
  }

  installRevisions(revisions: readonly DefinitionRevision[]): void {
    transaction(this.db, () => {
      for (const revision of revisions) this.installRevision(revision);
    });
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
        if (event.type !== input.revision.definition.type || event.version !== input.revision.definition.version || event.definitionRevision !== input.revision.digest || event.payloadDigest !== payloadDigest) {
          throw new StoreError("idempotency_conflict", `idempotency key already belongs to ${event.id}`);
        }
        return { event, created: false };
      }

      const now = this.clock.now();
      const id = input.id ?? randomUUID();
      const maxAttempts = input.revision.definition.retry.maxAttempts;
      const event = this.insertEventAndRead({
        id,
        producerId: input.producerId,
        idempotencyKey: input.idempotencyKey,
        type: input.revision.definition.type,
        version: input.revision.definition.version,
        definitionRevision: input.revision.digest,
        payload: input.payload,
        payloadJson,
        payloadDigest,
        correlationId: input.correlationId,
        emittedAt: new Date(now).toISOString(),
        state: "queued",
        attempt: 0,
        maxAttempts,
        availableAt: now,
        effectPolicy: input.revision.definition.effectPolicy,
        createdAt: now,
        updatedAt: now,
      });
      this.insertUpdate.run(id, JSON.stringify({}), now);
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
      sequence: Number(row.sequence),
      eventId: String(row.event_id),
      kind: String(row.kind),
      ...(row.attempt == null ? {} : { attempt: Number(row.attempt) }),
      ...(row.worker_id == null ? {} : { workerId: String(row.worker_id) }),
      ...(row.lease_id == null ? {} : { leaseId: String(row.lease_id) }),
      data: JSON.parse(String(row.data_json)),
      createdAt: Number(row.created_at),
    }));
  }

  getRevision(digest: string): DefinitionRevision {
    const row = this.findRevision.get(digest) as RevisionRow | undefined;
    if (!row) throw new StoreError("revision_not_found", `definition revision not found: ${digest}`);
    return compileRevision({
      digest: String(row.digest),
      definition: String(row.definition_json),
      inputSchema: String(row.input_schema_json),
      outputSchema: String(row.output_schema_json),
      instructions: nullableString(row.instructions_text),
      resolvedCommand: nullableString(row.resolved_command),
    });
  }

  countEvents(): number {
    const row = this.countEventRows.get() as EventRow;
    return Number(row.count);
  }

  close(): void {
    this.db.close();
  }

  private installRevision(revision: DefinitionRevision): void {
    const material = revisionMaterial(revision);
    const existing = this.findRevision.get(revision.digest) as RevisionRow | undefined;
    if (existing) {
      if (String(existing.type) !== material.type || Number(existing.version) !== material.version) throw new StoreError("revision_conflict", `digest is already stored for a different definition`);
      return;
    }
    const sameKey = this.findRevisionKey.get(material.type, material.version) as RevisionRow | undefined;
    if (sameKey && String(sameKey.digest) !== revision.digest) throw new StoreError("revision_conflict", `definition ${material.type}@${material.version} is immutable`);
    this.insertRevision.run(
      revision.digest,
      material.type,
      material.version,
      json(revision.definition, "definition"),
      json(revision.inputSchema, "inputSchema"),
      json(revision.outputSchema, "outputSchema"),
      revision.instructions ?? null,
      revision.resolvedCommand ?? null,
      this.clock.now(),
    );
  }

  private insertEventAndRead(input: {
    id: string;
    producerId: string;
    idempotencyKey: string;
    type: string;
    version: number;
    definitionRevision: string;
    payload: unknown;
    payloadJson: string;
    payloadDigest: string;
    correlationId?: string;
    emittedAt: string;
    state: string;
    attempt: number;
    maxAttempts: number;
    availableAt: number;
    effectPolicy: string;
    createdAt: number;
    updatedAt: number;
  }): StoredEvent {
    this.insertEvent.run(
      input.id,
      input.producerId,
      input.idempotencyKey,
      input.type,
      input.version,
      input.definitionRevision,
      input.payloadJson,
      input.payloadDigest,
      input.correlationId ?? null,
      input.maxAttempts,
      input.availableAt,
      input.effectPolicy,
      input.createdAt,
      input.updatedAt,
    );
    return this.rowToEvent(this.findEvent.get(input.id) as EventRow);
  }

  private rowToEvent(row: EventRow): StoredEvent {
    return {
      id: String(row.id),
      producerId: String(row.producer_id),
      idempotencyKey: String(row.idempotency_key),
      type: String(row.type),
      version: Number(row.version),
      definitionRevision: String(row.definition_revision),
      payload: JSON.parse(String(row.payload_json)),
      payloadDigest: String(row.payload_digest),
      emittedAt: new Date(Number(row.created_at)).toISOString(),
      ...(row.correlation_id == null ? {} : { correlationId: String(row.correlation_id) }),
      state: String(row.state),
      attempt: Number(row.attempt),
      maxAttempts: Number(row.max_attempts),
      availableAt: Number(row.available_at),
      ...(row.worker_id == null ? {} : { workerId: String(row.worker_id) }),
      ...(row.lease_id == null ? {} : { leaseId: String(row.lease_id) }),
      ...(row.lease_expires_at == null ? {} : { leaseExpiresAt: Number(row.lease_expires_at) }),
      ...(row.hard_deadline_at == null ? {} : { hardDeadlineAt: Number(row.hard_deadline_at) }),
      ...(row.cancel_requested_at == null ? {} : { cancelRequestedAt: Number(row.cancel_requested_at) }),
      effectPolicy: String(row.effect_policy),
      ...(row.recovery_reason == null ? {} : { recoveryReason: String(row.recovery_reason) }),
      ...(row.result_json == null ? {} : { result: JSON.parse(String(row.result_json)) }),
      ...(row.error_json == null ? {} : { error: JSON.parse(String(row.error_json)) }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}

export function openStore(path: string, clock: Clock = { now: () => Date.now() }): Store {
  return new SqliteStore(path, clock);
}
