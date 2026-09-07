import type { StoredEvent, UpdateRecord } from "./store.ts";

export type RelayTransport =
  | { request(input: string | URL, init?: RequestInit): Promise<Response>; baseUrl?: string; token?: string }
  | { fetch(input: string | URL, init?: RequestInit): Promise<Response>; baseUrl?: string; token?: string }
  | ((input: string | URL, init?: RequestInit) => Promise<Response>);

export interface RelayBrowserClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: RelayTransport;
  retries?: number;
  reconnectDelayMs?: number;
}

export interface EmitOptions {
  idempotencyKey?: string;
  correlationId?: string;
  signal?: AbortSignal;
}

export interface StreamOptions {
  cursor?: number | string;
  eventId?: string;
  signal?: AbortSignal;
  reconnectDelayMs?: number;
  maxEvents?: number;
}

export interface RelayStreamEvent<T = unknown> {
  id?: string;
  event: string;
  data: T;
}

export class RelayClientError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "RelayClientError";
    this.status = status;
    this.code = code;
  }
}

type ClientConfig = {
  baseUrl: string;
  token: string;
  transport: RelayTransport;
  retries: number;
  reconnectDelayMs: number;
};

type ErrorPayload = { error?: { code?: unknown; message?: unknown } };


function randomIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `relay:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function isOptions(value: RelayTransport | RelayBrowserClientOptions): value is RelayBrowserClientOptions {
  if (typeof value !== "object" || value === null || "request" in value) return false;
  return "token" in value || "baseUrl" in value || "retries" in value || "reconnectDelayMs" in value;
}

function defaultTransport(): RelayTransport {
  return (input, init) => globalThis.fetch(input, init);
}

function resolveTransport(value: RelayTransport | undefined): RelayTransport {
  return value ?? defaultTransport();
}

function toAbsoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function responseError(response: Response): Promise<RelayClientError> {
  let payload: ErrorPayload = {};
  try { payload = await response.clone().json() as ErrorPayload; } catch { /* non-JSON error */ }
  const code = typeof payload.error?.code === "string" ? payload.error.code : undefined;
  const message = typeof payload.error?.message === "string" ? payload.error.message : `relay request failed (${response.status})`;
  return new RelayClientError(response.status, message, code);
}

function parseData(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

class SseDecoder {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;

  feed(chunk: string): RelayStreamEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.line(line.endsWith("\r") ? line.slice(0, -1) : line));
  }

  finish(): RelayStreamEvent[] {
    const events = this.buffer.length > 0 ? this.line(this.buffer) : [];
    return [...events, ...this.dispatch()];
  }

  private line(line: string): RelayStreamEvent[] {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return [];
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return [];
  }

  private dispatch(): RelayStreamEvent[] {
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

async function* responseChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function waitForReconnect(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      done();
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}


export class RelayBrowserClient {
  private readonly config: ClientConfig;

  constructor(transport: RelayTransport, options?: Omit<RelayBrowserClientOptions, "fetch">);
  constructor(options: RelayBrowserClientOptions);
  constructor(transportOrOptions: RelayTransport | RelayBrowserClientOptions, options?: Omit<RelayBrowserClientOptions, "fetch">) {
    const config = isOptions(transportOrOptions) ? transportOrOptions : { ...options, fetch: transportOrOptions };
    const transport = config.fetch ?? (isOptions(transportOrOptions) ? undefined : transportOrOptions);
    const token = config.token ?? (typeof transportOrOptions === "object" && transportOrOptions !== null && "token" in transportOrOptions && typeof transportOrOptions.token === "string" ? transportOrOptions.token : "");
    if (!token && transport === undefined) throw new TypeError("relay bearer token is required");
    this.config = {
      baseUrl: config.baseUrl ?? (typeof transportOrOptions === "object" && transportOrOptions !== null && "baseUrl" in transportOrOptions && typeof transportOrOptions.baseUrl === "string" ? transportOrOptions.baseUrl : "http://127.0.0.1:8787"),
      token,
      transport: resolveTransport(transport),
      retries: Math.max(0, config.retries ?? 1),
      reconnectDelayMs: Math.max(0, config.reconnectDelayMs ?? 250),
    };
  }

  async emit(type: string, version: number, payload: unknown, options: EmitOptions = {}): Promise<StoredEvent> {
    const idempotencyKey = options.idempotencyKey ?? randomIdempotencyKey();
    const body = JSON.stringify({ type, version, payload, idempotencyKey, ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }) });
    const response = await this.request("/v1/events", { method: "POST", body, signal: options.signal, headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey } }, this.config.retries);
    const value = await response.json() as { event?: StoredEvent };
    if (!value.event) throw new Error("relay acceptance response did not include an event");
    return value.event;
  }

  async get(eventId: string, signal?: AbortSignal): Promise<StoredEvent> {
    const response = await this.request(`/v1/events/${encodeURIComponent(eventId)}`, { method: "GET", signal });
    return await response.json() as StoredEvent;
  }

  async cancel(eventId: string, signal?: AbortSignal): Promise<StoredEvent> {
    const response = await this.request(`/v1/events/${encodeURIComponent(eventId)}/cancel`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: "{}" });
    return await response.json() as StoredEvent;
  }

  async *stream(options: StreamOptions = {}): AsyncIterable<RelayStreamEvent<UpdateRecord | { events: readonly StoredEvent[]; lastSequence: number } | unknown>> {
    let cursor = options.cursor === undefined ? undefined : String(options.cursor);
    let count = 0;
    const signal = options.signal;
    while (!signal?.aborted && (options.maxEvents === undefined || count < options.maxEvents)) {
      const url = new URL(toAbsoluteUrl(this.config.baseUrl, "/v1/stream"));
      if (options.eventId !== undefined) url.searchParams.set("eventId", options.eventId);
      let response: Response;
      try {
        response = await this.request(url.pathname + url.search, {
          method: "GET",
          signal,
          headers: { Accept: "text/event-stream", ...(cursor === undefined ? {} : { "Last-Event-ID": cursor }) },
        }, 0);
        if (!response.body) throw new Error("relay stream response has no body");
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("text/event-stream")) throw new Error("relay stream response is not text/event-stream");
        const decoder = new TextDecoder();
        const parser = new SseDecoder();
        for await (const chunk of responseChunks(response.body)) {
          for (const event of parser.feed(decoder.decode(chunk, { stream: true }))) {
            if (event.id !== undefined) cursor = event.id;
            yield event as RelayStreamEvent<UpdateRecord>;
            count += 1;
            if (options.maxEvents !== undefined && count >= options.maxEvents) return;
          }
        }
        for (const event of [...parser.feed(decoder.decode()), ...parser.finish()]) {
          if (event.id !== undefined) cursor = event.id;
          yield event as RelayStreamEvent<UpdateRecord>;
          count += 1;
          if (options.maxEvents !== undefined && count >= options.maxEvents) return;
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof RelayClientError) throw error;
      }
      if (signal?.aborted) return;
      await waitForReconnect(options.reconnectDelayMs ?? this.config.reconnectDelayMs, signal);
    }
  }
  private async request(path: string, init: RequestInit, retries = 0): Promise<Response> {
    const url = toAbsoluteUrl(this.config.baseUrl, path);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.config.token}`);
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.callTransport(url, { ...init, headers });
        if (!response.ok) throw await responseError(response);
        return response;
      } catch (error) {
        if (error instanceof RelayClientError || (init.signal?.aborted ?? false) || attempt === retries) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error("relay request failed");
  }

  private callTransport(input: string, init: RequestInit): Promise<Response> {
    const transport = this.config.transport;
    if (typeof transport === "function") return transport(input, init);
    if ("request" in transport) return transport.request(input, init);
    return transport.fetch(input, init);
  }
}
