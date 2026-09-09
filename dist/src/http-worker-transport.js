export class HttpWorkerTransportError extends Error {
    status;
    constructor(status, message = `worker transport request failed (${status})`) {
        super(message);
        this.name = "HttpWorkerTransportError";
        this.status = status;
    }
}
export class HttpWorkerTransport {
    baseUrl;
    token;
    fetchFn;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.token = options.token;
        this.fetchFn = options.fetch ?? globalThis.fetch;
    }
    async control(authority, signal) {
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
    async cancelled(authority, evidence) {
        await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/cancelled`, {
            method: "POST",
            body: JSON.stringify({ effects: evidence }),
        });
    }
    async recordEffectIntent(authority, effectKey, idempotencyBoundaryConfirmed) {
        await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/effect-intent`, {
            method: "POST",
            body: JSON.stringify({ effectKey, idempotencyBoundaryConfirmed }),
        });
    }
    async confirmEffect(authority, effectKey, externalRef) {
        await this.json(`/v1/deliveries/${encodeURIComponent(authority.leaseId)}/effect-confirmation`, {
            method: "POST",
            body: JSON.stringify({ effectKey, externalRef }),
        });
    }
    async json(path, init) {
        const response = await this.fetchFn(`${this.baseUrl}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
        });
        if (!response.ok)
            throw new HttpWorkerTransportError(response.status);
        try {
            return await response.json();
        }
        catch {
            throw new HttpWorkerTransportError(response.status, "worker transport returned invalid JSON");
        }
    }
}
