import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { streamUpdates, UpdateNotifier } from "../src/sse.ts";
import { openStore } from "../src/store.ts";
import { acceptInput, testStore } from "./helpers.ts";

function eventId(frame: { data?: unknown }): string | undefined {
  return (frame.data as { eventId?: string } | undefined)?.eventId;
}

function snapshotEvents(frame: { data?: unknown }): { id: string }[] {
  return (frame.data as { events: { id: string }[] }).events;
}

test("fresh snapshot and high-water mark share one read transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "open-relay-sse-"));
  const path = join(root, "relay.sqlite");
  const fixture = testStore();
  fixture.store.close();
  const writerStore = openStore(path);
  writerStore.installRevisions([fixture.revision]);
  let injected = false;
  const store = openStore(path, { now: () => Date.now() }, {
    betweenSnapshotAndHighWater: () => {
      if (injected) return;
      injected = true;
      writerStore.accept({ ...acceptInput({ idempotencyKey: "between-reads" }), revision: fixture.revision });
    },
  });
  store.installRevisions([fixture.revision]);
  try {
    const first = store.accept({ ...acceptInput({ idempotencyKey: "first" }), revision: fixture.revision }).event;
    const result = store.snapshotAtHighWater();
    assert.equal(result.snapshot.lastSequence, result.highWater);
    assert.equal(result.highWater, 1);
    assert.deepEqual(result.snapshot.events.map((event) => event.id), [first.id]);
    assert.equal(writerStore.snapshotAtHighWater().highWater, 2);
  } finally {
    writerStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit after the fresh high-water read is replayed to the tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-relay-sse-race-"));
  const path = join(root, "relay.sqlite");
  const fixture = testStore();
  fixture.store.close();
  const store = openStore(path);
  const writerStore = openStore(path);
  store.installRevisions([fixture.revision]);
  writerStore.installRevisions([fixture.revision]);
  try {
    const originalSnapshot = store.snapshotAtHighWater.bind(store);
    let injected = false;
    store.snapshotAtHighWater = (eventId) => {
      const result = originalSnapshot(eventId);
      if (!injected) {
        injected = true;
        writerStore.accept({ ...acceptInput({ idempotencyKey: "after-snapshot" }), revision: fixture.revision });
      }
      return result;
    };
    const reader = streamUpdates(store, new UpdateNotifier(), { heartbeatMs: 10 })[Symbol.asyncIterator]();
    const snapshot = await reader.next();
    assert.equal(snapshot.value?.id, 0);
    const update = await reader.next();
    assert.equal(update.value?.id, 1);
    assert.equal(injected, true);
    await reader.return?.();
  } finally {
    writerStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit after the replay query is recovered by heartbeat", async () => {
  const root = mkdtempSync(join(tmpdir(), "open-relay-sse-race-"));
  const path = join(root, "relay.sqlite");
  const fixture = testStore();
  fixture.store.close();
  const store = openStore(path);
  const writerStore = openStore(path);
  store.installRevisions([fixture.revision]);
  writerStore.installRevisions([fixture.revision]);
  try {
    const seed = store.accept({ ...acceptInput({ idempotencyKey: "seed" }), revision: fixture.revision }).event;
    const originalList = store.listUpdatesAfter.bind(store);
    let reads = 0;
    store.listUpdatesAfter = (cursor, eventId) => {
      const rows = originalList(cursor, eventId);
      reads += 1;
      if (reads === 2) writerStore.accept({ ...acceptInput({ idempotencyKey: "after-replay" }), revision: fixture.revision });
      return rows;
    };
    const reader = streamUpdates(store, new UpdateNotifier(), { cursor: 1, heartbeatMs: 10 })[Symbol.asyncIterator]();
    const heartbeat = await reader.next();
    assert.equal(heartbeat.value?.event, "heartbeat");
    const update = await reader.next();
    assert.equal(update.value?.id, 2);
    assert.notEqual(seed.id, eventId(update.value!));
    await reader.return?.();
  } finally {
    writerStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained cursor replays updates to the durable tail", async () => {
  const { store, revision } = testStore();
  const notifier = new UpdateNotifier();
  const first = store.accept({ ...acceptInput({ idempotencyKey: "first" }), revision }).event;
  const second = store.accept({ ...acceptInput({ idempotencyKey: "second" }), revision }).event;
  const reader = streamUpdates(store, notifier, { cursor: 0, heartbeatMs: 10 })[Symbol.asyncIterator]();
  const frames = [await reader.next(), await reader.next()];
  assert.equal(frames[0].value?.id, 1);
  assert.equal(frames[0].value?.event, "queued");
  assert.equal(frames[1].value?.id, 2);
  assert.equal(eventId(frames[1].value!), second.id);
  assert.notEqual(first.id, second.id);
  await reader.return?.();
  store.close();
});

test("fresh stream emits a snapshot and then a wake-triggered update", async () => {
  const { store, revision } = testStore();
  const notifier = new UpdateNotifier();
  const reader = streamUpdates(store, notifier, { heartbeatMs: 1000 })[Symbol.asyncIterator]();
  const snapshot = await reader.next();
  assert.equal(snapshot.value?.event, "snapshot");
  const eventPromise = reader.next();
  await Promise.resolve();
  const event = store.accept({ ...acceptInput({ idempotencyKey: "new" }), revision }).event;
  notifier.wake(1);
  const frame = await eventPromise;
  assert.equal(frame.value?.id, 1);
  assert.equal(eventId(frame.value!), event.id);
  await reader.return?.();
  store.close();
});

test("duplicate wakes do not duplicate durable updates", async () => {
  const { store, revision } = testStore();
  const seed = store.accept({ ...acceptInput({ idempotencyKey: "seed" }), revision }).event;
  const notifier = new UpdateNotifier();
  const reader = streamUpdates(store, notifier, { cursor: 0, heartbeatMs: 10 })[Symbol.asyncIterator]();
  const initial = await reader.next();
  assert.equal(initial.value?.id, 1);
  assert.equal(eventId(initial.value!), seed.id);
  const eventPromise = reader.next();
  const event = store.accept({ ...acceptInput({ idempotencyKey: "new" }), revision }).event;
  notifier.wake(2);
  notifier.wake(2);
  const frame = await eventPromise;
  assert.equal(frame.value?.id, 2);
  assert.equal(eventId(frame.value!), event.id);
  const heartbeat = await reader.next();
  assert.equal(heartbeat.value?.event, "heartbeat");
  await reader.return?.();
  store.close();
});

test("heartbeat recovers an update after a missed wake", async () => {
  const { store, revision } = testStore();
  const notifier = new UpdateNotifier();
  const reader = streamUpdates(store, notifier, { cursor: 0, heartbeatMs: 10 })[Symbol.asyncIterator]();
  await reader.next();
  const eventPromise = reader.next();
  const event = store.accept({ ...acceptInput({ idempotencyKey: "new" }), revision }).event;
  const frame = await eventPromise;
  if (frame.value?.event === "heartbeat") {
    assert.equal(eventId((await reader.next()).value!), event.id);
  } else {
    assert.equal(eventId(frame.value!), event.id);
  }
  await reader.return?.();
  store.close();
});

test("event filtering only emits the selected event", async () => {
  const { store, revision } = testStore();
  const selected = store.accept({ ...acceptInput({ idempotencyKey: "selected" }), revision }).event;
  store.accept({ ...acceptInput({ idempotencyKey: "other" }), revision }).event;
  const notifier = new UpdateNotifier();
  const reader = streamUpdates(store, notifier, { eventId: selected.id, heartbeatMs: 10 })[Symbol.asyncIterator]();
  const snapshot = await reader.next();
  const events = snapshotEvents(snapshot.value!);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, selected.id);
  const frame = await reader.next();
  assert.equal(frame.value?.event, "heartbeat");
  await reader.return?.();
  store.close();
});

test("abort removes the notifier waiter and ends the stream", async () => {
  const { store } = testStore();
  const notifier = new UpdateNotifier();
  const controller = new AbortController();
  const reader = streamUpdates(store, notifier, { signal: controller.signal, heartbeatMs: 1000 })[Symbol.asyncIterator]();
  await reader.next();
  const pending = reader.next();
  controller.abort();
  assert.equal((await pending).done, true);
  assert.equal(notifier.listenerCount, 0);
  store.close();
});
