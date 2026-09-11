# Agent quick start

Use this procedure to install Open Relay into an existing repository and prove that it works.

## Basic local relay

Requirements: Node.js 22.19 or newer and npm.

```bash
node --version
npm install --global https://github.com/feddericovonwernich/open-relay/archive/refs/heads/main.tar.gz
cd /path/to/target-repository
relay init
```

Inspect the generated `.relay/events`, `.relay/schemas`, and `.relay/handlers` files. `relay init` is idempotent when those files are unchanged and refuses to overwrite modified files.

Start the service in a persistent terminal:

```bash
cd /path/to/target-repository
relay start
```

In a second terminal:

```bash
cd /path/to/target-repository
relay emit example.requested \
  --version 1 \
  --idempotency-key onboarding-1 \
  --json '{"message":"hello"}'
relay get <event-id-from-emit>
relay stop
```

Success means `emit` returns an event ID and `get` returns that same event. The starter event may remain queued until a compatible agent worker registers; acceptance and durable retrieval are the onboarding proof.

## One-shot harness agent loop

Run the agent poll as a harness-managed foreground or background process:

```bash
relay agent poll onboarding-agent --definitions example.requested@1 --structured-output --context-tokens 5000
```

While parked, the process prints nothing and consumes no model turn. When a compatible event arrives, it prints one raw delivery JSON line and exits `0`. Service that delivery immediately, then use the lease ID to reply before polling again:

```bash
relay agent reply <lease-id> start
relay agent reply <lease-id> complete --json '{"result":{"reply":"hello"},"effects":[]}'
relay agent poll onboarding-agent --definitions example.requested@1 --structured-output --context-tokens 5000
```

The harness waits on process completion; it never loops `relay get` or runs model/tool execution while no event exists. The exact lifecycle is:

```text
park -> wake with one delivery -> start -> optional progress/renew/effect/control -> complete/fail/cancelled -> re-poll
```

After the ten-minute deadline with no delivery, the only output is `{"type":"timeout"}` and the harness must re-poll immediately. An active-delivery error means settle the existing lease before polling again. Credentials stay only in ignored `.relay/agent-leases` files with mode `0600`; they are not in delivery JSON, stdout, or argv. A Relay restart invalidates the authority and existing recovery owns unresolved work.

## GitHub PR automation

Generate the base project and connector configuration:

```bash
cd /path/to/target-repository
relay init --github owner/repository
relay start
```

In a second terminal, provide a read-only GitHub token with **Checks**, **Pull requests**, and **Metadata** access, then discover the provider identities observed in the repository:

```bash
cd /path/to/target-repository
export GITHUB_TOKEN=github_pat_...
relay connect github --config .relay/connectors/github.json --once --discover
```

The generated Copilot and Cursor Bugbot identities are pinned. SonarQube identity varies by installation, so discovery intentionally leaves it unpinned. Add the observed Sonar `appId` to `match.appIds` or `appSlug` to `match.appSlugs` in `.relay/connectors/github.json`, inspect the diff, then run:

```bash
relay connect github --config .relay/connectors/github.json
```

Never commit `GITHUB_TOKEN`. The configuration stores only the environment-variable name.

### Persistent targeted watch

Run both commands under harness process supervision:

```bash
relay connect github --config .relay/connectors/github.json --pull-request 197
relay agent poll pr-197-agent --definitions pr.automation.settled@1 --structured-output --context-tokens 5000 --correlation-id github:owner/repository:pull-request:197
```

The connector stays running and silent while any configured trigger lacks a terminal current-head artifact; the poll stays parked and the settled event wakes it. To receive immediate artifacts too, use `--definitions pr.automation.completed@1,pr.automation.settled@1` and settle/re-poll after each delivery. Before `complete`, construct `body.result` against the returned `delivery.outputSchema`; HTTP 400 leaves the lease active for a corrected reply. Targeted `lookbackHours` is irrelevant, unrelated queued events cannot match the correlation filter, and neither command consumes model turns while blocked.

## Recovery and shutdown

```bash
relay recovery list
relay recovery resolve <event-id> --as completed --evidence '{"verified":true}'
relay cancel <event-id>
relay stop
```

If `relay start` reports a definition error, inspect the paths named by files in `.relay/events/`. If another relay owns the default port, stop it or start this one with `relay start --port <port>`.

## Agent completion report

Report:

- Node version and installation command;
- target repository path;
- whether basic or GitHub initialization was used;
- generated files inspected;
- emitted event ID and state;
- GitHub discovery identities pinned, when applicable;
- shutdown result.
