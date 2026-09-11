import { createServer } from "node:http";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { AuthError, CredentialStore } from "./auth.js";
import { Dispatcher, DispatcherError } from "./dispatcher.js";
import { ProcessAdapter } from "./process-adapter.js";
import { LeaseReaper } from "./reaper.js";
import { RegistryError, Registry, loadRegistry } from "./registry.js";
import { streamUpdates, UpdateNotifier } from "./sse.js";
import { StoreError } from "./store.js";
function errorStatus(code) {
    if (code === "unauthorized" || code === "invalid_credential")
        return 401;
    if (code === "forbidden")
        return 403;
    if (code === "event_not_found" || code === "definition_not_found" || code === "revision_not_found" || code === "not_found")
        return 404;
    if (code === "idempotency_conflict" || code === "stale_delivery" || code === "invalid_state")
        return 409;
    if (code === "body_too_large")
        return 413;
    return 400;
}
function relayError(error) {
    if (error instanceof AuthError || error instanceof StoreError || error instanceof DispatcherError || error instanceof RegistryError) {
        return { status: errorStatus(error.code), code: error.code, message: error.message };
    }
    if (error instanceof SyntaxError)
        return { status: 400, code: "invalid_json", message: "request body must be valid JSON" };
    return { status: 500, code: "internal_error", message: "internal server error" };
}
function jsonObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new StoreError("invalid_request", "request body must be an object");
    return value;
}
function requiredString(value, field) {
    if (typeof value !== "string" || value.length === 0)
        throw new StoreError("invalid_request", `${field} is required`);
    return value;
}
function numberValue(value, field) {
    const number = typeof value === "string" ? Date.parse(value) : Number(value);
    if (!Number.isFinite(number))
        throw new StoreError("invalid_request", `${field} must be a number or date`);
    return number;
}
function bearer(request) {
    const value = request.headers.authorization;
    if (!value || !/^Bearer [^\s]+$/i.test(value))
        throw new AuthError("unauthorized", "bearer credential is required");
    return value.slice(7);
}
function serialize(value) {
    return JSON.stringify(value, (_key, child) => typeof child === "bigint" ? Number(child) : child);
}
export function createRelayServer(options) {
    let registry = options.registry;
    const credentials = options.credentials ?? options.dispatcher.credentials;
    const adminToken = options.adminToken ?? credentials.issue("admin", "admin");
    if (options.adminToken)
        credentials.adopt(options.adminToken, "admin", "admin");
    const notifier = new UpdateNotifier();
    const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    const allowedOrigins = new Set(options.allowedOrigins ?? options.corsOrigins ?? []);
    const runtimePath = options.runtimePath ?? join(options.projectRoot ?? process.cwd(), ".relay", "runtime.json");
    const controller = new AbortController();
    let loops = [];
    let started = false;
    let runtimeWritten = false;
    const streams = new Set();
    const requests = new Set();
    const server = createServer((request, response) => {
        void handle(request, response).catch((error) => sendError(request, response, error));
    });
    function headers(request) {
        const result = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
        const origin = request.headers.origin;
        if (origin && allowedOrigins.has(origin)) {
            result["Access-Control-Allow-Origin"] = origin;
            result["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Idempotency-Key, Last-Event-ID";
            result["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
            result.Vary = "Origin";
        }
        return result;
    }
    function send(request, response, status, value) {
        if (response.writableEnded || response.destroyed)
            return;
        response.writeHead(status, headers(request));
        response.end(serialize(value));
    }
    function sendError(request, response, error) {
        if (response.writableEnded || response.destroyed)
            return;
        const failure = relayError(error);
        send(request, response, failure.status, { error: { code: failure.code, message: failure.message } });
    }
    async function body(request) {
        const length = Number(request.headers["content-length"] ?? 0);
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > maxBodyBytes)
                throw new StoreError("body_too_large", "request body exceeds configured limit");
            chunks.push(bytes);
        }
        if (size === 0)
            return {};
        return jsonObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    function authenticate(request, scope) {
        const token = bearer(request);
        return { ...credentials.verify(token, scope), token };
    }
    function authenticateAdmin(request) { return authenticate(request, "admin"); }
    function authenticateCancel(request) {
        const token = bearer(request);
        try {
            return { ...credentials.verify(token, "admin"), token };
        }
        catch (error) {
            if (!(error instanceof AuthError) || error.code !== "forbidden")
                throw error;
            return { ...credentials.verify(token, "producer"), token };
        }
    }
    function worker(request) {
        const token = bearer(request);
        const principal = { ...credentials.verify(token, "worker"), token };
        const registration = options.dispatcher.registrationFor(token);
        if (registration.workerId !== principal.subjectId)
            throw new AuthError("forbidden", "worker identity does not match registration");
        return { principal, registration };
    }
    function wake() { notifier.wake(0); }
    async function handle(request, response) {
        const method = request.method ?? "GET";
        const parsed = new URL(request.url ?? "/", "http://relay.local");
        if (method === "OPTIONS") {
            const origin = request.headers.origin;
            if (origin && allowedOrigins.has(origin)) {
                response.writeHead(204, headers(request));
                response.end();
            }
            else
                send(request, response, 403, { error: { code: "cors_forbidden", message: "origin is not allowed" } });
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
            if (!Number.isInteger(version))
                throw new StoreError("invalid_request", "version must be an integer");
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
            if (!event)
                throw new StoreError("event_not_found", "event not found");
            send(request, response, 200, event);
            return;
        }
        const cancelMatch = /^\/v1\/events\/([^/]+)\/cancel$/.exec(path);
        if (method === "POST" && cancelMatch) {
            const principal = authenticateCancel(request);
            const eventId = decodeURIComponent(cancelMatch[1]);
            const event = options.store.getEvent(eventId);
            if (!event)
                throw new StoreError("event_not_found", "event not found");
            if (principal.scope === "producer" && event.producerId !== principal.subjectId)
                throw new AuthError("forbidden", "producer does not own event");
            const result = options.dispatcher.requestCancel(eventId);
            wake();
            send(request, response, 200, result);
            return;
        }
        if (method === "GET" && path === "/v1/stream") {
            authenticate(request, "observer");
            const cursorRaw = parsed.searchParams.get("cursor") ?? request.headers["last-event-id"];
            const cursor = cursorRaw === undefined ? undefined : Number(cursorRaw);
            if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0))
                throw new StoreError("invalid_request", "cursor must be a non-negative integer");
            const eventId = parsed.searchParams.get("eventId") ?? undefined;
            response.writeHead(200, { ...headers(request), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
            const abort = new AbortController();
            streams.add(abort);
            request.on("aborted", () => abort.abort());
            response.on("close", () => abort.abort());
            try {
                for await (const frame of streamUpdates(options.store, notifier, { cursor, eventId, heartbeatMs: options.heartbeatMs, signal: abort.signal })) {
                    if (response.writableEnded)
                        break;
                    if (frame.id !== undefined)
                        response.write(`id: ${frame.id}\n`);
                    response.write(`event: ${frame.event}\n`);
                    response.write(`data: ${serialize(frame.data ?? {})}\n\n`);
                }
                if (!response.writableEnded)
                    response.end();
            }
            finally {
                streams.delete(abort);
            }
            return;
        }
        if (method === "POST" && path === "/v1/workers/register") {
            authenticateAdmin(request);
            const input = await body(request);
            const correlationId = input.correlationId;
            if (correlationId !== undefined && (typeof correlationId !== "string" || correlationId.length === 0)) {
                throw new StoreError("invalid_request", "correlationId must be a non-empty string");
            }
            const capabilities = {
                workerId: requiredString(input.workerId, "workerId"),
                allowedDefinitions: Array.isArray(input.allowedDefinitions) ? input.allowedDefinitions.filter((value) => typeof value === "string") : [],
                tools: Array.isArray(input.tools) ? input.tools.filter((value) => typeof value === "string") : [],
                structuredOutput: input.structuredOutput === true,
                contextTokens: Number(input.contextTokens),
                systemReserveTokens: Number(input.systemReserveTokens),
                maxConcurrent: Number(input.maxConcurrent),
                ...(correlationId === undefined ? {} : { correlationId }),
            };
            const registration = options.dispatcher.registerWorker(capabilities);
            send(request, response, 201, registration);
            return;
        }
        if (method === "POST" && path === "/v1/credentials") {
            authenticateAdmin(request);
            const input = await body(request);
            const scope = input.scope;
            if (scope !== "producer" && scope !== "observer" && scope !== "worker")
                throw new StoreError("invalid_request", "scope must be producer, observer, or worker");
            const token = credentials.issue(scope, requiredString(input.subjectId, "subjectId"), Array.isArray(input.grants) ? input.grants.filter((value) => typeof value === "string") : []);
            send(request, response, 201, { scope, subjectId: input.subjectId, token });
            return;
        }
        if (method === "POST" && path === "/v1/agent/poll") {
            const { registration } = worker(request);
            const signal = requestSignal(request, response);
            const delivery = await options.dispatcher.poll(registration, signal);
            if (!response.writableEnded)
                send(request, response, 200, delivery ?? null);
            return;
        }
        const leaseMatch = /^\/v1\/deliveries\/([^/]+)\/(start|renew|progress|control|cancelled|complete|fail|effect-intent|effect-confirmation)$/.exec(path);
        if (leaseMatch) {
            const leaseId = decodeURIComponent(leaseMatch[1]);
            const action = leaseMatch[2];
            const { registration } = worker(request);
            if (action === "control" && method === "GET") {
                const result = await options.dispatcher.control(registration, leaseId, requestSignal(request, response));
                if (!response.writableEnded)
                    send(request, response, 200, { status: result });
                return;
            }
            if (method !== "POST")
                throw new StoreError("not_found", "route not found");
            const input = await body(request);
            const authority = { workerId: registration.workerId, leaseId };
            if (action === "start")
                options.dispatcher.start(registration, authority);
            else if (action === "renew")
                options.dispatcher.renew(registration, authority, numberValue(input.leaseExpiresAt, "leaseExpiresAt"));
            else if (action === "progress")
                options.dispatcher.progress(registration, authority, input.data);
            else if (action === "cancelled")
                options.dispatcher.acknowledgeCancel(registration, authority, Array.isArray(input.effects) ? input.effects : []);
            else if (action === "complete")
                options.dispatcher.complete(registration, authority, input.result, Array.isArray(input.effects) ? input.effects : []);
            else if (action === "effect-intent")
                options.dispatcher.recordEffectIntent(registration, authority, requiredString(input.effectKey, "effectKey"), input.idempotencyBoundaryConfirmed === true);
            else if (action === "effect-confirmation")
                options.dispatcher.confirmEffect(registration, authority, requiredString(input.effectKey, "effectKey"), requiredString(input.externalRef, "externalRef"));
            else if (action === "fail") {
                const code = requiredString(input.code, "code");
                options.dispatcher.fail(registration, authority, { ...input, code });
            }
            else
                throw new StoreError("not_found", "route not found");
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
            if (!options.projectRoot || !options.definitionsDir)
                throw new StoreError("reload_unconfigured", "registry reload is not configured");
            const next = loadRegistry(options.projectRoot, options.definitionsDir, registry);
            options.store.installRevisions(next.revisions());
            registry = next;
            send(request, response, 200, { revisions: next.revisions().map((revision) => ({ type: revision.definition.type, version: revision.definition.version, digest: revision.digest })) });
            return;
        }
        throw new StoreError("not_found", "route not found");
    }
    function requestSignal(request, response) {
        const requestController = new AbortController();
        requests.add(requestController);
        const timer = setTimeout(() => requestController.abort(), options.pollTimeoutMs ?? 30_000);
        const abort = () => {
            clearTimeout(timer);
            requestController.abort();
        };
        request.on("aborted", abort);
        response.once("finish", abort);
        response.once("close", abort);
        requestController.signal.addEventListener("abort", () => {
            requests.delete(requestController);
            request.removeListener("aborted", abort);
            response.removeListener("finish", abort);
            response.removeListener("close", abort);
        }, { once: true });
        return requestController.signal;
    }
    function writeRuntime() {
        mkdirSync(dirname(runtimePath), { recursive: true, mode: 0o700 });
        writeFileSync(runtimePath, `${JSON.stringify({ port: server.address().port, token: adminToken })}\n`, { mode: 0o600 });
        chmodSync(runtimePath, 0o600);
        runtimeWritten = true;
    }
    server.once("listening", () => {
        if (started)
            return;
        writeRuntime();
        const reaper = options.reaper ?? new LeaseReaper(options.store, () => options.dispatcher.notifyWork());
        loops = [reaper.start(controller.signal)];
        if (options.processAdapter)
            loops.push(options.dispatcher.runProcessLoop(options.processAdapter, controller.signal));
    });
    const nativeListen = server.listen.bind(server);
    server.listen = ((...args) => {
        const first = args[0];
        if (typeof first === "object" && first !== null) {
            const listenOptions = first;
            if (typeof listenOptions.port !== "number")
                throw new Error("loopback HTTP server requires a numeric port");
            const host = listenOptions.host;
            if (host !== undefined && host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
                throw new Error("relay server must bind to loopback");
            if (host === undefined)
                listenOptions.host = "127.0.0.1";
        }
        else {
            if (typeof first !== "number")
                throw new Error("loopback HTTP server requires a numeric port");
            const hostIndex = args.findIndex((value, index) => index > 0 && typeof value === "string");
            if (hostIndex >= 0 && args[hostIndex] !== "127.0.0.1" && args[hostIndex] !== "localhost" && args[hostIndex] !== "::1")
                throw new Error("relay server must bind to loopback");
            if (hostIndex < 0)
                args.splice(1, 0, "127.0.0.1");
        }
        return nativeListen(...args);
    });
    const close = server.close.bind(server);
    server.close = ((callback) => {
        controller.abort();
        for (const stream of streams)
            stream.abort();
        for (const request of requests)
            request.abort();
        close(() => {
            void Promise.allSettled(loops).then(async () => {
                if (runtimeWritten) {
                    await unlink(runtimePath).catch(() => undefined);
                    runtimeWritten = false;
                }
                if (options.closeStore !== false)
                    options.store.close();
                callback?.();
            });
        });
        return server;
    });
    Object.defineProperties(server, { adminToken: { value: adminToken }, credentials: { value: credentials }, notifier: { value: notifier } });
    return server;
}
export { ProcessAdapter };
