import { Ajv } from "ajv";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { CredentialStore } from "../src/auth.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { initializeProject } from "../src/init.ts";
import { loadRegistry } from "../src/registry.ts";
import { createRelayServer, type RelayServer } from "../src/server.ts";
import { openStore, type Store } from "../src/store.ts";
import { GitHubClient } from "../src/connectors/github/client.ts";
import { GitHubRelayEmitter } from "../src/connectors/github/emitter.ts";
import { runGitHubConnector, runGitHubCycle, type GitHubRunnerState } from "../src/connectors/github/runner.ts";
import type { GitHubConnectorConfig } from "../src/connectors/github/types.ts";
import { deferred, fakeGitHubServer, json, type FakeGitHubServer } from "./github-helpers.ts";

const repository = "octo/repo";
const pullRequestNumber = 197;
const headSha = "sha-197";
const githubToken = "github-token-for-e2e";
const fullReviewBody = `FULL_REVIEW_BODY_SHOULD_NOT_LEAK_${"x".repeat(2_400)}`;
const correlationId = `github:${repository}:pull-request:${pullRequestNumber}`;

type RelayHarness = {
  root: string;
  store: Store;
  server: RelayServer;
  baseUrl: string;
};

function pullRequest(): Record<string, unknown> {
  return {
    number: pullRequestNumber,
    html_url: `https://github.com/${repository}/pull/${pullRequestNumber}`,
    head: { sha: headSha },
    base: { ref: "main", repo: { id: 42, full_name: repository } },
    state: "open",
    updated_at: "2026-10-20T00:00:00Z",
  };
}

function checkRun(id: number, name: string, conclusion: string | null, status = "completed"): Record<string, unknown> {
  return {
    id,
    name,
    status,
    conclusion,
    head_sha: headSha,
    completed_at: status === "completed" ? "2026-10-20T01:00:00Z" : null,
    details_url: `https://github.example/check/${id}`,
    app: name === "SonarQube Quality Gate"
      ? { id: 11, slug: "sonarqube" }
      : name === "Cursor Bugbot"
        ? { id: 22, slug: "cursor" }
        : null,
    pull_requests: [{ number: pullRequestNumber }],
  };
}

function copilotReview(): Record<string, unknown> {
  return {
    id: 1973,
    user: {
      id: 77,
      login: "copilot-pull-request-reviewer[bot]",
      type: "Bot",
      html_url: "https://github.com/apps/copilot-pull-request-reviewer",
    },
    commit_id: headSha,
    submitted_at: "2026-10-20T01:00:00Z",
    html_url: "https://github.example/review/1973",
  };
}

function reviewThread(isResolved: boolean): Record<string, unknown> {
  return {
    id: "thread-197-bugbot",
    isResolved,
    isOutdated: false,
    path: "src/app.ts",
    line: 27,
    startLine: 27,
    comments: {
      totalCount: 3,
      nodes: [{
        id: "comment-197-bugbot",
        url: "https://github.example/thread/197",
        body: fullReviewBody,
        createdAt: "2026-10-20T01:00:00Z",
        updatedAt: "2026-10-20T01:00:00Z",
        author: { login: "cursor[bot]" },
      }],
    },
  };
}

function connectorConfig(apiBaseUrl: string): GitHubConnectorConfig {
  return {
    connector: "github",
    apiBaseUrl,
    graphqlUrl: `${apiBaseUrl}/graphql`,
    apiVersion: "2026-03-10",
    tokenEnv: "GITHUB_TOKEN",
    pollIntervalMs: 15_000,
    lookbackHours: 24,
    repositories: [{ name: repository, mode: "configured-tools-and-generic-check-runs" }],
    triggers: [
      {
        id: "sonarqube-completed-v1",
        recognizer: "sonarqube",
        match: { checkNames: ["SonarQube Quality Gate"], appIds: [11], appSlugs: ["sonarqube"] },
        emit: { type: "pr.automation.completed", version: 1 },
      },
      {
        id: "copilot-review-completed-v1",
        recognizer: "copilot-review",
        match: {
          userIds: [77],
          appUrls: ["https://github.com/apps/copilot-pull-request-reviewer"],
          logins: ["copilot-pull-request-reviewer[bot]"],
        },
        emit: { type: "pr.automation.completed", version: 1 },
      },
      {
        id: "cursor-bugbot-completed-v1",
        recognizer: "cursor-bugbot",
        match: { checkNames: ["Cursor Bugbot"], appIds: [22], appSlugs: ["cursor"] },
        emit: { type: "pr.automation.completed", version: 1 },
      },
    ],
    verification: {
      id: "pr-verification-settled-v1",
      emit: { type: "pr.verification.settled", version: 1 },
      reviewers: {
        "cursor-bugbot": ["cursor[bot]"],
        "copilot-review": ["copilot-pull-request-reviewer[bot]"],
      },
    },
  };
}

