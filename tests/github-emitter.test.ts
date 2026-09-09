import assert from "node:assert/strict";
import test from "node:test";
import { completionKey, GitHubRelayEmitter } from "../src/connectors/github/emitter.ts";
import { normalizeCompletion } from "../src/connectors/github/normalize.ts";
import type { CompletionCandidate, PrSnapshot, TriggerConfig } from "../src/connectors/github/types.ts";

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
  });
  assert.equal(event.url.includes("producer-secret"), false);
  assert.equal(JSON.stringify(body).includes("producer-secret"), false);
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
