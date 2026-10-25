import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAMES = Object.freeze([
  "using-open-relay",
  "setting-up-open-relay",
  "waiting-for-open-relay-events",
  "automating-github-prs-with-open-relay",
  "recovering-open-relay",
]);

const CONFLICT_REASONS = new Set(["modified", "unowned", "symlink", "unrelated-files", "invalid-target"]);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestName = ".open-relay-manifest.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readFrontmatterName(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const line = match[1].split(/\r?\n/).find((value) => value.startsWith("name:"));
  return line?.slice("name:".length).trim();
}

async function loadSources(root) {
  const sources = [];
  for (const name of SKILL_NAMES) {
    try {
      const directory = await lstat(join(root, "skills", name));
      if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error("skill directory is not a directory");
      const path = join(root, "skills", name, "SKILL.md");
      const file = await lstat(path);
      if (file.isSymbolicLink() || !file.isFile()) throw new Error("SKILL.md is not a regular file");
      const bytes = await readFile(path);
      if (readFrontmatterName(bytes.toString("utf8")) !== name) throw new Error("frontmatter name does not match");
      sources.push({ name, bytes, hash: sha256(bytes) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid packaged skill ${name}: ${reason}`);
    }
  }
  return sources;
}

function invalidManifest() {
  throw new Error("invalid Open Relay skill manifest");
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function readManifest(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { schemaVersion: 1, skills: {}, skipped: {} };
    }
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalidManifest();
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.skills) || !isRecord(value.skipped)) invalidManifest();
  if (!Object.keys(value.skills).every((name) => SKILL_NAMES.includes(name))) invalidManifest();
  if (!Object.keys(value.skipped).every((name) => SKILL_NAMES.includes(name))) invalidManifest();
  for (const entry of Object.values(value.skills)) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["sha256"]) || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) invalidManifest();
  }
  for (const entry of Object.values(value.skipped)) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["reason"]) || typeof entry.reason !== "string" || !CONFLICT_REASONS.has(entry.reason)) invalidManifest();
  }
  return value;
}

async function atomicWrite(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function inspectTarget(skillsRoot, source, previous) {
  const path = join(skillsRoot, source.name);
  const target = await optionalLstat(path);
  if (!target) return { ...source, status: "installed" };
  if (target.isSymbolicLink()) return { ...source, status: "skipped", reason: "symlink" };
  if (!target.isDirectory()) return { ...source, status: "skipped", reason: "invalid-target" };
  const entries = await readdir(path);
  if (entries.length === 0) return { ...source, status: "installed" };
  if (entries.some((entry) => entry !== "SKILL.md")) return { ...source, status: "skipped", reason: "unrelated-files" };
  const skillPath = join(path, "SKILL.md");
  const skill = await lstat(skillPath);
  if (skill.isSymbolicLink()) return { ...source, status: "skipped", reason: "symlink" };
  if (!skill.isFile()) return { ...source, status: "skipped", reason: "invalid-target" };
  const hash = sha256(await readFile(skillPath));
  const priorHash = previous.skills[source.name]?.sha256;
  if (hash === source.hash) return { ...source, status: priorHash ? "current" : "adopted" };
  if (priorHash && hash === priorHash) return { ...source, status: "updated" };
  if (priorHash) return { ...source, status: "skipped", reason: "modified" };
  return { ...source, status: "skipped", reason: "unowned" };
}

async function applyDecision(skillsRoot, decision) {
  if (decision.status !== "installed" && decision.status !== "updated") return;
  const path = join(skillsRoot, decision.name);
  if (decision.status === "installed") await mkdir(path, { recursive: true, mode: 0o700 });
  await atomicWrite(join(path, "SKILL.md"), decision.bytes);
}

function recordDecision(next, previous, decision) {
  if (decision.status !== "skipped") {
    next.skills[decision.name] = { sha256: decision.hash };
    delete next.skipped[decision.name];
    return;
  }
  if (previous.skills[decision.name]) next.skills[decision.name] = previous.skills[decision.name];
  next.skipped[decision.name] = { reason: decision.reason };
}

function formatResult(decision) {
  return decision.status === "skipped" ? `${decision.name}: skipped: ${decision.reason}` : `${decision.name}: ${decision.status}`;
}

function formatSummary(decisions) {
  const skipped = decisions.filter((decision) => decision.status === "skipped").length;
  return `Open Relay skills: ${decisions.length - skipped} managed, ${skipped} skipped`;
}

async function validateSkillsRoot(home, skillsRoot) {
  const agentsRoot = await optionalLstat(join(home, ".agents"));
  if (agentsRoot?.isSymbolicLink()) throw new Error("invalid Open Relay skill root: .agents is a symlink");
  const root = await optionalLstat(skillsRoot);
  if (root?.isSymbolicLink()) throw new Error("invalid Open Relay skill root: skills is a symlink");
}

export async function installSkills({ packageRoot: root, home, log = console.log }) {
  if (!isAbsolute(home)) throw new Error("home must be an absolute path");
  const sources = await loadSources(root);
  const skillsRoot = join(home, ".agents", "skills");
  const manifestPath = join(skillsRoot, manifestName);
  await validateSkillsRoot(home, skillsRoot);
  const previous = await readManifest(manifestPath);
  const decisions = await Promise.all(sources.map((source) => inspectTarget(skillsRoot, source, previous)));
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  const next = { schemaVersion: 1, skills: {}, skipped: {} };
  for (const decision of decisions) {
    await applyDecision(skillsRoot, decision);
    recordDecision(next, previous, decision);
    log(formatResult(decision));
  }
  await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
  log(formatSummary(decisions));
  return decisions.map(({ name, status, reason }) => reason === undefined ? { name, status } : { name, status, reason });
}

export async function runPostinstall({ env = process.env, packageRoot: root = packageRoot, log = console.log } = {}) {
  if (env.npm_config_global !== "true") return [];
  if (typeof env.HOME !== "string" || env.HOME.length === 0 || !isAbsolute(env.HOME)) {
    throw new Error("HOME must be an absolute path for global skill installation");
  }
  return installSkills({ packageRoot: root, home: env.HOME, log });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runPostinstall().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
