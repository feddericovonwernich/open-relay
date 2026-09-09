import { createHash } from "node:crypto";
import { chmod, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Delivery, DeliveryAuthority, EffectEvidence, WorkerCapabilities } from "./protocol.ts";
import { HttpWorkerTransport, HttpWorkerTransportError } from "./http-worker-transport.ts";
import type { FailureEvidence } from "./store.ts";

export type AgentReplyAction =
  | "start"
  | "renew"
  | "progress"
  | "control"
  | "cancelled"
  | "complete"
  | "fail"
  | "effect-intent"
  | "effect-confirmation";

export interface AgentRuntime {
  port: number;
  token: string;
  pid?: number;
}

export interface PollAgentOptions {
  root: string;
  runtime: AgentRuntime;
  capabilities: WorkerCapabilities;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface ReplyAgentOptions {
  root: string;
  runtime: AgentRuntime;
  leaseId: string;
  action: AgentReplyAction;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

type LeaseAuthority = {
  version: 1;
  relayId: string;
  workerId: string;
  leaseId: string;
  eventId: string;
  token: string;
};

type Deadline = { type: "deadline" };
const deadlineReached: Deadline = { type: "deadline" };

function isDeadline(value: unknown): value is Deadline {
  return value === deadlineReached;
}
const DEFAULT_TIMEOUT_MS = 600_000;

function relayId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function safeError(error: unknown, secrets: readonly string[] = []): Error {
  if (error instanceof HttpWorkerTransportError) {
    return secrets.some((secret) => secret.length > 0 && error.message.includes(secret))
      ? new HttpWorkerTransportError(error.status)
      : error;
  }
  if (error instanceof Error && !secrets.some((secret) => secret.length > 0 && error.message.includes(secret))) return error;
  return new Error("agent session request failed");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortError(): Error {
  return new DOMException("operation aborted", "AbortError");
}

function leaseFile(root: string, leaseId: string): string {
  return join(root, ".relay", "agent-leases", `${Buffer.from(leaseId).toString("base64url")}.json`);
}

async function removeLease(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function ensureLeaseDirectory(root: string): string {
  const directory = join(root, ".relay", "agent-leases");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

async function readLease(path: string): Promise<LeaseAuthority> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
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
  return value as unknown as LeaseAuthority;
}

async function removeStaleLeases(directory: string, currentRelayId: string, workerId: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let activeLeaseId: string | undefined;
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const path = join(directory, name);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      await removeLease(path);
      return;
    }
    if (!isObject(value) || value.relayId !== currentRelayId) {
      await removeLease(path);
      return;
    }
    if (value.workerId === workerId && typeof value.leaseId === "string") activeLeaseId = value.leaseId;
  }));
  return activeLeaseId;
}

async function registration(
  runtime: AgentRuntime,
  capabilities: WorkerCapabilities,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<{ workerId: string; token: string }> {
  let response: Response;
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
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw safeError(error, [runtime.token]);
  }
  if (!response.ok) throw new HttpWorkerTransportError(response.status);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("worker registration returned invalid JSON");
  }
  if (!isObject(value) || value.workerId !== capabilities.workerId || typeof value.token !== "string" || value.token.length === 0) {
    throw new Error("worker registration returned invalid identity");
  }
  return { workerId: value.workerId, token: value.token };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T | Deadline> {
  if (signal?.aborted) throw abortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<Deadline>((resolve) => {
    timer = setTimeout(() => resolve(deadlineReached), timeoutMs);
  });
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout, abort]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

