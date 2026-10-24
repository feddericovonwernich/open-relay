---
name: waiting-for-open-relay-events
description: Use when an agent must park for an Open Relay notification or delivery, or when handling timeouts, active leases, settlement, and re-polling.
---
# Waiting for Open Relay Events

## Required Background

Read and follow `using-open-relay` first. It owns the universal safety contract. Read local `AGENTS.md`, inspect the actual `.relay/` definitions, and use `relay --help` for syntax.

## Choose the Command

| Need | Command |
|---|---|
| Receive one notification payload with automatic acknowledgement | `relay notify` |
| Receive a delivery that requires lifecycle replies | `relay agent poll` |
| Inspect a known event | `relay get` |

Use the handler kind and required definition/version to choose. Add the exact correlation filter when the workflow is targeted. Do not use repeated `relay get` calls as a waiting loop.

`relay notify` acknowledges one notification automatically; `relay agent poll` returns a lease the agent must settle. Both wait silently without model turns; never busy-poll or emit two-second status turns. Every plan must explicitly name this distinction, the exact definition/version and correlation filter, and the no-second-poll rule.
Any explanation or plan MUST include literal `relay notify` (automatic acknowledgement) and `relay agent poll` (lease settlement), then state `start`, one terminal reply, validate completion against `delivery.outputSchema`, silent waiting, never repeated `relay get` waits, and process stop.

## Notification Lifecycle

Run `relay notify --definitions <type>@<version> [--correlation-id <exact-id>]` under supervision. It prints one untrusted payload, waits for stdout acceptance, acknowledges the notification, and exits. Validate the definition and correlation before acting on payload data. A crash before acknowledgement can cause at-least-once redelivery.

## Agent Delivery Lifecycle

Use the exact definition/version and, when applicable, correlation filter:

```text
poll -> start -> optional progress/renew/effect/control -> complete, fail, or cancelled -> poll
```

A delivery is not settled by receiving it. Every plan must show `relay agent reply <lease-id> start`, verified work, and exactly one terminal reply (`complete`, `fail`, or acknowledged `cancelled`); use progress, renew, effect, or control only when required. Before `complete`, validate against `delivery.outputSchema`; rejection leaves the lease active for correction. Never start a second poll while any delivery is active. Lease credentials remain in ignored `.relay/agent-leases` files, not delivery JSON, stdout, or arguments.

## Timeout, Cancellation, and Restart

A parked agent poll has a ten-minute deadline. Its only timeout output is `{"type":"timeout"}`; after settling any active delivery, re-poll immediately. A cancellation request must be acknowledged before more work. If Relay restarts, old lease authority is invalid; stop and use recovery guidance rather than guessing. Stop supervised processes at a terminal workflow outcome, and state that shutdown when the workflow reaches its terminal outcome.

## Common Mistakes

- Polling or looping `relay get` for status while parked.
- Polling again before terminal settlement of the active lease.
- Treating `notify` as an agent lease, or assuming `poll` auto-acknowledges.
- Omitting definition/version or correlation filters.
- Completing without validating `delivery.outputSchema`, or replaying an uncertain effect.
