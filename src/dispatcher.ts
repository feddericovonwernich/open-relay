import { AuthError, CredentialStore, type Principal } from "./auth.ts";
import type { ProcessMessage, ProcessOutcome } from "./process-adapter.ts";
import type { Delivery, EventDefinition, WorkerCapabilities } from "./protocol.ts";
import type { DefinitionRevision } from "./registry.ts";
import type { DeliveryAuthority, EffectEvidence, FailureEvidence, Store, StoredEvent } from "./store.ts";

export interface WorkerRegistration {
  readonly workerId: string;
  readonly capabilities: WorkerCapabilities;
  readonly token: string;
  readonly credential: string;
  readonly allowedDefinitions: readonly string[];
  readonly tools: readonly string[];
  readonly structuredOutput: boolean;
  readonly contextTokens: number;
  readonly systemReserveTokens: number;
  readonly maxConcurrent: number;
}

export interface DispatcherOptions {
  now?: (() => number) | { now(): number };
  pollTimeoutMs?: number;
  processConcurrency?: number;
}

export interface ProcessAdapterLike {
  run(
    delivery: Delivery,
    revision: DefinitionRevision,
    signal: AbortSignal,
    hooks?: { onMessage?(message: Exclude<ProcessMessage, { type: "complete" | "fail" | "cancelled" }>): void | Promise<void> },
  ): Promise<ProcessOutcome>;
}

export function definitionAllowed(allowedDefinitions: readonly string[], type: string, version: number): boolean {
  const name = `${type}@${version}`;
  return allowedDefinitions.some((entry) => entry === "*" || entry === name || (entry.endsWith(".*") && type.startsWith(entry.slice(0, -1))));
}

export function matches(definition: EventDefinition, worker: WorkerCapabilities, activeDeliveries: number): boolean {
  const requiredContext = Math.max(definition.requires.minContextTokens, worker.systemReserveTokens + definition.requires.maxInputTokens + definition.requires.maxOutputTokens);
  return definition.handler.kind === "agent"
    && definitionAllowed(worker.allowedDefinitions, definition.type, definition.version)
    && activeDeliveries < worker.maxConcurrent
    && definition.requires.tools.every((tool) => worker.tools.includes(tool))
    && (!definition.requires.structuredOutput || worker.structuredOutput)
    && worker.contextTokens >= requiredContext;
}

class DispatcherError extends Error {
  readonly code: "forbidden" | "invalid_registration";
  constructor(code: "forbidden" | "invalid_registration", message: string) {
    super(message);
    this.name = "DispatcherError";
    this.code = code;
  }
}

type Waiter = { resolve: () => void; timer?: ReturnType<typeof setTimeout> };
type Clock = (() => number) | { now(): number };
function readNow(clock: Clock): number { return typeof clock === "function" ? clock() : clock.now(); }

export class Dispatcher {
  private readonly registrations = new Map<string, WorkerRegistration>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly now: () => number;
  private readonly pollTimeoutMs: number;
  private readonly processConcurrency: number;
  private readonly store: Store;
  readonly credentials: CredentialStore;

  constructor(store: Store, credentials: CredentialStore, options: DispatcherOptions = {}) {
    this.store = store;
    this.credentials = credentials;
    this.now = () => readNow(options.now ?? (() => Date.now()));
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
    this.processConcurrency = Math.max(1, options.processConcurrency ?? 1);
    this.store.watchWork?.(() => this.notifyWork());
  }

  registerWorker(capabilities: WorkerCapabilities): WorkerRegistration {
    if (!capabilities.workerId || !Number.isInteger(capabilities.maxConcurrent) || capabilities.maxConcurrent < 1) throw new DispatcherError("invalid_registration", "worker capabilities are invalid");
    const token = this.credentials.issue("worker", capabilities.workerId);
    const registration: WorkerRegistration = {
      ...capabilities,
      capabilities: { ...capabilities, allowedDefinitions: [...capabilities.allowedDefinitions], tools: [...capabilities.tools] },
      token,
      credential: token,
    };
    this.registrations.set(capabilities.workerId, registration);
    this.notifyWork();
    return registration;
  }
  registrationFor(token: string): WorkerRegistration {
    const principal = this.credentials.verify(token, "worker");
    const registration = this.registrations.get(principal.subjectId);
    if (!registration || registration.token !== token) throw new DispatcherError("forbidden", "worker registration is not current");
    return registration;
  }

