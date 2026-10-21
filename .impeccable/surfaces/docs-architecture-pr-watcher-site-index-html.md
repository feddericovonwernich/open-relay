---
version: 1
slug: "docs-architecture-pr-watcher-site-index-html"
primary_target: "docs/architecture/pr-watcher/site/index.html"
related_targets: ["docs/architecture/pr-watcher/site/narrative-dossier.html","docs/architecture/pr-watcher/site/guided-signal-desk.html","docs/architecture/pr-watcher/site/layered-system-lens.html"]
---

# Surface Brief

## Purpose

Give reviewers three views of the deterministic PR watcher architecture. Reuse the validated Archify diagrams in all views.

## Audience

Open Relay maintainers review ownership, evidence boundaries, settlement, delivery, and future aggregation. They can select a system map, a question-based path, or a technical narrative.

## Visual Direction

Use black paper, warm ivory, signal gold, and hairline rules. Use Alumni Sans for display text and Albert Sans for body text. Use monospace only for protocol labels. Do not use shadows, gradients, decorative cards, or illustrations.

## Principles

- Show the same verified architecture facts in all three layouts.
- Use diagrams as evidence. Use prose for review questions and invariants.
- Native anchors, ordinary links, and static HTML support local files and no-script reading.
- The switcher stores the selected layout in the URL hash. Browser navigation restores the selected layout.
- On mobile, show prose before evidence. Move wide-screen rails into normal flow before the rails can overflow.
- Treat comment bodies as untrusted data. Do not imply that a model interprets GitHub evidence.

## Decision Log

- 2026-10-16 — Ship Narrative Dossier, Guided Signal Desk, and Layered System Lens together rather than forcing one presentation structure.
- 2026-10-16 — Default to Guided Signal Desk because it exposes the review questions and invariants directly.
- 2026-10-16 — Reuse standalone Archify HTML through local relative URLs instead of duplicating generated diagram code.
- 2026-10-16 — Keep layout content in semantic HTML.
- 2026-10-16 — Limit JavaScript to the outer hash-based switcher.
