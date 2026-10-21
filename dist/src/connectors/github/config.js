import { readFile } from "node:fs/promises";
export class GitHubConfigError extends Error {
    code;
    constructor(code, message = "GitHub connector configuration is invalid") {
        super(message);
        this.name = "GitHubConfigError";
        this.code = code;
    }
}
const RECOGNIZERS = {
    sonarqube: true,
    "copilot-review": true,
    "cursor-bugbot": true,
};
const TOP_LEVEL_KEYS = {
    connector: true,
    apiBaseUrl: true,
    graphqlUrl: true,
    apiVersion: true,
    tokenEnv: true,
    pollIntervalMs: true,
    lookbackHours: true,
    repositories: true,
    triggers: true,
    aggregate: true,
    verification: true,
};
const TRIGGER_KEYS = {
    id: true,
    recognizer: true,
    match: true,
    emit: true,
};
const REPOSITORY_KEYS = {
    name: true,
    mode: true,
};
const CHECK_RUN_MATCH_KEYS = {
    checkNames: true,
    appIds: true,
    appSlugs: true,
};
const COPILOT_MATCH_KEYS = {
    userIds: true,
    appUrls: true,
    logins: true,
};
const VERIFICATION_KEYS = {
    id: true,
    emit: true,
    reviewers: true,
};
const REVIEWER_KEYS = {
    "cursor-bugbot": true,
    "copilot-review": true,
};
const VERIFICATION_PROVIDERS = ["cursor-bugbot", "copilot-review"];
const SECRET_KEY = /token|credential|secret/i;
const TRIGGER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
function invalid(code, message) {
    throw new GitHubConfigError(code, message);
}
function isRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function rejectSecretKeys(value, seen = new WeakSet()) {
    if (value === null || typeof value !== "object")
        return;
    if (seen.has(value))
        invalid("config_cycle");
    seen.add(value);
    if (Array.isArray(value)) {
        for (const entry of value)
            rejectSecretKeys(entry, seen);
        seen.delete(value);
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (SECRET_KEY.test(key) && key !== "tokenEnv")
            invalid("secret_key");
        rejectSecretKeys(child, seen);
    }
    seen.delete(value);
}
function object(value, field) {
    if (!isRecord(value))
        invalid("property_type", `${field} must be an object`);
    return value;
}
function string(value, field) {
    if (typeof value !== "string" || value.length === 0) {
        invalid("property_type", `${field} must be a non-empty string`);
    }
    return value;
}
function optionalString(value, field, defaultValue) {
    return value === undefined ? defaultValue : string(value, field);
}
function integer(value, field, min, max) {
    if (!Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) {
        invalid("property_type", `${field} must be an integer in range`);
    }
    return value;
}
function array(value, field) {
    if (!Array.isArray(value))
        invalid("property_type", `${field} must be an array`);
    return value;
}
function strings(value, field, allowEmpty = false) {
    const entries = array(value, field);
    const result = entries.map((entry, index) => string(entry, `${field}[${index}]`));
    if (!allowEmpty && result.length === 0)
        invalid("property_type", `${field} must not be empty`);
    return result;
}
function numbers(value, field) {
    return array(value, field).map((entry, index) => integer(entry, `${field}[${index}]`, 1));
}
function optionalStrings(value, field) {
    return value === undefined ? [] : strings(value, field, true);
}
function optionalNumbers(value, field) {
    return value === undefined ? [] : numbers(value, field);
}
function checkUnknownKeys(value, allowed) {
    for (const key of Object.keys(value)) {
        if (allowed[key] !== true)
            invalid("unknown_property");
    }
}
function isLoopback(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1")
        return true;
    const octets = host.split(".");
    return octets.length === 4 && octets[0] === "127" && octets.slice(1).every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}
