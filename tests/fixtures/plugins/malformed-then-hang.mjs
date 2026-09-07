#!/usr/bin/env node
process.stdout.write("not-json\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
