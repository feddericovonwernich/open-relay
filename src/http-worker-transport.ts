import type { Delivery, DeliveryAuthority, EffectEvidence } from "./protocol.ts";
import type { FailureEvidence } from "./store.ts";
import type { WorkerTransport } from "./worker-runtime.ts";

export interface HttpWorkerTransportOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export class HttpWorkerTransportError extends Error {
  readonly status: number;

  constructor(status: number, message = `worker transport request failed (${status})`) {
    super(message);
    this.name = "HttpWorkerTransportError";
    this.status = status;
  }
}

function isDelivery(value: unknown): value is Delivery {
  if (typeof value !== "object" || value === null || !("event" in value) || typeof value.event !== "object" || value.event === null || !("id" in value.event)) {
    return false;
  }
  return typeof value.event.id === "string"
    && "outputSchema" in value
    && typeof value.outputSchema === "object"
    && value.outputSchema !== null
    && !Array.isArray(value.outputSchema)
    && "workerId" in value
    && typeof value.workerId === "string"
    && "leaseId" in value
    && typeof value.leaseId === "string"
    && "leaseExpiresAt" in value
    && typeof value.leaseExpiresAt === "string"
    && "hardDeadlineAt" in value
    && typeof value.hardDeadlineAt === "string";
}

export class HttpWorkerTransport implements WorkerTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: HttpWorkerTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }
  async poll(signal: AbortSignal): Promise<Delivery | undefined> {
    const value = await this.json("/v1/agent/poll", {
      method: "POST",
      body: JSON.stringify({}),
      signal,
    });
    if (value === null) return undefined;
    if (!isDelivery(value)) {
      throw new HttpWorkerTransportError(200, "worker transport returned invalid poll response");
    }
    return value;
  }

  async start(authority: DeliveryAuthority): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/start`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async renew(authority: DeliveryAuthority, leaseExpiresAt: number | string): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/renew`, {
      method: "POST",
      body: JSON.stringify({ leaseExpiresAt }),
    });
  }

  async progress(authority: DeliveryAuthority, data: unknown): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/progress`, {
      method: "POST",
      body: JSON.stringify({ data }),
    });
  }

  async complete(authority: DeliveryAuthority, result: unknown, effects: readonly EffectEvidence[]): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ result, effects }),
    });
  }

  async fail(authority: DeliveryAuthority, failure: FailureEvidence): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/fail`, {
      method: "POST",
      body: JSON.stringify(failure),
    });
  }


  async control(authority: DeliveryAuthority, signal: AbortSignal): Promise<"cancel_requested" | "timeout"> {
    const value = await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/control`, { method: "GET", signal });
    if (typeof value !== "object" || value === null || !("status" in value)) {
      throw new HttpWorkerTransportError(200, "worker transport returned invalid control response");
    }
    const status = value.status;
    if (status !== "cancel_requested" && status !== "timeout") {
      throw new HttpWorkerTransportError(200, "worker transport returned invalid control response");
    }
    return status;
  }

  async cancelled(authority: DeliveryAuthority, evidence: readonly EffectEvidence[]): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/cancelled`, {
      method: "POST",
      body: JSON.stringify({ effects: evidence }),
    });
  }

  async recordEffectIntent(authority: DeliveryAuthority, effectKey: string, idempotencyBoundaryConfirmed: boolean): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/effect-intent`, {
      method: "POST",
      body: JSON.stringify({ effectKey, idempotencyBoundaryConfirmed }),
    });
  }

  async confirmEffect(authority: DeliveryAuthority, effectKey: string, externalRef: string): Promise<void> {
    await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/effect-confirmation`, {
      method: "POST",
      body: JSON.stringify({ effectKey, externalRef }),
    });
  }

  private async json(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) throw new HttpWorkerTransportError(response.status);
    try {
      return await response.json();
    } catch {
      throw new HttpWorkerTransportError(response.status, "worker transport returned invalid JSON");
    }
  }
}
