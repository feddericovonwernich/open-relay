function freezeDeep(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freezeDeep(child);
        Object.freeze(value);
    }
    return value;
}
/** Build the stable, provider-independent payload without copying source objects. */
export function normalizeCompletion(snapshot, candidate) {
    return freezeDeep({
        schemaVersion: 1,
        provider: candidate.provider,
        repository: {
            id: snapshot.repository.id,
            fullName: snapshot.repository.fullName,
        },
        pullRequest: {
            number: snapshot.pullRequest.number,
            url: snapshot.pullRequest.url,
            headSha: snapshot.pullRequest.headSha,
            baseRef: snapshot.pullRequest.baseRef,
        },
        artifact: {
            kind: candidate.artifactKind,
            id: candidate.artifactId,
            name: candidate.artifact.name,
            completion: candidate.artifact.completion,
            conclusion: candidate.artifact.conclusion,
            completedAt: candidate.artifact.completedAt,
            detailsUrl: candidate.artifact.detailsUrl,
        },
    });
}
export function normalizeSettled(snapshot, candidates) {
    const artifacts = candidates.map((candidate) => ({
        triggerId: candidate.triggerId,
        provider: candidate.provider,
        kind: candidate.artifactKind,
        id: candidate.artifactId,
        name: candidate.artifact.name,
        completion: candidate.artifact.completion,
        conclusion: candidate.artifact.conclusion,
        completedAt: candidate.artifact.completedAt,
        detailsUrl: candidate.artifact.detailsUrl,
    }));
    artifacts.sort((left, right) => {
        const triggerOrder = left.triggerId < right.triggerId ? -1 : left.triggerId > right.triggerId ? 1 : 0;
        if (triggerOrder !== 0)
            return triggerOrder;
        const kindOrder = left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
        return kindOrder !== 0 ? kindOrder : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
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
        artifacts,
    });
}
export function normalizeCiSettled(snapshot, checks) {
    const normalized = checks.map((check) => ({
        id: String(check.id),
        name: check.name,
        conclusion: check.conclusion,
        completedAt: check.completedAt ?? "",
        detailsUrl: check.detailsUrl,
    }));
    normalized.sort((left, right) => {
        const idOrder = Number(left.id) - Number(right.id);
        return idOrder !== 0 ? idOrder : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
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
        outcome: normalized.every(({ conclusion }) => conclusion === "success" || conclusion === "neutral" || conclusion === "skipped")
            ? "success"
            : "failure",
        checks: normalized,
    });
}
