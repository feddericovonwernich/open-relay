import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  const left = testStore();
  left.store.close();
  const first = openStore(join(root, "relay.sqlite"));
  const second = openStore(join(root, "relay.sqlite"));
  try {
    first.installRevisions([left.revision]);
    second.installRevisions([left.revision]);
    const input = acceptInput({ producerId: "browser:concurrent", idempotencyKey: "go:concurrent" });
    const results = await Promise.all([
      Promise.resolve().then(() => first.accept({ ...input, revision: left.revision })),
      Promise.resolve().then(() => second.accept({ ...input, revision: left.revision })),
    ]);
    assert.equal(results[0].event.id, results[1].event.id);
    assert.equal(first.countEvents(), 1);
    assert.equal(first.listUpdatesAfter(0).length, 1);
  } finally {
    first.close();
    second.close();
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
