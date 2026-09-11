# Open Relay

A local, durable event relay for AI harnesses, subprocess plugins, and external connectors.

Open Relay keeps event behavior extensible while fixing the lifecycle around it: schema validation, idempotent acceptance, immutable definitions, leases, retries, cancellation, recovery, and observation.

> **Status:** Experimental. The architecture is implemented and extensively tested, but public APIs may change. Node 22 currently reports `node:sqlite` as experimental.

## Why

Agent integrations often combine browser actions, shell polling, ad hoc JSON, and source edits without a reliable handoff. Open Relay provides one local path for that work:

```mermaid
flowchart LR
  P[Browser / CLI / Connector] -->|typed event| R[Open Relay]
  R --> D[(SQLite)]
  D --> A[AI harness]
  D --> X[Subprocess plugin]
  A & X -->|lease-bound progress and result| R
  R -->|cursor-safe SSE| O[Observer]
```

Event definitions decide **what** work means and which handler receives it. Open Relay owns **how** work is accepted, delivered, recovered, and observed.

## Features

- Versioned JSON event definitions with input and output schemas
- Content-addressed immutable definition revisions
- Producer-scoped idempotency keys
- At-least-once delivery with worker and lease fencing
- Durable retry scheduling and explicit recovery for uncertain effects
- Capability-matched AI workers with trusted context boundaries
- Bounded subprocess protocol over JSONL
- Cursor-safe Server-Sent Events backed by durable update history
- Loopback-only HTTP API with scoped credentials
- CLI and browser clients
- GitHub PR connector with recognizers for:
  - SonarQube / SonarCloud analysis
  - GitHub Copilot code review
  - Cursor Bugbot review

## Requirements

- Node.js 22.19 or newer
- npm

## Install

```bash
npm install --global https://github.com/feddericovonwernich/open-relay/archive/refs/heads/main.tar.gz
relay --help
```

The GitHub installation uses the checked-in CLI build verified by CI. Open Relay is not published to the npm registry.

## Two-minute quick start

Create a project:

```bash
mkdir relay-demo
cd relay-demo
relay init
```

Start the relay in that directory:

```bash
relay start
```

In another terminal, return to the same directory and emit an event:

```bash
cd relay-demo
relay emit example.requested \
  --version 1 \
  --idempotency-key example-1 \
  --json '{"message":"hello"}'
```

Use the returned ID to read the durable event, then stop the service:

```bash
relay get <event-id>
relay stop
```

The example can remain queued until a compatible worker registers. Successful acceptance and retrieval prove the relay is installed and the generated definition is valid.

`relay init` creates `.relay/events`, `.relay/schemas`, and `.relay/handlers`. It is idempotent when generated files are unchanged and refuses to overwrite modified files. See [`examples/basic`](examples/basic) for the exact generated project.

## Agent installation

Agents should read [`AGENTS.md`](AGENTS.md), then follow the deterministic [`agent quick start`](docs/agent-quickstart.md). The required sequence is:

```text
verify Node -> install from GitHub -> initialize target repository
-> inspect generated files -> start -> emit -> get -> stop -> report evidence
```

### Harness agent delivery

Harness agents use a one-shot poll process rather than a `relay get` loop:

```bash
relay agent poll onboarding-agent --definitions example.requested@1 --structured-output --context-tokens 5000
```

Keep this command under harness process supervision. It prints nothing while parked, prints one raw JSON delivery when compatible work wakes it, and prints `{"type":"timeout"}` after ten minutes when no delivery arrives. When it exits, service that one delivery immediately and reply before polling again:

```bash
relay agent reply <lease-id> start
relay agent reply <lease-id> complete --json '{"result":{"reply":"hello"},"effects":[]}'
relay agent poll onboarding-agent --definitions example.requested@1 --structured-output --context-tokens 5000
```

The harness waits on process completion; it never loops `relay get` or consumes model turns while no event exists. The complete loop is:

```text
park one foreground/background poll -> receive one delivery -> reply start/progress/renew/effects -> reply complete/fail/cancelled -> start a fresh poll
```

There is no model or tool execution while the poll is parked, and the harness must never loop `relay get` to acquire work. A timeout means immediate re-poll. An active-delivery error means settle the existing lease before polling again. Worker credentials are kept only in ignored `.relay/agent-leases` files with mode `0600`; they never appear in delivery JSON, stdout, or argv. A Relay restart invalidates those authorities and hands unresolved work to the existing lease recovery path.

