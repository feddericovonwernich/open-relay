#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "progress", data: "x".repeat(200000) }) + "\n");
process.stdin.resume();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
