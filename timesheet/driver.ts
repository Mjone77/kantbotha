// Tab driver: runs self-contained page functions in a tab's main world through
// chrome.scripting. All interaction with Workday happens inside those page functions
// (synthetic DOM events, see page/workday.ts `wdAct`); no debugger is used.

export class StopError extends Error {
  constructor(message = "Stopped.") {
    super(message);
    this.name = "StopError";
  }
}

export class Driver {
  constructor(
    readonly tabId: number,
    private readonly shouldStop: () => boolean,
  ) {}

  /** Runs a self-contained function in the page's main world and returns its result. */
  async run<A extends unknown[], R>(func: (...args: A) => R | Promise<R>, ...args: A): Promise<R> {
    this.checkStop();
    let results: chrome.scripting.InjectionResult<unknown>[];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: "MAIN",
        func: func as (...args: unknown[]) => unknown,
        args: args as unknown[],
      });
    } catch (e) {
      throw new Error("Couldn't run in the tab (" + String((e as Error).message || e) + ").");
    }
    const first = results[0];
    if (!first) throw new Error("Script returned no result (tab closed or navigating?).");
    return first.result as R;
  }

  checkStop(): void {
    if (this.shouldStop()) throw new StopError();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `fn` until `done(value)` or the timeout; returns the last value and whether it finished. */
export async function poll<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  opts: { timeout: number; interval?: number; check?: () => void },
): Promise<{ value: T; ok: boolean }> {
  const start = Date.now();
  let value = await fn();
  while (!done(value)) {
    if (Date.now() - start > opts.timeout) return { value, ok: false };
    opts.check?.();
    await sleep(opts.interval ?? 300);
    value = await fn();
  }
  return { value, ok: true };
}
