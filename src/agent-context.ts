import type { TrustLevel } from "./protocol.ts";

export type Tokenizer = (text: string) => number;
export type ContextRole = "system" | "user" | "assistant" | "tool";

export interface ContextMessage {
  readonly role: ContextRole;
  content: string;
}

export interface RetrievedContext {
  readonly source: string;
  readonly content: string;
}

export interface ContextSegment {
  readonly source: string;
  readonly trust: TrustLevel;
  readonly byteCount: number;
  readonly tokenCount: number;
  readonly content: string;
}

export interface ContextInput {
  readonly systemPolicy: string;
  readonly definitionInstructions: string;
  readonly payload: unknown;
  readonly retrieved?: readonly RetrievedContext[];
  readonly retrievedContext?: readonly RetrievedContext[];
  readonly allowedTools: readonly string[];
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly contextTokens?: number;
  readonly tokenizer?: Tokenizer;
}

export interface AssembledContext {
  readonly messages: ContextMessage[];
  readonly segments: readonly ContextSegment[];
  readonly allowedTools: readonly string[];
  readonly inputTokens: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedOutputTokens: number;
}

export class ContextBudgetError extends Error {
  readonly code = "CONTEXT_BUDGET_EXCEEDED" as const;

  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

export interface ToolPolicy {
  readonly allowedTools: readonly string[];
}

export class ToolPolicyError extends Error {
  readonly code = "tool_forbidden" as const;

  constructor(tool: string) {
    super(`tool is not allowed: ${tool}`);
    this.name = "ToolPolicyError";
  }
}

export function toolPolicy(allowedTools: readonly string[]): ToolPolicy {
  return Object.freeze({ allowedTools: Object.freeze([...new Set(allowedTools)]) });
}

export function assertToolAllowed(policy: ToolPolicy, tool: string): void {
  if (!policy.allowedTools.includes(tool)) throw new ToolPolicyError(tool);
}

export function intersectToolPolicy(...allowed: readonly (readonly string[])[]): ToolPolicy {
  const [first = []] = allowed;
  return toolPolicy(first.filter((tool) => allowed.every((list) => list.includes(tool))));
}

function defaultTokenizer(text: string): number {
  return Math.ceil(text.length / 4);
}

function jsonValue(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
    }
    return entry;
  };
  const encoded = JSON.stringify(stable(value));
  return encoded === undefined ? String(value) : encoded;
}

function segment(source: string, trust: TrustLevel, content: string, tokenizer: Tokenizer): ContextSegment {
  return { source, trust, byteCount: Buffer.byteLength(content, "utf8"), tokenCount: tokenizer(content), content };
}

function untrustedMessage(value: ContextSegment, label: string): string {
  const metadata = JSON.stringify({ label, source: value.source, bytes: value.byteCount, tokens: value.tokenCount });
  return `<<< UNTRUSTED ${label} ${metadata} >>>\n${value.content}\n<<< END UNTRUSTED ${label} >>>`;
}

export function assembleAgentContext(input: ContextInput): AssembledContext {
  if (!Number.isInteger(input.maxInputTokens) || input.maxInputTokens < 0 || !Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 0) {
    throw new ContextBudgetError("context token budgets must be non-negative integers");
  }
  const tokenizer = input.tokenizer ?? defaultTokenizer;
  const policy = toolPolicy(input.allowedTools);
  const messages: ContextMessage[] = [
    { role: "system", content: input.systemPolicy },
    { role: "system", content: input.definitionInstructions },
  ];
  const fixed = [
    segment("system.policy", "trusted", input.systemPolicy, tokenizer),
    segment("definition.instructions", "trusted", input.definitionInstructions, tokenizer),
  ];
  const payload = segment("event.payload", "untrusted", jsonValue(input.payload), tokenizer);
  const retrieved = input.retrieved ?? input.retrievedContext ?? [];
  const retrievedSegments = retrieved.map((entry) => segment(entry.source, "untrusted", entry.content, tokenizer));
  const totalBudget = input.contextTokens === undefined ? input.maxInputTokens + input.maxOutputTokens : input.contextTokens;
  const inputBudget = Math.min(input.maxInputTokens, Math.max(0, totalBudget - input.maxOutputTokens));
  let used = 0;
  for (const entry of fixed) {
    const cost = tokenizer(messages[entry.source === "system.policy" ? 0 : 1].content);
    if (used + cost > inputBudget) throw new ContextBudgetError(`fixed context does not fit: ${entry.source}`);
    used += cost;
  }
  const payloadMessage = untrustedMessage(payload, "EVENT PAYLOAD");
  const payloadCost = tokenizer(payloadMessage);
  if (used + payloadCost > inputBudget) throw new ContextBudgetError("fixed context does not fit: event.payload");
  const included: ContextSegment[] = [...fixed];
  for (const entry of retrievedSegments) {
    const wrapped = untrustedMessage(entry, "RETRIEVED CONTEXT");
    const cost = tokenizer(wrapped);
    if (used + cost + payloadCost > inputBudget) break;
    used += cost;
    included.push(entry);
    messages.push({ role: "user", content: wrapped });
  }
  used += payloadCost;
  included.push(payload);
  messages.push({ role: "user", content: payloadMessage });
  return {
    messages,
    segments: included,
    allowedTools: policy.allowedTools,
    inputTokens: used,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    reservedOutputTokens: input.maxOutputTokens,
  };
}
