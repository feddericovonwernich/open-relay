# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain static HTML, CSS, and minimal browser JavaScript. No build step or runtime dependency.

## Users

Technical collaborators reviewing and challenging the architecture before implementation.

## Product Purpose

Explain an extensible local event relay inspired by Impeccable Live Mode. The presentation should make the components, event lifecycle, extension contracts, reliability model, and implementation sequence understandable enough to support a design review.

## Positioning

Event types and handlers are open-ended, while the envelope, schema validation, leasing, progress, completion, and recovery lifecycle remain fixed. One relay supports both AI-harness handlers and executable subprocess plugins.

## Operating Context

The artifact is opened locally in a browser and presented slide by slide. Reviewers need both a guided narrative and enough visible detail to discuss protocol decisions.

## Capabilities and Constraints

- Browser and local CLI tools are first-version event producers.
- TypeScript and Node own the future relay and plugin API.
- Delivery is at least once with idempotent acceptance, immutable definition revisions, scoped leases, and explicit recovery for uncertain effects.
- Event handlers may be declarative AI instructions or executable subprocesses; both use capability matching, enforced trust boundaries, and one relay-owned lifecycle.
- The presentation itself is one static HTML file and must work without a server.
- The system name remains undecided.

## Brand Commitments

The presentation should take visual inspiration from impeccable.style: dark editorial surfaces, warm metallic accents, restrained ornament, strong typography, and a crafted rather than generic technical-document feel.

## Evidence on Hand

The architecture is grounded in the public Impeccable Live Mode documentation and source investigation. No product logo, final name, customer evidence, benchmarks, or production implementation exists; the presentation must not fabricate them.

## Product Principles

- Keep the relay local and operationally boring.
- Make arbitrary event behavior possible without making reliability extensible.
- Treat schemas and leases as public contracts.
- Isolate executable plugins from the relay process.
- Add distributed-system machinery only after a local use case requires it.

## Accessibility & Inclusion

The presentation must support keyboard navigation, visible focus, semantic document structure, readable contrast, and reduced-motion preferences.