async function relayHarness(): Promise<RelayHarness> {
  const root = await mkdtemp(join(tmpdir(), "relay-pr-verification-e2e-"));
  await initializeProject(root, repository);
  await rm(join(root, ".relay", "events", "example.v1.json"));
  await rm(join(root, ".relay", "events", "pr-automation-settled.v1.json"));
  const registry = loadRegistry(root, ".relay/events");
  const store = openStore(join(root, ".relay", "relay.sqlite"));
  store.installRevisions(registry.revisions());
  const credentials = new CredentialStore();
  const dispatcher = new Dispatcher(store, credentials, { pollTimeoutMs: 10_000 });
  const server = createRelayServer({
    store,
    registry,
    credentials,
    dispatcher,
    projectRoot: root,
    definitionsDir: ".relay/events",
    closeStore: false,
    pollTimeoutMs: 10_000,
  }) as RelayServer;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { root, store, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeRelay(relay: RelayHarness): Promise<void> {
  await new Promise<void>((resolve) => relay.server.close(() => resolve()));
  relay.store.close();
  await rm(relay.root, { recursive: true, force: true });
}

function eventPayload(event: { payload: unknown }): Record<string, unknown> {
  assert.ok(event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload));
  return event.payload as Record<string, unknown>;
}

function eventText(events: readonly { payload: unknown; idempotencyKey: string; error?: unknown }[]): string {
  return events.map((event) => JSON.stringify({ payload: event.payload, idempotencyKey: event.idempotencyKey, error: event.error })).join("\n");
}

type VerificationPayload = Parameters<GitHubRelayEmitter["emitVerification"]>[2];
type VerificationEmitter = Pick<GitHubRelayEmitter, "emit" | "emitAggregate" | "emitCiSettled" | "emitVerification">;

function observingEmitter(
  real: GitHubRelayEmitter,
  capture: (payload: VerificationPayload) => void,
): VerificationEmitter {
  return {
    emit: real.emit.bind(real),
    emitAggregate: real.emitAggregate.bind(real),
    emitCiSettled: real.emitCiSettled.bind(real),
    emitVerification: (...args) => {
      capture(args[2]);
      return real.emitVerification(...args);
    },
  };
}

function verificationSchemaDiagnostics(
  errors: readonly { instancePath: string; keyword: string; params: unknown }[] | null | undefined,
): Array<{ path: string; keyword: string; expected: string }> {
  return (errors ?? []).map((error) => {
    const params = error.params;
    const expected = params !== null && typeof params === "object" && "type" in params
      ? String(params.type)
      : error.keyword === "required"
        ? "required property"
        : error.keyword === "additionalProperties"
          ? "no additional properties"
          : error.keyword;
    return { path: error.instancePath, keyword: error.keyword, expected };
  });
}

test("real verification evidence parks and wakes one correlation-filtered notification", async () => {
  const relay = await relayHarness();
  let github: FakeGitHubServer | undefined;
  let notifyPromise: Promise<number> | undefined;
  const logs: string[] = [];
  const relayTokens: string[] = [];
  let terminalChecks = false;
  let failingCi = true;
  let resolvedThread = false;
  const notifyPollStarted = deferred<void>();
  const scripts = {
    [`/repos/${repository}/pulls/${pullRequestNumber}`]: json(pullRequest()),
    [`/repos/${repository}/commits/${headSha}/check-runs?status=completed&filter=all&per_page=100`]: json({
      total_count: 2,
      check_runs: [
        checkRun(1971, "SonarQube Quality Gate", "success"),
        checkRun(1972, "Cursor Bugbot", "success"),
      ],
    }),
    [`/repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=100`]: json([copilotReview()]),
    [`/repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=100`]: () => json({
      total_count: terminalChecks ? 1 : 1,
      check_runs: [terminalChecks
        ? checkRun(1974, "Build", failingCi ? "failure" : "success")
        : checkRun(1974, "Build", null, "queued")],
    }),
    "/graphql": () => json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [reviewThread(resolvedThread)],
            },
          },
        },
      },
    }),
  };

  const allSummaries: Array<{ errors: string[] }> = [];
  const runLog = (value: string): void => logs.push(value);
  const captureRelayRequest = (request: { url?: string; headers: Record<string, string | string[] | undefined> }): void => {
    if (request.url === "/v1/events" && typeof request.headers.authorization === "string") relayTokens.push(request.headers.authorization.replace(/^Bearer /, ""));
    if (request.url === "/v1/notification/poll") notifyPollStarted.resolve();
  };
  relay.server.on("request", captureRelayRequest);

  try {
    github = await fakeGitHubServer(scripts);
    const config = connectorConfig(github.url);
    await writeFile(join(relay.root, ".relay", "connectors", "github.json"), JSON.stringify(config));
    const verificationSchema = JSON.parse(await readFile(join(relay.root, ".relay", "schemas", "pr-verification-settled.json"), "utf8")) as object;
    const validateVerification = new Ajv({ allErrors: true, strict: true }).compile(verificationSchema);
    let capturedVerification: VerificationPayload | undefined;
    let capturedVerificationDiagnostics: Array<{ path: string; keyword: string; expected: string }> = [];
    const runtime = JSON.parse(await readFile(join(relay.root, ".relay", "runtime.json"), "utf8")) as { port: number; token: string };
    assert.equal(runtime.port, Number(new URL(relay.baseUrl).port));

    let stdout = "";
    let stderr = "";
    notifyPromise = runCli([
      "notify",
      "--definitions", "pr.verification.settled@1",
      "--correlation-id", correlationId,
    ], {
      cwd: relay.root,
      stdout: {
        write(value: string, callback?: (error?: Error | null) => void): void {
          stdout += value;
          callback?.();
        },
      },
      stderr: { write(value: string): void { stderr += value; } },
    });
    await notifyPollStarted.promise;

    const client = new GitHubClient({ baseUrl: github.url, graphqlUrl: `${github.url}/graphql`, apiVersion: "2026-03-10", token: githubToken });
    const realEmitter = new GitHubRelayEmitter({ baseUrl: relay.baseUrl, adminToken: relay.server.adminToken });
    const emitter = observingEmitter(realEmitter, (payload) => {
      capturedVerification = payload;
      validateVerification(payload);
      capturedVerificationDiagnostics = verificationSchemaDiagnostics(validateVerification.errors);
    });
    const state = new Map<string, GitHubRunnerState>();
    const runnerOptions = {
      config,
      client,
      emitter,
      pullRequestNumber,
      state,
      log: runLog,
    };

    const pending = await runGitHubCycle({ ...runnerOptions, once: true });
    allSummaries.push(pending);
    const pendingEvents = relay.store.snapshotAtHighWater().snapshot.events;
    assert.equal(pending.emitted, 3);
    assert.equal(pendingEvents.filter((event) => event.type === "pr.automation.completed").length, 3);
    assert.equal(pendingEvents.filter((event) => event.type === "pr.ci.settled").length, 0);
    assert.equal(pendingEvents.filter((event) => event.type === "pr.verification.settled").length, 0);
    assert.equal(stdout, "");

    terminalChecks = true;
    const firstObservation = await runGitHubCycle({ ...runnerOptions, once: false });
    allSummaries.push(firstObservation);
    assert.deepEqual(firstObservation.errors, [], `first terminal observation errors: ${JSON.stringify(firstObservation.errors)}`);
    assert.equal(firstObservation.emitted, 0);
    assert.equal(relay.store.snapshotAtHighWater().snapshot.events.filter((event) => event.type === "pr.verification.settled").length, 0);

    const secondObservation = await runGitHubCycle({ ...runnerOptions, once: false });
    allSummaries.push(secondObservation);
    assert.deepEqual(secondObservation.errors, [], `second terminal observation errors: ${JSON.stringify(secondObservation.errors)}`);
    assert.ok(capturedVerification !== undefined, "verification payload was not captured before real emission");
    assert.deepEqual(capturedVerificationDiagnostics, [], `generated verification schema diagnostics: ${JSON.stringify(capturedVerificationDiagnostics)}`);
    const firstEvents = relay.store.snapshotAtHighWater().snapshot.events;
    const firstVerificationEvents = firstEvents.filter((event) => event.type === "pr.verification.settled");
    assert.equal(firstVerificationEvents.length, 1, `verification event boundary: summary=${JSON.stringify(secondObservation)} logs=${JSON.stringify(logs)} eventTypes=${JSON.stringify(firstEvents.map((event) => event.type))}`);
    assert.equal(firstVerificationEvents[0]?.correlationId, correlationId);
    const firstPayload = eventPayload(firstVerificationEvents[0]!);
    assert.equal(firstPayload.verdict, "action_required");
    assert.deepEqual((firstPayload.actions as Array<Record<string, unknown>>).map((action) => action.code), ["investigate_ci_failures", "resolve_review_findings"]);
    const firstReviews = firstPayload.reviews as Record<string, unknown>;
    const firstFindings = firstReviews.findings as Array<Record<string, unknown>>;
    assert.equal(firstFindings.length, 1);
    assert.equal(firstFindings[0]?.provider, "cursor-bugbot");
    assert.ok(String(firstFindings[0]?.body).length <= 2_000);
    assert.equal(String(firstFindings[0]?.body).includes(fullReviewBody), false);
    assert.equal(firstEvents.filter((event) => event.type === "pr.ci.settled").length, 1);

    assert.equal(await notifyPromise, 0);
    assert.equal(stderr, "");
    assert.equal(stdout, `${JSON.stringify(firstPayload)}\n`);
    const completed = relay.store.getEvent(firstVerificationEvents[0]!.id);
    assert.equal(completed?.state, "completed");
    assert.deepEqual(completed?.result, { delivered: true });
    assert.deepEqual(await readdir(join(relay.root, ".relay", "agent-leases")), []);

    const countBeforeReplay = relay.store.countEvents();
    const replayState = new Map<string, GitHubRunnerState>();
    const replay = await runGitHubConnector({
      config,
      client: new GitHubClient({ baseUrl: github.url, graphqlUrl: `${github.url}/graphql`, apiVersion: "2026-03-10", token: githubToken }),
      emitter: new GitHubRelayEmitter({ baseUrl: relay.baseUrl, adminToken: relay.server.adminToken }),
      pullRequestNumber,
      once: true,
      state: replayState,
      log: runLog,
    });
    allSummaries.push(replay);
    assert.equal(replay.replayed, 5);
    assert.equal(replay.emitted, 0);
    assert.equal(relay.store.countEvents(), countBeforeReplay);

    failingCi = false;
    resolvedThread = true;
    const resolvedFirst = await runGitHubCycle({
      config,
      client: new GitHubClient({ baseUrl: github.url, graphqlUrl: `${github.url}/graphql`, apiVersion: "2026-03-10", token: githubToken }),
      emitter: new GitHubRelayEmitter({ baseUrl: relay.baseUrl, adminToken: relay.server.adminToken }),
      pullRequestNumber,
      state: replayState,
      log: runLog,
    });
    allSummaries.push(resolvedFirst);
    assert.equal(relay.store.snapshotAtHighWater().snapshot.events.filter((event) => event.type === "pr.verification.settled").length, 1);
    const resolvedSecond = await runGitHubCycle({
      config,
      client: new GitHubClient({ baseUrl: github.url, graphqlUrl: `${github.url}/graphql`, apiVersion: "2026-03-10", token: githubToken }),
      emitter: new GitHubRelayEmitter({ baseUrl: relay.baseUrl, adminToken: relay.server.adminToken }),
      pullRequestNumber,
      state: replayState,
      log: runLog,
    });
    allSummaries.push(resolvedSecond);
    const finalEvents = relay.store.snapshotAtHighWater().snapshot.events;
    const finalVerificationEvents = finalEvents.filter((event) => event.type === "pr.verification.settled");
    assert.equal(finalVerificationEvents.length, 2);
    assert.notEqual(finalVerificationEvents[0]?.idempotencyKey, finalVerificationEvents[1]?.idempotencyKey);
    const finalPayload = eventPayload(finalVerificationEvents[1]!);
    assert.equal(finalPayload.verdict, "success");
    assert.deepEqual(finalPayload.actions, []);
    assert.equal(finalPayload.reviews && (finalPayload.reviews as Record<string, unknown>).unresolvedCount, 0);

    const producerToken = relayTokens.find((token) => token !== relay.server.adminToken);
    assert.ok(producerToken);
    const secrets = [githubToken, relay.server.adminToken, producerToken, fullReviewBody];
    const safeText = [
      eventText(finalEvents),
      ...logs,
      ...allSummaries.flatMap((summary) => summary.errors),
      stdout,
      stderr,
    ].join("\n");
    for (const secret of secrets) assert.equal(safeText.includes(secret), false, `secret leaked: ${secret.slice(0, 16)}`);
    assert.equal(finalEvents.some((event) => event.idempotencyKey.includes(fullReviewBody)), false);
  } finally {
    relay.server.off("request", captureRelayRequest);
    if (github !== undefined) await github.close();
    await closeRelay(relay);
    if (notifyPromise !== undefined) await notifyPromise.catch(() => undefined);
  }
});
