#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./registry.ts";
import { RelayBrowserClient } from "./browser.ts";
import { GitHubClient } from "./connectors/github/client.ts";
import { loadGitHubConnectorConfig } from "./connectors/github/config.ts";
import { GitHubRelayEmitter } from "./connectors/github/emitter.ts";
import { runGitHubConnector } from "./connectors/github/runner.ts";
import { initializeProject } from "./init.ts";
import { pollAgent, replyAgent } from "./agent-session.ts";
import type { AgentReplyAction } from "./agent-session.ts";
import type { WorkerCapabilities } from "./protocol.ts";


export type CliOptionValue = string | boolean;
export interface ParsedArgs {
  command?: string;
  args: string[];
  options: Record<string, CliOptionValue>;
}

export interface CliIo {
  cwd?: string;
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
}

export type Runtime = { port: number; token: string; pid?: number };
type JsonObject = Record<string, unknown>;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: string[] = [];
  const options: Record<string, CliOptionValue> = {};
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === "--") {
      args.push(...argv.slice(index + 1));
      break;
    }
    if (value.startsWith("--")) {
      const raw = value.slice(2);
      const equals = raw.indexOf("=");
      if (equals >= 0) {
        options[raw.slice(0, equals)] = raw.slice(equals + 1);
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          options[raw] = next;
          index += 1;
        } else options[raw] = true;
      }
      continue;
    }
    if (command === undefined) command = value;
    else args.push(value);
  }
  return { command, args, options };
}

function option(options: Record<string, CliOptionValue>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = options[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function requiredArg(args: readonly string[], index: number, name: string): string {
  const value = args[index];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, child) => typeof child === "bigint" ? Number(child) : child);
}

function printJson(io: Required<Pick<CliIo, "stdout">>, value: unknown): void {
  io.stdout.write(`${json(value)}\n`);
}

export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|credential|secret/i.test(key)).map(([key, child]) => [key, withoutSecrets(child)]));
  }
  return value;
}


async function runtimeFile(cwd: string, options: Record<string, CliOptionValue>): Promise<string> {
  return resolve(cwd, option(options, "runtime") ?? ".relay/runtime.json");
}

async function readRuntime(cwd: string, options: Record<string, CliOptionValue>): Promise<Runtime> {
  const path = await runtimeFile(cwd, options);
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(`runtime file not found: ${path}`); }
  if (value === null || typeof value !== "object") throw new Error("runtime file is invalid");
  const runtime = value as Partial<Runtime>;
  if (!Number.isInteger(runtime.port) || typeof runtime.token !== "string" || runtime.token.length === 0) throw new Error("runtime file is invalid");
  return runtime as Runtime;
}
export async function verifyRuntimeProcess(runtime: Runtime): Promise<void> {
  const pid = runtime.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) throw new Error("runtime does not contain a valid process id");
  let commandLine: string;
  try { commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8"); }
  catch { throw new Error("relay process identity could not be verified"); }
  if (!commandLine.includes("cli.js") && !commandLine.includes("relay")) throw new Error("runtime process identity does not match relay");
  let response: Response;
  try { response = await fetch(`http://127.0.0.1:${runtime.port}/v1/events/__relay_stop_probe__`, { headers: { Authorization: `Bearer ${runtime.token}` } }); }
  catch { throw new Error("relay loopback health check failed"); }
  await response.body?.cancel();
  if (response.status !== 403) throw new Error("relay loopback health check failed");
}


async function request(runtime: Runtime, method: string, path: string, body?: unknown, scopeToken = runtime.token): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${scopeToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: json(body) }),
  });
  let value: unknown;
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) {
    const error = value as { error?: { message?: unknown } };
    throw new Error(typeof error.error?.message === "string" ? error.error.message : `request failed (${response.status})`);
  }
  return value;
}