function trustedUrl(value, field, code, options) {
    const text = string(value, field);
    let parsed;
    try {
        parsed = new URL(text);
    }
    catch {
        invalid(code);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
        invalid(code);
    if (parsed.protocol === "https:")
        return parsed.toString().replace(/\/$/, "");
    if (parsed.protocol === "http:" && (options.allowLoopbackHttp || process.env.NODE_ENV === "test") && isLoopback(parsed.hostname)) {
        return parsed.toString().replace(/\/$/, "");
    }
    invalid(code);
}
function appUrls(value) {
    const urls = optionalStrings(value, "match.appUrls");
    for (const appUrl of urls) {
        let parsed;
        try {
            parsed = new URL(appUrl);
        }
        catch {
            invalid("provider_identity");
        }
        if (parsed.protocol !== "https:" ||
            parsed.hostname.toLowerCase() !== "github.com" ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash)
            invalid("provider_identity");
    }
    return urls;
}
function emit(value) {
    const record = object(value, "emit");
    checkUnknownKeys(record, { type: true, version: true });
    return {
        type: string(record.type, "emit.type"),
        version: integer(record.version, "emit.version", 1),
    };
}
function checkRunMatch(value, field = "match") {
    const record = object(value, field);
    checkUnknownKeys(record, CHECK_RUN_MATCH_KEYS);
    return {
        checkNames: strings(record.checkNames, `${field}.checkNames`),
        appIds: optionalNumbers(record.appIds, `${field}.appIds`),
        appSlugs: optionalStrings(record.appSlugs, `${field}.appSlugs`),
    };
}
function trigger(value, discover) {
    const record = object(value, "trigger");
    checkUnknownKeys(record, TRIGGER_KEYS);
    const id = string(record.id, "trigger.id");
    if (!TRIGGER_ID.test(id))
        invalid("trigger_id");
    if (typeof record.recognizer !== "string" || RECOGNIZERS[record.recognizer] !== true)
        invalid("recognizer");
    const recognizer = record.recognizer;
    const emission = emit(record.emit);
    if (recognizer === "copilot-review") {
        const match = object(record.match, "match");
        checkUnknownKeys(match, COPILOT_MATCH_KEYS);
        const normalized = {
            userIds: optionalNumbers(match.userIds, "match.userIds"),
            appUrls: appUrls(match.appUrls),
            logins: optionalStrings(match.logins, "match.logins"),
        };
        if (normalized.userIds.length === 0 && normalized.appUrls.length === 0 && normalized.logins.length === 0) {
            invalid("copilot_identity_required");
        }
        return { id, recognizer, match: normalized, emit: emission };
    }
    const match = checkRunMatch(record.match);
    if (!discover && recognizer === "sonarqube" && match.appIds.length === 0 && match.appSlugs.length === 0) {
        invalid("sonar_identity_required");
    }
    if (recognizer === "cursor-bugbot" && match.appIds.length === 0 && match.appSlugs.length === 0) {
        invalid("cursor_identity_required");
    }
    return { id, recognizer, match, emit: emission };
}
function repository(value) {
    if (!isRecord(value))
        invalid("repository");
    const record = object(value, "repository");
    checkUnknownKeys(record, REPOSITORY_KEYS);
    const repositoryName = record.name;
    if (typeof repositoryName !== "string")
        invalid("repository");
    const [owner, name, ...extra] = repositoryName.split("/");
    if (extra.length > 0 || !owner || !name || owner === "." || owner === ".." || name === "." || name === ".." || !REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) {
        invalid("repository");
    }
    const mode = record.mode;
    if (mode !== "configured-tools"
        && mode !== "generic-check-runs"
        && mode !== "configured-tools-and-generic-check-runs")
        invalid("repository_mode");
    return { name: repositoryName, mode };
}
function aggregate(value) {
    const record = object(value, "aggregate");
    checkUnknownKeys(record, { id: true, emit: true });
    const id = string(record.id, "aggregate.id");
    if (!TRIGGER_ID.test(id))
        invalid("aggregate_id");
    return { id, emit: emit(record.emit) };
}
function verification(value, triggers, aggregateConfig, hasCombinedRepositories) {
    const record = object(value, "verification");
    checkUnknownKeys(record, VERIFICATION_KEYS);
    const id = string(record.id, "verification.id");
    if (!TRIGGER_ID.test(id))
        invalid("verification_id");
    const emission = emit(record.emit);
    if (!hasCombinedRepositories)
        invalid("verification_mode");
    if (triggers.some((trigger) => trigger.id === id) || aggregateConfig?.id === id) {
        invalid("verification_id_duplicate");
    }
    const reviewerRecord = record.reviewers;
    if (!isRecord(reviewerRecord))
        invalid("verification_reviewers");
    checkUnknownKeys(reviewerRecord, REVIEWER_KEYS);
    const configuredProviders = new Set(triggers
        .filter((trigger) => trigger.recognizer === "cursor-bugbot" || trigger.recognizer === "copilot-review")
        .map((trigger) => trigger.recognizer));
    const seenLogins = new Set();
    const reviewers = {};
    for (const provider of VERIFICATION_PROVIDERS) {
        const valueForProvider = reviewerRecord[provider];
        if (valueForProvider === undefined) {
            if (configuredProviders.has(provider))
                invalid("verification_reviewer_required");
            continue;
        }
        if (!configuredProviders.has(provider))
            invalid("verification_reviewer_unused");
        const logins = strings(valueForProvider, `verification.reviewers.${provider}`).map((login) => login.toLowerCase());
        for (const login of logins) {
            if (seenLogins.has(login))
                invalid("verification_reviewer_duplicate");
            seenLogins.add(login);
        }
        reviewers[provider] = logins;
    }
    return { id, emit: emission, reviewers };
}
function freeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freeze(child);
        Object.freeze(value);
    }
    return value;
}
export function validateGitHubConnectorConfig(value, options = {}) {
    rejectSecretKeys(value);
    const record = object(value, "config");
    checkUnknownKeys(record, TOP_LEVEL_KEYS);
    if (record.connector !== "github")
        invalid("connector");
    const repositories = array(record.repositories, "repositories").map((entry) => repository(entry));
    if (repositories.length === 0)
        invalid("repository");
    const repositoryNames = new Set();
    for (const entry of repositories) {
        const normalizedName = entry.name.toLowerCase();
        if (repositoryNames.has(normalizedName))
            invalid("repository_duplicate");
        repositoryNames.add(normalizedName);
    }
    const hasConfiguredRepositories = repositories.some((entry) => entry.mode !== "generic-check-runs");
    const rawTriggers = array(record.triggers, "triggers");
    if (rawTriggers.length === 0 && hasConfiguredRepositories)
        invalid("triggers_required");
    if (rawTriggers.length > 0 && !hasConfiguredRepositories)
        invalid("triggers_unused");
    const ids = new Set();
    const triggers = rawTriggers.map((entry) => {
        const normalized = trigger(entry, options.discover === true);
        if (ids.has(normalized.id))
            invalid("trigger_id_duplicate");
        ids.add(normalized.id);
        return normalized;
    });
    const graphqlUrl = record.graphqlUrl === undefined
        ? undefined
        : trustedUrl(record.graphqlUrl, "graphqlUrl", "graphql_url", options);
    if (!hasConfiguredRepositories && record.aggregate !== undefined)
        invalid("aggregate_unused");
    const aggregateConfig = record.aggregate === undefined ? undefined : aggregate(record.aggregate);
    if (aggregateConfig !== undefined && ids.has(aggregateConfig.id))
        invalid("aggregate_id_duplicate");
    const hasCombinedRepositories = repositories.some((entry) => entry.mode === "configured-tools-and-generic-check-runs");
    const verificationConfig = record.verification === undefined
        ? undefined
        : verification(record.verification, triggers, aggregateConfig, hasCombinedRepositories);
    const pollIntervalMs = record.pollIntervalMs === undefined ? 15_000 : record.pollIntervalMs;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 5_000 || pollIntervalMs > 3_600_000)
        invalid("poll_interval");
    const lookbackHours = record.lookbackHours === undefined ? 24 : record.lookbackHours;
    if (!Number.isSafeInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 720)
        invalid("lookback");
    const apiBaseUrl = record.apiBaseUrl === undefined
        ? "https://api.github.com"
        : trustedUrl(record.apiBaseUrl, "apiBaseUrl", "api_url", options);
    let normalizedGraphqlUrl = graphqlUrl;
    if (verificationConfig !== undefined && normalizedGraphqlUrl === undefined) {
        if (apiBaseUrl !== "https://api.github.com")
            invalid("graphql_url_required");
        normalizedGraphqlUrl = "https://api.github.com/graphql";
    }
    const normalized = {
        connector: "github",
        apiBaseUrl,
        ...(normalizedGraphqlUrl === undefined ? {} : { graphqlUrl: normalizedGraphqlUrl }),
        apiVersion: optionalString(record.apiVersion, "apiVersion", "2026-03-10"),
        tokenEnv: optionalString(record.tokenEnv, "tokenEnv", "GITHUB_TOKEN"),
        pollIntervalMs: pollIntervalMs,
        lookbackHours: lookbackHours,
        repositories,
        triggers,
        ...(aggregateConfig === undefined ? {} : { aggregate: aggregateConfig }),
        ...(verificationConfig === undefined ? {} : { verification: verificationConfig }),
    };
    if (!ENV_NAME.test(normalized.tokenEnv))
        invalid("token_env");
    return freeze(normalized);
}
export async function loadGitHubConnectorConfig(path, options = {}) {
    const text = await readFile(path, "utf8");
    return validateGitHubConnectorConfig(JSON.parse(text), options);
}
