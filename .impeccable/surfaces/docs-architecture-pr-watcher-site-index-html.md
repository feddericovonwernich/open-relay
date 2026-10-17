---
version: 1
slug: "docs-architecture-pr-watcher-site-index-html"
primary_target: "docs/architecture/pr-watcher/site/index.html"
related_targets: ["docs/architecture/pr-watcher/site/narrative-dossier.html","docs/architecture/pr-watcher/site/guided-signal-desk.html","docs/architecture/pr-watcher/site/layered-system-lens.html"]
---

# Surface Brief

## Purpose

Help reviewers understand and challenge the deterministic PR watcher architecture through three switchable reading structures without duplicating or regenerating the validated Archify diagrams.

## Audience

Open Relay maintainers reviewing ownership, evidence boundaries, settlement, delivery, and extension seams. They need a fast system map, a guided question path, or a continuous technical narrative depending on review context.

## Visual Direction

Signal Desk: black paper, warm ivory, signal gold, hairline rules, Alumni Sans display type, Albert Sans body type, and monospace only for protocol labels. Flat editorial surfaces; no shadows, gradients, decorative cards, or invented illustration.

## Principles

- The same verified architecture facts must remain visible in all three layouts.
- Diagrams are the proving surface; concise prose frames reviewer questions and invariants.
- Native anchors, ordinary links, and static HTML preserve local-file operation and no-script readability.
- The switcher records the selected layout in the URL hash and keeps browser navigation meaningful.
- Mobile order is prose first, evidence second; wide-screen rails become normal-flow navigation before they can cause overflow.
- Comment bodies remain untrusted data and no UI wording implies model interpretation of GitHub evidence.

## Decision Log

- 2026-10-16 — Ship Narrative Dossier, Guided Signal Desk, and Layered System Lens together rather than forcing one presentation structure.
- 2026-10-16 — Default to Guided Signal Desk because it exposes the review questions and invariants directly.
- 2026-10-16 — Reuse standalone Archify HTML through local relative URLs instead of duplicating generated diagram code.
- 2026-10-16 — Keep layout content in semantic HTML; JavaScript is limited to the outer hash-based switcher.
