import type { EventSnapshot, SnapshotAtHighWater, Store, UpdateRecord } from "./store.ts";

export interface SseFrame {
  id?: number;
  event: string;
  data?: unknown;
}

export interface StreamOptions {
  cursor?: number;
  eventId?: string;
  heartbeatMs?: number;
  signal?: AbortSignal;
}

export class UpdateNotifier {
  private readonly listeners = new Set<() => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  wake(_sequence: number): void {
    for (const listener of this.listeners) listener();
  }
}

function snapshotFrame(snapshot: EventSnapshot, highWater: number): SseFrame {
  return { id: highWater, event: "snapshot", data: snapshot };
}

function updateFrame(update: UpdateRecord): SseFrame {
  return { id: update.sequence, event: update.kind, data: update };
}

function heartbeatFrame(): SseFrame {
  return { event: "heartbeat", data: {} };
}

function heartbeatAfter(milliseconds: number): { promise: Promise<"heartbeat">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<"heartbeat">((resolve) => {
    timer = setTimeout(() => resolve("heartbeat"), milliseconds);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export async function* streamUpdates(
  store: Store,
  notifier: UpdateNotifier,
  options: StreamOptions = {},
): AsyncIterable<SseFrame> {
  const { eventId, signal } = options;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let cursor = options.cursor;
  let wakeVersion = 0;
  let observedWakeVersion = 0;
  let resolveWake: () => void = () => {};
  let wakePromise = new Promise<void>((resolve) => { resolveWake = resolve; });
  const onWake = (): void => {
    wakeVersion += 1;
    resolveWake();
  };
  const removeWakeListener = notifier.watch(onWake);
  const onAbort = (): void => { resolveWake(); };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) return;
    const { snapshot, highWater }: SnapshotAtHighWater = store.snapshotAtHighWater(eventId);
    if (cursor === undefined) {
      yield snapshotFrame(snapshot, highWater);
      cursor = highWater;
    } else {
      for (const update of store.listUpdatesAfter(cursor, eventId)) {
        if (update.sequence > highWater && update.sequence > cursor) continue;
        if (update.sequence <= cursor) continue;
        cursor = update.sequence;
        yield updateFrame(update);
      }
    }

    while (!signal?.aborted) {
      const updates = store.listUpdatesAfter(cursor ?? 0, eventId);
      let emitted = false;
      for (const update of updates) {
        if (update.sequence <= (cursor ?? 0)) continue;
        cursor = update.sequence;
        emitted = true;
        yield updateFrame(update);
      }
      if (emitted) continue;
      if (signal?.aborted) return;

      if (wakeVersion !== observedWakeVersion) {
        observedWakeVersion = wakeVersion;
        wakePromise = new Promise<void>((resolve) => { resolveWake = resolve; });
        continue;
      }

      const pendingWake = wakePromise;
      let result: "wake" | "heartbeat";
      if (heartbeatMs > 0) {
        const heartbeat = heartbeatAfter(heartbeatMs);
        try {
          result = await Promise.race([pendingWake.then(() => "wake" as const), heartbeat.promise]);
        } finally {
          heartbeat.cancel();
        }
      } else {
        result = await pendingWake.then(() => "wake" as const);
      }
      if (result === "heartbeat") yield heartbeatFrame();
      observedWakeVersion = wakeVersion;
      if (wakeVersion !== observedWakeVersion) continue;
      wakePromise = new Promise<void>((resolve) => { resolveWake = resolve; });
    }
  } finally {
    removeWakeListener();
    signal?.removeEventListener("abort", onAbort);
  }
}
