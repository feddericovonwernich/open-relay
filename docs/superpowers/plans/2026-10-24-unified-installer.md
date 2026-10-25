# Unified Open Relay Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing global npm command install and safely update Open Relay plus its five canonical agent skills.

**Architecture:** Add one dependency-free Node.js lifecycle script that validates packaged skill sources, classifies each target against a SHA-256 ownership manifest, and uses atomic file replacement for safe changes. Package integration invokes the script only for global npm installs; focused unit tests prove the synchronization rules, and the existing packed-package onboarding test proves the real install path.

**Tech Stack:** Node.js 22.19 ESM, npm lifecycle scripts, Node standard library, TypeScript tests with `node:test`

**Spec:** `docs/superpowers/specs/2026-10-24-unified-installer-design.md`

## Global Constraints

- Keep this exact install and update command: `npm install --global https://github.com/feddericovonwernich/open-relay/archive/refs/heads/main.tar.gz`.
- Manage exactly `using-open-relay`, `setting-up-open-relay`, `waiting-for-open-relay-events`, `automating-github-prs-with-open-relay`, and `recovering-open-relay`.
- Install only each skill's direct `SKILL.md`; do not manage another file.
- Write only below `$HOME/.agents/skills/` during a global npm install.
- Return before reading `HOME` or packaged skills when `npm_config_global !== "true"`.
- Reject a missing, empty, or non-absolute `HOME` during a global install.
- Use SHA-256 hashes, manifest schema version `1`, and atomic temporary-file rename.
- Preserve modified, unowned, symlinked, invalid, and unrelated targets byte-for-byte.
- Expected per-skill conflicts exit successfully; malformed state and unexpected filesystem errors fail installation.
- Use Node.js standard-library APIs only; add no dependency, prompt, override, force mode, backup, telemetry, or uninstall behavior.

## File Map

- Create `scripts/install-skills.mjs`: lifecycle gate, package validation, manifest parsing, target classification, atomic writes, status output.
- Create `tests/install-skills.test.ts`: isolated behavioral coverage for the script and all safety rules.
- Modify `package.json`: pack the script and five skill files, then invoke the global-only lifecycle script from `postinstall`.
- Modify `tests/onboarding.test.ts`: prove that the real packed global install provides both `relay` and all five managed skills.
- Modify `README.md`: replace manual skill copying with automatic synchronization and conflict recovery.
- Modify `AGENTS.md`: state that the existing command installs both components and require manifest inspection.
- Do not modify `package-lock.json`: npm does not record `files` or lifecycle scripts in the root lock entry.

---

### Task 1: Safe Skill Synchronization Engine

**Files:**
- Create: `scripts/install-skills.mjs`
- Create: `tests/install-skills.test.ts`

**Interfaces:**
- Produces: `SKILL_NAMES`, a frozen array containing the five canonical names in the order listed under Global Constraints.
- Produces: `installSkills({ packageRoot, home, log })`, which returns `Promise<InstallResult[]>` after synchronizing all five skills.
- Produces: `runPostinstall({ env, packageRoot, log })`, which returns `Promise<InstallResult[]>`; it returns `[]` for non-global installs and derives `home` from `env.HOME` for global installs.
- Produces: `InstallResult` values shaped as `{ name, status }` for `installed`, `adopted`, `updated`, and `current`, or `{ name, status: "skipped", reason }` for conflicts.
- Produces: manifest data shaped as `{ schemaVersion: 1, skills: Record<string, { sha256: string }>, skipped: Record<string, { reason: ConflictReason }> }`.
- Consumes: only Node standard-library APIs and packaged `skills/<name>/SKILL.md` files.

- [ ] **Step 1: Add the lifecycle-gate and first-install tests**

Create `tests/install-skills.test.ts` with imports from `node:assert/strict`, `node:child_process`, `node:fs/promises`, `node:os`, `node:path`, `node:test`, and `node:util`. Import the JavaScript module through a computed URL so TypeScript does not require a declaration file:

