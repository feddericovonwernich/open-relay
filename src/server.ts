import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { AuthError, CredentialStore, type Principal, type Scope } from "./auth.ts";
import { Dispatcher, DispatcherError, type ProcessAdapterLike, type WorkerRegistration } from "./dispatcher.ts";
import { ProcessAdapter } from "./process-adapter.ts";
import { LeaseReaper } from "./reaper.ts";
import { RegistryError, Registry, loadRegistry } from "./registry.ts";
import type { EventDefinition, EffectEvidence, WorkerCapabilities } from "./protocol.ts";
import { streamUpdates, UpdateNotifier } from "./sse.ts";
import { StoreError, type Store } from "./store.ts";

export interface ServerOptions {
  store: Store;
  registry: Registry;
  credentials?: CredentialStore;
  dispatcher: Dispatcher;
  reaper?: LeaseReaper;
  processAdapter?: ProcessAdapterLike;
  projectRoot?: string;
  definitionsDir?: string;
  runtimePath?: string;
  adminToken?: string;
  allowedOrigins?: readonly string[];
  corsOrigins?: readonly string[];
  maxBodyBytes?: number;
  heartbeatMs?: number;
  pollTimeoutMs?: number;
  closeStore?: boolean;
}

type RelayErrorLike = { status: number; code: string; message: string };
type PrincipalWithToken = Principal & { token: string };

function errorStatus(code: string): number {
  if (code === "unauthorized" || code === "invalid_credential") return 401;
  if (code === "forbidden") return 403;
  if (code === "event_not_found" || code === "definition_not_found" || code === "revision_not_found" || code === "not_found") return 404;
  if (code === "idempotency_conflict" || code === "stale_delivery" || code === "invalid_state") return 409;
  if (code === "body_too_large") return 413;
  return 400;
}

function relayError(error: unknown): RelayErrorLike {
  if (error instanceof AuthError || error instanceof StoreError || error instanceof DispatcherError || error instanceof RegistryError) {
    return { status: errorStatus(error.code), code: error.code, message: error.message };
  }
  if (error instanceof SyntaxError) return { status: 400, code: "invalid_json", message: "request body must be valid JSON" };
  return { status: 500, code: "internal_error", message: "internal server error" };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StoreError("invalid_request", "request body must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new StoreError("invalid_request", `${field} is required`);
  return value;
}

function numberValue(value: unknown, field: string): number {
  const number = typeof value === "string" ? Date.parse(value) : Number(value);
  if (!Number.isFinite(number)) throw new StoreError("invalid_request", `${field} must be a number or date`);
  return number;
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value || !/^Bearer [^\s]+$/i.test(value)) throw new AuthError("unauthorized", "bearer credential is required");
  return value.slice(7);
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, child) => typeof child === "bigint" ? Number(child) : child);
}

