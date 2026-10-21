import { createHash } from "node:crypto";
import { normalizeCiSettled, normalizeSettled } from "./normalize.js";
const MAX_FINDINGS = 20;
const MAX_BODY_CODE_POINTS = 2_000;
const REVIEWS_MAX_BYTES = 48 * 1024;
const PAYLOAD_MAX_BYTES = 65_536;
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const PROVIDERS = ["copilot-review", "cursor-bugbot"];
const INVESTIGATE_MESSAGE = "Investigate the failed CI checks. Fix failures caused by the change when possible. Otherwise report the cause and why it could not be fixed automatically.";
const RESOLVE_MESSAGE = "Review the unresolved Bugbot/Copilot comments. If a finding is valid, implement a fix. In every case, reply with the result and resolve the thread when addressed.";
const VERIFY_MESSAGE = "Verify the completed neutral Bugbot result. Confirm whether the run contains findings, cancellation, or an internal error before treating the review as successful.";
function freezeDeep(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freezeDeep(child);
        Object.freeze(value);
    }
    return value;
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function compareFinding(left, right) {
    const providerOrder = compareText(left.provider, right.provider);
    if (providerOrder !== 0)
        return providerOrder;
    const pathOrder = compareText(left.path, right.path);
    if (pathOrder !== 0)
        return pathOrder;
    if (left.line === null && right.line !== null)
        return 1;
    if (left.line !== null && right.line === null)
        return -1;
    if (left.line !== right.line)
        return (left.line ?? 0) - (right.line ?? 0);
    return compareText(left.threadId, right.threadId);
}
function compareDigest(left, right) {
    const providerOrder = compareText(left.provider, right.provider);
    if (providerOrder !== 0)
        return providerOrder;
    return compareText(left.threadId, right.threadId);
}
function bodyForWire(body) {
    const codePoints = Array.from(body);
    if (codePoints.length <= MAX_BODY_CODE_POINTS)
        return { body, bodyTruncated: false };
    return { body: codePoints.slice(0, MAX_BODY_CODE_POINTS).join(""), bodyTruncated: true };
}
export class GitHubVerificationError extends Error {
    code = "verification_payload_too_large";
    constructor() {
        super("verification payload exceeds 65536 bytes");
        this.name = "GitHubVerificationError";
    }
}
export function normalizeVerification(snapshot, candidates, checks, threads, verification) {
    const providerByLogin = {};
    for (const provider of PROVIDERS) {
        for (const login of verification.reviewers[provider] ?? []) {
            const normalizedLogin = login.toLowerCase();
            if (providerByLogin[normalizedLogin] === undefined)
                providerByLogin[normalizedLogin] = provider;
        }
    }
    const matching = threads.filter((item) => !item.isResolved && providerByLogin[item.rootComment.authorLogin.toLowerCase()] !== undefined);
    const digestRecords = matching.map((item) => ({
        provider: providerByLogin[item.rootComment.authorLogin.toLowerCase()],
        threadId: item.id,
        isResolved: item.isResolved,
        isOutdated: item.isOutdated,
        path: item.path,
        startLine: item.startLine,
        line: item.line,
        rootCommentId: item.rootComment.id,
        authorLogin: item.rootComment.authorLogin,
        updatedAt: item.rootComment.updatedAt,
        bodyHash: createHash("sha256").update(item.rootComment.body).digest("hex"),
    }));
    digestRecords.sort(compareDigest);
    const evidenceDigest = createHash("sha256").update(JSON.stringify(digestRecords)).digest("hex");
    const canonicalCandidates = matching.map((item) => {
        const wireBody = bodyForWire(item.rootComment.body);
        return {
            provider: providerByLogin[item.rootComment.authorLogin.toLowerCase()],
            threadId: item.id,
            rootCommentId: item.rootComment.id,
            authorLogin: item.rootComment.authorLogin,
            url: item.rootComment.url,
            path: item.path,
            startLine: item.startLine,
            line: item.line,
            isOutdated: item.isOutdated,
            body: wireBody.body,
            bodyTruncated: wireBody.bodyTruncated,
            replyCount: Math.max(0, item.commentCount - 1),
        };
    });
    canonicalCandidates.sort(compareFinding);
    const totalReplyCount = matching.reduce((sum, item) => sum + Math.max(0, item.commentCount - 1), 0);
    const findings = [];
    const reviewBase = {
        unresolvedCount: matching.length,
        includedCount: 0,
        totalReplyCount,
        truncated: false,
        evidenceDigest,
    };
    for (const finding of canonicalCandidates) {
        if (findings.length >= MAX_FINDINGS)
            break;
        const nextFindings = [...findings, finding];
        const nextReviews = { ...reviewBase, includedCount: nextFindings.length, findings: nextFindings };
        if (Buffer.byteLength(JSON.stringify(nextReviews), "utf8") > REVIEWS_MAX_BYTES)
            break;
        findings.push(finding);
    }
    const truncated = findings.length < matching.length;
    const automationPayload = normalizeSettled(snapshot, candidates);
    const automation = { artifacts: automationPayload.artifacts };
    const ciPayload = normalizeCiSettled(snapshot, checks);
    const ci = { outcome: ciPayload.outcome, checks: ciPayload.checks };
    const failingNames = [...new Set(ci.checks.filter((check) => !PASSING_CONCLUSIONS.has(check.conclusion ?? "")).map((check) => check.name))].sort();
    const actions = [];
    if (failingNames.length > 0) {
        actions.push({ code: "investigate_ci_failures", checkNames: failingNames, message: INVESTIGATE_MESSAGE });
    }
    const providers = [...new Set(canonicalCandidates.map((finding) => finding.provider))].sort();
    if (matching.length > 0) {
        actions.push({ code: "resolve_review_findings", providers, findingCount: matching.length, message: RESOLVE_MESSAGE });
    }
    const hasUnresolvedBugbot = canonicalCandidates.some((finding) => finding.provider === "cursor-bugbot");
    if (!hasUnresolvedBugbot) {
        const neutralBugbot = automation.artifacts.find((artifact) => artifact.provider === "cursor-bugbot" && artifact.kind === "check_run" && artifact.conclusion === "neutral");
        if (neutralBugbot)
            actions.push({ code: "verify_review_result", provider: "cursor-bugbot", checkName: neutralBugbot.name, message: VERIFY_MESSAGE });
    }
    return freezeDeep({
        schemaVersion: 1,
        provider: "github",
        repository: { id: snapshot.repository.id, fullName: snapshot.repository.fullName },
        pullRequest: {
            number: snapshot.pullRequest.number,
            url: snapshot.pullRequest.url,
            headSha: snapshot.pullRequest.headSha,
            baseRef: snapshot.pullRequest.baseRef,
        },
        verdict: actions.length === 0 ? "success" : "action_required",
        automation,
        ci: { ...ci, failingCheckNames: failingNames },
        reviews: {
            ...reviewBase,
            includedCount: findings.length,
            truncated,
            findings,
        },
        actions,
    });
}
export function verificationKey(payload) {
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_MAX_BYTES)
        throw new GitHubVerificationError();
    const hash = createHash("sha256").update(serialized).digest("hex");
    return `github:${payload.repository.id}:verification-settled:pull-request:${payload.pullRequest.number}:head:${payload.pullRequest.headSha}:payload:${hash}`;
}
