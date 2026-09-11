import assert from "node:assert/strict";
import test from "node:test";
import { ciSettledKey, completionKey, GitHubRelayEmitter, pullRequestCorrelationId, settledKey } from "../src/connectors/github/emitter.ts";
import { normalizeCiSettled, normalizeCompletion, normalizeSettled } from "../src/connectors/github/normalize.ts";
import type { CompletionCandidate, GitHubCheckRun, PrSnapshot, TriggerConfig } from "../src/connectors/github/types.ts";

const trigger: TriggerConfig = {
  id: "copilot-v1",
  recognizer: "copilot-review",
  match: { userIds: [42], appUrls: [], logins: [] },
  emit: { type: "pr.automation.completed", version: 1 },
};

const snapshot: PrSnapshot = {
  repository: { id: 7, fullName: "example/repo" },
  pullRequest: { number: 12, url: "https://github.com/example/repo/pull/12", headSha: "head-1", baseRef: "main", updatedAt: "2026-09-08T00:00:00Z" },
  checkRuns: [],
  reviews: [],
};

const candidate: CompletionCandidate = {
  provider: "copilot-review",
  triggerId: "copilot-v1",
  repositoryId: 7,
  pullRequestNumber: 12,
  artifactKind: "pull_request_review",
  artifactId: "42",
  artifactHeadSha: "head-1",
  artifact: {
    name: "GitHub Copilot review",
    completion: "submitted",
    conclusion: "submitted",
    completedAt: "2026-09-08T00:00:00Z",
    detailsUrl: null,
  },
};
const aggregate = { id: "settled-v1", emit: { type: "pr.automation.settled", version: 1 } };
const ciCheck = (overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun => ({
  id: 2,
  name: "build",
  status: "completed",
  conclusion: "success",
  headSha: "head-1",
  completedAt: "2026-09-08T01:00:00Z",
  detailsUrl: "https://ci.example/build/2",
  app: null,
  pullRequests: [],
  ...overrides,
});

function candidateFor(triggerId: string, kind: CompletionCandidate["artifactKind"], id: string): CompletionCandidate {
  return {
    ...candidate,
    triggerId,
    artifactKind: kind,
    artifactId: id,
    artifact: {
      ...candidate.artifact,
      completion: kind === "check_run" ? "completed" : "submitted",
    },
  };
}
function errorCode(value: unknown): unknown {
  return value !== null && typeof value === "object" && "code" in value ? value.code : undefined;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function requestUrl(input: URL | RequestInfo): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
}


test("normalizes a fresh immutable payload and excludes mutable/private fields", () => {
  const source = structuredClone(snapshot) as PrSnapshot & { observedAt?: string };
  source.observedAt = "now";
  const privateCandidate = structuredClone(candidate) as CompletionCandidate & { isCurrentHead?: boolean; reviewBody?: string };
  privateCandidate.isCurrentHead = true;
  privateCandidate.reviewBody = "review body";
  const payload = normalizeCompletion(source, privateCandidate);

  assert.deepEqual(payload, {
    schemaVersion: 1,
    provider: "copilot-review",
    repository: { id: 7, fullName: "example/repo" },
    pullRequest: { number: 12, url: "https://github.com/example/repo/pull/12", headSha: "head-1", baseRef: "main" },
    artifact: {
      kind: "pull_request_review",
      id: "42",
      name: "GitHub Copilot review",
      completion: "submitted",
      conclusion: "submitted",
      completedAt: "2026-09-08T00:00:00Z",
      detailsUrl: null,
    },
  });
  assert.equal(JSON.stringify(payload).includes("review body"), false);
  assert.equal("observedAt" in payload, false);
  assert.equal("isCurrentHead" in payload, false);
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.artifact), true);
});
test("normalizes all settled candidates in deterministic immutable order", () => {
  const payload = normalizeSettled(snapshot, [
    candidateFor("z-trigger", "check_run", "2"),
    candidateFor("a-trigger", "pull_request_review", "9"),
    candidateFor("a-trigger", "check_run", "1"),
  ]);
  assert.deepEqual(payload, {
    schemaVersion: 1,
    provider: "github",
    repository: { id: 7, fullName: "example/repo" },
    pullRequest: { number: 12, url: snapshot.pullRequest.url, headSha: "head-1", baseRef: "main" },
    artifacts: [
      { triggerId: "a-trigger", provider: "copilot-review", kind: "check_run", id: "1", name: "GitHub Copilot review", completion: "completed", conclusion: "submitted", completedAt: candidate.artifact.completedAt, detailsUrl: null },
      { triggerId: "a-trigger", provider: "copilot-review", kind: "pull_request_review", id: "9", name: "GitHub Copilot review", completion: "submitted", conclusion: "submitted", completedAt: candidate.artifact.completedAt, detailsUrl: null },
      { triggerId: "z-trigger", provider: "copilot-review", kind: "check_run", id: "2", name: "GitHub Copilot review", completion: "completed", conclusion: "submitted", completedAt: candidate.artifact.completedAt, detailsUrl: null },
    ],
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.artifacts), true);
  assert.equal(Object.isFrozen(payload.artifacts[0]), true);
});

