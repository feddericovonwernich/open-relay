import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { acceptInput, errorWithCode, testStore } from "./helpers.ts";
import { openStore } from "../src/store.ts";

test("lost 202 replay returns the original event", () => {
  const { store, revision } = testStore();
  try {
    const input = acceptInput({ producerId: "browser:1", idempotencyKey: "go:42" });
    const first = store.accept({ ...input, revision });
    const replay = store.accept({ ...input, revision });
    assert.equal(replay.event.id, first.event.id);
    assert.equal(replay.created, false);
    assert.equal(store.countEvents(), 1);
    assert.deepEqual(store.listUpdatesAfter(0).map((update) => update.kind), ["queued"]);
  } finally {
    store.close();
  }
});

test("same key with different payload is a conflict", () => {
  const { store, revision } = testStore();
  try {
    store.accept({ ...acceptInput({ payload: { variant: "dark" } }), revision });
    assert.throws(
      () => store.accept({ ...acceptInput({ payload: { variant: "light" } }), revision }),
      errorWithCode("idempotency_conflict"),
    );
    assert.equal(store.countEvents(), 1);
    assert.deepEqual(store.listUpdatesAfter(0).map((update) => update.kind), ["queued"]);
  } finally {
    store.close();
  }
});

test("concurrent stores converge on one idempotent event", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-relay-store-"));
  const databasePath = join(root, "relay.sqlite");
  const bootstrap = openStore(databasePath);
  bootstrap.close();
  const workerScript = `
    import { parentPort, workerData } from "node:worker_threads";
    const { openStore } = await import(workerData.storeModule);
    const { loadRegistry } = await import(workerData.registryModule);
    const revision = loadRegistry(workerData.fixturesRoot, "events").resolve("ui.variant.requested", 1);
    const store = openStore(workerData.databasePath);
    parentPort.postMessage({ type: "ready" });
    await new Promise((resolve) => parentPort.once("message", resolve));
    try {
      const accepted = store.accept({ ...workerData.input, revision });
      parentPort.postMessage({ type: "result", eventId: accepted.event.id });
    } catch (error) {
      parentPort.postMessage({ type: "error", code: error?.code, message: String(error) });
    } finally {
      store.close();
    }
  `;
  const workerData = {
    databasePath,
    storeModule: new URL("../src/store.ts", import.meta.url).href,
    registryModule: new URL("../src/registry.ts", import.meta.url).href,
    fixturesRoot: fileURLToPath(new URL("./fixtures/", import.meta.url)),
    input: acceptInput({ producerId: "browser:concurrent", idempotencyKey: "go:concurrent" }),
  };
  const workers = [1, 2].map(() => {
    const worker = new Worker(workerScript, { eval: true, type: "module", workerData } as ConstructorParameters<typeof Worker>[1]);
    let readyResolve: () => void = () => undefined;
    let readyReject: (error: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const result = new Promise<string>((resolve, reject) => {
      worker.on("message", (message: { type: string; eventId?: string; code?: string; message?: string }) => {
        if (message.type === "ready") readyResolve();
        else if (message.type === "result" && message.eventId) resolve(message.eventId);
        else if (message.type === "error") reject(new Error(`${message.code}: ${message.message}`));
      });
      worker.on("error", (error) => {
        readyReject(error);
        reject(error);
      });
    });
    result.catch(() => undefined);
    return { worker, ready, result };
  });
  try {
    await Promise.all(workers.map(({ ready }) => ready));
    for (const { worker } of workers) worker.postMessage("go");
    const eventIds = await Promise.all(workers.map(({ result }) => result));
    assert.equal(eventIds[0], eventIds[1]);
    await Promise.all(workers.map(({ worker }) => worker.terminate()));
    const store = openStore(databasePath);
    try {
      assert.equal(store.countEvents(), 1);
      assert.equal(store.listUpdatesAfter(0).length, 1);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all(workers.map(({ worker }) => worker.terminate()));
  }
});

test("persisted revisions rebuild validators without a registry", () => {
  const { store, revision } = testStore();
  try {
    const rebuilt = store.getRevision(revision.digest);
    assert.equal(rebuilt.digest, revision.digest);
    assert.equal(rebuilt.definition.type, revision.definition.type);
    assert.equal(rebuilt.instructions, revision.instructions);
    assert.equal(rebuilt.validateInput({ variant: "dark" }), true);
    assert.equal(rebuilt.validateInput({ variant: 42 }), false);
  } finally {
    store.close();
  }
});
