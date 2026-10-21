import { GitHubClient, GitHubClientError } from "./client.js";
import { GitHubRelayEmitter, GitHubRelayEmitterError, ciSettledKey } from "./emitter.js";
import { GitHubVerificationError, normalizeVerification, verificationKey } from "./verification.js";
import { discoverPullRequest, discoverPullRequests, deriveSnapshotRequirements, loadPrSnapshot, mapConcurrent, verifyCurrentHead } from "./poller.js";
import { settledCheckRuns } from "./ci.js";
import { normalizeCiSettled } from "./normalize.js";
import { recognizeSonarQube } from "./recognizers/sonarqube.js";
import { recognizeCopilotReviews } from "./recognizers/copilot.js";
import { recognizeCursorBugbot } from "./recognizers/bugbot.js";
class RequestLimiter {
    active = 0;
    queue = [];
    async run(task, signal) {
        if (signal.aborted)
            throw new DOMException("The operation was aborted", "AbortError");
        if (this.active >= 4)
            await new Promise((resolve) => this.queue.push(resolve));
        if (signal.aborted)
            throw new DOMException("The operation was aborted", "AbortError");
        this.active += 1;
        try {
            return await task();
        }
        finally {
            this.active -= 1;
            this.queue.shift()?.();
        }
    }
}
function limitedClient(client, limiter) {
    return {
        listOpenPullRequests: (repository, signal) => limiter.run(() => client.listOpenPullRequests(repository, signal), signal ?? new AbortController().signal),
        listRecentClosedPullRequests: (repository, cutoff, signal) => limiter.run(() => client.listRecentClosedPullRequests(repository, cutoff, signal), signal ?? new AbortController().signal),
        listCompletedCheckRuns: (repository, sha, signal) => limiter.run(() => client.listCompletedCheckRuns(repository, sha, signal), signal ?? new AbortController().signal),
        listCurrentCheckRuns: (repository, sha, signal) => limiter.run(() => client.listCurrentCheckRuns(repository, sha, signal), signal ?? new AbortController().signal),
        listReviews: (repository, number, signal) => limiter.run(() => client.listReviews(repository, number, signal), signal ?? new AbortController().signal),
        listReviewThreads: (repository, number, signal) => limiter.run(() => client.listReviewThreads(repository, number, signal), signal ?? new AbortController().signal),
        getPullRequest: (repository, number, signal) => limiter.run(() => client.getPullRequest(repository, number, signal), signal ?? new AbortController().signal),
    };
}
const recognizers = {
    sonarqube: recognizeSonarQube,
    "copilot-review": recognizeCopilotReviews,
    "cursor-bugbot": recognizeCursorBugbot,
};
export { recognizers };
const DEFAULT_SLEEP = (milliseconds, signal) => new Promise((resolve, reject) => {
    let timer;
    const done = () => {
        if (timer !== undefined)
            clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        resolve();
    };
    const aborted = () => {
        if (timer !== undefined)
            clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        reject(new DOMException("The operation was aborted", "AbortError"));
    };
    if (signal.aborted) {
        aborted();
        return;
    }
    timer = setTimeout(done, Math.max(0, milliseconds));
    signal.addEventListener("abort", aborted, { once: true });
});
function emptySummary(repositories) {
    return { repositories, pullRequests: 0, candidates: 0, emitted: 0, replayed: 0, stale: 0, errors: [] };
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function isAbort(error, signal) {
    return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
function isTransient(error) {
    return error instanceof GitHubClientError && error.code === "github_transient_error";
}
function isNotFound(error) {
    return error instanceof GitHubClientError && error.code === "github_not_found";
}
function isAuthFailure(error) {
    return error instanceof GitHubClientError && error.code === "github_auth_failed";
}
function isFatalRelayFailure(error) {
    if (!(error instanceof GitHubRelayEmitterError))
        return false;
    return error.status === 401 || error.status === 403 || ["credential_failed", "unauthorized", "invalid_runtime"].includes(error.code);
}
function discoveryIdentities(snapshot) {
    const identities = [];
    for (const run of snapshot.checkRuns) {
        identities.push({
            kind: "check_run",
            name: run.name,
            appId: run.app?.id ?? null,
            appSlug: run.app?.slug ?? null,
        });
    }
    for (const review of snapshot.reviews) {
        if (review.user === null)
            continue;
        identities.push({
            kind: "pull_request_review",
            login: review.user.login,
            userId: review.user.id,
            appUrl: review.user.htmlUrl,
        });
    }
    return identities;
}
function logCandidate(log, snapshot, candidate, result) {
    log?.(JSON.stringify({
        connector: "github",
        "repository.id": snapshot.repository.id,
        "repository.fullName": snapshot.repository.fullName,
        "pullRequest.number": snapshot.pullRequest.number,
        "pullRequest.headSha": snapshot.pullRequest.headSha,
        recognizer: candidate.provider,
        triggerId: candidate.triggerId,
        "artifact.kind": candidate.artifactKind,
        "artifact.id": candidate.artifactId,
        result,
    }));
}
function stateFor(states, repository) {
    const existing = states.get(repository);
    if (existing !== undefined)
        return existing;
    const state = {
        transientDelay: 0,
        nextEligibleAt: 0,
        disabled: false,
        ciObservations: new Map(),
        verificationTransientDelay: 0,
        verificationNextEligibleAt: 0,
        verificationObservations: new Map(),
    };
    states.set(repository, state);
    return state;
}
function logVerification(log, event, snapshot, code) {
    const record = {
        connector: "github",
        event,
        repository: snapshot.repository.fullName,
        pullRequest: snapshot.pullRequest.number,
        headSha: snapshot.pullRequest.headSha,
    };
    if (code !== undefined)
        record.code = code;
    log?.(JSON.stringify(record));
}
function clearVerificationObservation(state, pullRequestNumber, headSha) {
    const previous = state.verificationObservations.get(pullRequestNumber);
    if (previous === undefined) {
        state.verificationObservations.set(pullRequestNumber, {
            headSha,
            identity: "",
            consecutive: 0,
            emittedIdentities: new Set(),
        });
    }
    else if (previous.headSha !== headSha) {
        state.verificationObservations.delete(pullRequestNumber);
    }
    else {
        previous.consecutive = 0;
    }
}
async function runRepository(options, client, repository, summary, states, signal, now, onFatal) {
    const repositoryName = repository.name;
    const state = stateFor(states, repositoryName);
    const verification = repository.mode === "configured-tools-and-generic-check-runs"
        ? options.config.verification
        : undefined;
    const verificationEnabled = verification !== undefined;
    if (state.disabled
        || signal.aborted
        || now() < state.nextEligibleAt
        || (repository.mode === "generic-check-runs" && options.disabledCiRepositories?.has(repositoryName)))
        return;
    try {
        const pullRequests = options.pullRequestNumber === undefined
            ? await discoverPullRequests(client, repositoryName, now() - options.config.lookbackHours * 60 * 60 * 1000, signal)
            : [await discoverPullRequest(client, repositoryName, options.pullRequestNumber, signal)];
        summary.pullRequests += pullRequests.length;
        state.transientDelay = 0;
        state.nextEligibleAt = 0;
        const configured = repository.mode !== "generic-check-runs";
        const generic = repository.mode !== "configured-tools";
        const ciEnabled = generic && !options.disabledCiRepositories?.has(repositoryName);
        const verificationChecks = verificationEnabled && !options.discover;
        const configuredRequirements = deriveSnapshotRequirements(options.config.triggers);
        const snapshots = await mapConcurrent(pullRequests, 4, async (pullRequest) => {
            const configuredSnapshot = configured
                ? await loadPrSnapshot(client, repositoryName, pullRequest, configuredRequirements, signal)
                : undefined;
            const genericSnapshot = generic && (!options.discover || !configured) && (ciEnabled || verificationChecks)
                ? await loadPrSnapshot(client, repositoryName, pullRequest, { checkRuns: "current", reviews: false }, signal)
                : undefined;
            return { configuredSnapshot, genericSnapshot };
        });
        for (const { configuredSnapshot, genericSnapshot } of snapshots) {
            if (options.discover) {
                const discoverySnapshot = configuredSnapshot ?? genericSnapshot;
                if (discoverySnapshot !== undefined) {
                    for (const identity of discoveryIdentities(discoverySnapshot)) {
                        options.onDiscovery?.({
                            repository: discoverySnapshot.repository.fullName,
                            pullRequest: discoverySnapshot.pullRequest.number,
                            ...identity,
                        });
                    }
                }
                if (configuredSnapshot === undefined)
                    continue;
            }
            let recognizedByTrigger = new Map();
            let erroredTriggers = new Set();
            if (configuredSnapshot !== undefined) {
                const snapshot = configuredSnapshot;
                recognizedByTrigger = new Map();
                erroredTriggers = new Set();
                for (const trigger of options.config.triggers) {
                    if (options.disabledTriggers?.has(trigger.id))
                        continue;
                    const configuredRecognizers = options.recognizers ?? {};
                    const recognizer = configuredRecognizers[trigger.recognizer] ?? recognizers[trigger.recognizer];
                    let candidates;
                    try {
                        candidates = recognizer(snapshot, trigger);
                        recognizedByTrigger.set(trigger.id, [...candidates]);
                    }
                    catch (error) {
                        erroredTriggers.add(trigger.id);
                        summary.errors.push(`recognizer ${trigger.id}: ${errorText(error)}`);
                        continue;
                    }
                    for (const candidate of candidates) {
                        summary.candidates += 1;
                        logCandidate(options.log, snapshot, candidate, "recognized");
                        if (options.discover || options.emitter === undefined)
                            continue;
                        try {
                            const verifyHead = options.headVerifier ?? options.verifyCurrentHead ?? ((candidateToVerify, verifySignal) => verifyCurrentHead(client, candidateToVerify, verifySignal));
                            const current = await verifyHead({ repository: repositoryName, pullRequestNumber: candidate.pullRequestNumber, artifactHeadSha: candidate.artifactHeadSha }, signal);
                            if (!current) {
                                summary.stale += 1;
                                logCandidate(options.log, snapshot, candidate, "stale");
                                continue;
                            }
                            const result = await options.emitter.emit(trigger, snapshot, candidate, signal);
                            if (result === "emitted")
                                summary.emitted += 1;
                            else
                                summary.replayed += 1;
                            logCandidate(options.log, snapshot, candidate, result);
                        }
                        catch (error) {
                            if (isAuthFailure(error) || isTransient(error))
                                throw error;
                            if (isFatalRelayFailure(error)) {
                                onFatal(error);
                                throw error;
                            }
                            if (isAbort(error, signal))
                                throw error;
                            erroredTriggers.add(trigger.id);
                            if (error instanceof GitHubRelayEmitterError && (error.code === "trigger_drift" || error.code === "trigger_invalid")) {
                                options.disabledTriggers?.add(trigger.id);
                                summary.errors.push(`${error.code}: ${errorText(error)}`);
                                logCandidate(options.log, snapshot, candidate, "error");
                                break;
                            }
                            summary.errors.push(`emission ${candidate.artifactId}: ${errorText(error)}`);
                            logCandidate(options.log, snapshot, candidate, "error");
                        }
                    }
                }
                const aggregate = options.config.aggregate;
                const aggregateCandidates = options.config.triggers.flatMap((trigger) => recognizedByTrigger.get(trigger.id) ?? []);
                const aggregateReady = aggregate !== undefined
                    && !options.discover
                    && options.emitter !== undefined
                    && !options.disabledAggregates?.has(aggregate.id)
                    && options.config.triggers.every((trigger) => !options.disabledTriggers?.has(trigger.id)
                        && !erroredTriggers.has(trigger.id)
                        && (recognizedByTrigger.get(trigger.id)?.length ?? 0) > 0);
                if (aggregateReady) {
                    try {
                        const verifyHead = options.headVerifier ?? options.verifyCurrentHead ?? ((candidateToVerify, verifySignal) => verifyCurrentHead(client, candidateToVerify, verifySignal));
                        const current = await verifyHead({
                            repository: repositoryName,
                            pullRequestNumber: snapshot.pullRequest.number,
                            artifactHeadSha: snapshot.pullRequest.headSha,
                        }, signal);
                        if (current) {
                            const result = await options.emitter.emitAggregate(aggregate, snapshot, aggregateCandidates, signal);
                            if (result === "emitted")
                                summary.emitted += 1;
                            else
                                summary.replayed += 1;
                        }
                    }
                    catch (error) {
                        if (isAuthFailure(error) || isTransient(error))
                            throw error;
                        if (isFatalRelayFailure(error)) {
                            onFatal(error);
                            throw error;
                        }
                        if (isAbort(error, signal))
                            throw error;
                        if (error instanceof GitHubRelayEmitterError && (error.code === "aggregate_drift" || error.code === "aggregate_invalid")) {
                            options.disabledAggregates?.add(aggregate.id);
                            summary.errors.push(`${error.code}: ${errorText(error)}`);
                        }
                        else {
                            summary.errors.push(`aggregate ${aggregate.id}: ${errorText(error)}`);
                        }
                    }
                }
            }
            if (genericSnapshot !== undefined) {
                const snapshot = genericSnapshot;
                const checks = settledCheckRuns(snapshot);
                if (checks !== undefined) {
                    if (ciEnabled)
                        summary.candidates += checks.length;
                    const identity = ciSettledKey(normalizeCiSettled(snapshot, checks));
                    const previous = state.ciObservations.get(snapshot.pullRequest.number);
                    const observation = previous === undefined || previous.headSha !== snapshot.pullRequest.headSha
                        ? { headSha: snapshot.pullRequest.headSha, identity, consecutive: 1, emittedIdentities: new Set() }
                        : previous;
                    if (observation !== previous) {
                        state.ciObservations.set(snapshot.pullRequest.number, observation);
                    }
                    else if (observation.identity !== identity) {
                        observation.identity = identity;
                        observation.consecutive = 1;
                    }
                    else {
                        observation.consecutive += 1;
                    }
                    if (ciEnabled
                        && options.emitter !== undefined
                        && (options.once || observation.consecutive >= 2)
                        && !observation.emittedIdentities.has(identity)) {
                        const verifyHead = options.headVerifier
                            ?? options.verifyCurrentHead
                            ?? ((candidate, verifySignal) => verifyCurrentHead(client, candidate, verifySignal));
                        try {
                            const current = await verifyHead({
                                repository: repositoryName,
                                pullRequestNumber: snapshot.pullRequest.number,
                                artifactHeadSha: snapshot.pullRequest.headSha,
                            }, signal);
                            if (!current) {
                                state.ciObservations.delete(snapshot.pullRequest.number);
                                summary.stale += 1;
                            }
                            else {
                                const result = await options.emitter.emitCiSettled(snapshot, checks, signal);
                                if (result === "emitted")
                                    summary.emitted += 1;
                                else
                                    summary.replayed += 1;
                                observation.emittedIdentities.add(identity);
                            }
                        }
                        catch (error) {
                            if (isAuthFailure(error) || isTransient(error))
                                throw error;
                            if (isFatalRelayFailure(error)) {
                                onFatal(error);
                                throw error;
                            }
                            if (isAbort(error, signal))
                                throw error;
                            if (error instanceof GitHubRelayEmitterError && (error.code === "ci_drift" || error.code === "ci_invalid")) {
                                options.disabledCiRepositories?.add(repositoryName);
                                summary.errors.push(`${error.code}: ${errorText(error)}`);
                            }
                            else {
                                summary.errors.push(`emission ci ${snapshot.pullRequest.number}: ${errorText(error)}`);
                            }
                        }
                    }
                }
                else {
                    state.ciObservations.delete(snapshot.pullRequest.number);
                }
            }
            if (verificationEnabled
                && verification !== undefined
                && configuredSnapshot !== undefined
                && genericSnapshot !== undefined
                && options.emitter !== undefined
                && !options.discover
                && !options.disabledVerificationRepositories?.has(repositoryName)) {
                const snapshot = configuredSnapshot;
                const number = snapshot.pullRequest.number;
                const checks = settledCheckRuns(genericSnapshot);
                const automationReady = options.config.triggers.every((trigger) => !options.disabledTriggers?.has(trigger.id)
                    && !erroredTriggers.has(trigger.id)
                    && (recognizedByTrigger.get(trigger.id)?.length ?? 0) > 0);
                if (!automationReady) {
                    clearVerificationObservation(state, number, snapshot.pullRequest.headSha);
                    logVerification(options.log, "verification_pending_automation", snapshot);
                }
                else if (checks === undefined) {
                    clearVerificationObservation(state, number, snapshot.pullRequest.headSha);
                    logVerification(options.log, "verification_pending_checks", snapshot);
                }
                else if (now() < state.verificationNextEligibleAt) {
                    continue;
                }
                else {
                    let threads;
                    try {
                        threads = await client.listReviewThreads(repositoryName, number, signal);
                        state.verificationTransientDelay = 0;
                        state.verificationNextEligibleAt = 0;
                    }
                    catch (error) {
                        if (isAuthFailure(error))
                            throw error;
                        if (isAbort(error, signal))
                            throw error;
                        clearVerificationObservation(state, number, snapshot.pullRequest.headSha);
                        if (isTransient(error)) {
                            state.verificationTransientDelay = state.verificationTransientDelay === 0
                                ? options.config.pollIntervalMs
                                : Math.min(options.config.pollIntervalMs * 8, state.verificationTransientDelay * 2);
                            state.verificationNextEligibleAt = now() + state.verificationTransientDelay;
                        }
                        summary.errors.push(`verification ${repositoryName}: ${errorText(error)}`);
                        logVerification(options.log, "verification_error", snapshot, error instanceof GitHubClientError ? error.code : undefined);
                        continue;
                    }
                    let payload;
                    try {
                        payload = normalizeVerification(snapshot, options.config.triggers.flatMap((trigger) => recognizedByTrigger.get(trigger.id) ?? []), checks, threads, verification);
                    }
                    catch (error) {
                        const code = error instanceof GitHubVerificationError ? error.code : "verification_error";
                        clearVerificationObservation(state, number, snapshot.pullRequest.headSha);
                        summary.errors.push(`${code}: ${errorText(error)}`);
                        logVerification(options.log, "verification_error", snapshot, code);
                        continue;
                    }
                    let identity;
                    try {
                        identity = verificationKey(payload);
                    }
                    catch (error) {
                        const code = error instanceof GitHubVerificationError ? error.code : "verification_error";
                        clearVerificationObservation(state, number, snapshot.pullRequest.headSha);
                        summary.errors.push(`${code}: ${errorText(error)}`);
                        logVerification(options.log, "verification_error", snapshot, code);
                        continue;
                    }
                    const previous = state.verificationObservations.get(number);
                    const observation = previous === undefined || previous.headSha !== snapshot.pullRequest.headSha
                        ? { headSha: snapshot.pullRequest.headSha, identity, consecutive: 1, emittedIdentities: new Set() }
                        : previous;
                    if (observation !== previous) {
                        state.verificationObservations.set(number, observation);
                    }
                    else if (observation.identity !== identity) {
                        observation.identity = identity;
                        observation.consecutive = 1;
                    }
                    else {
                        observation.consecutive += 1;
                    }
                    if (!options.once && observation.consecutive < 2) {
                        logVerification(options.log, "verification_pending_stability", snapshot);
                        continue;
                    }
                    if (observation.emittedIdentities.has(identity))
                        continue;
                    const verifyHead = options.headVerifier
                        ?? options.verifyCurrentHead
                        ?? ((candidate, verifySignal) => verifyCurrentHead(client, candidate, verifySignal));
                    try {
                        const current = await verifyHead({
                            repository: repositoryName,
                            pullRequestNumber: number,
                            artifactHeadSha: snapshot.pullRequest.headSha,
                        }, signal);
                        if (!current) {
                            state.verificationObservations.delete(number);
                            summary.stale += 1;
                            continue;
                        }
                        const result = await options.emitter.emitVerification(verification, snapshot, payload, signal);
                        if (result === "emitted")
                            summary.emitted += 1;
                        else
                            summary.replayed += 1;
                        observation.emittedIdentities.add(identity);
                        logVerification(options.log, result === "emitted" ? "verification_emitted" : "verification_replayed", snapshot);
                    }
                    catch (error) {
                        if (isAuthFailure(error) || isTransient(error))
                            throw error;
                        if (isFatalRelayFailure(error)) {
                            onFatal(error);
                            throw error;
                        }
                        if (isAbort(error, signal))
                            throw error;
                        if (error instanceof GitHubRelayEmitterError && (error.code === "verification_drift" || error.code === "verification_invalid")) {
                            options.disabledVerificationRepositories?.add(repositoryName);
                            summary.errors.push(`${error.code}: ${errorText(error)}`);
                        }
                        else {
                            summary.errors.push(`emission verification ${number}: ${errorText(error)}`);
                        }
                        logVerification(options.log, "verification_error", snapshot, error instanceof GitHubRelayEmitterError ? error.code : undefined);
                    }
                }
            }
        }
        if (!options.discover) {
            const returned = new Set(pullRequests.map((pullRequest) => pullRequest.number));
            if (generic) {
                for (const number of state.ciObservations.keys()) {
                    if (!returned.has(number))
                        state.ciObservations.delete(number);
                }
            }
            if (verificationEnabled) {
                for (const number of state.verificationObservations.keys()) {
                    if (!returned.has(number))
                        state.verificationObservations.delete(number);
                }
            }
        }
    }
    catch (error) {
        if (isAuthFailure(error)) {
            onFatal(error);
            throw error;
        }
        if (isAbort(error, signal))
            return;
        if (isNotFound(error)) {
            state.disabled = true;
            summary.errors.push(`repository ${repositoryName}: not found`);
            return;
        }
        if (isTransient(error)) {
            state.transientDelay = state.transientDelay === 0 ? options.config.pollIntervalMs : Math.min(options.config.pollIntervalMs * 8, state.transientDelay * 2);
            state.nextEligibleAt = now() + state.transientDelay;
            summary.errors.push(`repository ${repositoryName}: ${errorText(error)}`);
            return;
        }
        summary.errors.push(`repository ${repositoryName}: ${errorText(error)}`);
    }
}
function validatePullRequestSelection(config, pullRequestNumber) {
    if (pullRequestNumber === undefined)
        return;
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
        throw new Error("pull request number must be a positive safe integer");
    }
    if (config.repositories.length !== 1) {
        throw new Error("pull request selection requires exactly one configured repository");
    }
}
export async function runGitHubCycle(options) {
    validatePullRequestSelection(options.config, options.pullRequestNumber);
    const parentSignal = options.signal ?? new AbortController().signal;
    const cycleController = new AbortController();
    const abortCycle = () => cycleController.abort();
    if (parentSignal.aborted)
        cycleController.abort();
    else
        parentSignal.addEventListener("abort", abortCycle, { once: true });
    const signal = cycleController.signal;
    const now = options.now ?? options.clock ?? Date.now;
    const states = options.state ?? new Map();
    const summary = emptySummary(options.config.repositories.length);
    const client = limitedClient(options.client, new RequestLimiter());
    const cycleOptions = {
        ...options,
        disabledTriggers: options.disabledTriggers ?? new Set(),
        disabledAggregates: options.disabledAggregates ?? new Set(),
        disabledCiRepositories: options.disabledCiRepositories ?? new Set(),
        disabledVerificationRepositories: options.disabledVerificationRepositories ?? new Set(),
    };
    let fatal;
    const onFatal = (error) => {
        if (fatal === undefined)
            fatal = error;
        cycleController.abort();
    };
    try {
        await mapConcurrent(options.config.repositories, 4, async (repository) => {
            try {
                await runRepository(cycleOptions, client, repository, summary, states, signal, now, onFatal);
            }
            catch (error) {
                if (!isAbort(error, signal))
                    onFatal(error);
            }
        });
    }
    finally {
        parentSignal.removeEventListener("abort", abortCycle);
    }
    if (fatal !== undefined)
        throw fatal;
    return summary;
}
export async function runGitHubConnector(options) {
    validatePullRequestSelection(options.config, options.pullRequestNumber);
    const signal = options.signal ?? new AbortController().signal;
    const sleep = options.sleep ?? DEFAULT_SLEEP;
    const state = options.state ?? new Map();
    const total = emptySummary(options.config.repositories.length);
    const disabledTriggers = options.disabledTriggers ?? new Set();
    const disabledAggregates = options.disabledAggregates ?? new Set();
    const disabledCiRepositories = options.disabledCiRepositories ?? new Set();
    const disabledVerificationRepositories = options.disabledVerificationRepositories ?? new Set();
    const merge = (summary) => {
        total.pullRequests += summary.pullRequests;
        total.candidates += summary.candidates;
        total.emitted += summary.emitted;
        total.replayed += summary.replayed;
        total.stale += summary.stale;
        total.errors.push(...summary.errors);
    };
    do {
        const cycle = await runGitHubCycle({ ...options, signal, sleep, state, disabledTriggers, disabledAggregates, disabledCiRepositories, disabledVerificationRepositories });
        merge(cycle);
        if (options.once || options.discover || signal.aborted)
            break;
        try {
            await sleep(options.config.pollIntervalMs, signal);
        }
        catch (error) {
            if (!isAbort(error, signal))
                throw error;
            break;
        }
    } while (!options.once);
    return total;
}
