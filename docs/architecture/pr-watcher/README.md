# Deterministic PR Watcher Diagrams

Validated Archify diagrams for the design in [`../../superpowers/specs/2026-09-17-deterministic-pr-watcher-design.md`](../../superpowers/specs/2026-09-17-deterministic-pr-watcher-design.md).

## Architecture site

Open [`site/index.html`](site/index.html) to select one of three views of the design:

- **Narrative Dossier** — a continuous technical explanation with review invariants.
- **Guided Signal Desk** — a review path based on review questions.
- **Layered System Lens** — a map-first view of evidence, decisions, settlement, delivery, resilience, and future aggregation.

The static site works from `file://`. It embeds each viewer without copying generated diagram code.

## Recommended reading order

| # | Diagram | Type | Covers |
|---|---|---|---|
| 1 | [Runtime architecture](runtime.architecture.html) | Architecture | GitHub REST/GraphQL, connector-owned heuristics, Relay notification acquisition, `relay notify`, and future aggregation. |
| 2 | [Setup and identity discovery](setup-and-discovery.sequence.html) | Sequence | Dormant generated contracts, discovery, identity pinning, verification enablement, and process supervision. |
| 3 | [Review evidence](review-evidence.sequence.html) | Sequence | GraphQL pagination, root-author provider matching, authoritative resolution, evidence digest, and wire bounds. |
| 4 | [Heuristic decisions](heuristic-decisions.sequence.html) | Sequence | Failed CI, unresolved findings, ambiguous neutral Bugbot, and successful verdict rules. |
| 5 | [Continuous action-required settlement](continuous-action-required.sequence.html) | Sequence | Pending CI, two stable terminal observations, final head fence, and actionable notification emission. |
| 6 | [Continuous successful settlement](continuous-success.sequence.html) | Sequence | Stable all-clear evidence and a success notification with no actions. |
| 7 | [One-shot reconciliation and replay](once-and-replay.sequence.html) | Sequence | `--once`, deterministic event creation, fresh connector state, and Relay replay. |
| 8 | [Single-consumer notification delivery](notification-delivery.sequence.html) | Sequence | Hidden registration/lease/start/complete lifecycle, print-before-completion, and crash replay. |
| 9 | [Evidence change and re-evaluation](evidence-change.sequence.html) | Sequence | Agent remediation, thread resolution, same-head identity changes, and revised notification delivery. |
| 10 | [Failure isolation and retry](failure-isolation.sequence.html) | Sequence | GraphQL failures, low-level event independence, Relay outage retry, and head drift suppression. |
| 11 | [Future aggregation family](future-aggregation-family.sequence.html) | Sequence | A future durable reducer consumes correlated low-level events and reuses notification delivery. |

Each `.html` file is standalone. Each viewer includes light and dark themes, guided views, search, relationship tracing, presentation mode, and export controls. Each related `.json` file contains validated Archify source.
