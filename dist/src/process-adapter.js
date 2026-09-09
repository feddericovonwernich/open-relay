import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
export class ProcessAdapterError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ProcessAdapterError";
        this.code = code;
    }
}
const TERMINALS = new Set(["complete", "fail", "cancelled"]);
const DEFAULT_LINE_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_GRACE_MS = 100;
function bytes(value) { return Buffer.byteLength(value, "utf8"); }
function asEffects(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new ProcessAdapterError("plugin_protocol_error", "effects must be an array");
    return value;
}
function validMessage(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const message = value;
    if (typeof message.type !== "string")
        return false;
    if (message.type === "started" || message.type === "progress")
        return message.type === "started" || "data" in message;
    if (message.type === "renew")
        return (typeof message.leaseExpiresAt === "number" && Number.isFinite(message.leaseExpiresAt)) || typeof message.leaseExpiresAt === "string";
    if (message.type === "effect_started")
        return typeof message.effectKey === "string" && message.effectKey.length > 0 && (message.idempotencyBoundaryConfirmed === undefined || typeof message.idempotencyBoundaryConfirmed === "boolean");
    if (message.type === "effect_confirmed")
        return typeof message.effectKey === "string" && message.effectKey.length > 0 && typeof message.externalRef === "string" && message.externalRef.length > 0;
    if (message.type === "complete")
        return "result" in message && (message.effects === undefined || Array.isArray(message.effects));
    if (message.type === "fail")
        return typeof message.code === "string" && message.code.length > 0 && (message.effectStatus === undefined || ["none", "started", "unknown", "confirmed", "cancelled"].includes(String(message.effectStatus)));
    if (message.type === "cancelled")
        return message.effects === undefined || Array.isArray(message.effects);
    return false;
}
export class ProcessAdapter {
    projectRoot;
    maxLineBytes;
    maxStdoutBytes;
    maxStderrBytes;
    gracePeriodMs;
    baseEnv;
    constructor(first, second = {}) {
        const options = typeof first === "string" ? { ...second, projectRoot: first } : first;
        this.projectRoot = options.projectRoot;
        this.maxLineBytes = options.maxLineBytes ?? DEFAULT_LINE_BYTES;
        this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_OUTPUT_BYTES;
        this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_OUTPUT_BYTES;
        this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_MS;
        this.baseEnv = options.env ?? process.env;
    }
    async run(delivery, revision, signal, hooks = {}) {
        if (!revision.resolvedCommand)
            throw new ProcessAdapterError("plugin_invalid_definition", "process revision has no resolved command");
        const handler = revision.definition.handler;
        if (handler.kind !== "process")
            throw new ProcessAdapterError("plugin_invalid_definition", "revision is not a process definition");
        const env = {};
        for (const entry of handler.env) {
            const separator = entry.indexOf("=");
            const key = separator < 0 ? entry : entry.slice(0, separator);
            if (!key)
                continue;
            env[key] = separator < 0 ? this.baseEnv[key] : entry.slice(separator + 1);
        }
        const child = spawn(revision.resolvedCommand, handler.args, {
            shell: false,
            cwd: this.projectRoot,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let terminal;
        let failure;
        let exited = false;
        let stdoutBytes = 0;
        const effectEvidence = [];
        let stderrBytes = 0;
        let buffered = "";
        let sawTerminal = false;
        let abortReason;
        const decoder = new StringDecoder("utf8");
        const timeoutMs = Math.max(1, Math.min(revision.definition.timeoutMs, revision.definition.hardDeadlineMs));
        let timeout;
        let abortListener;
        let stderrPromise;
        let stdoutPromise;
        let exitPromise;
        const messageTasks = [];
        const stop = (error) => {
            if (failure)
                return;
            failure = error;
            buffered = "";
            void terminate(child, this.gracePeriodMs);
        };
        const handle = (message) => {
            if (message.type === "complete" || message.type === "cancelled" || message.type === "fail") {
                if (sawTerminal)
                    return stop(new ProcessAdapterError("plugin_protocol_error", "duplicate terminal message"));
                sawTerminal = true;
                if (message.type === "complete")
                    terminal = { type: "complete", result: message.result, effects: message.effects === undefined ? effectEvidence : asEffects(message.effects) };
                else if (message.type === "cancelled")
                    terminal = { type: "cancelled", effects: message.effects === undefined ? effectEvidence : asEffects(message.effects) };
                else {
                    const { type: _type, ...failureData } = message;
                    terminal = { type: "fail", failure: failureData };
                }
                return;
            }
            if (message.type === "effect_started")
                effectEvidence.push({ effectKey: message.effectKey, status: "started", idempotencyBoundaryConfirmed: message.idempotencyBoundaryConfirmed === true });
            else if (message.type === "effect_confirmed")
                effectEvidence.push({ effectKey: message.effectKey, status: "confirmed", externalRef: message.externalRef });
            messageTasks.push(Promise.resolve(hooks.onMessage?.(message)).catch((error) => {
                stop(new ProcessAdapterError("plugin_protocol_error", error instanceof Error ? error.message : String(error)));
            }));
        };
        const parse = (chunk) => {
            if (failure)
                return;
            stdoutBytes += chunk.byteLength;
            if (stdoutBytes > this.maxStdoutBytes)
                return stop(new ProcessAdapterError("plugin_output_overflow", "plugin stdout exceeded the configured limit"));
            buffered += decoder.write(chunk);
            let newline = buffered.indexOf("\n");
            while (newline >= 0) {
                const line = buffered.slice(0, newline).replace(/\r$/, "");
                buffered = buffered.slice(newline + 1);
                if (bytes(line) > this.maxLineBytes)
                    return stop(new ProcessAdapterError("plugin_output_overflow", "plugin output line exceeded the configured limit"));
                if (!line.trim())
                    return stop(new ProcessAdapterError("plugin_protocol_error", "plugin emitted a blank line"));
                let value;
                try {
                    value = JSON.parse(line);
                }
                catch {
                    return stop(new ProcessAdapterError("plugin_protocol_error", "plugin emitted malformed JSONL"));
                }
                if (!validMessage(value))
                    return stop(new ProcessAdapterError("plugin_protocol_error", "plugin emitted an invalid protocol message"));
                handle(value);
                if (failure)
                    return;
                newline = buffered.indexOf("\n");
            }
            if (bytes(buffered) > this.maxLineBytes)
                stop(new ProcessAdapterError("plugin_output_overflow", "plugin output line exceeded the configured limit"));
        };
        stdoutPromise = new Promise((resolve) => {
            if (!child.stdout)
                return resolve();
            child.stdout.on("data", parse);
            child.stdout?.on("end", () => {
                buffered += decoder.end();
                if (!failure && buffered.trim()) {
                    try {
                        const value = JSON.parse(buffered);
                        if (!validMessage(value))
                            throw new Error("invalid protocol message");
                        handle(value);
                    }
                    catch {
                        stop(new ProcessAdapterError("plugin_protocol_error", "plugin emitted malformed JSONL"));
                    }
                }
                void Promise.all(messageTasks).finally(resolve);
            });
            child.stdout?.on("error", (error) => { stop(new ProcessAdapterError("plugin_io_error", error.message)); resolve(); });
        });
        stderrPromise = new Promise((resolve) => {
            if (!child.stderr)
                return resolve();
            child.stderr.on("data", (chunk) => {
                stderrBytes += chunk.byteLength;
                if (stderrBytes > this.maxStderrBytes)
                    stop(new ProcessAdapterError("plugin_output_overflow", "plugin stderr exceeded the configured limit"));
            });
            child.stderr.on("end", resolve);
            child.stderr.on("error", resolve);
        });
        exitPromise = new Promise((resolve) => {
            const finish = (result) => {
                if (exited)
                    return;
                exited = true;
                resolve(result);
            };
            child.once("exit", (code, childSignal) => finish({ code, signal: childSignal }));
            child.once("error", (error) => {
                stop(new ProcessAdapterError("plugin_spawn_error", error.message));
                finish({ code: null, signal: null });
            });
        });
        abortListener = () => {
            if (abortReason || failure || exited)
                return;
            abortReason = "cancelled";
            stop(new ProcessAdapterError("plugin_cancelled", "plugin execution was cancelled"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
        timeout = setTimeout(() => {
            if (!abortReason && !failure && !exited) {
                abortReason = "timeout";
                stop(new ProcessAdapterError("plugin_timeout", "plugin execution timed out"));
            }
        }, timeoutMs);
        try {
            child.stdin?.end(`${JSON.stringify(delivery)}\n`);
            const exit = await exitPromise;
            await Promise.all([stdoutPromise, stderrPromise]);
            if (!failure && !terminal) {
                failure = new ProcessAdapterError(exit.code === 0 ? "plugin_crash" : "plugin_crash", `plugin exited before a terminal message${exit.code === null ? "" : ` (code ${exit.code})`}`);
            }
            if (failure)
                throw failure;
            return terminal;
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (abortListener)
                signal.removeEventListener("abort", abortListener);
        }
    }
}
async function terminate(child, gracePeriodMs) {
    if (child.exitCode !== null || child.signalCode !== null || child.killed)
        return;
    try {
        child.kill("SIGTERM");
    }
    catch {
        return;
    }
    await new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                try {
                    child.kill("SIGKILL");
                }
                catch { /* process already exited */ }
            }
            resolve();
        }, gracePeriodMs);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
}
