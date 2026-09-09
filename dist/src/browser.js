export class RelayClientError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.name = "RelayClientError";
        this.status = status;
        this.code = code;
    }
}
function randomIdempotencyKey() {
    return globalThis.crypto?.randomUUID?.() ?? `relay:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}
function isOptions(value) {
    if (typeof value !== "object" || value === null || "request" in value)
        return false;
    return "token" in value || "baseUrl" in value || "retries" in value || "reconnectDelayMs" in value;
}
function defaultTransport() {
    return (input, init) => globalThis.fetch(input, init);
}
function resolveTransport(value) {
    return value ?? defaultTransport();
}
function toAbsoluteUrl(baseUrl, path) {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}
async function responseError(response) {
    let payload = {};
    try {
        payload = await response.clone().json();
    }
    catch { /* non-JSON error */ }
    const code = typeof payload.error?.code === "string" ? payload.error.code : undefined;
    const message = typeof payload.error?.message === "string" ? payload.error.message : `relay request failed (${response.status})`;
    return new RelayClientError(response.status, message, code);
}
function parseData(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
class SseDecoder {
    buffer = "";
    event = "";
    data = [];
    id;
    feed(chunk) {
        this.buffer += chunk;
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        return lines.flatMap((line) => this.line(line.endsWith("\r") ? line.slice(0, -1) : line));
    }
    finish() {
        const events = this.buffer.length > 0 ? this.line(this.buffer) : [];
        return [...events, ...this.dispatch()];
    }
    line(line) {
        if (line === "")
            return this.dispatch();
        if (line.startsWith(":"))
            return [];
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        let value = separator < 0 ? "" : line.slice(separator + 1);
        if (value.startsWith(" "))
            value = value.slice(1);
        if (field === "event")
            this.event = value;
        else if (field === "data")
            this.data.push(value);
        else if (field === "id" && !value.includes("\0"))
            this.id = value;
        return [];
    }
    dispatch() {
        if (this.data.length === 0) {
            this.event = "";
            this.id = undefined;
            return [];
        }
        const result = { ...(this.id === undefined ? {} : { id: this.id }), event: this.event || "message", data: parseData(this.data.join("\n")) };
        this.event = "";
        this.data = [];
        this.id = undefined;
        return [result];
    }
}
async function* responseChunks(body) {
    if (!body)
        return;
    const reader = body.getReader();
    try {
        while (true) {
            const next = await reader.read();
            if (next.done)
                return;
            yield next.value;
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
async function waitForReconnect(milliseconds, signal) {
    if (signal?.aborted)
        return;
    await new Promise((resolve) => {
        const timer = setTimeout(done, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            done();
        };
        function done() {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
export class RelayBrowserClient {
    config;
    constructor(transportOrOptions, options) {
        const config = isOptions(transportOrOptions) ? transportOrOptions : { ...options, fetch: transportOrOptions };
        const transport = config.fetch ?? (isOptions(transportOrOptions) ? undefined : transportOrOptions);
        const token = config.token ?? (typeof transportOrOptions === "object" && transportOrOptions !== null && "token" in transportOrOptions && typeof transportOrOptions.token === "string" ? transportOrOptions.token : "");
        if (!token && transport === undefined)
            throw new TypeError("relay bearer token is required");
        this.config = {
            baseUrl: config.baseUrl ?? (typeof transportOrOptions === "object" && transportOrOptions !== null && "baseUrl" in transportOrOptions && typeof transportOrOptions.baseUrl === "string" ? transportOrOptions.baseUrl : "http://127.0.0.1:8787"),
            token,
            transport: resolveTransport(transport),
            retries: Math.max(0, config.retries ?? 1),
            reconnectDelayMs: Math.max(0, config.reconnectDelayMs ?? 250),
        };
    }
    async emit(type, version, payload, options = {}) {
        const idempotencyKey = options.idempotencyKey ?? randomIdempotencyKey();
        const body = JSON.stringify({ type, version, payload, idempotencyKey, ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }) });
        const response = await this.request("/v1/events", { method: "POST", body, signal: options.signal, headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey } }, this.config.retries);
        const value = await response.json();
        if (!value.event)
            throw new Error("relay acceptance response did not include an event");
        return value.event;
    }
    async get(eventId, signal) {
        const response = await this.request(`/v1/events/${encodeURIComponent(eventId)}`, { method: "GET", signal });
        return await response.json();
    }
    async cancel(eventId, signal) {
        const response = await this.request(`/v1/events/${encodeURIComponent(eventId)}/cancel`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: "{}" });
        return await response.json();
    }
    async *stream(options = {}) {
        let cursor = options.cursor === undefined ? undefined : String(options.cursor);
        let count = 0;
        const signal = options.signal;
        while (!signal?.aborted && (options.maxEvents === undefined || count < options.maxEvents)) {
            const url = new URL(toAbsoluteUrl(this.config.baseUrl, "/v1/stream"));
            if (options.eventId !== undefined)
                url.searchParams.set("eventId", options.eventId);
            let response;
            try {
                response = await this.request(url.pathname + url.search, {
                    method: "GET",
                    signal,
                    headers: { Accept: "text/event-stream", ...(cursor === undefined ? {} : { "Last-Event-ID": cursor }) },
                }, 0);
                if (!response.body)
                    throw new Error("relay stream response has no body");
                const contentType = response.headers.get("content-type") ?? "";
                if (!contentType.toLowerCase().startsWith("text/event-stream"))
                    throw new Error("relay stream response is not text/event-stream");
                const decoder = new TextDecoder();
                const parser = new SseDecoder();
                for await (const chunk of responseChunks(response.body)) {
                    for (const event of parser.feed(decoder.decode(chunk, { stream: true }))) {
                        if (event.id !== undefined)
                            cursor = event.id;
                        yield event;
                        count += 1;
                        if (options.maxEvents !== undefined && count >= options.maxEvents)
                            return;
                    }
                }
                for (const event of [...parser.feed(decoder.decode()), ...parser.finish()]) {
                    if (event.id !== undefined)
                        cursor = event.id;
                    yield event;
                    count += 1;
                    if (options.maxEvents !== undefined && count >= options.maxEvents)
                        return;
                }
            }
            catch (error) {
                if (signal?.aborted)
                    return;
                if (error instanceof RelayClientError)
                    throw error;
            }
            if (signal?.aborted)
                return;
            await waitForReconnect(options.reconnectDelayMs ?? this.config.reconnectDelayMs, signal);
        }
    }
    async request(path, init, retries = 0) {
        const url = toAbsoluteUrl(this.config.baseUrl, path);
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${this.config.token}`);
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                const response = await this.callTransport(url, { ...init, headers });
                if (!response.ok)
                    throw await responseError(response);
                return response;
            }
            catch (error) {
                if (error instanceof RelayClientError || (init.signal?.aborted ?? false) || attempt === retries)
                    throw error;
                lastError = error;
            }
        }
        throw lastError ?? new Error("relay request failed");
    }
    callTransport(input, init) {
        const transport = this.config.transport;
        if (typeof transport === "function")
            return transport(input, init);
        if ("request" in transport)
            return transport.request(input, init);
        return transport.fetch(input, init);
    }
}