test("settled key is membership-based and mapping-independent", () => {
  const candidates = [candidateFor("b", "check_run", "2"), candidateFor("a", "check_run", "1")];
  const reversed = [...candidates].reverse();
  assert.equal(settledKey(aggregate, snapshot, candidates), settledKey({ ...aggregate, emit: { type: "other", version: 9 } }, snapshot, reversed));
  assert.match(settledKey(aggregate, snapshot, candidates), /^github:7:aggregate:settled-v1:pull-request:12:head:head-1:members:[a-f0-9]{64}$/);
});

test("issues one repository-scoped producer and distinguishes created from replayed", async () => {
  const requests: Request[] = [];
  let eventCalls = 0;
  const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    if (requestUrl(input).pathname === "/v1/credentials") return response(201, { token: "producer-secret" });
    eventCalls += 1;
    return response(eventCalls === 1 ? 201 : 200, { event: { id: "event-1" } });
  };
  const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher });

  assert.equal(await emitter.emit(trigger, snapshot, candidate), "emitted");
  assert.equal(await emitter.emit(trigger, snapshot, candidate), "replayed");
  assert.equal(requests.filter((request) => new URL(request.url).pathname === "/v1/credentials").length, 1);
  const event = requests.find((request) => new URL(request.url).pathname === "/v1/events");
  assert.ok(event);
  assert.equal(event.headers.get("Authorization"), "Bearer producer-secret");
  const body = JSON.parse(await event.text()) as Record<string, unknown>;
  assert.deepEqual(body, {
    type: "pr.automation.completed",
    version: 1,
    payload: normalizeCompletion(snapshot, candidate),
    idempotencyKey: completionKey(candidate),
    correlationId: "github:example/repo:pull-request:12",
  });
  assert.equal(event.url.includes("producer-secret"), false);
  assert.equal(JSON.stringify(body).includes("producer-secret"), false);
});
test("individual events carry a stable pull-request correlation id", async () => {
  const requests: Request[] = [];
  const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    return requestUrl(input).pathname === "/v1/credentials"
      ? response(201, { token: "producer-secret" })
      : response(201, { event: { id: "event-1" } });
  };
  const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher });
  assert.equal(pullRequestCorrelationId("Example/Repo", 12), "github:example/repo:pull-request:12");
  await emitter.emit(trigger, snapshot, candidate);
  const event = requests.find((request) => new URL(request.url).pathname === "/v1/events");
  assert.ok(event);
  const body = JSON.parse(await event.text()) as Record<string, unknown>;
  assert.equal(body.idempotencyKey, completionKey(candidate));
  assert.deepEqual(body.payload, normalizeCompletion(snapshot, candidate));
  assert.equal(body.correlationId, "github:example/repo:pull-request:12");
  assert.equal(event.headers.get("Idempotency-Key"), completionKey(candidate));
  assert.equal(JSON.stringify(body).includes("admin-secret"), false);
  assert.equal(JSON.stringify(body).includes("producer-secret"), false);
});
test("emits aggregate payload with stable key and pull-request correlation", async () => {
  const requests: Request[] = [];
  let eventCalls = 0;
  const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    return requestUrl(input).pathname === "/v1/credentials"
      ? response(201, { token: "producer-secret" })
      : response(++eventCalls === 1 ? 201 : 200, { event: { id: "event-aggregate" } });
  };
  const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher });
  const members = [candidateFor("b", "check_run", "2"), candidateFor("a", "check_run", "1")];
  assert.equal(await emitter.emitAggregate(aggregate, snapshot, members), "emitted");
  assert.equal(await emitter.emitAggregate(aggregate, snapshot, members), "replayed");
  const event = requests.filter((request) => new URL(request.url).pathname === "/v1/events")[0];
  assert.ok(event);
  const body = JSON.parse(await event.text()) as Record<string, unknown>;
  assert.deepEqual(body, {
    type: "pr.automation.settled",
    version: 1,
    payload: normalizeSettled(snapshot, members),
    idempotencyKey: settledKey(aggregate, snapshot, members),
    correlationId: "github:example/repo:pull-request:12",
  });
  assert.equal(event.headers.get("Idempotency-Key"), settledKey(aggregate, snapshot, members));
});


