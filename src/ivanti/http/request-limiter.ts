// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * How many requests this process may have in flight to the tenant at once.
 *
 * The tenant is the ceiling, not this server: one process serves many conversations, a tool call
 * can fan out into several requests, and nothing else stood between a busy hour and the tenant.
 * Past the cap a request waits its turn, in order — for as long as its own timeout would have
 * allowed it to take — and one still waiting then fails as never sent.
 */
export interface RequestLimiter {
  /** Runs `send` once a slot is free; rejects with `IvantiBusyError` if none frees within `waitMs`. */
  run: <T>(send: () => Promise<T>, waitMs: number) => Promise<T>;
  /** Requests in flight and waiting — for a test, or a later metric. */
  readonly inFlight: number;
  readonly waiting: number;
}

/**
 * The request never left this process: every slot stayed taken for as long as it could wait.
 *
 * Not an `IvantiApiError`, on purpose. Those describe what Ivanti did, and a status-0 one on a
 * write is reported as "may have been applied" — true of a request that timed out on the wire,
 * false of one that was never sent.
 */
export class IvantiBusyError extends Error {
  constructor(
    readonly limit: number,
    readonly waitedMs: number,
  ) {
    super(
      `Every one of this server's ${String(limit)} concurrent Ivanti requests stayed in use for ` +
        `${String(Math.round(waitedMs / 1000))} s, so this one was not sent.`,
    );
    this.name = 'IvantiBusyError';
  }
}

export function createRequestLimiter(limit: number): RequestLimiter {
  let inFlight = 0;
  const queue: { start: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

  const release = (): void => {
    const next = queue.shift();
    if (next === undefined) {
      inFlight -= 1;
      return;
    }
    // The slot passes straight to the next in line; `inFlight` does not change.
    clearTimeout(next.timer);
    next.start();
  };

  const run = <T>(send: () => Promise<T>, waitMs: number): Promise<T> => {
    const go = (): Promise<T> =>
      send().finally(() => {
        release();
      });

    if (inFlight < limit) {
      inFlight += 1;
      return go();
    }

    return new Promise<T>((resolve, reject) => {
      const started = Date.now();
      const entry = {
        start: (): void => {
          go().then(resolve, reject);
        },
        timer: setTimeout(() => {
          const at = queue.indexOf(entry);
          if (at !== -1) queue.splice(at, 1);
          reject(new IvantiBusyError(limit, Date.now() - started));
        }, waitMs),
      };
      queue.push(entry);
    });
  };

  return {
    run,
    get inFlight(): number {
      return inFlight;
    },
    get waiting(): number {
      return queue.length;
    },
  };
}
