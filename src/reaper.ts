import type { Clock, Store } from "./store.ts";

export type ReaperWake = (() => void) | { wake(): void };

export class LeaseReaper {
  private readonly store: Store;
  private readonly wake: ReaperWake;
  private readonly clock: Clock;
  private readonly waiters = new Set<() => void>();
  private readonly unsubscribe?: () => void;

  constructor(store: Store, wake: ReaperWake = () => {}, clock: Clock = { now: () => Date.now() }) {
    this.store = store;
    this.wake = wake;
    this.clock = clock;
    this.unsubscribe = store.watchLeases?.(() => this.interrupt());
  }

  async start(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const deadline = this.store.nextLeaseDeadline();
        await this.sleep(deadline === undefined ? 1000 : Math.max(0, deadline - this.clock.now()), signal);
        if (signal.aborted) break;
        const expired = this.store.expireLeases(this.clock.now());
        if (expired.length > 0) this.notify();
      }
    } finally {
      this.unsubscribe?.();
    }
  }

  private interrupt(): void {
    for (const resolve of this.waiters) resolve();
  }
  private notify(): void {
    if (typeof this.wake === "function") this.wake();
    else this.wake.wake();
  }
  private sleep(delay: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout>;
      const wake = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", wake);
        this.waiters.delete(wake);
        resolve();
      };
      timer = setTimeout(wake, delay);
      this.waiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }
}