test("isolates trigger drift and unknown definitions without leaking secrets", async () => {
  for (const [status, code, expected] of [[409, "idempotency_conflict", "trigger_drift"], [404, "definition_not_found", "trigger_invalid"]] as const) {
    const fetcher = async (input: URL | RequestInfo): Promise<Response> => requestUrl(input).pathname === "/v1/credentials"
      ? response(201, { token: "producer-secret" })
      : response(status, { error: { code, message: "bad producer-secret payload review body" } });
    const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher });
    await assert.rejects(emitter.emit(trigger, snapshot, candidate), (error: unknown) => {
      assert.equal((error as { code: string }).code, expected);
      assert.match(String((error as Error).message), /copilot-v1/);
      assert.match(String((error as Error).message), /7/);
      assert.equal(String(error).includes("producer-secret"), false);
      assert.equal(String(error).includes("review body"), false);
      return true;
    });
  }
});

test("an aborted emission does not cancel shared credential issuance", async () => {
  let resolveCredential!: (value: Response) => void;
  const credential = new Promise<Response>((resolve) => { resolveCredential = resolve; });
  let credentials = 0;
  let events = 0;
  const fetcher = async (input: URL | RequestInfo): Promise<Response> => {
    if (requestUrl(input).pathname === "/v1/credentials") {
      credentials += 1;
      return credential;
    }
    events += 1;
    return response(201, { event: { id: `event-${events}` } });
  };
  const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher });
  const controller = new AbortController();
  const aborted = emitter.emit(trigger, snapshot, candidate, controller.signal);
  const healthy = emitter.emit(trigger, snapshot, candidate);
  controller.abort();
  await assert.rejects(aborted, (error: unknown) => error === controller.signal.reason);
  resolveCredential(response(201, { token: "producer-secret" }));
  assert.equal(await healthy, "emitted");
  assert.equal(credentials, 1);
});
test("connector lifetime abort cancels shared credential issuance", async () => {
  let credentials = 0;
  const lifetime = new AbortController();
  const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (requestUrl(input).pathname !== "/v1/credentials") return response(201, { event: { id: "event-1" } });
    credentials += 1;
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(init?.signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));

      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher, lifetimeSignal: lifetime.signal });
  const first = emitter.emit(trigger, snapshot, candidate);
  const second = emitter.emit(trigger, snapshot, candidate);
  lifetime.abort("connector stopped");
  await assert.rejects(first, (error: unknown) => error === "connector stopped");
  await assert.rejects(second, (error: unknown) => error === "connector stopped");
  assert.equal(credentials, 1);
});
test("emits the fixed generic CI event request and replays a 200 response", async () => {
  const checks = [ciCheck({ id: 2, name: "build" }), ciCheck({ id: 1, name: "test", conclusion: "failure", detailsUrl: null })];
  const requests: Request[] = [];
  let eventCalls = 0;
  const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init));
    return requestUrl(input).pathname === "/v1/credentials"
      ? response(201, { token: "producer-secret" })
      : response(++eventCalls === 1 ? 201 : 200, { event: { id: "event-ci" } });
  };
  const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher });
  const payload = normalizeCiSettled(snapshot, checks);
  const key = ciSettledKey(payload);

  assert.equal(await emitter.emitCiSettled(snapshot, checks), "emitted");
  assert.equal(await emitter.emitCiSettled(snapshot, checks), "replayed");
  assert.equal(requests.filter((request) => requestUrl(request).pathname === "/v1/credentials").length, 1);
  const event = requests.find((request) => requestUrl(request).pathname === "/v1/events");
  assert.ok(event);
  const body = JSON.parse(await event.text()) as Record<string, unknown>;
  assert.deepEqual(body, {
    type: "pr.ci.settled",
    version: 1,
    payload,
    idempotencyKey: key,
    correlationId: "github:example/repo:pull-request:12",
  });
  assert.equal(event.headers.get("Authorization"), "Bearer producer-secret");
  assert.equal(event.headers.get("Idempotency-Key"), key);
  assert.equal(event.url.includes("producer-secret"), false);
  assert.equal(JSON.stringify(body).includes("producer-secret"), false);
  assert.equal(JSON.stringify(body).includes("admin-secret"), false);
});

