// The locks: directories under work/locks, taken by mkdir, which is atomic on
// the home volume, and given back by removing them. Each holds an `owner`
// file naming its session, the boot it was taken in, and what it is doing.
//
// A lock never outlives the turn that took it, nor dies before it. Its holder
// is dead only when the runtime says its session is not running a turn — a
// restart is no proof, because the platform resumes an interrupted turn. An
// attended session (a person is present) ends its turns between messages, so
// its lock goes stale only `attendedStaleMin` after it was taken. A runtime
// that does not answer frees nothing: a guess could hand a live run's slot to
// another.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { kv, parseKv, readText, writeKv } from "./kv.ts";
import type { Liveness, Runtime } from "./runtime.ts";
import { type Clock, epoch, iso, nowSeconds } from "./time.ts";

export const OWNER_KEYS = ["session", "boot", "since", "item", "slot", "phase", "phase_at"] as const;

export interface Owner {
  readonly session: string;
  readonly boot: string;
  readonly since: string;
  readonly item: string;
  readonly slot: string;
  readonly phase: string;
  readonly phase_at: string;
}

export interface Held {
  readonly name: string;
  readonly dir: string;
  readonly owner: Owner;
  /** Whether the lock has an owner file yet: a lock being taken has none. */
  readonly owned: boolean;
}

export interface LockOptions {
  readonly dir: string;
  readonly session: string;
  readonly boot: string;
  readonly clock: Clock;
  readonly runtime: Runtime;
  readonly attendedStaleMin: number;
  /** The program named in an owner file's header. */
  readonly writer: string;
}

function owner(file: string): Owner {
  const m = parseKv(readText(file));
  const g = (k: string) => m.get(k) ?? "";
  return {
    session: g("session"),
    boot: g("boot"),
    since: g("since"),
    item: g("item"),
    slot: g("slot"),
    phase: g("phase"),
    phase_at: g("phase_at"),
  };
}

export class Locks {
  readonly dir: string;
  readonly me: string;
  private readonly opts: LockOptions;

  constructor(opts: LockOptions) {
    this.opts = opts;
    this.dir = opts.dir;
    this.me = opts.session;
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  read(name: string): Held | undefined {
    const dir = this.path(name);
    if (!isDir(dir)) return undefined;
    const file = join(dir, "owner");
    return { name, dir, owner: owner(file), owned: existsSync(file) };
  }

  /** Every lock, by name, in name order. */
  all(): Held[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).sort();
    } catch {
      return [];
    }
    return names.flatMap((n) => {
      const h = this.read(n);
      return h ? [h] : [];
    });
  }

  /** The locks of one kind: `item-`, `slot-`, or the one named `exclusive`. */
  ofKind(prefix: string): Held[] {
    return this.all().filter((h) => h.name.startsWith(prefix));
  }

  mine(name: string): boolean {
    return this.me !== "" && this.read(name)?.owner.session === this.me;
  }

  /** The name of a lock of that kind this session holds. */
  myLock(prefix: string): string | undefined {
    return this.ofKind(prefix).find((h) => h.owner.session === this.me && this.me !== "")?.name;
  }

  /** Takes a lock: true when taken now or already ours, false when another holds it. */
  take(name: string, fields: Readonly<Record<string, string>> = {}): boolean {
    mkdirSync(this.dir, { recursive: true });
    const dir = this.path(name);
    try {
      mkdirSync(dir);
    } catch {
      return this.mine(name);
    }
    const now = iso(this.opts.clock.now());
    writeKv(
      join(dir, "owner"),
      OWNER_KEYS,
      { session: this.me, boot: this.opts.boot, since: now, phase: "started", phase_at: now, ...fields },
      null,
      this.opts.writer,
    );
    return true;
  }

  /** Changes fields of a lock's owner file, keeping the rest. */
  update(name: string, fields: Readonly<Record<string, string>>): void {
    writeKv(join(this.path(name), "owner"), OWNER_KEYS, fields, undefined, this.opts.writer);
  }

  drop(name: string): void {
    rmSync(this.path(name), { recursive: true, force: true });
  }

  /** Stamps the phase on every lock this session holds. */
  stamp(phase: string): void {
    const now = iso(this.opts.clock.now());
    for (const h of this.all())
      if (this.me !== "" && h.owner.session === this.me) this.update(h.name, { phase, phase_at: now });
  }

  /** Whether a lock's holder is provably gone. */
  async dead(h: Held): Promise<boolean> {
    if (!h.owned) {
      // being taken, unless it has been so for a minute
      try {
        return nowSeconds(this.opts.clock) - Math.floor(statSync(h.dir).mtimeMs / 1000) > 60;
      } catch {
        return false;
      }
    }
    const l: Liveness = await this.opts.runtime.liveness(h.owner.session);
    if (l === "stopped") return true;
    if (l !== "attended") return false;
    const t = epoch(h.owner.since);
    if (t === undefined) return true;
    return Math.floor((nowSeconds(this.opts.clock) - t) / 60) >= this.opts.attendedStaleMin;
  }

  stopBlocks(name: string): number {
    const n = Number(readText(join(this.path(name), "stop_blocks")).trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A key of a lock's owner file, read without a Locks: what a hook needs. */
export function ownerKey(dir: string, key: string): string {
  return kv(join(dir, "owner"), key);
}
