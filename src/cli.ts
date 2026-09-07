#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialStore } from "./auth.ts";
import { Dispatcher } from "./dispatcher.ts";
import { ProcessAdapter } from "./process-adapter.ts";
import { loadRegistry } from "./registry.ts";
import { createRelayServer, type RelayServer } from "./server.ts";
import { openStore } from "./store.ts";
import { RelayBrowserClient } from "./browser.ts";

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

type Runtime = { port: number; token: string; pid?: number };
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

function withoutSecrets(value: unknown): unknown {
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

async function startRelay(parsed: ParsedArgs, io: Required<Pick<CliIo, "cwd" | "stdout">>): Promise<number> {
  const root = resolve(io.cwd, option(parsed.options, "project-root", "project") ?? ".");
  const definitionsDir = option(parsed.options, "definitions") ?? (existsSync(join(root, ".relay", "events")) ? ".relay/events" : "events");
  const registry = loadRegistry(root, definitionsDir);
  await mkdir(join(root, ".relay"), { recursive: true });
  const store = openStore(join(root, ".relay", "relay.sqlite"));
  store.installRevisions(registry.revisions());
  const credentials = new CredentialStore();
  const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: Number(option(parsed.options, "poll-timeout") ?? 30_000) });
  const runtimePath = await runtimeFile(root, parsed.options);
  const server = createRelayServer({ store, registry, credentials, dispatcher, processAdapter: new ProcessAdapter(root), projectRoot: root, definitionsDir, runtimePath }) as RelayServer;
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
  if (parsed.command === "start") return startRelay(parsed, io);
  const root = resolve(io.cwd, option(parsed.options, "project-root", "project") ?? ".");
  if (parsed.command === "stop") {
    const path = await runtimeFile(root, parsed.options);
    const runtime = await readRuntime(root, parsed.options);
    if (runtime.pid !== undefined && runtime.pid !== process.pid) {
      process.kill(runtime.pid, "SIGTERM");
      io.stdout.write("relay stopped\n");
    } else throw new Error("runtime does not contain a stoppable process");
    await unlink(path).catch(() => undefined);
    return 0;
  }
  const runtime = await readRuntime(root, parsed.options);
  if (parsed.command === "emit") {
    const type = requiredArg(parsed.args, 0, "event type");
    const version = Number(requiredArg(parsed.args, 1, "event version"));
    if (!Number.isInteger(version)) throw new Error("event version must be an integer");
    const payloadText = option(parsed.options, "payload") ?? requiredArg(parsed.args, 2, "event payload");
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
      const state = requiredArg(parsed.args, 2, "resolution state");
      if (!["completed", "failed", "cancelled"].includes(state)) throw new Error("resolution state must be completed, failed, or cancelled");
      const evidenceText = option(parsed.options, "evidence") ?? requiredArg(parsed.args, 3, "resolution evidence");
      printJson(io, withoutSecrets(await request(runtime, "POST", `/v1/recovery/${encodeURIComponent(eventId)}/resolve`, { state, evidence: JSON.parse(evidenceText) })));
      return 0;
    }
    throw new Error(`unknown recovery action: ${action}`);
  }
  if (parsed.command === "workers") {
    const value = await request(runtime, "POST", "/v1/workers/register", {
      workerId: option(parsed.options, "id", "worker-id") ?? requiredArg(parsed.args, 0, "worker id"),
      allowedDefinitions: (option(parsed.options, "definitions") ?? "*").split(",").filter(Boolean),
      tools: (option(parsed.options, "tools") ?? "").split(",").filter(Boolean),
      structuredOutput: parsed.options["structured-output"] === true,
      contextTokens: Number(option(parsed.options, "context-tokens") ?? 0),
      systemReserveTokens: Number(option(parsed.options, "system-reserve") ?? 0),
      maxConcurrent: Number(option(parsed.options, "max-concurrent") ?? 1),
    });
    printJson(io, withoutSecrets(value));
    return 0;
  }
  if (parsed.command === "reload") {
    printJson(io, withoutSecrets(await request(runtime, "POST", "/v1/admin/reload", {})));
    return 0;
  }
  throw new Error("usage: relay start|stop|emit|get|cancel|recovery|workers|reload");
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
