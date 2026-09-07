#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "complete", result: { ok: true } }) + "\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
