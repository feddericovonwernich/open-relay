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
