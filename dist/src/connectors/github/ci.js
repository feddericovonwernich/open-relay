function validIdentity(snapshot) {
    return snapshot.repository.fullName.length > 0
        && snapshot.pullRequest.url.length > 0
        && snapshot.pullRequest.headSha.length > 0
        && snapshot.pullRequest.baseRef.length > 0;
}
function validCheck(check, headSha) {
    return check.status === "completed"
        && check.headSha === headSha
        && Number.isSafeInteger(check.id)
        && check.id > 0
        && check.name.length > 0
        && typeof check.completedAt === "string"
        && check.completedAt.length > 0;
}
export function settledCheckRuns(snapshot) {
    if (!validIdentity(snapshot) || snapshot.checkRuns.length === 0)
        return undefined;
    if (!snapshot.checkRuns.every((check) => validCheck(check, snapshot.pullRequest.headSha)))
        return undefined;
    const checks = snapshot.checkRuns.map((check) => Object.freeze({ ...check }));
    checks.sort((left, right) => left.id - right.id || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return Object.freeze(checks);
}
