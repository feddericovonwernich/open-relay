#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  JSON.parse(input);
  process.stdout.write(JSON.stringify({ type: "started" }) + "\n");
  if (process.argv[2] === "renew") process.stdout.write(JSON.stringify({ type: "renew", leaseExpiresAt: Date.now() + 1000 }) + "\n");
  if (process.argv[2] === "effects") {
    process.stdout.write(JSON.stringify({ type: "effect_started", effectKey: "charge", idempotencyBoundaryConfirmed: true }) + "\n");
    process.stdout.write(JSON.stringify({ type: "effect_confirmed", effectKey: "charge", externalRef: "ref-1" }) + "\n");
  }
  process.stdout.write(JSON.stringify({ type: "complete", result: { ok: true } }) + "\n");
});