async function scopedToken(runtime: Runtime, scope: "producer" | "observer"): Promise<string> {
  const value = await request(runtime, "POST", "/v1/credentials", { scope, subjectId: `cli:${process.pid}` });
  const token = (value as { token?: unknown }).token;
  if (typeof token !== "string") throw new Error("relay did not issue a credential");
  return token;
}
function parseWorkerCapabilities(parsed: ParsedArgs, workerId: string, maxConcurrent = Number(option(parsed.options, "max-concurrent") ?? 1)): WorkerCapabilities {
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

function parseAgentTimeout(parsed: ParsedArgs): number {
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
] as const;

function isAgentReplyAction(value: string): value is AgentReplyAction {
  return (AGENT_REPLY_ACTIONS as readonly string[]).includes(value);
}

function parseReplyBody(parsed: ParsedArgs): JsonObject {
  const value = parsed.options.json;
  if (typeof value !== "string") throw new Error("agent reply requires --json <object>");
  let body: unknown;
  try {
    body = JSON.parse(value);
  } catch {
    throw new Error("agent reply --json must be valid JSON object");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("agent reply --json must be a JSON object");
  }
  return body as JsonObject;
}
function requireAgentCapabilityValues(parsed: ParsedArgs): void {
  for (const name of ["definitions", "tools", "context-tokens", "system-reserve"]) {
    if (parsed.options[name] !== undefined && typeof parsed.options[name] !== "string") {
      throw new Error(`--${name} requires a value`);
    }
  }
}


async function agentCommand(parsed: ParsedArgs, io: Required<Pick<CliIo, "cwd" | "stdout">>): Promise<number> {
  const root = resolve(io.cwd, option(parsed.options, "project-root", "project") ?? ".");
  const action = requiredArg(parsed.args, 0, "agent action");
  if (action === "poll") {
    if (parsed.args.length !== 2) throw new Error("agent poll accepts exactly one worker id");
    requireAgentCapabilityValues(parsed);
    const workerId = requiredArg(parsed.args, 1, "worker id");
    const timeout = parsed.options.timeout === undefined ? 600_000 : parseAgentTimeout(parsed);
    const runtime = await readRuntime(root, parsed.options);
    const capabilities = parseWorkerCapabilities(parsed, workerId, 1);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const delivery = await pollAgent({ root, runtime, capabilities, timeoutMs: timeout, signal: controller.signal });
      printJson(io, delivery);
      return 0;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
  if (action === "reply") {
    if (parsed.args.length !== 3) throw new Error("agent reply accepts exactly a lease id and action");
    const leaseId = requiredArg(parsed.args, 1, "lease id");
    const replyAction = requiredArg(parsed.args, 2, "agent action");
    if (!isAgentReplyAction(replyAction)) throw new Error(`unknown agent action: ${replyAction}`);
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


async function startRelay(parsed: ParsedArgs, io: Required<Pick<CliIo, "cwd" | "stdout">>): Promise<number> {
  const [{ CredentialStore }, { Dispatcher }, { ProcessAdapter }, { createRelayServer }, { openStore }] = await Promise.all([
    import("./auth.ts"),
    import("./dispatcher.ts"),
    import("./process-adapter.ts"),
    import("./server.ts"),
    import("./store.ts"),
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
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  try {
    const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as Runtime;
    await writeFile(runtimePath, `${json({ ...runtime, pid: process.pid })}\n`, { mode: 0o600 });
  } catch { /* server already wrote a valid runtime file */ }
  io.stdout.write(`relay started on http://127.0.0.1:${(server.address() as { port: number }).port}\n`);
  const close = (): void => { void new Promise<void>((done) => server.close(() => done())); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise<void>((done) => server.once("close", done));
  return 0;
}

async function recoveryList(runtime: Runtime, io: Required<Pick<CliIo, "stdout">>): Promise<void> {
  const token = await scopedToken(runtime, "observer");
  const client = new RelayBrowserClient({ baseUrl: `http://127.0.0.1:${runtime.port}`, token, reconnectDelayMs: 0 });
  const controller = new AbortController();
  for await (const frame of client.stream({ signal: controller.signal, maxEvents: 1 })) {
    controller.abort();
    const data = frame.data as { events?: readonly JsonObject[] };
    printJson(io, (data.events ?? []).filter((event) => event.state === "recovery_required"));
    return;
  }
  printJson(io, []);
}

async function execute(parsed: ParsedArgs, io: Required<Pick<CliIo, "cwd" | "stdout">>): Promise<number> {
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
    if (typeof repository === "boolean") throw new Error("--github requires owner/repository");
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
    if (connector !== "github") throw new Error(`unknown connector: ${connector}`);
    const discover = parsed.options.discover === true;
    const once = parsed.options.once === true || discover;
    const configPath = resolve(root, option(parsed.options, "config") ?? ".relay/connectors/github.json");
    const config = await loadGitHubConnectorConfig(configPath, { discover, allowLoopbackHttp: process.env.NODE_ENV === "test" });
    const githubToken = process.env[config.tokenEnv];
    if (!githubToken) throw new Error(`GitHub token environment variable is missing: ${config.tokenEnv}`);
    const runtime = await readRuntime(root, parsed.options);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
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
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
  if (parsed.command === "agent") return agentCommand(parsed, io);

  if (parsed.command === "start") return startRelay(parsed, io);
  if (parsed.command === "stop") {
    const path = await runtimeFile(root, parsed.options);
    const runtime = await readRuntime(root, parsed.options);
    if (runtime.pid !== undefined && runtime.pid !== process.pid) {
      await verifyRuntimeProcess(runtime);
      process.kill(runtime.pid, "SIGTERM");
      io.stdout.write("relay stopped\n");
    } else throw new Error("runtime does not contain a stoppable process");
    await unlink(path).catch(() => undefined);
    return 0;
  }
  const runtime = await readRuntime(root, parsed.options);
  if (parsed.command === "emit") {
    const type = requiredArg(parsed.args, 0, "event type");
    const version = Number(option(parsed.options, "version") ?? requiredArg(parsed.args, 1, "event version"));
    if (!Number.isInteger(version)) throw new Error("event version must be an integer");
    const payloadText = option(parsed.options, "json", "payload") ?? requiredArg(parsed.args, 2, "event payload");
    const payload = JSON.parse(payloadText);
    const token = await scopedToken(runtime, "producer");
    const value = await request(runtime, "POST", "/v1/events", { type, version, payload, idempotencyKey: option(parsed.options, "idempotency-key", "key") ?? `cli:${process.pid}:${Date.now()}` }, token);
    printJson(io, withoutSecrets((value as JsonObject).event ?? value));
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
    if (action === "list") { await recoveryList(runtime, io); return 0; }
    if (action === "resolve") {
      const eventId = requiredArg(parsed.args, 1, "event id");
      const state = option(parsed.options, "as") ?? requiredArg(parsed.args, 2, "resolution state");
      if (!["completed", "failed", "cancelled"].includes(state)) throw new Error("resolution state must be completed, failed, or cancelled");
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

export async function runCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
  const errors = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  try { return await execute(parseArgs(argv), { cwd, stdout: output }); }
  catch (error) {
    errors.write(`relay: ${error instanceof Error ? error.message : "command failed"}\n`);
    return 1;
  }
}

export async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

export function isCliEntrypoint(argvPath: string, modulePath = fileURLToPath(import.meta.url)): boolean {
  try { return realpathSync(resolve(argvPath)) === realpathSync(modulePath); }
  catch { return false; }
}

if (process.argv[1] !== undefined && isCliEntrypoint(process.argv[1])) void main();
