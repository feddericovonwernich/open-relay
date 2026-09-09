# Agent quick start

Use this procedure to install Open Relay into an existing repository and prove that it works.

## Basic local relay

Requirements: Node.js 22.19 or newer and npm.

```bash
node --version
npm install --global github:feddericovonwernich/open-relay
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
