// UTC timestamps for the state files, and reading them back. Every time the
// app writes is the clock's own UTC second, as `YYYY-MM-DDTHH:MM:SSZ`, so two
// of them order as strings — which is how GitHub's answers are compared too.

/** The clock every command reads, and how it waits: a test supplies its own. */
export interface Clock {
  now(): Date;
  sleep(seconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
};

/** A time as the state files write it: the second, in UTC, no fraction. */
export function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Seconds since the epoch of an ISO time, or undefined for an empty or unparsable one. */
export function epoch(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

/** Whole minutes from an ISO time to now: undefined when the time does not parse. */
export function minutesSince(s: string | undefined, clock: Clock): number | undefined {
  const t = epoch(s);
  return t === undefined ? undefined : Math.floor((Math.floor(clock.now().getTime() / 1000) - t) / 60);
}

/** Seconds since the epoch, now. */
export function nowSeconds(clock: Clock): number {
  return Math.floor(clock.now().getTime() / 1000);
}