```ts
const skillNames = [
  "using-open-relay",
  "setting-up-open-relay",
  "waiting-for-open-relay-events",
  "automating-github-prs-with-open-relay",
  "recovering-open-relay",
] as const;

type InstallResult = {
  name: typeof skillNames[number];
  status: "installed" | "adopted" | "updated" | "current" | "skipped";
  reason?: "modified" | "unowned" | "symlink" | "unrelated-files" | "invalid-target";
};

type InstallerModule = {
  installSkills(options: { packageRoot: string; home: string; log?: (line: string) => void }): Promise<InstallResult[]>;
  runPostinstall(options: { env: NodeJS.ProcessEnv; packageRoot: string; log?: (line: string) => void }): Promise<InstallResult[]>;
};

const installerUrl = new URL("../scripts/install-skills.mjs", import.meta.url).href;
const installer = await import(installerUrl) as InstallerModule;
```

Add a fixture helper that creates an isolated package root and home, writes one valid source file for each canonical name, and removes the temporary root in each test's `finally` block:

```ts
function skillText(name: string, body = "canonical"): string {
  return `---\nname: ${name}\ndescription: Test skill.\n---\n# ${name}\n${body}\n`;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "open-relay-skill-installer-"));
  const packageRoot = join(root, "package");
  const home = join(root, "home");
  await mkdir(home);
  for (const name of skillNames) {
    const directory = join(packageRoot, "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), skillText(name));
  }
  return { root, packageRoot, home };
}
```

Add these exact behaviors:

1. `runPostinstall` with an empty `env` returns `[]`, writes no log lines, and does not inspect a deliberately missing `packageRoot`.
2. `runPostinstall` with `npm_config_global: "true"` and `HOME` set to either `""` or `"relative"` rejects with `/HOME must be an absolute path/` before it inspects a deliberately missing `packageRoot`.
3. A first global run reports five `installed` results, logs one `installed` line per skill plus `Open Relay skills: 5 managed, 0 skipped`, writes each source byte-for-byte to `$HOME/.agents/skills/<name>/SKILL.md`, uses mode `0600` for files and `0700` for created skill directories, and creates `.open-relay-manifest.json` with all five hashes and an empty `skipped` object.
4. A second unchanged run reports and logs five `current` results, logs the same managed summary, and leaves the manifest content unchanged.
5. Malformed JSON and `schemaVersion: 2` each reject with `/invalid Open Relay skill manifest/` before any canonical target is created or changed.
6. Separate fixtures with a missing packaged source, a symlinked skill directory, a symlinked packaged `SKILL.md`, and mismatched frontmatter each reject with `/invalid packaged skill/` before any target write.
7. A regular file passed as `home` causes the unexpected filesystem error to reject instead of becoming a successful conflict.
8. Use promisified `execFile` to run `node scripts/install-skills.mjs` with `{ ...process.env, npm_config_global: "true", HOME: "" }`. Assert that it rejects with exit code `1`, stderr matches `/HOME must be an absolute path/`, and stdout is empty.

- [ ] **Step 2: Run the focused tests and confirm the missing module failure**

Run:

```bash
node --test tests/install-skills.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/install-skills.mjs`.

- [ ] **Step 3: Implement lifecycle gating, source validation, manifest validation, and first install**

Create `scripts/install-skills.mjs`. Use these constants and public entry points:

```js
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

