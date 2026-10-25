# Unified Open Relay Installer Design

## Status

Approved in chat on 2026-10-24.

## Goal

Make the existing global npm command install or update both Open Relay and its five canonical agent skills:

```bash
npm install --global https://github.com/feddericovonwernich/open-relay/archive/refs/heads/main.tar.gz
```

The command must keep user-modified or unrelated skill targets unchanged.

## Context

The npm package currently contains the compiled CLI but excludes `skills/`. The README requires users to copy five skill directories into `~/.agents/skills/` after installing the CLI. This creates two independent update paths and permits the CLI and skills to drift.

No installer script or skill-sync command exists. The package already uses Node.js 22.19 or newer, so the installer can use Node.js standard-library APIs without another runtime or dependency.

## Goals

- Keep the current global npm command as the only install and update command.
- Package the five canonical skills with the CLI.
- Install missing skills during a global npm install.
- Adopt an existing skill when its bytes equal the packaged skill.
- Update a managed skill only when the user has not changed it since the previous install.
- Preserve modified, unowned, symlinked, and unrelated targets.
- Keep local development installs and `npm ci` from writing to the user skill directory.
- Record ownership and skipped conflicts in an inspectable manifest.
- Use atomic file replacement and no new dependency.

## Non-goals

- Uninstall skills when npm removes Open Relay.
- Add a `relay skills` command.
- Add prompts or an interactive installer.
- Support another skill root or an environment-variable override.
- Merge user edits with canonical skill text.
- Delete, back up, or overwrite conflicting user content.
- Install skills for other providers or runtimes.

## Package Layout

`package.json` will include these paths in the packed artifact:

```text
dist/src/
skills/using-open-relay/SKILL.md
skills/setting-up-open-relay/SKILL.md
skills/waiting-for-open-relay-events/SKILL.md
skills/automating-github-prs-with-open-relay/SKILL.md
skills/recovering-open-relay/SKILL.md
scripts/install-skills.mjs
```

The package will run `node scripts/install-skills.mjs` from `postinstall`. The script will return immediately unless npm identifies the install as global. It must perform this check before it resolves the home directory or reads packaged skills. Therefore, repository `npm install` and `npm ci` remain side-effect free outside the checkout.

The canonical skill list is hardcoded. The installer does not enumerate arbitrary package directories.

The module exports its synchronization function for tests. The lifecycle entry point derives the package root from its own file location and the target root from the current user's home directory. This test seam is not a production path override.

For a global install, `HOME` must be a non-empty absolute path. A missing or invalid `HOME` value is fatal. The script does not infer another target root.

## Target and Manifest

The target root is:

```text
~/.agents/skills/
```

The ownership manifest is:

```text
~/.agents/skills/.open-relay-manifest.json
```

The manifest has this versioned shape:

```json
{
  "schemaVersion": 1,
  "skills": {
    "using-open-relay": {
      "sha256": "<hash of the last installed SKILL.md>"
    }
  },
  "skipped": {
    "recovering-open-relay": {
      "reason": "modified"
    }
  }
}
```

`skills` records the last hash that Open Relay installed or adopted. A conflict can leave this ownership record in place while `skipped` records the current problem. This lets a later run update the skill if the user restores the last managed bytes. A successful install, adoption, update, or current result removes that skill from `skipped`. The installer writes no timestamp, machine identifier, or credential.

A missing manifest means no existing target is trusted as managed. A malformed or unsupported manifest is fatal and must be reported before any target changes.

## Source Validation

Before it changes targets, the installer must validate all five packaged sources:

- Each skill path is a directory, not a symbolic link, and its `SKILL.md` is a regular file, not a symbolic link.
- Each `SKILL.md` has frontmatter whose `name` equals its canonical directory name.
- Every source can be read and hashed with SHA-256.

A missing or invalid packaged skill is fatal. The installer must not perform a partial install from an invalid package.

## Synchronization Rules

The installer inspects each canonical target with `lstat` and applies the first matching rule:

