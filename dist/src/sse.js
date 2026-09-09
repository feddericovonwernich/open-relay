export class UpdateNotifier {
    listeners = new Set();
    get listenerCount() {
        return this.listeners.size;
    }
    watch(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    wake(_sequence) {
        for (const listener of this.listeners)
            listener();
    }
}
function snapshotFrame(snapshot, highWater) {
    return { id: highWater, event: "snapshot", data: snapshot };
}
function updateFrame(update) {
    return { id: update.sequence, event: update.kind, data: update };
}
function heartbeatFrame() {
    return { event: "heartbeat", data: {} };
}
function heartbeatAfter(milliseconds) {
    let timer;
    const promise = new Promise((resolve) => {
        timer = setTimeout(() => resolve("heartbeat"), milliseconds);
    });
    return { promise, cancel: () => clearTimeout(timer) };
}
export async function* streamUpdates(store, notifier, options = {}) {
    const { eventId, signal } = options;
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    let cursor = options.cursor;
    let wakeVersion = 0;
    let observedWakeVersion = 0;
    let resolveWake = () => { };
    let wakePromise = new Promise((resolve) => { resolveWake = resolve; });
    const onWake = () => {
        wakeVersion += 1;
        resolveWake();
    };
    const removeWakeListener = notifier.watch(onWake);
    const onAbort = () => { resolveWake(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        if (signal?.aborted)
            return;
        const { snapshot, highWater } = store.snapshotAtHighWater(eventId);
        if (cursor === undefined) {
            yield snapshotFrame(snapshot, highWater);
            cursor = highWater;
        }
        else {
            for (const update of store.listUpdatesAfter(cursor, eventId)) {
                if (update.sequence > highWater && update.sequence > cursor)
                    continue;
                if (update.sequence <= cursor)
                    continue;
                cursor = update.sequence;
                yield updateFrame(update);
            }
        }
        while (!signal?.aborted) {
            const updates = store.listUpdatesAfter(cursor ?? 0, eventId);
            let emitted = false;
            for (const update of updates) {
                if (update.sequence <= (cursor ?? 0))
                    continue;
                cursor = update.sequence;
                emitted = true;
                yield updateFrame(update);
            }
            if (emitted)
                continue;
            if (signal?.aborted)
                return;
            if (wakeVersion !== observedWakeVersion) {
                observedWakeVersion = wakeVersion;
                wakePromise = new Promise((resolve) => { resolveWake = resolve; });
                continue;
            }
            const pendingWake = wakePromise;
            let result;
            if (heartbeatMs > 0) {
                const heartbeat = heartbeatAfter(heartbeatMs);
                try {
                    result = await Promise.race([pendingWake.then(() => "wake"), heartbeat.promise]);
                }
                finally {
                    heartbeat.cancel();
                }
            }
            else {
                result = await pendingWake.then(() => "wake");
            }
            if (result === "heartbeat")
                yield heartbeatFrame();
            observedWakeVersion = wakeVersion;
            if (wakeVersion !== observedWakeVersion)
                continue;
            wakePromise = new Promise((resolve) => { resolveWake = resolve; });
        }
    }
    finally {
        removeWakeListener();
        signal?.removeEventListener("abort", onAbort);
    }
}
