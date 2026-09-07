import {
  assembleAgentContext,
  assertToolAllowed,
  intersectToolPolicy,
  type AssembledContext,
  type ContextInput,
  type Tokenizer,
} from "./agent-context.ts";
import type { Delivery, DeliveryAuthority, EffectEvidence } from "./protocol.ts";
export interface ModelAdapter {
  generate(context: AssembledContext, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ToolAdapter {
  invoke(name: string, input: unknown, secrets: ReadonlyMap<string, string>, signal: AbortSignal): Promise<unknown>;
}

export interface SecretResolver {
  resolve(handles: readonly string[]): ReadonlyMap<string, string>;
}

export interface WorkerTransport {
  control(authority: DeliveryAuthority, signal: AbortSignal): Promise<"cancel_requested" | "timeout">;
  cancelled(authority: DeliveryAuthority, evidence: readonly EffectEvidence[]): Promise<void>;
  recordEffectIntent?(authority: DeliveryAuthority, effectKey: string, idempotencyBoundaryConfirmed: boolean): Promise<void>;
  confirmEffect?(authority: DeliveryAuthority, effectKey: string, externalRef: string): Promise<void>;
}

export type ModelEvent =
  | { type: "tool_call" | "tool_request"; name: string; input?: unknown; secretHandles?: readonly string[]; secrets?: readonly string[] }
  | { type: "complete"; result?: unknown; effects?: readonly EffectEvidence[] }
  | { type: "fail"; code?: string; error?: unknown; effectStatus?: EffectEvidence["effectStatus"] }
  | { type: "progress"; data: unknown }
  | { type: "effect"; evidence: EffectEvidence };
export interface WorkerOutcome {
  readonly status: "completed" | "failed" | "cancelled";
  readonly result?: unknown;
  readonly effects: readonly EffectEvidence[];
  readonly code?: string;
  readonly error?: unknown;
}

export interface TrustedWorkerRuntimeOptions {
  readonly model: ModelAdapter;
  readonly tools?: ToolAdapter;
  readonly toolAdapter?: ToolAdapter;
  readonly secretResolver?: SecretResolver;
  readonly transport: WorkerTransport;
  readonly systemPolicy: string;
  readonly definitionInstructions?: string;
  readonly definition?: { readonly instructions?: string; readonly tools?: readonly string[] };
  readonly definitionTools?: readonly string[];
  readonly registeredTools: readonly string[];
  readonly systemTools?: readonly string[];
  readonly retrieved?: ContextInput["retrieved"];
  readonly contextInput?: Pick<ContextInput, "payload" | "retrieved" | "retrievedContext"> | ((delivery: Delivery) => Pick<ContextInput, "payload" | "retrieved" | "retrievedContext">);
  readonly tokenizer?: Tokenizer;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly contextTokens?: number;
  readonly authority?: DeliveryAuthority | ((delivery: Delivery) => DeliveryAuthority);
  readonly validateResult?: (result: unknown) => boolean | Promise<boolean>;
  readonly onProgress?: (data: unknown) => void | Promise<void>;
  readonly onLog?: (data: unknown) => void | Promise<void>;
}

type TrustedContextConfig = Readonly<{
  systemPolicy: string;
  definitionInstructions: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  contextTokens?: number;
  tokenizer?: Tokenizer;
}>;

function authorityFor(delivery: Delivery, authority: TrustedWorkerRuntimeOptions["authority"]): DeliveryAuthority {
  return typeof authority === "function" ? authority(delivery) : authority ?? { workerId: delivery.workerId, leaseId: delivery.leaseId, eventId: delivery.event.id };
}

function redact(value: unknown, secrets: readonly string[], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    let output = value;
    for (const secret of secrets) if (secret) output = output.split(secret).join("[REDACTED]");
    return output;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key, secrets, seen), redact(entry, secrets, seen)]));
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "worker_error";
}

export class TrustedWorkerRuntime<M extends ModelAdapter = ModelAdapter, T extends ToolAdapter = ToolAdapter> {
  private readonly options: TrustedWorkerRuntimeOptions & { model: M; tools?: T; toolAdapter?: T };
  private readonly tools: T;
  private readonly trusted: TrustedContextConfig;
  private readonly allowedTools: readonly string[];

  constructor(options: TrustedWorkerRuntimeOptions & { model: M; tools?: T; toolAdapter?: T });
  constructor(model: M, tools: T, options: Omit<TrustedWorkerRuntimeOptions, "model" | "tools" | "toolAdapter">);
  constructor(first: (TrustedWorkerRuntimeOptions & { model: M; tools?: T; toolAdapter?: T }) | M, second?: T, third?: Omit<TrustedWorkerRuntimeOptions, "model" | "tools" | "toolAdapter">) {
    const options = (typeof first === "object" && "model" in first
      ? first
      : { ...third, model: first, tools: second }) as TrustedWorkerRuntimeOptions & { model: M; tools?: T; toolAdapter?: T };
    this.options = options;
    const definitionTools = Object.freeze([...(options.definitionTools ?? options.definition?.tools ?? [])]);
    const registeredTools = Object.freeze([...options.registeredTools]);
    const systemTools = Object.freeze([...(options.systemTools ?? [])]);
    this.trusted = Object.freeze({
      systemPolicy: options.systemPolicy,
      definitionInstructions: options.definitionInstructions ?? options.definition?.instructions ?? "",
      maxInputTokens: options.maxInputTokens,
      maxOutputTokens: options.maxOutputTokens,
      contextTokens: options.contextTokens,
      tokenizer: options.tokenizer,
    });
    const tools = options.tools ?? options.toolAdapter;
    if (!tools) throw new TypeError("a tool adapter is required");
    this.tools = tools;
    this.allowedTools = intersectToolPolicy(
      definitionTools,
      registeredTools,
      systemTools,
    ).allowedTools;
  }