export function createRelayServer(options: ServerOptions): Server {
  let registry = options.registry;
  const credentials = options.credentials ?? options.dispatcher.credentials;
  const adminToken = options.adminToken ?? credentials.issue("admin", "admin");
  if (options.adminToken) credentials.adopt(options.adminToken, "admin", "admin");
  const notifier = new UpdateNotifier();
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const allowedOrigins = new Set(options.allowedOrigins ?? options.corsOrigins ?? []);
  const runtimePath = options.runtimePath ?? join(options.projectRoot ?? process.cwd(), ".relay", "runtime.json");
  const controller = new AbortController();
  let started = false;
  let runtimeWritten = false;
  let loops: Promise<void>[] = [];

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => sendError(request, response, error));
  });

  function headers(request: IncomingMessage): Record<string, string> {
    const result: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      result["Access-Control-Allow-Origin"] = origin;
      result["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Idempotency-Key, Last-Event-ID";
      result["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      result.Vary = "Origin";
    }
    return result;
  }

  function send(request: IncomingMessage, response: ServerResponse, status: number, value: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, headers(request));
    response.end(serialize(value));
  }

  function sendError(request: IncomingMessage, response: ServerResponse, error: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    const failure = relayError(error);
    send(request, response, failure.status, { error: { code: failure.code, message: failure.message } });
  }

  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const length = Number(request.headers["content-length"] ?? 0);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBodyBytes) throw new StoreError("body_too_large", "request body exceeds configured limit");
      chunks.push(bytes);
    }
    if (size === 0) return {};
    return jsonObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }

  function authenticate(request: IncomingMessage, scope: Scope): PrincipalWithToken {
    const token = bearer(request);
    return { ...credentials.verify(token, scope), token };
  }

  function authenticateAdmin(request: IncomingMessage): PrincipalWithToken { return authenticate(request, "admin"); }

  function authenticateCancel(request: IncomingMessage): PrincipalWithToken {
    const token = bearer(request);
    try { return { ...credentials.verify(token, "admin"), token }; }
    catch (error) {
      if (!(error instanceof AuthError) || error.code !== "forbidden") throw error;
      return { ...credentials.verify(token, "producer"), token };
    }
  }

  function worker(request: IncomingMessage): { principal: PrincipalWithToken; registration: WorkerRegistration } {
    const token = bearer(request);
    const principal = { ...credentials.verify(token, "worker"), token };
    const registration = options.dispatcher.registrationFor(token);
    if (registration.workerId !== principal.subjectId) throw new AuthError("forbidden", "worker identity does not match registration");
    return { principal, registration };
  }

  function wake(): void { notifier.wake(0); }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const parsed = new URL(request.url ?? "/", "http://relay.local");
    if (method === "OPTIONS") {
      const origin = request.headers.origin;
      if (origin && allowedOrigins.has(origin)) {
        response.writeHead(204, headers(request));
        response.end();
      } else send(request, response, 403, { error: { code: "cors_forbidden", message: "origin is not allowed" } });
      return;
    }
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin) && allowedOrigins.size > 0) {
      send(request, response, 403, { error: { code: "cors_forbidden", message: "origin is not allowed" } });
      return;
    }

    const path = parsed.pathname;
    if (method === "POST" && path === "/v1/events") {
      const principal = authenticate(request, "producer");
      const input = await body(request);
      const type = requiredString(input.type, "type");
      const version = Number(input.version);
      if (!Number.isInteger(version)) throw new StoreError("invalid_request", "version must be an integer");
      const idempotencyKey = requiredString(input.idempotencyKey ?? request.headers["idempotency-key"], "idempotencyKey");
      const revision = registry.resolve(type, version);
      const result = options.store.accept({ producerId: principal.subjectId, idempotencyKey, payload: input.payload, revision, ...(typeof input.correlationId === "string" ? { correlationId: input.correlationId } : {}) });
      wake();
      send(request, response, result.created ? 201 : 200, result);
      return;
    }

    const eventMatch = /^\/v1\/events\/([^/]+)$/.exec(path);
    if (method === "GET" && eventMatch) {
      authenticate(request, "observer");
      const event = options.store.getEvent(decodeURIComponent(eventMatch[1]));
      if (!event) throw new StoreError("event_not_found", "event not found");
      send(request, response, 200, event);
      return;
    }

    const cancelMatch = /^\/v1\/events\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) {
      const principal = authenticateCancel(request);
      const eventId = decodeURIComponent(cancelMatch[1]);
      const event = options.store.getEvent(eventId);
      if (!event) throw new StoreError("event_not_found", "event not found");
      if (principal.scope === "producer" && event.producerId !== principal.subjectId) throw new AuthError("forbidden", "producer does not own event");
      const result = options.dispatcher.requestCancel(eventId);
      wake();
      send(request, response, 200, result);
      return;
    }

    if (method === "GET" && path === "/v1/stream") {
      authenticate(request, "observer");
      const cursorRaw = parsed.searchParams.get("cursor") ?? request.headers["last-event-id"];
      const cursor = cursorRaw === undefined ? undefined : Number(cursorRaw);
      if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) throw new StoreError("invalid_request", "cursor must be a non-negative integer");
      const eventId = parsed.searchParams.get("eventId") ?? undefined;
      response.writeHead(200, { ...headers(request), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const abort = new AbortController();
      request.on("aborted", () => abort.abort());
      response.on("close", () => abort.abort());
      for await (const frame of streamUpdates(options.store, notifier, { cursor, eventId, heartbeatMs: options.heartbeatMs, signal: abort.signal })) {
        if (response.writableEnded) break;
        if (frame.id !== undefined) response.write(`id: ${frame.id}\n`);
        response.write(`event: ${frame.event}\n`);
        response.write(`data: ${serialize(frame.data ?? {})}\n\n`);
      }
      if (!response.writableEnded) response.end();
      return;
    }

    if (method === "POST" && path === "/v1/workers/register") {
      authenticateAdmin(request);
      const input = await body(request);
      const capabilities: WorkerCapabilities = {
        workerId: requiredString(input.workerId, "workerId"),
        allowedDefinitions: Array.isArray(input.allowedDefinitions) ? input.allowedDefinitions.filter((value): value is string => typeof value === "string") : [],
        tools: Array.isArray(input.tools) ? input.tools.filter((value): value is string => typeof value === "string") : [],
        structuredOutput: input.structuredOutput === true,
        contextTokens: Number(input.contextTokens),
        systemReserveTokens: Number(input.systemReserveTokens),
        maxConcurrent: Number(input.maxConcurrent),
      };
      const registration = options.dispatcher.registerWorker(capabilities);
      send(request, response, 201, registration);
      return;
    }

    if (method === "POST" && path === "/v1/credentials") {
      authenticateAdmin(request);
      const input = await body(request);
      const scope = input.scope;
      if (scope !== "producer" && scope !== "observer" && scope !== "worker") throw new StoreError("invalid_request", "scope must be producer, observer, or worker");
      const token = credentials.issue(scope, requiredString(input.subjectId, "subjectId"), Array.isArray(input.grants) ? input.grants.filter((value): value is string => typeof value === "string") : []);
      send(request, response, 201, { scope, subjectId: input.subjectId, token });
      return;
    }

    if (method === "POST" && path === "/v1/agent/poll") {
      const { registration } = worker(request);
      const signal = requestSignal(request);
      const delivery = await options.dispatcher.poll(registration, signal);
      if (!response.writableEnded) send(request, response, 200, delivery ?? null);
      return;
    }

    const leaseMatch = /^\/v1\/deliveries\/([^/]+)\/(start|renew|progress|control|cancelled|complete|fail)$/.exec(path);
    if (leaseMatch) {
      const leaseId = decodeURIComponent(leaseMatch[1]);
      const action = leaseMatch[2];
      const { registration } = worker(request);
      if (action === "control" && method === "GET") {
        const result = await options.dispatcher.control(registration, leaseId, requestSignal(request));
        if (!response.writableEnded) send(request, response, 200, { status: result });
        return;
      }
      if (method !== "POST") throw new StoreError("not_found", "route not found");
      const input = await body(request);
      const authority = { workerId: registration.workerId, leaseId };
      if (action === "start") options.dispatcher.start(registration, authority);
      else if (action === "renew") options.dispatcher.renew(registration, authority, numberValue(input.leaseExpiresAt, "leaseExpiresAt"));
      else if (action === "progress") options.dispatcher.progress(registration, authority, input.data);
      else if (action === "cancelled") options.dispatcher.acknowledgeCancel(registration, authority, Array.isArray(input.effects) ? input.effects as EffectEvidence[] : []);
      else if (action === "complete") options.dispatcher.complete(registration, authority, input.result, Array.isArray(input.effects) ? input.effects as EffectEvidence[] : []);
      else if (action === "fail") options.dispatcher.fail(registration, authority, input as { code: string });
      else throw new StoreError("not_found", "route not found");
      wake();
      send(request, response, 200, { ok: true });
      return;
    }

    const recoveryMatch = /^\/v1\/recovery\/([^/]+)\/resolve$/.exec(path);
    if (method === "POST" && recoveryMatch) {
      authenticateAdmin(request);
      const input = await body(request);
      const result = options.store.resolveRecovery(decodeURIComponent(recoveryMatch[1]), { ...input, admin: true, evidence: input.evidence });
      wake();
      send(request, response, 200, result);
      return;
    }

    if (method === "POST" && path === "/v1/admin/reload") {
      authenticateAdmin(request);
      if (!options.projectRoot || !options.definitionsDir) throw new StoreError("reload_unconfigured", "registry reload is not configured");
      const next = loadRegistry(options.projectRoot, options.definitionsDir, registry);
      options.store.installRevisions(next.revisions());
      registry = next;
      send(request, response, 200, { revisions: next.revisions().map((revision) => ({ type: revision.definition.type, version: revision.definition.version, digest: revision.digest })) });
      return;
    }

    throw new StoreError("not_found", "route not found");
  }

  function requestSignal(request: IncomingMessage): AbortSignal {
    const requestController = new AbortController();
    const timer = setTimeout(() => requestController.abort(), options.pollTimeoutMs ?? 30_000);
    const abort = (): void => {
      clearTimeout(timer);
      requestController.abort();
    };
    request.on("aborted", abort);
    requestController.signal.addEventListener("abort", () => {
      request.removeListener("aborted", abort);
    }, { once: true });
    return requestController.signal;
  }

  function writeRuntime(): void {
    mkdirSync(dirname(runtimePath), { recursive: true, mode: 0o700 });
    writeFileSync(runtimePath, `${JSON.stringify({ port: (server.address() as { port: number }).port, token: adminToken })}\n`, { mode: 0o600 });
    chmodSync(runtimePath, 0o600);
    runtimeWritten = true;
  }

  server.once("listening", () => {
    if (started) return;
    writeRuntime();
    const reaper = options.reaper ?? new LeaseReaper(options.store, () => options.dispatcher.notifyWork());
    loops = [reaper.start(controller.signal)];
    if (options.processAdapter) loops.push(options.dispatcher.runProcessLoop(options.processAdapter, controller.signal));
  });

  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    controller.abort();
    close(() => {
      void Promise.allSettled(loops).then(async () => {
        if (runtimeWritten) { await unlink(runtimePath).catch(() => undefined); runtimeWritten = false; }
        if (options.closeStore !== false) options.store.close();
        callback?.();
      });
    });
    return server;
  }) as typeof server.close;

  Object.defineProperties(server, { adminToken: { value: adminToken }, credentials: { value: credentials }, notifier: { value: notifier } });
  return server;
}

export type RelayServer = Server & { readonly adminToken: string; readonly credentials: CredentialStore; readonly notifier: UpdateNotifier };
export { ProcessAdapter };
