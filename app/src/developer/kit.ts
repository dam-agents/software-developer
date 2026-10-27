// The software-developer kit's world: where its state lives under $HOME, the
// configuration it reads, and the labels and limits that follow from it.
// Every command of the kit starts from one Kit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Config, splitRepo } from "../factory/config.ts";
import type { Deps } from "../factory/context.ts";
import { Git } from "../factory/git.ts";
import { Locks } from "../factory/locks.ts";

/** How long an attended session's locks wait for it before they read stale. */
export const ATTENDED_STALE_MIN = 120;

/** How long a waiter watches before it hands the turn back: under the two hours a harness background task may run. */
export const PARK_FOR_SECONDS = 6900;

export const ITEM_KEYS = [
  "item",
  "state",
  "branch",
  "slot",
  "pr",
  "session",
  "seen_at",
  "abandoned",
  "babysit_since",
  "round_at",
  "babysat_out",
  // the pull request a Slack "ready to merge" post was asked for, so it is asked once
  "notified",
  // the last required check recorded for the item: "<check> <pass|fail|skipped> <commit>"
  "checked",
  "updated_at",
] as const;

export const GATE_KEYS = ["diagnosed_at", "diagnoses"] as const;

/** The outcomes a run finishes with, and what each leaves on the item. */
export const OUTCOMES = [
  "nothing",
  "pr-opened",
  "pr-updated",
  "released",
  "blocked",
  "waiting-lock",
  "needs-info",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The program the state files name as their one writer. */
export const WRITER = "scripts/run-state.sh";

export class Kit {
  readonly deps: Deps;
  readonly home: string;
  readonly work: string;
  readonly items: string;
  readonly slots: string;
  readonly gate: string;
  readonly log: string;
  readonly cfg: Config;
  readonly repo: string;
  readonly host: string;
  readonly slug: string;
  readonly me: string;
  readonly git: Git;
  readonly locks: Locks;

  /** `repo` names the repository when CONFIG.md does not: the precheck's fallback to the checkout. */
  constructor(deps: Deps, repo?: string) {
    this.deps = deps;
    const env = deps.env;
    this.home = env.HOME ?? "/home/agent";
    this.work = join(this.home, "work");
    this.items = join(this.work, "items");
    this.slots = join(this.work, "slots");
    this.gate = join(this.work, "GATE.md");
    this.log = join(this.work, "TICK.log");
    this.cfg = Config.load(this.work);
    this.repo = repo ?? this.cfg.get("repo");
    const { host, slug } = splitRepo(this.repo);
    this.host = host;
    this.slug = slug;
    this.me = env.CLAUDE_CODE_SESSION_ID ?? "";
    this.git = new Git(env);
    this.locks = new Locks({
      dir: env.SD_LOCKS || join(this.work, "locks"),
      session: this.me,
      boot: env.SD_BOOT_ID || bootId(),
      clock: deps.clock,
      runtime: deps.runtime,
      attendedStaleMin: ATTENDED_STALE_MIN,
      writer: WRITER,
      // a test names the waiter pids it pretends are alive; a real run reads /proc
      ...(env.SD_LIVE_PIDS !== undefined ? { livePids: new Set(env.SD_LIVE_PIDS.split(/\s+/).filter(Boolean)) } : {}),
    });
  }

  get slotCount(): number {
    return this.cfg.int("slots", 3, 1);
  }
  get stuckMin(): number {
    return this.cfg.int("stuck_after_min", 120);
  }
  get babysitMaxHours(): number {
    return this.cfg.int("babysit_max_hours", 4);
  }
  get labelHandoff(): string {
    return this.cfg.or("label_handoff", "agent/implement");
  }
  get labelClaimed(): string {
    return this.cfg.or("label_claimed", "agent/in-progress");
  }
  get labelNeedsInfo(): string {
    return this.cfg.or("label_needs_info", "agent/needs-info");
  }
  get labelFailed(): string {
    return this.cfg.or("label_failed", "agent/failed");
  }
  get labelMine(): string {
    return this.cfg.get("label_mine");
  }
  get author(): string {
    return this.cfg.get("author");
  }
  /** The check a change on `verify_exclusive_paths` must pass: in the slot's Environment when set, else on what `exclusive` names. */
  get requiredCheck(): string {
    return this.cfg.get("verify_environment")
      ? "verify_environment"
      : this.cfg.get("verify_exclusive")
        ? "verify_exclusive"
        : "";
  }
  /** The default branch of `repo`, from its checkout: main when that cannot say. */
  get defaultBranch(): string {
    return this.git.defaultBranch(this.checkout);
  }
  get requiredPaths(): string[] {
    return this.cfg.list("verify_exclusive_paths");
  }

  /** work/<name>: the checkout of `repo`. */
  get checkout(): string {
    return join(this.work, this.repo.split("/").pop() ?? "");
  }

  itemFile(item: string): string {
    return join(this.items, `${item}.md`);
  }

  /**
   * Whether a run may act on a repository: `repo` itself, or one `repos_also`
   * names — `owner/name` or `owner/*`, case ignored. The work always comes from
   * an issue of `repo`; these are where it may also need changing.
   */
  allows(want: string): boolean {
    const w = want.toLowerCase();
    if (!/^[^/]+\/[^/]+$/.test(w)) return false;
    for (const p of [this.repo, ...this.cfg.list("repos_also")]) {
      const pat = p.toLowerCase();
      if (pat === "") continue;
      if (pat.endsWith("/*")) {
        const owner = pat.slice(0, -1);
        if (w.startsWith(owner) && w.length > owner.length) return true;
      } else if (w === pat) return true;
    }
    return false;
  }
}

function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}