| Target state | Action | Manifest result |
|---|---|---|
| Target directory is absent | Create it and atomically install `SKILL.md` | Record packaged hash in `skills` |
| Target directory exists and is empty | Atomically install `SKILL.md` | Record packaged hash in `skills` |
| Existing `SKILL.md` equals the packaged bytes and no unrelated entry exists | Leave bytes unchanged and adopt it | Record packaged hash in `skills` |
| Existing target hash equals its prior manifest hash and no unrelated entry exists | Atomically replace `SKILL.md` with the packaged version | Record new packaged hash in `skills` |
| Existing target already equals the packaged hash and is managed | Leave bytes unchanged | Retain packaged hash in `skills` |
| Target directory or `SKILL.md` is a symbolic link | Skip the target | Record `symlink` in `skipped` |
| Target contains an entry other than `SKILL.md` | Skip the target | Record `unrelated-files` in `skipped` |
| Existing unowned `SKILL.md` differs from the package | Skip the target | Record `unowned` in `skipped` |
| Managed `SKILL.md` differs from its prior manifest hash | Skip the target | Record `modified` in `skipped` |
| Target path exists but is not a directory, or `SKILL.md` is not a regular file | Skip the target | Record `invalid-target` in `skipped` |

A conflict affects only that skill. Other skills continue to install or update. A conflict does not fail the global npm installation.

When a managed target is skipped, the installer retains its previous `skills` hash and adds the current `skipped` reason. When an unowned target is skipped, the installer adds only the `skipped` reason.

The installer never removes an entry from a target directory. It never follows a target symbolic link.

## Atomic Writes and Recovery

The installer writes each `SKILL.md` to a temporary sibling file, sets user-only file permissions, and renames it over the destination. It writes the manifest with the same temporary-file-and-rename pattern.

The installer validates all packaged sources and parses the manifest before any target write. An unexpected filesystem error is fatal. If a failure occurs after a skill file is replaced but before the manifest rename, rerunning the same npm command can adopt the packaged bytes and repair ownership state.

Created target directories use user-only permissions. Existing directory permissions remain unchanged.

## Output and Remediation

The script reports one status for every canonical skill:

```text
installed
adopted
updated
current
skipped: <reason>
```

It prints a final summary. Successful lifecycle output can be suppressed by npm, so the manifest remains the durable status record.

For a skipped target, documentation tells the user to inspect it. To resume canonical updates, the user moves or removes that conflicting target and reruns the same global npm command. The installer does not provide a force option.

## Security Boundaries

- The package controls the source list; target names never come from user input.
- Symbolic links at a canonical skill directory or its `SKILL.md` are rejected.
- Hash comparison uses exact file bytes.
- The installer writes only below `~/.agents/skills/`.
- The manifest contains hashes and status reasons only.
- Conflicts fail closed by preserving target bytes.
- Unexpected I/O failures return a nonzero lifecycle status.

## Documentation Changes

`README.md` will keep the existing install command and state that it installs or updates the CLI and canonical skills. It will replace the manual copy block with:

- the target root;
- the managed-update rule;
- the manifest path;
- skipped-conflict behavior;
- the move-or-remove-and-rerun remediation.

`AGENTS.md` will keep the current command and require inspection of installer results before initialization. The focused setup skill remains correct because its system installation command does not change.

## Verification

### Unit behavior

`tests/install-skills.test.ts` will exercise the installer against temporary package and home directories:

- non-global install is a no-op;
- global install with a missing or invalid `HOME` fails before reading packaged skills;
- first global install creates all five skills and the manifest;
- an empty target is installed;
- identical manual copies are adopted;
- unchanged managed copies update;
- current managed copies remain unchanged;
- modified managed copies are skipped;
- differing unowned copies are skipped;
- unrelated files are preserved and skipped;
- target and file symbolic links are rejected;
- invalid target types are skipped;
- malformed or unsupported manifests fail before target writes;
- missing, symlinked, or invalid packaged skills fail before target writes;
- unexpected filesystem failures return a failure;
- a rerun repairs ownership after packaged bytes exist without a matching manifest entry.

Tests verify bytes, manifest state, and observable statuses. They do not assert source wording.

### Packed-package behavior

`tests/onboarding.test.ts` will extend the existing real package smoke test:

1. Pack Open Relay.
2. Install it globally into a temporary prefix with a temporary home.
3. Verify `relay --help`.
4. Verify all five direct-root `SKILL.md` files.
5. Verify every installed skill is byte-identical to the packaged source.
6. Verify the manifest owns all five skills.
7. Reinstall and verify the managed update path remains successful.

`npm pack --dry-run --json` must list the installer and all five skill files.

### Repository verification

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --exit-code -- dist/src
npm run test:onboarding
```

## Acceptance Criteria

- The existing global npm command installs the CLI and five skills.
- Rerunning that command updates every unchanged managed skill.
- The installed CLI and skills come from the same packed package.
- Modified or unrelated skill targets remain byte-for-byte unchanged.
- Every skipped conflict is represented in the manifest.
- Local dependency installation does not touch the user skill root.
- The packed artifact contains the installer and all canonical skills.
- The full repository verification sequence passes.
