#!/usr/bin/env node
const first = Buffer.from(JSON.stringify({ type: "progress", data: "€" }) + "\n");
const split = first.indexOf(0xe2);
process.stdout.write(first.subarray(0, split + 1));
setTimeout(() => {
  process.stdout.write(first.subarray(split + 1));
  process.stdout.write(JSON.stringify({ type: "complete", result: { ok: true } }) + "\n");
}, 5);
