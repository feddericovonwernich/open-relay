import { strict as assert } from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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

type Fixture = {
  root: string;
  packageRoot: string;
  home: string;
};

type ExecError = {
  code?: unknown;
  stderr?: unknown;
  stdout?: unknown;
};

type InstallerModule = {
  SKILL_NAMES: readonly string[];
  installSkills(options: { packageRoot: string; home: string; log?: (line: string) => void }): Promise<InstallResult[]>;
  runPostinstall(options: { env: NodeJS.ProcessEnv; packageRoot: string; log?: (line: string) => void }): Promise<InstallResult[]>;
};

const installerUrl = new URL("../scripts/install-skills.mjs", import.meta.url).href;
// The computed URL intentionally exercises the runtime module boundary without a declaration file.
const installer = await import(installerUrl) as InstallerModule;

function skillText(name: string, body = "canonical"): string {
  return `---\nname: ${name}\ndescription: Test skill.\n---\n# ${name}\n${body}\n`;
}

async function createFixture(): Promise<Fixture> {
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

async function manifest(home: string) {
  return JSON.parse(await readFile(join(home, ".agents", "skills", ".open-relay-manifest.json"), "utf8"));
}

async function target(home: string, name: string) {
  return readFile(join(home, ".agents", "skills", name, "SKILL.md"));
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("runPostinstall skips non-global installs before package inspection", async () => {
  const log: string[] = [];
  const result = await installer.runPostinstall({ env: {}, packageRoot: "/deliberately/missing", log: (line) => log.push(line) });
  assert.deepEqual(result, []);
  assert.deepEqual(log, []);
});

test("runPostinstall rejects missing or relative HOME before package inspection", async () => {
  for (const HOME of ["", "relative"]) {
    await assert.rejects(
      installer.runPostinstall({ env: { npm_config_global: "true", HOME }, packageRoot: "/deliberately/missing" }),
      /HOME must be an absolute path/,
    );
  }
});

test("exports canonical skill names", () => {
  assert.deepEqual(installer.SKILL_NAMES, skillNames);
  assert(Object.isFrozen(installer.SKILL_NAMES));
});

test("first global run installs all skills, logs, modes, and manifest", async () => withFixture(async ({ root, packageRoot, home }) => {
  const log: string[] = [];
  const result = await installer.runPostinstall({ env: { npm_config_global: "true", HOME: home }, packageRoot, log: (line) => log.push(line) });
  assert.deepEqual(result, skillNames.map((name) => ({ name, status: "installed" })));
  assert.deepEqual(log, [...skillNames.map((name) => `${name}: installed`), "Open Relay skills: 5 managed, 0 skipped"]);
  for (const name of skillNames) {
    assert.deepEqual(await readFile(join(home, ".agents", "skills", name, "SKILL.md")), Buffer.from(skillText(name)));
    assert.equal((await stat(join(home, ".agents", "skills", name))).mode & 0o777, 0o700);
    assert.equal((await stat(join(home, ".agents", "skills", name, "SKILL.md"))).mode & 0o777, 0o600);
  }
  const value = await manifest(home);
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(Object.keys(value.skills), [...skillNames]);
  assert.deepEqual(value.skipped, {});
  assert.deepEqual(log.slice(-1), ["Open Relay skills: 5 managed, 0 skipped"]);
  void root;
}));

test("unchanged run is current and leaves manifest unchanged", async () => withFixture(async ({ packageRoot, home }) => {
  await installer.installSkills({ packageRoot, home, log: () => {} });
  const before = await readFile(join(home, ".agents", "skills", ".open-relay-manifest.json"));
  const log: string[] = [];
  const result = await installer.installSkills({ packageRoot, home, log: (line) => log.push(line) });
  assert.deepEqual(result, skillNames.map((name) => ({ name, status: "current" })));
  assert.deepEqual(log, [...skillNames.map((name) => `${name}: current`), "Open Relay skills: 5 managed, 0 skipped"]);
  assert.deepEqual(await readFile(join(home, ".agents", "skills", ".open-relay-manifest.json")), before);
}));

test("rejects malformed or unsupported manifests before target writes", async () => withFixture(async ({ packageRoot, home }) => {
  const skillsRoot = join(home, ".agents", "skills");
  await mkdir(skillsRoot, { recursive: true });
  const manifestPath = join(skillsRoot, ".open-relay-manifest.json");
  for (const contents of ["{", JSON.stringify({ schemaVersion: 2, skills: {}, skipped: {} })]) {
    await writeFile(manifestPath, contents);
    await assert.rejects(installer.installSkills({ packageRoot, home }), /invalid Open Relay skill manifest/);
    assert.deepEqual(await readdir(skillsRoot), [".open-relay-manifest.json"]);
  }
}));

test("rejects missing, symlinked, and mismatched packaged skills before target writes", async () => {
  const cases = [
    async ({ packageRoot }: Fixture) => rm(join(packageRoot, "skills", skillNames[0], "SKILL.md")),
    async ({ packageRoot, root }: Fixture) => {
      await rm(join(packageRoot, "skills", skillNames[0]), { recursive: true });
      await symlink(join(root, "elsewhere"), join(packageRoot, "skills", skillNames[0]));
    },
    async ({ packageRoot, root }: Fixture) => {
      await writeFile(join(root, "linked.md"), skillText(skillNames[0]));
      await rm(join(packageRoot, "skills", skillNames[0], "SKILL.md"));
      await symlink(join(root, "linked.md"), join(packageRoot, "skills", skillNames[0], "SKILL.md"));
    },
    async ({ packageRoot }: Fixture) => writeFile(join(packageRoot, "skills", skillNames[0], "SKILL.md"), skillText("wrong")),
  ];
  for (const setup of cases) await withFixture(async (fixture) => {
    await setup(fixture);
    await assert.rejects(installer.installSkills({ packageRoot: fixture.packageRoot, home: fixture.home }), /invalid packaged skill/);
    assert.equal(await lstat(join(fixture.home, ".agents")).catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");
  });
});

test("rejects symlinked skill-root ancestors before changing the external target", async () => {
  for (const level of ["agents", "skills"]) {
    await withFixture(async ({ packageRoot, home, root }) => {
      const external = join(root, "external");
      const externalSkills = join(external, "skills");
      await mkdir(externalSkills, { recursive: true });
      if (level === "agents") {
        await symlink(external, join(home, ".agents"));
      } else {
        await mkdir(join(home, ".agents"));
        await symlink(externalSkills, join(home, ".agents", "skills"));
      }
      await assert.rejects(
        installer.installSkills({ packageRoot, home }),
        /invalid Open Relay skill root/,
      );
      assert.deepEqual(await readdir(level === "agents" ? external : externalSkills), level === "agents" ? ["skills"] : []);
      assert.equal(await lstat(join(externalSkills, ".open-relay-manifest.json")).catch((error: NodeJS.ErrnoException) => error.code), "ENOENT");
    });
  }
});

test("propagates an unexpected regular-file home error", async () => withFixture(async ({ packageRoot, root }) => {
  const home = join(root, "home-file");
  await writeFile(home, "not a directory");
  await assert.rejects(installer.installSkills({ packageRoot, home }), (error: unknown) => {
    if (error === null || typeof error !== "object" || !("code" in error)) return false;
    return error.code === "ENOTDIR" || error.code === "EEXIST";
  });
}));

test("direct global process rejects invalid HOME with code 1 and no stdout", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/install-skills.mjs"], { env: { ...process.env, npm_config_global: "true", HOME: "" } }),
    (error: unknown) => {
      if (error === null || typeof error !== "object") return false;
      const details = error as ExecError;
      return details.code === 1 && typeof details.stderr === "string" && /HOME must be an absolute path/.test(details.stderr) && details.stdout === "";
    },
  );
});

test("adopts an identical unowned target without rewriting", async () => withFixture(async ({ packageRoot, home }) => {
  const name = skillNames[0];
  const path = join(home, ".agents", "skills", name, "SKILL.md");
  await mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(skillText(name));
  await writeFile(path, bytes);
  const before = await readFile(path);
  const result = await installer.installSkills({ packageRoot, home });
  assert.equal(result[0].status, "adopted");
  assert.deepEqual(await readFile(path), before);
}));

test("installs into an empty target directory", async () => withFixture(async ({ packageRoot, home }) => {
  const name = skillNames[0];
  await mkdir(join(home, ".agents", "skills", name), { recursive: true });
  const result = await installer.installSkills({ packageRoot, home });
  assert.equal(result[0].status, "installed");
  assert.deepEqual(await readdir(join(home, ".agents", "skills", name)), ["SKILL.md"]);
}));

test("updates a changed managed source", async () => withFixture(async ({ packageRoot, home }) => {
  await installer.installSkills({ packageRoot, home, log: () => {} });
  const name = skillNames[0];
  const bytes = skillText(name, "version two");
  await writeFile(join(packageRoot, "skills", name, "SKILL.md"), bytes);
  const result = await installer.installSkills({ packageRoot, home });
  assert.equal(result[0].status, "updated");
  assert.deepEqual(await target(home, name), Buffer.from(bytes));
}));

test("classifies initial target conflicts in canonical order", async () => withFixture(async ({ packageRoot, home, root }) => {
  const skillsRoot = join(home, ".agents", "skills");
  const setups = [
    async () => { const path = join(skillsRoot, skillNames[0], "SKILL.md"); await mkdir(dirname(path), { recursive: true }); await writeFile(path, skillText(skillNames[0])); },
    async () => { const path = join(skillsRoot, skillNames[1], "SKILL.md"); await mkdir(dirname(path), { recursive: true }); await writeFile(path, "different"); },
    async () => { const path = join(skillsRoot, skillNames[2]); await mkdir(path, { recursive: true }); await writeFile(join(path, "other"), "x"); },
    async () => { await symlink(join(root, "link-target"), join(skillsRoot, skillNames[3])); },
    async () => { await mkdir(skillsRoot, { recursive: true }); await writeFile(join(skillsRoot, skillNames[4]), "file"); },
  ];
  for (const setup of setups) await setup();
  const result = await installer.installSkills({ packageRoot, home });
  assert.deepEqual(result, [
    { name: skillNames[0], status: "adopted" },
    { name: skillNames[1], status: "skipped", reason: "unowned" },
    { name: skillNames[2], status: "skipped", reason: "unrelated-files" },
    { name: skillNames[3], status: "skipped", reason: "symlink" },
    { name: skillNames[4], status: "skipped", reason: "invalid-target" },
  ]);
}));

test("preserves modified and symlinked managed conflicts in the manifest", async () => withFixture(async ({ packageRoot, home, root }) => {
  await installer.installSkills({ packageRoot, home, log: () => {} });
  const modified = skillNames[0];
  const linked = skillNames[1];
  const custom = Buffer.from("custom");
  await writeFile(join(home, ".agents", "skills", modified, "SKILL.md"), custom);
  const linkTarget = join(root, "custom.md");
  await writeFile(linkTarget, "linked");
  await rm(join(home, ".agents", "skills", linked, "SKILL.md"));
  await symlink(linkTarget, join(home, ".agents", "skills", linked, "SKILL.md"));
  const result = await installer.installSkills({ packageRoot, home });
  assert.deepEqual(result.slice(0, 2), [
    { name: modified, status: "skipped", reason: "modified" },
    { name: linked, status: "skipped", reason: "symlink" },
  ]);
  assert.deepEqual(await readFile(join(home, ".agents", "skills", modified, "SKILL.md")), custom);
  assert.equal(await readlink(join(home, ".agents", "skills", linked, "SKILL.md")), linkTarget);
  const value = await manifest(home);
  assert.equal(value.skills[modified].sha256.length, 64);
  assert.equal(value.skills[linked].sha256.length, 64);
  assert.equal(value.skipped[modified].reason, "modified");
  assert.equal(value.skipped[linked].reason, "symlink");
}));

test("resolves conflicts and removes skipped entries", async () => withFixture(async ({ packageRoot, home }) => {
  await installer.installSkills({ packageRoot, home, log: () => {} });
  const name = skillNames[0];
  await writeFile(join(home, ".agents", "skills", name, "SKILL.md"), "changed");
  await installer.installSkills({ packageRoot, home, log: () => {} });
  await writeFile(join(home, ".agents", "skills", name, "SKILL.md"), skillText(name));
  const result = await installer.installSkills({ packageRoot, home });
  assert.equal(result[0].status, "current");
  assert.equal((await manifest(home)).skipped[name], undefined);
}));

test("accepts synchronized version-two bytes after an interrupted manifest rename", async () => withFixture(async ({ packageRoot, home }) => {
  await installer.installSkills({ packageRoot, home, log: () => {} });
  const name = skillNames[0];
  const bytes = skillText(name, "version two");
  await writeFile(join(packageRoot, "skills", name, "SKILL.md"), bytes);
  await writeFile(join(home, ".agents", "skills", name, "SKILL.md"), bytes);
  const result = await installer.installSkills({ packageRoot, home });
  assert.equal(result[0].status, "current");
  assert.notEqual((await manifest(home)).skills[name].sha256, undefined);
  assert.equal((await manifest(home)).skipped[name], undefined);
}));