async function pollOnce(transport: HttpWorkerTransport, remainingMs: number, signal: AbortSignal | undefined, secrets: readonly string[]): Promise<Delivery | undefined | Deadline> {
  const controller = new AbortController();
  let onAbort: (() => void) | undefined;
  if (signal !== undefined) {
    onAbort = () => controller.abort();
    if (signal.aborted) throw abortError();
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const request = transport.poll(controller.signal).catch((error: unknown) => {
    if (signal?.aborted) throw abortError();
    throw safeError(error, secrets);
  });
  try {
    return await withDeadline(request, remainingMs, signal);
  } finally {
    controller.abort();
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}


export async function pollAgent(options: PollAgentOptions): Promise<Delivery | { type: "timeout" }> {
  if (options.capabilities.maxConcurrent !== 1) throw new Error("agent polling requires maxConcurrent to be 1");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("agent polling timeout must be a positive integer");
  const signal = options.signal;
  if (signal?.aborted) throw abortError();
  const fetchFn = options.fetch ?? globalThis.fetch;
  const currentRelayId = relayId(options.runtime.token);
  const directory = ensureLeaseDirectory(options.root);
  const activeLeaseId = await removeStaleLeases(directory, currentRelayId, options.capabilities.workerId);
  if (activeLeaseId !== undefined) throw new Error(`active delivery must be settled before polling: ${activeLeaseId}`);

  const deadline = Date.now() + timeoutMs;
  const registrationRemaining = deadline - Date.now();
  if (registrationRemaining <= 0) return { type: "timeout" };
  const registrationController = new AbortController();
  const abortRegistration = (): void => registrationController.abort();
  if (signal !== undefined) signal.addEventListener("abort", abortRegistration, { once: true });
  let registered: { workerId: string; token: string } | Deadline;
  try {
    registered = await withDeadline(registration(options.runtime, options.capabilities, fetchFn, registrationController.signal), registrationRemaining, signal);
  } finally {
    registrationController.abort();
    if (signal !== undefined) signal.removeEventListener("abort", abortRegistration);
  }
  if (isDeadline(registered)) return { type: "timeout" };
  const transport = new HttpWorkerTransport({ baseUrl: `http://127.0.0.1:${options.runtime.port}`, token: registered.token, fetch: fetchFn });

  while (true) {
    if (signal?.aborted) throw abortError();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { type: "timeout" };
    const result = await pollOnce(transport, remaining, signal, [options.runtime.token, registered.token]);
    if (isDeadline(result) || result === undefined) {
      if (Date.now() >= deadline) return { type: "timeout" };
      continue;
    }
    if (signal?.aborted) throw abortError();
    const authority: LeaseAuthority = {
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

export async function replyAgent(options: ReplyAgentOptions): Promise<unknown> {
  const path = leaseFile(options.root, options.leaseId);
  const authority = await readLease(path);
  if (authority.relayId !== relayId(options.runtime.token)) {
    await removeLease(path);
    throw new Error("lease authority expired; Relay recovery owns the event");
  }
  const transport = new HttpWorkerTransport({ baseUrl: `http://127.0.0.1:${options.runtime.port}`, token: authority.token, fetch: options.fetch });
  const deliveryAuthority: DeliveryAuthority = { workerId: authority.workerId, leaseId: authority.leaseId, eventId: authority.eventId };
  try {
    let result: unknown;
    if (options.action === "control") {
      result = { status: await transport.control(deliveryAuthority, options.signal ?? new AbortController().signal) };
    } else if (options.action === "start") {
      await transport.start(deliveryAuthority);
      result = { ok: true };
    } else {
      if (!isObject(options.body)) throw new Error("agent reply body must be a JSON object");
      const body = options.body;
      if (options.action === "renew") await transport.renew(deliveryAuthority, body.leaseExpiresAt as number | string);
      else if (options.action === "progress") await transport.progress(deliveryAuthority, body.data);
      else if (options.action === "cancelled") await transport.cancelled(deliveryAuthority, body.effects as readonly EffectEvidence[]);
      else if (options.action === "complete") await transport.complete(deliveryAuthority, body.result, body.effects as readonly EffectEvidence[]);
      else if (options.action === "fail") await transport.fail(deliveryAuthority, body as FailureEvidence);
      else if (options.action === "effect-intent") await transport.recordEffectIntent(deliveryAuthority, body.effectKey as string, body.idempotencyBoundaryConfirmed === true);
      else if (options.action === "effect-confirmation") await transport.confirmEffect(deliveryAuthority, body.effectKey as string, body.externalRef as string);
      else throw new Error("unknown agent reply action");
      result = { ok: true };
    }
    if (options.action === "complete" || options.action === "fail" || options.action === "cancelled") await removeLease(path);
    return result;
  } catch (error) {
    if (error instanceof HttpWorkerTransportError && (error.status === 401 || error.status === 409)) {
      await removeLease(path);
      throw new Error("lease authority expired; Relay recovery owns the event");
    }
    if (options.signal?.aborted) throw abortError();
    throw safeError(error, [options.runtime.token, authority.token]);
  }
}
