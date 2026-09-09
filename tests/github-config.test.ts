import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadGitHubConnectorConfig,
  validateGitHubConnectorConfig,
} from "../src/connectors/github/config.ts";

const sonarMatch = {
  checkNames: ["SonarCloud Code Analysis"],
  appIds: [123456],
};
const copilotMatch = {
  userIds: [175728472],
  appUrls: ["https://github.com/apps/copilot-pull-request-reviewer"],
  logins: ["copilot-pull-request-reviewer[bot]"],
};
const bugbotMatch = {
  checkNames: ["Cursor Bugbot"],
  appIds: [1210556],
  appSlugs: ["cursor"],
};

function validConfig() {
  return {
    connector: "github",
    repositories: ["owner/repository"],
    triggers: [
      { id: "sonar-v1", recognizer: "sonarqube", match: { ...sonarMatch }, emit: { type: "pr.automation.completed", version: 1 } },
      { id: "copilot-v1", recognizer: "copilot-review", match: { ...copilotMatch }, emit: { type: "pr.automation.completed", version: 1 } },
      { id: "bugbot-v1", recognizer: "cursor-bugbot", match: { ...bugbotMatch }, emit: { type: "pr.automation.completed", version: 1 } },
    ],
  };
}

function errorWithCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && (error as Error & { code?: string }).code === code;
}

function configWithUnpinnedSonar() {
  const value = validConfig();
  value.triggers[0] = {
    ...value.triggers[0],
    match: { checkNames: ["SonarCloud Code Analysis"] },
  } as never;
  return value;
}

async function loadConfig(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), "github-config-"));
  const path = join(root, "github.json");
  await writeFile(path, JSON.stringify(value));
  return loadGitHubConnectorConfig(path);
}

test("loads a valid three-recognizer connector", async () => {
  const config = await loadConfig(validConfig());
  assert.equal(config.connector, "github");
  assert.deepEqual(config.repositories, ["owner/repository"]);
  assert.deepEqual(config.triggers.map((trigger) => trigger.recognizer), [
    "sonarqube",
    "copilot-review",
    "cursor-bugbot",
  ]);
  assert.equal(config.apiBaseUrl, "https://api.github.com");
  assert.equal(config.apiVersion, "2026-03-10");
  assert.equal(config.tokenEnv, "GITHUB_TOKEN");
  assert.equal(config.pollIntervalMs, 15_000);
  assert.equal(config.lookbackHours, 24);
});

test("requires pinned Sonar identity outside discovery", () => {
  assert.throws(
    () => validateGitHubConnectorConfig(configWithUnpinnedSonar()),
    errorWithCode("sonar_identity_required"),
  );
  assert.doesNotThrow(() =>
    validateGitHubConnectorConfig(configWithUnpinnedSonar(), { discover: true }),
  );
});

test("rejects secret-like keys at every nesting level", () => {
  const config = validConfig();
  (config as Record<string, unknown>).token = "ghp_secret";
  assert.throws(() => validateGitHubConnectorConfig(config), errorWithCode("secret_key"));

  const nested = validConfig();
  (nested.triggers[0].match as Record<string, unknown>).secret = "nope";
  assert.throws(() => validateGitHubConnectorConfig(nested), errorWithCode("secret_key"));
});

test("accepts tokenEnv but never a token value", () => {
  const config = validateGitHubConnectorConfig({ ...validConfig(), tokenEnv: "MY_GITHUB_TOKEN" });
  assert.equal(config.tokenEnv, "MY_GITHUB_TOKEN");
});

test("rejects credential-bearing or ambiguous provider app URLs", () => {
  for (const appUrl of [
    "https://user:password@github.com/apps/copilot-pull-request-reviewer",
    "https://github.com/apps/copilot-pull-request-reviewer?token=secret",
    "https://github.com/apps/copilot-pull-request-reviewer#secret",
  ]) {
    const value = validConfig();
    (value.triggers[1].match as { appUrls: string[] }).appUrls = [appUrl];
    assert.throws(() => validateGitHubConnectorConfig(value), errorWithCode("provider_identity"));
  }
});

test("rejects non-loopback HTTP API URLs", () => {
  assert.throws(
    () => validateGitHubConnectorConfig({ ...validConfig(), apiBaseUrl: "http://github.example.test" }),
    errorWithCode("api_url"),
  );
});

test("allows loopback HTTP only in test mode or explicit validation option", () => {
  const value = { ...validConfig(), apiBaseUrl: "http://127.0.0.1:8787" };
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    assert.doesNotThrow(() => validateGitHubConnectorConfig(value));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  assert.doesNotThrow(() =>
    validateGitHubConnectorConfig(value, { allowLoopbackHttp: true }),
  );
});

test("rejects invalid repositories", () => {
  assert.throws(
    () => validateGitHubConnectorConfig({ ...validConfig(), repositories: ["https://github.com/owner/repository"] }),
    errorWithCode("repository"),
  );
  assert.throws(
    () => validateGitHubConnectorConfig({ ...validConfig(), repositories: ["owner/../repository"] }),
    errorWithCode("repository"),
  );
});

test("rejects duplicate trigger IDs", () => {
  const value = validConfig();
  value.triggers[1] = { ...value.triggers[1], id: value.triggers[0].id };
  assert.throws(() => validateGitHubConnectorConfig(value), errorWithCode("trigger_id_duplicate"));
});

test("rejects unknown recognizers", () => {
  const value = validConfig();
  value.triggers[0] = { ...value.triggers[0], recognizer: "other" } as never;
  assert.throws(() => validateGitHubConnectorConfig(value), errorWithCode("recognizer"));
});

test("rejects invalid polling and lookback bounds", () => {
  assert.throws(() => validateGitHubConnectorConfig({ ...validConfig(), pollIntervalMs: 4_999 }), errorWithCode("poll_interval"));
  assert.throws(() => validateGitHubConnectorConfig({ ...validConfig(), pollIntervalMs: 3_600_001 }), errorWithCode("poll_interval"));
  assert.throws(() => validateGitHubConnectorConfig({ ...validConfig(), lookbackHours: 0 }), errorWithCode("lookback"));
  assert.throws(() => validateGitHubConnectorConfig({ ...validConfig(), lookbackHours: 721 }), errorWithCode("lookback"));
});

test("requires identity for every built-in provider", () => {
  const copilot = validConfig();
  copilot.triggers[1] = { ...copilot.triggers[1], match: {} } as never;
  assert.throws(() => validateGitHubConnectorConfig(copilot), errorWithCode("copilot_identity_required"));

  const bugbot = validConfig();
  bugbot.triggers[2] = { ...bugbot.triggers[2], match: { checkNames: ["Cursor Bugbot"] } } as never;
  assert.throws(() => validateGitHubConnectorConfig(bugbot), errorWithCode("cursor_identity_required"));
});

test("deep freezes normalized configuration", () => {
  const config = validateGitHubConnectorConfig(validConfig());
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.repositories), true);
  assert.equal(Object.isFrozen(config.triggers[0]), true);
  assert.equal(Object.isFrozen(config.triggers[0].match), true);
  assert.throws(() => {
    config.repositories.push("other/repository");
  }, TypeError);
});
