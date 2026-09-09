import { assembleAgentContext, assertToolAllowed, intersectToolPolicy, } from "./agent-context.js";
function authorityFor(delivery, authority) {
    return typeof authority === "function" ? authority(delivery) : authority ?? { workerId: delivery.workerId, leaseId: delivery.leaseId, eventId: delivery.event.id };
}
function redact(value, secrets, seen = new WeakSet()) {
    if (typeof value === "string") {
        let output = value;
        for (const secret of secrets)
            if (secret)
                output = output.split(secret).join("[REDACTED]");
        return output;
    }
    if (value === null || typeof value !== "object")
        return value;
    if (seen.has(value))
        return "[REDACTED]";
    seen.add(value);
    if (Array.isArray(value))
        return value.map((entry) => redact(entry, secrets, seen));
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key, secrets, seen), redact(entry, secrets, seen)]));
}
function errorCode(error) {
    return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "worker_error";
}
export class TrustedWorkerRuntime {
    options;
    tools;
    trusted;
    allowedTools;
    constructor(first, second, third) {
        const options = (typeof first === "object" && "model" in first
            ? first
            : { ...third, model: first, tools: second });
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
        if (typeof options.transport?.control !== "function" || typeof options.transport?.cancelled !== "function") {
            throw new TypeError("worker transport methods are required");
        }
        if (typeof options.transport.recordEffectIntent !== "function" || typeof options.transport.confirmEffect !== "function") {
            throw new TypeError("worker transport must persist effect evidence");
        }
        if (!tools)
            throw new TypeError("a tool adapter is required");
        this.tools = tools;
        this.allowedTools = intersectToolPolicy(definitionTools, registeredTools, systemTools).allowedTools;
    }
    async run(delivery) {
        const effects = [];
        const secretValues = [];
        let context;
        try {
            context = this.makeContext(delivery);
        }
        catch (error) {
            return { status: "failed", code: errorCode(error), error: redact(error, secretValues), effects };
        }
        const authority = authorityFor(delivery, this.options.authority);
        const controller = new AbortController();
        let cancelResolve;
        const cancellation = new Promise((resolve) => { cancelResolve = () => resolve("cancelled"); });
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
        }
        catch (error) {
            return { status: "failed", code: errorCode(error), error: redact(error, secretValues), effects: [...effects] };
        }
        finally {
            controller.abort();
            void controlTask;
        }
    }
    makeContext(delivery) {
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
    async executeModel(authority, context, signal, effects, secretValues) {
        for await (const event of this.options.model.generate(context, signal)) {
            const type = event.type;
            if (type === "tool_call" || type === "tool_request") {
                try {
                    assertToolAllowed({ allowedTools: this.allowedTools }, event.name);
                    const handles = event.secretHandles ?? event.secrets ?? [];
                    const secrets = this.options.secretResolver?.resolve(handles) ?? new Map();
                    secretValues.push(...secrets.values());
                    const result = await this.tools.invoke(event.name, event.input, secrets, signal);
                    const safe = redact(result, secretValues);
                    context.messages.push({ role: "tool", content: JSON.stringify(safe) });
                    await this.options.onProgress?.(safe);
                    await this.options.onLog?.(safe);
                }
                catch (error) {
                    return { status: "failed", code: errorCode(error), error: redact(error, secretValues), effects: [...effects] };
                }
            }
            else if (type === "effect") {
                const safe = redact(event.evidence, secretValues);
                await this.persistEffectEvidence(authority, safe);
                effects.push(safe);
            }
            else if (type === "progress") {
                const safe = redact(event.data, secretValues);
                await this.options.onProgress?.(safe);
                await this.options.onLog?.(safe);
            }
            else if (type === "fail") {
                return { status: "failed", code: event.code ?? "model_failed", error: redact(event.error, secretValues), effects: [...effects] };
            }
            else if (type === "complete") {
                if (event.effects) {
                    for (const entry of event.effects) {
                        const safe = redact(entry, secretValues);
                        await this.persistEffectEvidence(authority, safe);
                        effects.push(safe);
                    }
                }
                const safe = redact(event.result, secretValues);
                if (this.options.validateResult && !await this.options.validateResult(safe))
                    return { status: "failed", code: "invalid_output", error: safe, effects: [...effects] };
                return { status: "completed", result: safe, effects: [...effects] };
            }
        }
        return { status: "failed", code: "model_ended_without_result", effects: [...effects] };
    }
    async persistEffectEvidence(authority, evidence) {
        const effectKey = evidence.effectKey;
        const status = evidence.status ?? evidence.effectStatus;
        if (!effectKey)
            return;
        if (status === "started") {
            await this.options.transport.recordEffectIntent(authority, effectKey, evidence.idempotencyBoundaryConfirmed === true);
        }
        else if (status === "confirmed" && typeof evidence.externalRef === "string") {
            await this.options.transport.confirmEffect(authority, effectKey, evidence.externalRef);
        }
    }
    async controlLoop(authority, controller, cancel) {
        while (!controller.signal.aborted) {
            let response;
            try {
                response = await this.options.transport.control(authority, controller.signal);
            }
            catch {
                return;
            }
            if (response === "cancel_requested") {
                cancel();
                return;
            }
            if (!controller.signal.aborted)
                await new Promise((resolve) => setImmediate(resolve));
        }
    }
}
export { redact as redactSecrets };
