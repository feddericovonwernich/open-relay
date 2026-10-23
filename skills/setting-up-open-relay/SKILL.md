---
name: setting-up-open-relay
description: Use when installing Open Relay, initializing it in a repository, validating generated files, or proving a new local setup.
---
# Setting Up Open Relay

## Required Background

Read and follow `using-open-relay` first. It owns the universal safety contract; do not duplicate it here. Read the target repository's `AGENTS.md` and inspect its actual `.relay/` configuration and definitions before changing anything.

## Preconditions

- Verify `node --version` is 22.19 or newer and npm is available.
- Use the Open Relay version approved by the repository instructions. Keep the installation command and Node version for the completion report.
- Preserve unrelated working-tree changes. Never put a token in configuration, arguments, logs, or commits; provider-specific credentials and setup belong to `automating-github-prs-with-open-relay`.

## Installation and Initialization

Install exactly the repository-approved CLI. With the current repository instructions, use this command verbatim; do not substitute `npx`, `open-relay@latest`, a project-local package, or an arbitrary release:

```bash
npm install --global https://github.com/feddericovonwernich/open-relay/archive/refs/heads/main.tar.gz
cd /path/to/target-repository
```

Record the command and the installed version for the report.

Use `relay init` for a local setup. Use `relay init --github owner/repository` only when GitHub PR automation is required. Initialization is non-destructive: do not overwrite existing project instructions, schemas, event definitions, or connector files; unchanged files may be reused, while modified files must be preserved and the refusal investigated. Inspect generated `.relay/events`, `.relay/schemas`, `.relay/handlers`, and any connector configuration before starting Relay. Route GitHub discovery, token environment configuration, and provider identity pinning to the GitHub skill.

## Basic Smoke Proof

Start Relay in a supervised persistent process:

```bash
cd /path/to/target-repository
relay start
```

From a second terminal in the same repository, emit the starter event, capture its returned ID, retrieve that exact ID, observe its state, and stop the supervised process:

```bash
relay emit example.requested --version 1 --idempotency-key onboarding-1 --json '{"message":"hello"}'
relay get <event-id-from-emit>
relay stop
```

Do not skip this proof. Success requires the emitted ID and retrieved ID to match; acceptance and durable retrieval are sufficient even if the event remains queued without a worker.

## Setup Failures

For a definition error, inspect the paths named by `.relay/events/` files. If the default port is occupied, stop the other Relay or use `relay start --port <port>`. For stale runtime files or an uncertain prior process, stop safely and use the recovery skill; do not delete state speculatively. Stop on missing or conflicting instructions, modified-file refusal, or any credential exposure.

## Completion Report

Report: Node version and installation command; target repository path; basic or GitHub initialization; generated files inspected; emitted event ID and observed state; GitHub discovery identities pinned, when applicable; and shutdown result.