import { createHash } from "node:crypto";
import { chmod, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HttpWorkerTransport, HttpWorkerTransportError } from "./http-worker-transport.js";
const deadlineReached = { type: "deadline" };
function isDeadline(value) {
    return value === deadlineReached;
}
const DEFAULT_TIMEOUT_MS = 600_000;
function relayId(token) {
    return createHash("sha256").update(token).digest("hex");
}
function safeError(error, secrets = []) {
    if (error instanceof HttpWorkerTransportError) {
        return secrets.some((secret) => secret.length > 0 && error.message.includes(secret))
            ? new HttpWorkerTransportError(error.status)
            : error;
    }
    if (error instanceof Error && !secrets.some((secret) => secret.length > 0 && error.message.includes(secret)))
        return error;
    return new Error("agent session request failed");
}
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function abortError() {
    return new DOMException("operation aborted", "AbortError");
}
function leaseFile(root, leaseId) {
    return join(root, ".relay", "agent-leases", `${Buffer.from(leaseId).toString("base64url")}.json`);
}
async function removeLease(path) {
    try {
        await unlink(path);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
function ensureLeaseDirectory(root) {
    const directory = join(root, ".relay", "agent-leases");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return directory;
}
async function readLease(path) {
    let value;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        throw new Error("lease authority is unavailable");
    }
    if (!isObject(value)
        || value.version !== 1
        || typeof value.relayId !== "string"
        || typeof value.workerId !== "string"
        || typeof value.leaseId !== "string"
        || typeof value.eventId !== "string"
        || typeof value.token !== "string"
        || value.token.length === 0) {
        throw new Error("lease authority is invalid");
    }
    return value;
}
async function removeStaleLeases(directory, currentRelayId, workerId) {
    let names;
    try {
        names = await readdir(directory);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    let activeLeaseId;
    await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
        const path = join(directory, name);
        let value;
        try {
            value = JSON.parse(await readFile(path, "utf8"));
        }
        catch {
            await removeLease(path);
            return;
        }
        if (!isObject(value) || value.relayId !== currentRelayId) {
            await removeLease(path);
            return;
        }
        if (value.workerId === workerId && typeof value.leaseId === "string")
            activeLeaseId = value.leaseId;
    }));
    return activeLeaseId;
}
async function registration(runtime, capabilities, fetchFn, signal) {
    let response;
    try {
        response = await fetchFn(`http://127.0.0.1:${runtime.port}/v1/workers/register`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${runtime.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(capabilities),
            signal,
        });
    }
    catch (error) {
        if (signal?.aborted)
            throw abortError();
        throw safeError(error, [runtime.token]);
    }
    if (!response.ok)
        throw new HttpWorkerTransportError(response.status);
    let value;
    try {
        value = await response.json();
    }
    catch {
        throw new Error("worker registration returned invalid JSON");
    }
    if (!isObject(value) || value.workerId !== capabilities.workerId || typeof value.token !== "string" || value.token.length === 0) {
        throw new Error("worker registration returned invalid identity");
    }
    return { workerId: value.workerId, token: value.token };
}
async function withDeadline(promise, timeoutMs, signal) {
    if (signal?.aborted)
        throw abortError();
    let timer;
    let onAbort;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(deadlineReached), timeoutMs);
    });
    const abort = new Promise((_resolve, reject) => {
        onAbort = () => reject(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([promise, timeout, abort]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        if (signal !== undefined && onAbort !== undefined)
            signal.removeEventListener("abort", onAbort);
    }
}
async function pollOnce(transport, remainingMs, signal, secrets) {
    const controller = new AbortController();
    let onAbort;
    if (signal !== undefined) {
        onAbort = () => controller.abort();
        if (signal.aborted)
            throw abortError();
        signal.addEventListener("abort", onAbort, { once: true });
    }
    const request = transport.poll(controller.signal).catch((error) => {
        if (signal?.aborted)
            throw abortError();
        throw safeError(error, secrets);
    });
    try {
        return await withDeadline(request, remainingMs, signal);
    }
    finally {
        controller.abort();
        if (signal !== undefined && onAbort !== undefined)
            signal.removeEventListener("abort", onAbort);
    }
}
export async function pollAgent(options) {
    if (options.capabilities.maxConcurrent !== 1)
        throw new Error("agent polling requires maxConcurrent to be 1");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
        throw new Error("agent polling timeout must be a positive integer");
    const signal = options.signal;
    if (signal?.aborted)
        throw abortError();
    const fetchFn = options.fetch ?? globalThis.fetch;
    const currentRelayId = relayId(options.runtime.token);
    const directory = ensureLeaseDirectory(options.root);
    const activeLeaseId = await removeStaleLeases(directory, currentRelayId, options.capabilities.workerId);
    if (activeLeaseId !== undefined)
        throw new Error(`active delivery must be settled before polling: ${activeLeaseId}`);
    const deadline = Date.now() + timeoutMs;
    const registrationRemaining = deadline - Date.now();
    if (registrationRemaining <= 0)
        return { type: "timeout" };
    const registrationController = new AbortController();
    const abortRegistration = () => registrationController.abort();
    if (signal !== undefined)
        signal.addEventListener("abort", abortRegistration, { once: true });
    let registered;
    try {
        registered = await withDeadline(registration(options.runtime, options.capabilities, fetchFn, registrationController.signal), registrationRemaining, signal);
    }
    finally {
        registrationController.abort();
        if (signal !== undefined)
            signal.removeEventListener("abort", abortRegistration);
    }
    if (isDeadline(registered))
        return { type: "timeout" };
    const transport = new HttpWorkerTransport({ baseUrl: `http://127.0.0.1:${options.runtime.port}`, token: registered.token, fetch: fetchFn });
    while (true) {
        if (signal?.aborted)
            throw abortError();
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            return { type: "timeout" };
        const result = await pollOnce(transport, remaining, signal, [options.runtime.token, registered.token]);
        if (isDeadline(result) || result === undefined) {
            if (Date.now() >= deadline)
                return { type: "timeout" };
            continue;
        }
        if (signal?.aborted)
            throw abortError();
        const authority = {
            version: 1,
            relayId: currentRelayId,
            workerId: result.workerId,
            leaseId: result.leaseId,
            eventId: result.event.id,
            token: registered.token,
        };
        await writeFile(leaseFile(options.root, authority.leaseId), JSON.stringify(authority), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(leaseFile(options.root, authority.leaseId), 0o600);
        return result;
    }
}
export async function replyAgent(options) {
    const path = leaseFile(options.root, options.leaseId);
    const authority = await readLease(path);
    if (authority.relayId !== relayId(options.runtime.token)) {
        await removeLease(path);
        throw new Error("lease authority expired; Relay recovery owns the event");
    }
    const transport = new HttpWorkerTransport({ baseUrl: `http://127.0.0.1:${options.runtime.port}`, token: authority.token, fetch: options.fetch });
    const deliveryAuthority = { workerId: authority.workerId, leaseId: authority.leaseId, eventId: authority.eventId };
    try {
        let result;
        if (options.action === "control") {
            result = { status: await transport.control(deliveryAuthority, options.signal ?? new AbortController().signal) };
        }
        else if (options.action === "start") {
            await transport.start(deliveryAuthority);
            result = { ok: true };
        }
        else {
            if (!isObject(options.body))
                throw new Error("agent reply body must be a JSON object");
            const body = options.body;
            if (options.action === "renew")
                await transport.renew(deliveryAuthority, body.leaseExpiresAt);
            else if (options.action === "progress")
                await transport.progress(deliveryAuthority, body.data);
            else if (options.action === "cancelled")
                await transport.cancelled(deliveryAuthority, body.effects);
            else if (options.action === "complete")
                await transport.complete(deliveryAuthority, body.result, body.effects);
            else if (options.action === "fail")
                await transport.fail(deliveryAuthority, body);
            else if (options.action === "effect-intent")
                await transport.recordEffectIntent(deliveryAuthority, body.effectKey, body.idempotencyBoundaryConfirmed === true);
            else if (options.action === "effect-confirmation")
                await transport.confirmEffect(deliveryAuthority, body.effectKey, body.externalRef);
            else
                throw new Error("unknown agent reply action");
            result = { ok: true };
        }
        if (options.action === "complete" || options.action === "fail" || options.action === "cancelled")
            await removeLease(path);
        return result;
    }
    catch (error) {
        if (error instanceof HttpWorkerTransportError && (error.status === 401 || error.status === 409)) {
            await removeLease(path);
            throw new Error("lease authority expired; Relay recovery owns the event");
        }
        if (options.signal?.aborted)
            throw abortError();
        throw safeError(error, [options.runtime.token, authority.token]);
    }
}
