export class KeyedQueue {
  readonly #tails = new Map<string, Promise<unknown>>();
  #active = 0;
  #idleWaiters: Array<() => void> = [];

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    this.#active += 1;
    const next = previous.then(task, task).finally(() => {
      this.#active -= 1;
      if (this.#tails.get(key) === next) this.#tails.delete(key);
      if (this.#active === 0) {
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    });
    this.#tails.set(key, next);
    next.catch(() => undefined);
    return next;
  }

  get activeCount(): number {
    return this.#active;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (this.#active === 0) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      this.#idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
