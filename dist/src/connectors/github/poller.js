function assertRepository(pr, repository) {
    if (pr.repositoryFullName.toLowerCase() !== repository.toLowerCase()) {
        throw new Error(`GitHub PR ${pr.number} belongs to ${pr.repositoryFullName}, not ${repository}`);
    }
}
export function deriveSnapshotRequirements(triggers) {
    return {
        checkRuns: triggers.some((trigger) => trigger.recognizer === "sonarqube" || trigger.recognizer === "cursor-bugbot"),
        reviews: triggers.some((trigger) => trigger.recognizer === "copilot-review"),
    };
}
export async function discoverPullRequest(client, repository, pullRequestNumber, signal) {
    const pullRequest = await client.getPullRequest(repository, pullRequestNumber, signal);
    assertRepository(pullRequest, repository);
    return pullRequest;
}
export async function discoverPullRequests(client, repository, cutoff, signal) {
    const [open, closed] = await Promise.all([
        client.listOpenPullRequests(repository, signal),
        client.listRecentClosedPullRequests(repository, cutoff, signal),
    ]);
    const byNumber = new Map();
    for (const pullRequest of [...open, ...closed]) {
        assertRepository(pullRequest, repository);
        const previous = byNumber.get(pullRequest.number);
        if (previous === undefined || Date.parse(pullRequest.updatedAt) > Date.parse(previous.updatedAt)) {
            byNumber.set(pullRequest.number, pullRequest);
        }
    }
    return [...byNumber.values()].sort((left, right) => left.number - right.number);
}
export async function loadPrSnapshot(client, repository, pullRequest, requirements, signal) {
    assertRepository(pullRequest, repository);
    const [checkRuns, reviews] = await Promise.all([
        requirements.checkRuns ? client.listCompletedCheckRuns(repository, pullRequest.headSha, signal) : Promise.resolve([]),
        requirements.reviews ? client.listReviews(repository, pullRequest.number, signal) : Promise.resolve([]),
    ]);
    return {
        repository: { id: pullRequest.repositoryId, fullName: pullRequest.repositoryFullName },
        pullRequest: {
            number: pullRequest.number,
            url: pullRequest.url,
            headSha: pullRequest.headSha,
            baseRef: pullRequest.baseRef,
            updatedAt: pullRequest.updatedAt,
        },
        checkRuns: Object.freeze(checkRuns),
        reviews: Object.freeze(reviews),
    };
}
export async function verifyCurrentHead(client, candidate, signal) {
    const current = await client.getPullRequest(candidate.repository, candidate.pullRequestNumber, signal);
    if (current.repositoryFullName.toLowerCase() !== candidate.repository.toLowerCase())
        return false;
    return current.headSha === candidate.artifactHeadSha;
}
export async function mapConcurrent(items, limit, mapper) {
    if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError("concurrency limit must be a positive integer");
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const index = next++;
            if (index >= items.length)
                return;
            results[index] = await mapper(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
}
