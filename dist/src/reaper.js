export class LeaseReaper {
    store;
    wake;
    clock;
    waiters = new Set();
    unsubscribe;
    constructor(store, wake = () => { }, clock = { now: () => Date.now() }) {
        this.store = store;
        this.wake = wake;
        this.clock = clock;
        this.unsubscribe = store.watchLeases?.(() => this.interrupt());
    }
    async start(signal) {
        try {
            if (!signal.aborted) {
                const expired = this.store.expireLeases(this.clock.now());
                if (expired.length > 0)
                    this.notify();
            }
            while (!signal.aborted) {
                const deadline = this.store.nextLeaseDeadline();
                await this.sleep(deadline === undefined ? 1000 : Math.max(0, deadline - this.clock.now()), signal);
                if (signal.aborted)
                    break;
                const expired = this.store.expireLeases(this.clock.now());
                if (expired.length > 0)
                    this.notify();
            }
        }
        finally {
            this.unsubscribe?.();
        }
    }
    interrupt() {
        for (const resolve of this.waiters)
            resolve();
    }
    notify() {
        if (typeof this.wake === "function")
            this.wake();
        else
            this.wake.wake();
    }
    sleep(delay, signal) {
        return new Promise((resolve) => {
            if (signal.aborted) {
                resolve();
                return;
            }
            let timer;
            const wake = () => {
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
