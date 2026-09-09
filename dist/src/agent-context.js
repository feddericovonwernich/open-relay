export class ContextBudgetError extends Error {
    code = "CONTEXT_BUDGET_EXCEEDED";
    constructor(message) {
        super(message);
        this.name = "ContextBudgetError";
    }
}
export class ToolPolicyError extends Error {
    code = "tool_forbidden";
    constructor(tool) {
        super(`tool is not allowed: ${tool}`);
        this.name = "ToolPolicyError";
    }
}
export function toolPolicy(allowedTools) {
    return Object.freeze({ allowedTools: Object.freeze([...new Set(allowedTools)]) });
}
export function assertToolAllowed(policy, tool) {
    if (!policy.allowedTools.includes(tool))
        throw new ToolPolicyError(tool);
}
export function intersectToolPolicy(...allowed) {
    const [first = []] = allowed;
    return toolPolicy(first.filter((tool) => allowed.every((list) => list.includes(tool))));
}
function defaultTokenizer(text) {
    return Math.ceil(text.length / 4);
}
function jsonValue(value) {
    const stable = (entry) => {
        if (Array.isArray(entry))
            return entry.map(stable);
        if (entry !== null && typeof entry === "object") {
            return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
        }
        return entry;
    };
    const encoded = JSON.stringify(stable(value));
    return encoded === undefined ? String(value) : encoded;
}
function segment(source, trust, content, tokenizer) {
    return { source, trust, byteCount: Buffer.byteLength(content, "utf8"), tokenCount: tokenizer(content), content };
}
function untrustedMessage(value, label) {
    const metadata = JSON.stringify({ label, source: value.source, bytes: value.byteCount, tokens: value.tokenCount });
    return `<<< UNTRUSTED ${label} ${metadata} >>>\n${value.content}\n<<< END UNTRUSTED ${label} >>>`;
}
export function assembleAgentContext(input) {
    if (!Number.isInteger(input.maxInputTokens) || input.maxInputTokens < 0 || !Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 0) {
        throw new ContextBudgetError("context token budgets must be non-negative integers");
    }
    const tokenizer = input.tokenizer ?? defaultTokenizer;
    const policy = toolPolicy(input.allowedTools);
    const messages = [
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
        if (used + cost > inputBudget)
            throw new ContextBudgetError(`fixed context does not fit: ${entry.source}`);
        used += cost;
    }
    const payloadMessage = untrustedMessage(payload, "EVENT PAYLOAD");
    const payloadCost = tokenizer(payloadMessage);
    if (used + payloadCost > inputBudget)
        throw new ContextBudgetError("fixed context does not fit: event.payload");
    const included = [...fixed];
    for (const entry of retrievedSegments) {
        const wrapped = untrustedMessage(entry, "RETRIEVED CONTEXT");
        const cost = tokenizer(wrapped);
        if (used + cost + payloadCost > inputBudget)
            break;
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
