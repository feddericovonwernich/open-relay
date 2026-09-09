#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./registry.js";
import { RelayBrowserClient } from "./browser.js";
import { GitHubClient } from "./connectors/github/client.js";
import { loadGitHubConnectorConfig } from "./connectors/github/config.js";
import { GitHubRelayEmitter } from "./connectors/github/emitter.js";
import { runGitHubConnector } from "./connectors/github/runner.js";
import { initializeProject } from "./init.js";
import { pollAgent, replyAgent } from "./agent-session.js";
export function parseArgs(argv) {
    const args = [];
    const options = {};
    let command;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === undefined)
            continue;
        if (value === "--") {
            args.push(...argv.slice(index + 1));
            break;
        }
        if (value.startsWith("--")) {
            const raw = value.slice(2);
            const equals = raw.indexOf("=");
            if (equals >= 0) {
                options[raw.slice(0, equals)] = raw.slice(equals + 1);
            }
            else {
                const next = argv[index + 1];
                if (next !== undefined && !next.startsWith("-")) {
                    options[raw] = next;
                    index += 1;
                }
                else
                    options[raw] = true;
            }
            continue;
        }
        if (command === undefined)
            command = value;
        else
            args.push(value);
    }
    return { command, args, options };
}
function option(options, ...names) {
    for (const name of names) {
        const value = options[name];
        if (typeof value === "string")
            return value;
    }
    return undefined;
}
function requiredArg(args, index, name) {
    const value = args[index];
    if (!value)
        throw new Error(`${name} is required`);
    return value;
}
function json(value) {
    return JSON.stringify(value, (_key, child) => typeof child === "bigint" ? Number(child) : child);
}
function printJson(io, value) {
    io.stdout.write(`${json(value)}\n`);
}
export function withoutSecrets(value) {
    if (Array.isArray(value))
        return value.map(withoutSecrets);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|credential|secret/i.test(key)).map(([key, child]) => [key, withoutSecrets(child)]));
    }
    return value;
}
async function runtimeFile(cwd, options) {
    return resolve(cwd, option(options, "runtime") ?? ".relay/runtime.json");
}
async function readRuntime(cwd, options) {
    const path = await runtimeFile(cwd, options);
    let value;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        throw new Error(`runtime file not found: ${path}`);
    }
    if (value === null || typeof value !== "object")
        throw new Error("runtime file is invalid");
    const runtime = value;
    if (!Number.isInteger(runtime.port) || typeof runtime.token !== "string" || runtime.token.length === 0)
        throw new Error("runtime file is invalid");
    return runtime;
}
export async function verifyRuntimeProcess(runtime) {
    const pid = runtime.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1)
        throw new Error("runtime does not contain a valid process id");
    let commandLine;
    try {
        commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    }
    catch {
        throw new Error("relay process identity could not be verified");
    }
    if (!commandLine.includes("cli.js") && !commandLine.includes("relay"))
        throw new Error("runtime process identity does not match relay");
    let response;
    try {
        response = await fetch(`http://127.0.0.1:${runtime.port}/v1/events/__relay_stop_probe__`, { headers: { Authorization: `Bearer ${runtime.token}` } });
    }
    catch {
        throw new Error("relay loopback health check failed");
    }
    await response.body?.cancel();
    if (response.status !== 403)
        throw new Error("relay loopback health check failed");
}
async function request(runtime, method, path, body, scopeToken = runtime.token) {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${scopeToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: json(body) }),
    });
    let value;
    try {
        value = await response.json();
    }
    catch {
        value = {};
    }
    if (!response.ok) {
        const error = value;
        throw new Error(typeof error.error?.message === "string" ? error.error.message : `request failed (${response.status})`);
    }
    return value;
}
async function scopedToken(runtime, scope) {
    const value = await request(runtime, "POST", "/v1/credentials", { scope, subjectId: `cli:${process.pid}` });
    const token = value.token;
    if (typeof token !== "string")
        throw new Error("relay did not issue a credential");
    return token;
}
function parseWorkerCapabilities(parsed, workerId, maxConcurrent = Number(option(parsed.options, "max-concurrent") ?? 1)) {
    return {
        workerId,
        allowedDefinitions: (option(parsed.options, "definitions") ?? "*").split(",").filter(Boolean),
        tools: (option(parsed.options, "tools") ?? "").split(",").filter(Boolean),
        structuredOutput: parsed.options["structured-output"] === true,
        contextTokens: Number(option(parsed.options, "context-tokens") ?? 0),
        systemReserveTokens: Number(option(parsed.options, "system-reserve") ?? 0),
        maxConcurrent,
    };
}
function parseAgentTimeout(parsed) {
    const value = parsed.options.timeout;
    const timeout = typeof value === "string" ? Number(value) : NaN;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000) {
        throw new Error("timeout must be an integer from 1 through 600000");
    }
    return timeout;
}
const AGENT_REPLY_ACTIONS = [
    "start",
    "renew",
    "progress",
    "control",
    "cancelled",
    "complete",
    "fail",
    "effect-intent",
    "effect-confirmation",
];
function isAgentReplyAction(value) {
    return AGENT_REPLY_ACTIONS.includes(value);
}
function parseReplyBody(parsed) {
    const value = parsed.options.json;
    if (typeof value !== "string")
        throw new Error("agent reply requires --json <object>");
    let body;
    try {
        body = JSON.parse(value);
    }
    catch {
        throw new Error("agent reply --json must be valid JSON object");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("agent reply --json must be a JSON object");
    }
    return body;
}
function requireAgentCapabilityValues(parsed) {
    for (const name of ["definitions", "tools", "context-tokens", "system-reserve"]) {
        if (parsed.options[name] !== undefined && typeof parsed.options[name] !== "string") {
            throw new Error(`--${name} requires a value`);
        }
    }
}
async function agentCommand(parsed, io) {
    const root = resolve(io.cwd, option(parsed.options, "project-root", "project") ?? ".");
    const action = requiredArg(parsed.args, 0, "agent action");
    if (action === "poll") {
        if (parsed.args.length !== 2)
            throw new Error("agent poll accepts exactly one worker id");
        requireAgentCapabilityValues(parsed);
        const workerId = requiredArg(parsed.args, 1, "worker id");
        const timeout = parsed.options.timeout === undefined ? 600_000 : parseAgentTimeout(parsed);
        const runtime = await readRuntime(root, parsed.options);
        const capabilities = parseWorkerCapabilities(parsed, workerId, 1);
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        try {
            const delivery = await pollAgent({ root, runtime, capabilities, timeoutMs: timeout, signal: controller.signal });
            printJson(io, delivery);
            return 0;
        }
        finally {
            process.off("SIGINT", abort);
            process.off("SIGTERM", abort);
        }
    }
    if (action === "reply") {
        if (parsed.args.length !== 3)
            throw new Error("agent reply accepts exactly a lease id and action");
        const leaseId = requiredArg(parsed.args, 1, "lease id");
        const replyAction = requiredArg(parsed.args, 2, "agent action");
        if (!isAgentReplyAction(replyAction))
            throw new Error(`unknown agent action: ${replyAction}`);
        if ((replyAction === "start" || replyAction === "control") && parsed.options.json !== undefined) {
            throw new Error(`--json is not supported for ${replyAction}`);
        }
        const body = replyAction === "start" || replyAction === "control" ? undefined : parseReplyBody(parsed);
        const runtime = await readRuntime(root, parsed.options);
        const result = await replyAgent({ root, runtime, leaseId, action: replyAction, body });
        printJson(io, result);
        return 0;
    }
    throw new Error(`unknown agent action: ${action}`);
}
async function startRelay(parsed, io) {
    const [{ CredentialStore }, { Dispatcher }, { ProcessAdapter }, { createRelayServer }, { openStore }] = await Promise.all([
        import("./auth.js"),
        import("./dispatcher.js"),
        import("./process-adapter.js"),
        import("./server.js"),
        import("./store.js"),
    ]);
    const root = resolve(io.cwd, option(parsed.options, "project-root", "project") ?? ".");
    const definitionsDir = option(parsed.options, "definitions") ?? (existsSync(join(root, ".relay", "events")) ? ".relay/events" : "events");
    const registry = loadRegistry(root, definitionsDir);
    await mkdir(join(root, ".relay"), { recursive: true });
    const store = openStore(join(root, ".relay", "relay.sqlite"));
    store.installRevisions(registry.revisions());
    const credentials = new CredentialStore();
    const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: Number(option(parsed.options, "poll-timeout") ?? 30_000) });
    const runtimePath = await runtimeFile(root, parsed.options);
    const server = createRelayServer({ store, registry, credentials, dispatcher, processAdapter: new ProcessAdapter(root), projectRoot: root, definitionsDir, runtimePath });
    const port = Number(option(parsed.options, "port") ?? 8787);
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolveListen());
    });
    try {
        const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
        await writeFile(runtimePath, `${json({ ...runtime, pid: process.pid })}\n`, { mode: 0o600 });
    }
    catch { /* server already wrote a valid runtime file */ }
    io.stdout.write(`relay started on http://127.0.0.1:${server.address().port}\n`);
    const close = () => { void new Promise((done) => server.close(() => done())); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await new Promise((done) => server.once("close", done));
    return 0;
}
async function recoveryList(runtime, io) {
    const token = await scopedToken(runtime, "observer");
    const client = new RelayBrowserClient({ baseUrl: `http://127.0.0.1:${runtime.port}`, token, reconnectDelayMs: 0 });
    const controller = new AbortController();
    for await (const frame of client.stream({ signal: controller.signal, maxEvents: 1 })) {
        controller.abort();
        const data = frame.data;
        printJson(io, (data.events ?? []).filter((event) => event.state === "recovery_required"));
        return;
    }
    printJson(io, []);
}
async function execute(parsed, io) {
    const root = resolve(io.cwd, option(parsed.options, "project-root", "project") ?? ".");
    if (parsed.options.help === true || parsed.command === "help") {
        io.stdout.write([
            "usage: relay <command> [options]",
            "",
            "commands:",
            "  relay init [--github owner/repository]",
            "  relay start | relay stop",
            "  relay emit <type> --version <n> --json <payload>",
            "  relay get <event-id> | relay cancel <event-id>",
            "  relay connect github [--once] [--discover]",
            "  relay recovery <list|resolve> | relay workers | relay reload",
            "  relay agent poll <worker-id> [options]",
            "  relay agent reply <lease-id> <action> [--json <object>]",
            "",
        ].join("\n"));
        return 0;
    }
    if (parsed.command === "init") {
        const repository = parsed.options.github;
        if (typeof repository === "boolean")
            throw new Error("--github requires owner/repository");
        const created = await initializeProject(root, repository);
        io.stdout.write(created.length === 0 ? "relay project already initialized\n" : `created ${created.length} relay files\n`);
        io.stdout.write("next: relay start\n");
        if (repository !== undefined) {
            io.stdout.write("then: export GITHUB_TOKEN=... && relay connect github --once --discover\n");
        }
        return 0;
    }
    if (parsed.command === "connect") {
        const connector = requiredArg(parsed.args, 0, "connector");
        if (connector !== "github")
            throw new Error(`unknown connector: ${connector}`);
        const discover = parsed.options.discover === true;
        const once = parsed.options.once === true || discover;
        const configPath = resolve(root, option(parsed.options, "config") ?? ".relay/connectors/github.json");
        const config = await loadGitHubConnectorConfig(configPath, { discover, allowLoopbackHttp: process.env.NODE_ENV === "test" });
        const githubToken = process.env[config.tokenEnv];
        if (!githubToken)
            throw new Error(`GitHub token environment variable is missing: ${config.tokenEnv}`);
        const runtime = await readRuntime(root, parsed.options);
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.once("SIGINT", abort);
        process.once("SIGTERM", abort);
        const client = new GitHubClient({ baseUrl: config.apiBaseUrl, apiVersion: config.apiVersion, token: githubToken });
        const emitter = new GitHubRelayEmitter({
            baseUrl: `http://127.0.0.1:${runtime.port}`,
            adminToken: runtime.token,
            lifetimeSignal: controller.signal,
        });
        try {
            await emitter.preflight(AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]));
            const summary = await runGitHubConnector({
                config,
                client,
                emitter,
                signal: controller.signal,
                once,
                discover,
                onDiscovery: discover ? (identity) => printJson(io, withoutSecrets(identity)) : undefined,
            });
            printJson(io, withoutSecrets(summary));
            return 0;
        }
        finally {
            process.off("SIGINT", abort);
            process.off("SIGTERM", abort);
        }
    }
    if (parsed.command === "agent")
        return agentCommand(parsed, io);
    if (parsed.command === "start")
        return startRelay(parsed, io);
    if (parsed.command === "stop") {
        const path = await runtimeFile(root, parsed.options);
        const runtime = await readRuntime(root, parsed.options);
        if (runtime.pid !== undefined && runtime.pid !== process.pid) {
            await verifyRuntimeProcess(runtime);
            process.kill(runtime.pid, "SIGTERM");
            io.stdout.write("relay stopped\n");
        }
        else
            throw new Error("runtime does not contain a stoppable process");
        await unlink(path).catch(() => undefined);
        return 0;
    }
    const runtime = await readRuntime(root, parsed.options);
    if (parsed.command === "emit") {
        const type = requiredArg(parsed.args, 0, "event type");
        const version = Number(option(parsed.options, "version") ?? requiredArg(parsed.args, 1, "event version"));
        if (!Number.isInteger(version))
            throw new Error("event version must be an integer");
        const payloadText = option(parsed.options, "json", "payload") ?? requiredArg(parsed.args, 2, "event payload");
        const payload = JSON.parse(payloadText);
        const token = await scopedToken(runtime, "producer");
        const value = await request(runtime, "POST", "/v1/events", { type, version, payload, idempotencyKey: option(parsed.options, "idempotency-key", "key") ?? `cli:${process.pid}:${Date.now()}` }, token);
        printJson(io, withoutSecrets(value.event ?? value));
        return 0;
    }
    if (parsed.command === "get") {
        const token = await scopedToken(runtime, "observer");
        printJson(io, withoutSecrets(await request(runtime, "GET", `/v1/events/${encodeURIComponent(requiredArg(parsed.args, 0, "event id"))}`, undefined, token)));
        return 0;
    }
    if (parsed.command === "cancel") {
        printJson(io, withoutSecrets(await request(runtime, "POST", `/v1/events/${encodeURIComponent(requiredArg(parsed.args, 0, "event id"))}/cancel`, {})));
        return 0;
    }
    if (parsed.command === "recovery") {
        const action = requiredArg(parsed.args, 0, "recovery action");
        if (action === "list") {
            await recoveryList(runtime, io);
            return 0;
        }
        if (action === "resolve") {
            const eventId = requiredArg(parsed.args, 1, "event id");
            const state = option(parsed.options, "as") ?? requiredArg(parsed.args, 2, "resolution state");
            if (!["completed", "failed", "cancelled"].includes(state))
                throw new Error("resolution state must be completed, failed, or cancelled");
            const evidenceText = option(parsed.options, "evidence") ?? requiredArg(parsed.args, 3, "resolution evidence");
            printJson(io, withoutSecrets(await request(runtime, "POST", `/v1/recovery/${encodeURIComponent(eventId)}/resolve`, { as: state, evidence: JSON.parse(evidenceText) })));
            return 0;
        }
        throw new Error(`unknown recovery action: ${action}`);
    }
    if (parsed.command === "workers") {
        const workerId = option(parsed.options, "id", "worker-id") ?? requiredArg(parsed.args, 0, "worker id");
        const value = await request(runtime, "POST", "/v1/workers/register", parseWorkerCapabilities(parsed, workerId));
        printJson(io, withoutSecrets(value));
        return 0;
    }
    if (parsed.command === "reload") {
        printJson(io, withoutSecrets(await request(runtime, "POST", "/v1/admin/reload", {})));
        return 0;
    }
    throw new Error("usage: relay init|start|stop|emit|get|cancel|recovery|workers|reload|agent");
}
export async function runCli(argv, io = {}) {
    const output = io.stdout ?? process.stdout;
    const errors = io.stderr ?? process.stderr;
    const cwd = io.cwd ?? process.cwd();
    try {
        return await execute(parseArgs(argv), { cwd, stdout: output });
    }
    catch (error) {
        errors.write(`relay: ${error instanceof Error ? error.message : "command failed"}\n`);
        return 1;
    }
}
export async function main() {
    process.exitCode = await runCli(process.argv.slice(2));
}
export function isCliEntrypoint(argvPath, modulePath = fileURLToPath(import.meta.url)) {
    try {
        return realpathSync(resolve(argvPath)) === realpathSync(modulePath);
    }
    catch {
        return false;
    }
}
if (process.argv[1] !== undefined && isCliEntrypoint(process.argv[1]))
    void main();