## GitHub PR connector

Initialize Open Relay for a repository:

```bash
cd /path/to/target-repository
relay init --github owner/repository
relay start
```

In another terminal, provide a read-only GitHub token and discover provider identities:

```bash
cd /path/to/target-repository
export GITHUB_TOKEN=github_pat_...
relay connect github --config .relay/connectors/github.json --once --discover
```

The generated configuration pins the documented Copilot and Cursor Bugbot identities. SonarQube identity varies by installation, so it is intentionally unpinned for discovery. Add the observed Sonar app ID or slug to `.relay/connectors/github.json` before continuous polling:

```bash
relay connect github --config .relay/connectors/github.json
```

Terminology:

- **Connector:** owns an external transport, authentication, polling, and Relay emission.
- **Recognizer:** identifies a provider-specific completion artifact.
- **Trigger:** maps a recognized completion to an Open Relay event type and version.

Repository modes:

| Mode | Provider completion events | All Check Runs settled event |
|---|---:|---:|
| `configured-tools` | Yes | No |
| `generic-check-runs` | No | Yes |
| `configured-tools-and-generic-check-runs` | Yes | Yes |

```json
{
  "name": "owner/repository",
  "mode": "configured-tools-and-generic-check-runs"
}
```

To receive SonarQube, Copilot, and Bugbot completion events plus one
`pr.ci.settled@1` event, set the repository mode to
`configured-tools-and-generic-check-runs`. Omit the optional `aggregate`
mapping when exactly four events are required; configuring it also emits
`pr.automation.settled@1`.

Copilot is a submitted pull-request review and therefore does not appear in
`pr.ci.settled@1.checks`.

| Provider | Completion signal |
|---|---|
| SonarQube | Completed `SonarCloud Code Analysis` or `SonarQube Code Analysis` check with operator-pinned app identity |
| GitHub Copilot | Submitted current-head pull-request review from the configured Copilot bot identity |
| Cursor Bugbot | Completed `Cursor Bugbot` check from the Cursor GitHub App |

The connector requires read-only **Checks**, **Pull requests**, and **Metadata** permissions. Tokens stay in authorization headers and are excluded from configuration, events, and logs.

See [`examples/github-pr-automation`](examples/github-pr-automation) and the [GitHub connector specification](docs/superpowers/specs/2026-09-08-github-pr-connectors-design.md).

## Security model

- The relay binds to loopback.
- Producer, observer, worker, and administrator credentials are separate.
- Payload and retrieved context are untrusted data.
- The trusted reference worker runtime enforces model tool access and redacts resolved secrets.
- Subprocess plugins and arbitrary worker processes remain trusted local code; process separation is crash containment, not a sandbox.
- Consequential effects retry only with persisted downstream idempotency evidence. Ambiguous outcomes enter explicit recovery.

## Architecture

- [Architecture specification](docs/superpowers/specs/2026-09-05-open-relay-design.md)
- [GitHub connector specification](docs/superpowers/specs/2026-09-08-github-pr-connectors-design.md)
- [Architecture presentation](docs/architecture/index.html)

## Development

```bash
git clone https://github.com/feddericovonwernich/open-relay.git
cd open-relay
npm ci
npm test
npm run typecheck
npm run build
npm run test:onboarding
```

The test suite covers concurrent acceptance, definition immutability, lease races, retries, cancellation, effect recovery, process failure modes, SSE replay races, GitHub pagination/rate limits, provider recognition, connector restart reconciliation, and real loopback integration.

## License

Apache License 2.0. See [LICENSE](LICENSE).

### Targeted GitHub PR watch

Run the connector and its parked harness worker as two persistent, harness-managed processes:

```bash
relay connect github --config .relay/connectors/github.json --pull-request 197
relay agent poll pr-197-agent --definitions pr.automation.settled@1 --structured-output --context-tokens 5000 --correlation-id github:owner/repository:pull-request:197
```

Targeted mode requires one configured repository; `lookbackHours` is irrelevant and unrelated queued events cannot match the correlation-filtered worker. The connector stays running and silent while any configured trigger lacks a terminal current-head artifact. The poll stays parked without model turns; the settled event wakes it. To receive immediate artifacts too, use `--definitions pr.automation.completed@1,pr.automation.settled@1` and settle/re-poll after each delivery.

Before `complete`, construct `body.result` against the returned `delivery.outputSchema`. HTTP 400 for an invalid output leaves the lease active for a corrected reply. Neither command consumes model turns while blocked.
