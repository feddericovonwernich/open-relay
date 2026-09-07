#!/usr/bin/env node
import { appendFileSync } from "node:fs";

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  JSON.parse(input);
  if (process.env.EFFECT_COUNT_FILE) appendFileSync(process.env.EFFECT_COUNT_FILE, "effect:42\n");
  process.stdout.write(JSON.stringify({ type: "started" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "effect_started", effectKey: "effect:42", idempotencyBoundaryConfirmed: false }) + "\n");
  const delay = Number(process.env.CRASH_DELAY_MS ?? 5_000);
  setTimeout(() => process.exit(1), Number.isFinite(delay) ? delay : 5_000);
});
