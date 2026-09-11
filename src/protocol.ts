export type HandlerKind = "agent" | "process";
export type EffectPolicy = "retry-safe" | "idempotency-required" | "manual-recovery";

export interface EventDefinition {
  type: string;
  version: number;
  inputSchema: string;
  outputSchema: string;
  effectPolicy: EffectPolicy;
  timeoutMs: number;
  hardDeadlineMs: number;
  retry: {
    maxAttempts: number;
    backoffMs: number[];
    retryableCodes: string[];
  };
  requires: {
    tools: string[];
    structuredOutput: boolean;
    minContextTokens: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxPayloadBytes: number;
  };
  handler:
    | { kind: "agent"; instructions: string }
    | { kind: "process"; command: string; args: string[]; env: string[] };
}

export interface WorkerCapabilities {
  workerId: string;
  allowedDefinitions: string[];
  tools: string[];
  structuredOutput: boolean;
  contextTokens: number;
  systemReserveTokens: number;
  maxConcurrent: number;
  correlationId?: string;
}


export interface ProcessWorker {
  workerId: "relay:process";
  maxConcurrent: number;
}

export interface EventEnvelope {
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
}

export interface Delivery {
  event: EventEnvelope;
  outputSchema: object;
  attempt: number;
  workerId: string;
  leaseId: string;
  leaseExpiresAt: string;
  hardDeadlineAt: string;
}
export interface DeliveryAuthority {
  eventId?: string;
  workerId: string;
  leaseId: string;
}

export type TrustLevel = "trusted" | "untrusted";

export interface EffectEvidence {
  effectKey?: string;
  status?: "none" | "started" | "unknown" | "confirmed" | "cancelled";
  effectStatus?: "none" | "started" | "unknown" | "confirmed" | "cancelled";
  idempotencyBoundaryConfirmed?: boolean;
  externalRef?: string;
  [key: string]: unknown;
}