export async function runPostinstall({ env = process.env, packageRoot: root = packageRoot, log = console.log } = {}) {
  if (env.npm_config_global !== "true") return [];
  if (typeof env.HOME !== "string" || env.HOME.length === 0 || !isAbsolute(env.HOME)) {
    throw new Error("HOME must be an absolute path for global skill installation");
  }
  return installSkills({ packageRoot: root, home: env.HOME, log });
}
```

Implement these internal helpers with the stated contracts:

```js
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
```

`loadSources(root)` must process all names before any target write. For each name, use `lstat` to require a non-symlink directory and a non-symlink regular `SKILL.md`. Read a `Buffer`, require `readFrontmatterName(bytes.toString("utf8")) === name`, and store `{ name, bytes, hash }`. Throw `invalid packaged skill <name>: <reason>` on any validation failure.

`readManifest(path)` must return empty schema-version-1 state for `ENOENT`. For an existing file, parse JSON and require:

- an object with `schemaVersion === 1`;
- object-valued `skills` and `skipped` fields;
- only canonical names as keys;
- each `skills[name]` is exactly an object with a lowercase 64-character hexadecimal `sha256`;
- each `skipped[name]` is exactly an object whose `reason` belongs to `CONFLICT_REASONS`.

Throw `invalid Open Relay skill manifest` for parse or schema failure. Do not rewrite an invalid manifest.

`atomicWrite(path, bytes)` must create a sibling named `.<basename>.<process.pid>.<randomUUID()>.tmp` with `flag: "wx"` and mode `0600`, rename it to `path`, and remove the temporary path with `{ force: true }` in `finally`.

For the first implementation of `installSkills`, use this order:

```js
export async function installSkills({ packageRoot: root, home, log = console.log }) {
  if (!isAbsolute(home)) throw new Error("home must be an absolute path");
  const sources = await loadSources(root);
  const skillsRoot = join(home, ".agents", "skills");
  const manifestPath = join(skillsRoot, manifestName);
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
```

At this step, `inspectTarget` must distinguish only `installed` for an absent or empty target, `adopted` for an identical unowned file, `current` for an identical managed file, and `unowned` for any differing unowned file. It must already skip a symlink or extra directory entry rather than overwrite it. `applyDecision` creates missing skill directories with mode `0700` and calls `atomicWrite` only for `installed`. `recordDecision` writes canonical hashes for successful results and conflict reasons for skipped results. `formatResult` emits `<name>: <status>` or `<name>: skipped: <reason>`; `formatSummary` emits `Open Relay skills: <managed> managed, <skipped> skipped`.

End the module with direct-execution error handling:

```js
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runPostinstall().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run the focused tests and confirm first-install behavior**

Run:

```bash
node --test tests/install-skills.test.ts
```

Expected: PASS for the lifecycle gate, missing `HOME`, source and manifest preflight failures, propagated filesystem errors, direct-process exit status, first install, and unchanged rerun.

- [ ] **Step 5: Add adoption, update, and conflict tests**

Extend `tests/install-skills.test.ts` with concrete scenarios:

- Pre-create one target with bytes equal to its source and assert `adopted` without rewriting it.
- Pre-create an empty target directory and assert it reports `installed` and receives only the canonical `SKILL.md`.
- After a successful install, replace one packaged source with valid frontmatter plus a new body. Assert the unchanged managed target reports `updated`, receives the new bytes, and stores the new hash.
- Before an initial run, create five targets that respectively contain identical bytes, differing unowned bytes, an unrelated file, a target-directory symlink, and a non-directory target. Assert `adopted`, `unowned`, `unrelated-files`, `symlink`, and `invalid-target` in canonical order.
- After a managed run, replace one target's `SKILL.md` with custom bytes and another target's `SKILL.md` with a symlink. Assert `modified` and `symlink`, verify the custom bytes and link target remain unchanged, and verify the prior managed hashes remain under `manifest.skills` while both reasons appear under `manifest.skipped`.
- Remove the conflicts and restore the last managed bytes. Assert the next run updates or reports current and removes the resolved names from `manifest.skipped`.
- Install version one, retain the version-one manifest, then change both the packaged source and target to the same valid version-two bytes. Rerun and assert `current`, assert the manifest hash changes to version two, and assert no skipped entry remains. This represents a completed skill rename followed by an interrupted manifest rename.

Use `readlink` for the symbolic-link assertion and compare exact `Buffer` values for preserved content. Do not assert implementation source text.

- [ ] **Step 6: Run the new tests and confirm missing classifications**

Run:

```bash
node --test tests/install-skills.test.ts
```

Expected: FAIL because managed updates and one or more conflict classifications are not implemented.

- [ ] **Step 7: Complete target classification and managed updates**

Implement `inspectTarget(skillsRoot, source, previous)` in this exact precedence order:

```text
missing directory -> installed
symlink directory -> skipped/symlink
non-directory target -> skipped/invalid-target
empty directory -> installed
any entry other than SKILL.md -> skipped/unrelated-files
symlink SKILL.md -> skipped/symlink
non-regular SKILL.md -> skipped/invalid-target
target hash equals source hash and prior ownership exists -> current
target hash equals source hash without prior ownership -> adopted
target hash equals prior managed hash -> updated
prior ownership exists but target hash differs -> skipped/modified
otherwise -> skipped/unowned
```

For `updated`, `applyDecision` must atomically replace only `SKILL.md`. For every successful result, `recordDecision` must write the packaged hash under `skills` and omit the name from `skipped`. For a skipped managed target, copy the previous hash into `next.skills` and write the new reason under `next.skipped`. For a skipped unowned target, write only the reason.

Do not call `rm` on a target path. The only removal is cleanup of an installer-owned temporary file.

- [ ] **Step 8: Run the focused tests and confirm synchronization behavior**

Run:

```bash
node --test tests/install-skills.test.ts
```

Expected: PASS for install, adoption, current, update, every conflict, and resolved-conflict behavior.


- [ ] **Step 9: Run repository type checking**

Run:

```bash
npm run typecheck
```

Expected: PASS. The computed dynamic import prevents a missing-declaration error for the `.mjs` module.

- [ ] **Step 10: Commit the synchronization engine**

```bash
git add scripts/install-skills.mjs tests/install-skills.test.ts
git commit -m "feat: safely synchronize Open Relay skills"
```

---

### Task 2: npm Package and Real Global Install

**Files:**
- Modify: `package.json:10-23`
- Modify: `tests/onboarding.test.ts:1-16,311-320,469-473`

**Interfaces:**
- Consumes: `scripts/install-skills.mjs` and its global lifecycle gate from Task 1.
- Produces: a packed artifact containing `dist/src`, `scripts/install-skills.mjs`, and exactly the five canonical `skills/*/SKILL.md` files.
- Produces: a `postinstall` lifecycle that invokes `node scripts/install-skills.mjs` for every npm install; the script itself makes local installs a no-op.
- Proves: the real `npm install --global --prefix <temporary-prefix>` path installs a working `relay` binary and managed skills under a temporary `HOME`.

- [ ] **Step 1: Extend the packed-package smoke test before changing package metadata**

In `tests/onboarding.test.ts`, add the canonical skill-name tuple near `projectRoot`. In the packed-package test, create `home` and `npm-cache` paths and pass this environment to both global install calls:

Increase this test's timeout from `20_000` to `40_000` because it now performs two global npm installs.

```ts
const home = join(directory, "home");
const installEnvironment = {
  ...process.env,
  HOME: home,
  npm_config_cache: join(directory, "npm-cache"),
};
await mkdir(home);
await exec("npm", ["install", "--global", "--prefix", prefix, join(directory, packageName.trim()), "--silent"], {
  env: installEnvironment,
});
```

Immediately after the existing `relay --help` assertions, add:

```ts
const installedSkillsRoot = join(home, ".agents", "skills");
for (const name of skillNames) {
  assert.equal(
    await readFile(join(installedSkillsRoot, name, "SKILL.md"), "utf8"),
    await readFile(join(projectRoot, "skills", name, "SKILL.md"), "utf8"),
    name,
  );
}
const skillManifest = JSON.parse(
  await readFile(join(installedSkillsRoot, ".open-relay-manifest.json"), "utf8"),
) as { schemaVersion: number; skills: Record<string, { sha256: string }>; skipped: Record<string, unknown> };
assert.equal(skillManifest.schemaVersion, 1);
assert.deepEqual(Object.keys(skillManifest.skills), [...skillNames]);
assert.deepEqual(skillManifest.skipped, {});
```

Before the test exits, run the same global install command a second time with `installEnvironment`, then re-read the five files and manifest. Assert their contents are unchanged and all five names remain managed.

- [ ] **Step 2: Run onboarding and confirm the packed package lacks skills**

Run:

```bash
npm run test:onboarding
```

Expected: FAIL with `ENOENT` for the first installed `SKILL.md`.

- [ ] **Step 3: Package and invoke the installer**

Change `package.json` to use this exact package surface:

```json
"files": ["dist/src", "skills/*/SKILL.md", "scripts/install-skills.mjs"],
```

Add this lifecycle entry under `scripts` without changing the current install command or any existing script:

```json
"postinstall": "node scripts/install-skills.mjs"
```

Do not add a dependency and do not change `package-lock.json`.

- [ ] **Step 4: Run local dependency installation and prove the lifecycle gate is inert**

Create a temporary sentinel home, then run the repository's locked local installation with global mode absent:

```bash
TEST_HOME="$(mktemp -d)" && trap 'rm -rf "$TEST_HOME"' EXIT && HOME="$TEST_HOME" npm ci --ignore-scripts=false && test ! -e "$TEST_HOME/.agents/skills"
```

Expected: PASS; npm runs `postinstall`, but no skill directory exists under the sentinel home.

- [ ] **Step 5: Run the packed-package onboarding test**

Run:

```bash
npm run test:onboarding
```

Expected: PASS. The temporary global install provides `relay --help`, all five byte-identical skills, and a schema-version-1 manifest on both installs.

- [ ] **Step 6: Inspect the packed artifact contract**

Run:

```bash
npm pack --dry-run --json
```

Expected: the JSON file list contains `scripts/install-skills.mjs` and exactly these skill files:

```text
skills/using-open-relay/SKILL.md
skills/setting-up-open-relay/SKILL.md
skills/waiting-for-open-relay-events/SKILL.md
skills/automating-github-prs-with-open-relay/SKILL.md
skills/recovering-open-relay/SKILL.md
```

It must not contain `tests/install-skills.test.ts` or another file below `skills/`.

- [ ] **Step 7: Commit package integration**

```bash
git add package.json tests/onboarding.test.ts
git commit -m "feat: install skills with the global package"
```

---

### Task 3: Installation Documentation and Full Verification

**Files:**
- Modify: `README.md:47-54,93-126`
- Modify: `AGENTS.md:3-17,55-67`

**Interfaces:**
- Consumes: the exact command, target path, manifest schema, and conflict behavior implemented in Tasks 1 and 2.
- Produces: one documented install/update path for humans and agents.

- [ ] **Step 1: Update the README install contract**

After the existing global npm command, replace the current single sentence with direct text that states:

```markdown
The command installs or updates the CLI and the five canonical agent skills. It installs from the checked-in CLI build because Open Relay is not published to the npm registry.
```

Keep the skill descriptions. Replace the manual `mkdir` and `cp` block with this content:

```markdown
The global install command synchronizes these skills to `~/.agents/skills/`. Open Relay records managed file hashes in `~/.agents/skills/.open-relay-manifest.json`.

The installer adds missing skills, adopts byte-identical copies, and updates unchanged managed copies. It does not overwrite a modified skill, an unowned skill, a symbolic link, an invalid target, or a directory that contains another file. It records each skipped target and reason under `skipped` in the manifest.

Inspect a skipped target before you change it. To restore canonical updates, move or remove that target and run the same global install command again.
```

Do not document a force option, custom root, backup, merge, or uninstall command.

- [ ] **Step 2: Update the agent installation sequence**

In `AGENTS.md`, change step 2 to `Install the CLI and canonical skills:` while keeping the command byte-for-byte unchanged. Insert this step immediately after it and renumber the remaining steps:

```markdown
3. Inspect `~/.agents/skills/.open-relay-manifest.json`. Preserve and report each entry under `skipped`; move or remove a conflicting target only with user approval.
```

Add these source-map entries:

```markdown
- `scripts/install-skills.mjs`: global npm lifecycle and conflict-safe canonical skill synchronization.
- `tests/install-skills.test.ts`: installer ownership, update, conflict, and failure contracts.
```

Keep the existing dependency-free implementation instruction.

- [ ] **Step 3: Check documentation and package diffs**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

Read the changed installation sections and confirm they contain one command, one target root, one manifest path, and no manual skill-copy sequence.

- [ ] **Step 4: Run the full test suite**

Run:

```bash
npm test
```

Expected: all existing tests plus `tests/install-skills.test.ts` PASS.

- [ ] **Step 5: Run type checking and build verification**

Run:

```bash
npm run typecheck
npm run build
git diff --exit-code -- dist/src
```

Expected: all commands PASS; the installer is a packaged `.mjs` script and does not alter generated CLI output.

- [ ] **Step 6: Run the real onboarding smoke test**

Run:

```bash
npm run test:onboarding
```

Expected: PASS for the packed global CLI, installed skills, manifest, reinstall, and parked-agent delivery lifecycle.

- [ ] **Step 7: Recheck the packed file list**

Run:

```bash
npm pack --dry-run --json
```

Expected: the installer and exactly five canonical `SKILL.md` files are present; test files and transient artifacts are absent.

- [ ] **Step 8: Commit documentation**

```bash
git add README.md AGENTS.md
git commit -m "docs: document unified Open Relay installation"
```