  async run(delivery: Delivery): Promise<WorkerOutcome> {
    const effects: EffectEvidence[] = [];
    const secretValues: string[] = [];
    let context: AssembledContext;
    try {
      context = this.makeContext(delivery);
    } catch (error) {
      return { status: "failed", code: errorCode(error), error: redact(error, secretValues), effects };
    }
    const authority = authorityFor(delivery, this.options.authority);
    const controller = new AbortController();
    let cancelResolve!: () => void;
    const cancellation = new Promise<"cancelled">((resolve) => { cancelResolve = () => resolve("cancelled"); });
    const controlTask = this.controlLoop(authority, controller, () => {
      cancelResolve();
      controller.abort();
    });
    const modelTask = this.executeModel(authority, context, controller.signal, effects, secretValues);
    void modelTask.catch(() => undefined);
    try {
      const result = await Promise.race([modelTask, cancellation]);
      if (result === "cancelled") {
        await this.options.transport.cancelled(authority, effects);
        return { status: "cancelled", effects: [...effects] };
      }
      return result;
    } catch (error) {
      return { status: "failed", code: errorCode(error), error: redact(error, secretValues), effects: [...effects] };
    } finally {
      controller.abort();
      void controlTask;
    }
  }

  private makeContext(delivery: Delivery): AssembledContext {
    const supplied = this.options.contextInput;
    const input = typeof supplied === "function" ? supplied(delivery) : supplied;
    return assembleAgentContext({
      systemPolicy: this.trusted.systemPolicy,
      definitionInstructions: this.trusted.definitionInstructions,
      payload: input?.payload ?? delivery.event.payload,
      retrieved: input?.retrieved ?? input?.retrievedContext ?? this.options.retrieved,
      allowedTools: this.allowedTools,
      maxInputTokens: this.trusted.maxInputTokens,
      maxOutputTokens: this.trusted.maxOutputTokens,
      contextTokens: this.trusted.contextTokens,
      tokenizer: this.trusted.tokenizer,
    });
  }

  private async executeModel(authority: DeliveryAuthority, context: AssembledContext, signal: AbortSignal, effects: EffectEvidence[], secretValues: string[]): Promise<WorkerOutcome> {
    for await (const event of this.options.model.generate(context, signal)) {
      const type = event.type;
      if (type === "tool_call" || type === "tool_request") {
        try {
          assertToolAllowed({ allowedTools: this.allowedTools }, event.name);
          const handles = event.secretHandles ?? event.secrets ?? [];
          const secrets = this.options.secretResolver?.resolve(handles) ?? new Map<string, string>();
          secretValues.push(...secrets.values());
          const result = await this.tools.invoke(event.name, event.input, secrets, signal);
          const safe = redact(result, secretValues);
          context.messages.push({ role: "tool", content: JSON.stringify(safe) });
          await this.options.onProgress?.(safe);
          await this.options.onLog?.(safe);
        } catch (error) {
          return { status: "failed", code: errorCode(error), error: redact(error, secretValues), effects: [...effects] };
        }
      } else if (type === "effect") {
        const safe = redact(event.evidence, secretValues) as EffectEvidence;
        await this.persistEffectEvidence(authority, safe);
        effects.push(safe);
      } else if (type === "progress") {
        const safe = redact(event.data, secretValues);
        await this.options.onProgress?.(safe);
        await this.options.onLog?.(safe);
      } else if (type === "fail") {
        return { status: "failed", code: event.code ?? "model_failed", error: redact(event.error, secretValues), effects: [...effects] };
      } else if (type === "complete") {
        if (event.effects) {
          for (const entry of event.effects) {
            const safe = redact(entry, secretValues) as EffectEvidence;
            await this.persistEffectEvidence(authority, safe);
            effects.push(safe);
          }
        }
        const safe = redact(event.result, secretValues);
        if (this.options.validateResult && !await this.options.validateResult(safe)) return { status: "failed", code: "invalid_output", error: safe, effects: [...effects] };
        return { status: "completed", result: safe, effects: [...effects] };
      }
    }
    return { status: "failed", code: "model_ended_without_result", effects: [...effects] };
  }

  private async persistEffectEvidence(authority: DeliveryAuthority, evidence: EffectEvidence): Promise<void> {
    const effectKey = evidence.effectKey;
    const status = evidence.status ?? evidence.effectStatus;
    if (!effectKey) return;
    if (status === "started") await this.options.transport.recordEffectIntent?.(authority, effectKey, evidence.idempotencyBoundaryConfirmed === true);
    else if (status === "confirmed" && typeof evidence.externalRef === "string") await this.options.transport.confirmEffect?.(authority, effectKey, evidence.externalRef);
  }

  private async controlLoop(authority: DeliveryAuthority, controller: AbortController, cancel: () => void): Promise<void> {
    while (!controller.signal.aborted) {
      let response: "cancel_requested" | "timeout";
      try {
        response = await this.options.transport.control(authority, controller.signal);
      } catch {
        return;
      }
      if (response === "cancel_requested") {
        cancel();
        return;
      }
      if (!controller.signal.aborted) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

export { redact as redactSecrets };