  async control(registration: WorkerRegistration, leaseId: string, signal: AbortSignal): Promise<"cancel_requested" | "timeout"> {
    const current = this.authorizeRegistration(registration);
    const deadline = Date.now() + this.pollTimeoutMs;
    while (!signal.aborted && Date.now() < deadline) {
      const event = this.store.snapshotAtHighWater().snapshot.events.find((candidate) => candidate.workerId === current.workerId && candidate.leaseId === leaseId);
      if (event?.state === "cancel_requested") return "cancel_requested";
      if (!event || !["leased", "running", "cancel_requested"].includes(event.state)) return "timeout";
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        timer = setTimeout(done, 25);
        signal.addEventListener("abort", done, { once: true });
      });
    }
    return "timeout";
  }

  authenticateWorker(token: string): Principal {
    return this.credentials.verify(token, "worker");
  }

  async poll(registration: WorkerRegistration, signal: AbortSignal): Promise<Delivery | undefined> {
    while (!signal.aborted) {
      const current = this.authorizeRegistration(registration);
      this.store.blockUnmatched?.([...this.registrations.values()].map((entry) => entry.capabilities), this.now());
      const delivery = this.store.acquireAgent(current.capabilities, this.now());
      if (delivery) return delivery;
      await this.waitForWork(current.workerId, signal);
    }
    return undefined;
  }

  pollOnce(registration: WorkerRegistration, signal?: AbortSignal): Promise<Delivery | undefined> {
    return this.poll(registration, signal ?? AbortSignal.timeout(this.pollTimeoutMs));
  }

  notifyWork(): void {
    for (const [workerId, pending] of this.waiters) {
      this.waiters.delete(workerId);
      for (const waiter of pending) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  async runProcessLoop(adapter: ProcessAdapterLike, signal: AbortSignal): Promise<void> {
    const worker = { workerId: "relay:process" as const, maxConcurrent: this.processConcurrency };
    const running = new Set<Promise<void>>();
    while (!signal.aborted) {
      while (running.size < this.processConcurrency && !signal.aborted) {
        const delivery = this.store.acquireProcess(worker, this.now());
        if (!delivery) break;
        const task = this.runProcessDelivery(adapter, delivery, signal).finally(() => running.delete(task));
        running.add(task);
      }
      if (running.size > 0) {
        const waiterAbort = new AbortController();
        const waiter = this.waitForWork("relay:process", waiterAbort.signal);
        await Promise.race([...running, waiter]);
        waiterAbort.abort();
      } else {
        await this.waitForWork("relay:process", signal);
      }
    }
    await Promise.all([...running]);
  }

  start(registration: WorkerRegistration, authority: DeliveryAuthority): void { this.authorized(registration, authority).store.start(authority); }
  renew(registration: WorkerRegistration, authority: DeliveryAuthority, newExpiry: number): void { this.authorized(registration, authority).store.renew(authority, newExpiry); }
  progress(registration: WorkerRegistration, authority: DeliveryAuthority, data: unknown): void { this.authorized(registration, authority).store.progress(authority, data); }
  fail(registration: WorkerRegistration, authority: DeliveryAuthority, failure: FailureEvidence): StoredEvent { return this.authorized(registration, authority).store.fail(authority, failure); }
  complete(registration: WorkerRegistration, authority: DeliveryAuthority, result: unknown, effects: EffectEvidence[]): StoredEvent { return this.authorized(registration, authority).store.complete(authority, result, effects); }
  requestCancel(eventId: string): StoredEvent { const event = this.store.requestCancel(eventId); this.notifyWork(); return event; }

  acknowledgeCancel(registration: WorkerRegistration, authority: DeliveryAuthority, evidence: EffectEvidence[]): StoredEvent {
    return this.authorized(registration, authority).store.acknowledgeCancel(authority, evidence);
  }
  private async runProcessDelivery(adapter: ProcessAdapterLike, delivery: Delivery, loopSignal: AbortSignal): Promise<void> {
    const revision = this.store.getRevision(delivery.event.definitionRevision);
    const authority = { eventId: delivery.event.id, workerId: "relay:process", leaseId: delivery.leaseId };
    const controller = new AbortController();
    const onLoopAbort = (): void => controller.abort();
    loopSignal.addEventListener("abort", onLoopAbort, { once: true });
    const poll = setInterval(() => {
      const event = this.store.getEvent(delivery.event.id);
      if (event?.state === "cancel_requested") controller.abort();
    }, 10);
    let outcome: ProcessOutcome | undefined;
    try {
      outcome = await adapter.run(delivery, revision, controller.signal, {
        onMessage: (message) => this.applyProcessMessage(authority, message),
      });
      const event = this.store.getEvent(delivery.event.id);
      if (outcome.type === "complete") this.store.complete(authority, outcome.result, outcome.effects);
      else if (outcome.type === "fail") this.store.fail(authority, outcome.failure as FailureEvidence);
      else if (event?.state === "cancel_requested") this.store.acknowledgeCancel(authority, outcome.effects);
      else this.store.fail(authority, { code: "plugin_cancelled" });
    } catch (error) {
      const event = this.store.getEvent(delivery.event.id);
      const code = error instanceof Error && "code" in error ? String((error as Error & { code: string }).code) : "plugin_crash";
      const effects = outcome !== undefined && "effects" in outcome ? outcome.effects : [];
      if (event?.state === "cancel_requested") this.store.acknowledgeCancel(authority, effects);
      else this.store.fail(authority, { code });
    } finally {
      clearInterval(poll);
      loopSignal.removeEventListener("abort", onLoopAbort);
    }
  }
  private applyProcessMessage(authority: DeliveryAuthority, message: Exclude<ProcessMessage, { type: "complete" | "fail" | "cancelled" }>): void {
    if (message.type === "started") this.store.start(authority);
    else if (message.type === "renew") this.store.renew(authority, typeof message.leaseExpiresAt === "string" ? Date.parse(message.leaseExpiresAt) : message.leaseExpiresAt);
    else if (message.type === "progress") this.store.progress(authority, message.data);
    else if (message.type === "effect_started") this.store.recordEffectIntent(authority, message.effectKey, message.idempotencyBoundaryConfirmed === true);
    else if (message.type === "effect_confirmed") this.store.confirmEffect(authority, message.effectKey, message.externalRef);
  }

  private authorizeRegistration(registration: WorkerRegistration): WorkerRegistration {
    const current = this.registrations.get(registration.workerId);
    if (!current || current.token !== registration.token || current.capabilities.workerId !== registration.capabilities.workerId) throw new DispatcherError("forbidden", "worker registration is not current");
    const principal = this.credentials.verify(current.token, "worker");
    if (principal.subjectId !== current.workerId) throw new DispatcherError("forbidden", "worker credential identity does not match registration");
    return current;
  }

  private authorized(registration: WorkerRegistration, authority: DeliveryAuthority): Dispatcher {
    const current = this.authorizeRegistration(registration);
    if (authority.workerId !== current.workerId) throw new DispatcherError("forbidden", "worker identity does not match registration");
    return this;
  }

  private waitForWork(workerId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => { resolve = complete; });
    let pending = this.waiters.get(workerId);
    if (!pending) { pending = new Set(); this.waiters.set(workerId, pending); }
    const waiter: Waiter = { resolve: () => undefined };
    const cleanup = (): void => {
      pending?.delete(waiter);
      if (pending?.size === 0) this.waiters.delete(workerId);
      clearTimeout(waiter.timer);
      signal.removeEventListener("abort", finish);
    };
    const finish = (): void => { cleanup(); resolve(); };
    waiter.resolve = finish;
    pending.add(waiter);
    signal.addEventListener("abort", finish, { once: true });
    waiter.timer = setTimeout(finish, this.pollTimeoutMs);
    return promise;
  }
}

export { DispatcherError };
export type { Scope } from "./auth.ts";
export { AuthError };