test("generic CI keys are order-independent and change for every payload mutation", () => {
  const first = ciCheck({ id: 1, name: "test", conclusion: "success", completedAt: "2026-09-08T01:00:00Z" });
  const second = ciCheck({ id: 2, name: "build", conclusion: "success", completedAt: "2026-09-08T02:00:00Z" });
  const baseline = ciSettledKey(normalizeCiSettled(snapshot, [first, second]));
  const reversed = ciSettledKey(normalizeCiSettled(snapshot, [second, first]));
  assert.equal(reversed, baseline);
  assert.notEqual(ciSettledKey(normalizeCiSettled(snapshot, [first, second, ciCheck({ id: 3, name: "lint" })])), baseline, "late Check Run");
  assert.notEqual(ciSettledKey(normalizeCiSettled(snapshot, [first])), baseline, "disappeared Check Run");
  assert.notEqual(ciSettledKey(normalizeCiSettled(snapshot, [first, { ...second, conclusion: "failure" }])), baseline, "changed conclusion");
  assert.notEqual(ciSettledKey(normalizeCiSettled(snapshot, [first, { ...second, completedAt: "2026-09-08T04:00:00Z" }])), baseline, "changed completion time");
  assert.match(baseline, /^github:7:ci-settled:pull-request:12:head:head-1:payload:[a-f0-9]{64}$/);
});

test("maps generic CI drift and missing definitions to isolated error codes", async () => {
  for (const [status, code, expected] of [[409, "idempotency_conflict", "ci_drift"], [404, "definition_not_found", "ci_invalid"]] as const) {
    const fetcher = async (input: URL | RequestInfo): Promise<Response> => requestUrl(input).pathname === "/v1/credentials"
      ? response(201, { token: "producer-secret" })
      : response(status, { error: { code, message: "bad producer-secret generic payload" } });
    const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher });
    await assert.rejects(emitter.emitCiSettled(snapshot, [ciCheck()]), (error: unknown) => {
      assert.equal(errorCode(error), expected);
      assert.match(String(error), /7/);
      assert.equal(String(error).includes("producer-secret"), false);
      assert.equal(String(error).includes("generic payload"), false);
      return true;
    });
  }
});

test("redacts credentials from generic Relay failures", async () => {
  const fetcher = async (input: URL | RequestInfo): Promise<Response> => requestUrl(input).pathname === "/v1/credentials"
    ? response(201, { token: "producer-secret" })
    : response(500, { error: { code: "relay_broken", message: "admin-secret producer-secret generic payload" } });
  const emitter = new GitHubRelayEmitter({ baseUrl: "https://relay.test", adminToken: "admin-secret", fetch: fetcher });
  await assert.rejects(emitter.emitCiSettled(snapshot, [ciCheck()]), (error: unknown) => {
    assert.equal(errorCode(error), "relay_broken");
    assert.equal(String(error).includes("admin-secret"), false);
    assert.equal(String(error).includes("producer-secret"), false);
    assert.equal(String(error).includes("generic payload"), true);
    return true;
  });
});
