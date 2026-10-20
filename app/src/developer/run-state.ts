// run-state — the one writer of the tick's state: which session works on
// which item, in which slot, and who holds the exclusive lock.
//
// Up to `slots` runs work at once (default 3), one item each, each in a slot
// of its own: a worktree of the checkout at work/slots/<k>, kept between runs
// so its build output stays warm. A run takes an item and a slot when it
// starts and gives both back when it finishes; the branch, pushed, is what
// carries the work from one run to the next. What `exclusive` names — a
// cluster, a database, a device — is one, so whatever touches it runs under a
// lock of its own, taken for those steps alone (factory/locks.ts says when a
// lock's holder is dead).
//
//   start <item> [branch]     take the item and a slot, put the slot on branch
//   also <owner/name>         a worktree of another repository `repos_also`
//                             allows, beside the slot and on its branch
//   phase <text>              before each long step: what, and since when
//   wait <pr>...              babysit: block up to ~9 minutes until one of the
//                             item's pull requests needs the run (exit 0),
//                             nothing yet (3), or the run has babysat them for
//                             babysit_max_hours (4); a pr is #<n> in `repo`,
//                             <owner/name>#<n> elsewhere
//   lock                      take the exclusive lock, or record waiting for it
//   unlock                    give the exclusive lock back
//   finish <outcome> [pr]...  the run's last act, on every way out: refused
//                             until the work is pushed and reported on GitHub;
//                             then backs work/ up, and with slack_channel set
//                             says what to post (notify:)
//   sweep                     free the locks of dead holders (the precheck)
//   held                      the items live runs hold, one per line
//   live                      how many slots are held
//   quiet                     live runs silent for stuck_after_min, one a line
//   diagnosed                 the precheck let a diagnostic run through
//   show                      all of it, for a human
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Command, Deps } from "../factory/context.ts";
import { Exit } from "../factory/context.ts";
import type { Conditional } from "../factory/github.ts";
import { kv, readText, writeKv } from "../factory/kv.ts";
import { epoch, iso, nowSeconds } from "../factory/time.ts";
import { persistTo } from "./backup.ts";
import { GATE_KEYS, ITEM_KEYS, Kit, OUTCOMES, type Outcome, WRITER } from "./kit.ts";
import { labelRef, type PrRef, type PullState, parsePrRef, recordRef, restPull, verdict } from "./pulls.ts";
import { ours, reported, slackThread } from "./reports.ts";
import { alsoDirs, prepare } from "./slots.ts";

const USAGE = "usage: run-state.sh start|also|phase|wait|lock|unlock|finish|sweep|held|live|quiet|diagnosed|show";

class RunState {
  readonly kit: Kit;
  readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
    this.kit = new Kit(deps);
  }

  say(s: string): void {
    this.deps.io.err(`run-state: ${s}`);
  }
  out(s: string): void {
    this.deps.io.out(s);
  }
  now(): string {
    return iso(this.deps.clock.now());
  }

  get locks() {
    return this.kit.locks;
  }

  writeItem(item: string, set: Readonly<Record<string, string>>): void {
    writeKv(this.kit.itemFile(item), ITEM_KEYS, set, undefined, WRITER);
  }

  itemKey(item: string, key: string): string {
    return kv(this.kit.itemFile(item), key);
  }

  needSession(): void {
    if (!this.kit.me) {
      this.say("no $CLAUDE_CODE_SESSION_ID — the runtime cannot tell this run is alive, so it may not hold anything");
      throw new Exit(2);
    }
  }

  myItem(): string {
    return this.locks.myLock("item-")?.slice("item-".length) ?? "";
  }
  mySlot(): string {
    return this.locks.myLock("slot-")?.slice("slot-".length) ?? "";
  }

  logLine(outcome: string, session: string, item: string, slot: string, pr: string, since: string, extra = ""): void {
    const end = this.now();
    const a = epoch(since);
    const b = epoch(end);
    const mins = a !== undefined && b !== undefined ? String(Math.floor((b - a) / 60)) : "-";
    const line = `${end} ${outcome} session=${session || "-"} issue=${item || "-"} slot=${slot || "-"} pr=${pr || "-"} minutes=${mins}${extra ? ` ${extra}` : ""}\n`;
    mkdirSync(this.kit.work, { recursive: true });
    appendFileSync(this.kit.log, line);
  }

  checkout(): void {
    const co = this.kit.checkout;
    if (!this.kit.repo || !this.kit.git.isRepo(co)) {
      this.say(
        `no checkout at work/${this.kit.repo.split("/").pop() ?? ""} — clone it first (CLAUDE.md → Runtime configuration)`,
      );
      throw new Exit(1);
    }
  }

  // ------------------------------------------------------------------ verbs

  async start(args: readonly string[]): Promise<number> {
    const raw = args[0];
    if (!raw) {
      this.say("start: item: the issue number");
      return 2;
    }
    const item = raw.replace(/^#/, "");
    this.needSession();
    this.checkout();
    const branch = args[1] || this.itemKey(item, "branch");
    if (!branch) {
      this.say(`item #${item} has no branch yet — give one: start ${item} <branch>`);
      return 2;
    }
    const own = await ours(this.kit, item);
    if (own.kind === "another") {
      this.say(`#${item} is not ours: ${own.why} — leave it, and take the next one.`);
      return 1;
    }
    if (own.kind === "unread") {
      this.say(`GitHub could not be read, so whose #${item} is was not measured — start nothing on it now.`);
      return 1;
    }
    await this.sweep(false);
    if (!this.locks.take(`item-${item}`, { item })) {
      const o = this.locks.read(`item-${item}`)?.owner;
      this.say(`item #${item} is held by session ${o?.session ?? ""}, at "${o?.phase ?? ""}" — take the next one.`);
      return 1;
    }
    // a run holds one slot: one already ours (a second start) is reused; else
    // the item's last slot, whose build output is its own, then any free one
    const n = this.kit.slotCount;
    let k = this.mySlot();
    if (!k) {
      const last = this.itemKey(item, "slot");
      const order = [last, ...Array.from({ length: n }, (_, i) => String(i + 1))];
      for (const c of order) {
        const num = Number(c);
        if (!/^[0-9]+$/.test(c) || num < 1 || num > n) continue;
        if (this.locks.take(`slot-${c}`, { item, slot: c })) {
          k = c;
          break;
        }
      }
    }
    if (!k) {
      this.locks.drop(`item-${item}`);
      this.say(`all ${n} slots are in use — nothing can start now.`);
      return 1;
    }
    this.locks.update(`slot-${k}`, { item, slot: k });
    this.locks.update(`item-${item}`, { slot: k });
    const p = prepare({
      git: this.kit.git,
      work: this.kit.work,
      locksDir: this.locks.dir,
      say: (s) => this.say(s),
      k,
      branch,
      checkout: this.kit.checkout,
      base: this.kit.slots,
    });
    if (!p.ok) {
      // 3 keeps the locks: the run saves what it found, then starts again
      if (p.code === 3) {
        this.out(`slot ${k}: ${join(this.kit.slots, k)}`);
        return 3;
      }
      this.locks.drop(`item-${item}`);
      this.locks.drop(`slot-${k}`);
      return 1;
    }
    // the babysit clock is this run's own: a run that resumes the item starts it again
    const now = this.now();
    this.writeItem(item, {
      item,
      state: "active",
      branch,
      slot: k,
      session: this.kit.me,
      seen_at: now,
      babysit_since: "-",
      round_at: "-",
      babysat_out: "-",
      updated_at: now,
    });
    this.out(`slot ${k}: ${join(this.kit.slots, k)} on ${branch}`);
    return 0;
  }

  /** One more repository a run takes beside its slot, in a worktree of its own on the slot's branch. */
  async also(args: readonly string[]): Promise<number> {
    const raw = args[0];
    if (!raw) {
      this.say("also: owner/name");
      return 2;
    }
    this.needSession();
    const k = this.mySlot();
    if (!k) {
      this.say("this session holds no slot — call start first");
      return 1;
    }
    const slug = raw.toLowerCase();
    if (slug === this.kit.slug.toLowerCase()) {
      this.out(`${slug} is \`repo\`: the slot is ${join(this.kit.slots, k)}`);
      return 0;
    }
    if (!this.kit.allows(slug)) {
      this.say(
        `${slug} is neither \`repo\` nor named by \`repos_also\` — only the operator adds it, in the direct session.`,
      );
      return 1;
    }
    const name = slug.split("/").pop() ?? slug;
    const co = join(this.kit.work, name);
    const git = this.kit.git;
    if (git.isRepo(co)) {
      const url = git.line(co, ["remote", "get-url", "origin"]);
      if (!new RegExp(`[/:]${escapeRe(slug)}(\\.git)?$`).test(url.toLowerCase())) {
        this.say(`work/${name} is a checkout of ${url}, not ${slug}`);
        return 1;
      }
    } else if (!(await this.deps.github.clone(this.kit.host, slug, co))) {
      this.say(`could not clone ${slug} into work/${name}`);
      return 1;
    }
    const b = git.branch(join(this.kit.slots, k));
    if (!b) {
      this.say(`slot ${k} is on no branch`);
      return 1;
    }
    const p = prepare({
      git,
      work: this.kit.work,
      locksDir: this.locks.dir,
      say: (s) => this.say(s),
      k,
      branch: b,
      checkout: co,
      base: join(this.kit.work, "also", name),
    });
    if (!p.ok) return p.code;
    this.locks.stamp(`also ${slug}`);
    this.out(`also ${slug}: ${join(this.kit.work, "also", name, k)} on ${b}`);
    return 0;
  }

  phase(args: readonly string[]): number {
    this.needSession();
    if (!this.mySlot()) {
      this.say("this session holds no slot — call start first");
      return 1;
    }
    const text = args[0];
    if (!text) {
      this.say("phase: phase text");
      return 2;
    }
    this.locks.stamp(text);
    return 0;
  }

  /**
   * One look at a pull request. Each look reads it, its reviews and its
   * head's checks over REST with the ETags of the look before: unchanged is
   * four free 304s. Only a change costs the GraphQL read `gh pr view` makes,
   * whose review decision is the one that counts; its verdict is kept for the
   * next unchanged look. GraphQL refused, the verdict is read off the REST
   * answers, whose decision is approximate, so it never says done.
   */
  async look(ref: PrRef, since: string, memo: LookMemo): Promise<ReturnType<typeof verdict> | undefined> {
    const gh = this.deps.github;
    const host = this.kit.host;
    // what the looks found: 0 nothing changed · 1 something did · 2 unreadable
    const cget = async (name: string, path: string): Promise<0 | 1 | 2> => {
      const r: Conditional = await gh.getIfChanged(host, path, memo.etags.get(name) ?? "");
      if (r.status === 304) return 0;
      if (r.status === 0) return 2;
      memo.etags.set(name, r.etag);
      memo.bodies.set(name, r.body);
      return 1;
    };
    let changed = await cget("pull", `repos/${ref.slug}/pulls/${ref.number}`);
    const sha = (memo.bodies.get("pull") as { head?: { sha?: string } } | undefined)?.head?.sha ?? "";
    if (!sha) changed = 2;
    if (changed !== 2) {
      for (const [name, path] of [
        ["reviews", `pulls/${ref.number}/reviews?per_page=100`],
        ["checks", `commits/${sha}/check-runs?per_page=100`],
        ["status", `commits/${sha}/status`],
      ] as const) {
        const c = await cget(name, `repos/${ref.slug}/${path}`);
        if (c === 2) {
          changed = 2;
          break;
        }
        if (c === 1) changed = 1;
      }
    }
    if (changed === 0 && memo.verdict) return memo.verdict;
    memo.verdict = undefined;
    let pr: PullState | undefined;
    const view = await gh.prView(
      host,
      ref.slug,
      ref.number,
      "state,mergeable,reviewDecision,headRefOid,latestReviews,statusCheckRollup",
    );
    if (view !== undefined) {
      const v = view as Partial<PullState>;
      pr = { ...v, latestReviews: v.latestReviews ?? [], statusCheckRollup: v.statusCheckRollup ?? [] };
    } else if (changed !== 2) {
      pr = restPull(
        memo.bodies.get("pull"),
        memo.bodies.get("reviews"),
        memo.bodies.get("checks"),
        memo.bodies.get("status"),
      );
    } else return undefined;
    const v = verdict(pr, since, this.kit.author);
    if (!v.act && !pr.approximate) memo.verdict = v;
    return v;
  }

  /**
   * A run babysits the pull request it opened until it is done — approved,
   * green, mergeable — or cannot be, in its own turn: the item stays held, so
   * no other run takes it, and the run that wrote the change answers its
   * review. `wait` is how it waits without leaving the turn: one look a
   * minute, up to SD_WAIT_FOR, and back to the run the moment there is
   * something to do. What counts as new is what came after the run last came
   * back from a wait (round_at). An item's work may be several pull requests,
   * one a repository: wait comes back for the first that needs the run, and
   * says done only once every one is done or merged.
   */
  async wait(args: readonly string[]): Promise<number> {
    if (args.length === 0) {
      this.say("usage: wait <pr>...");
      return 2;
    }
    this.needSession();
    const item = this.myItem();
    if (!item) {
      this.say("this session holds no item — call start first");
      return 1;
    }
    const refs: PrRef[] = [];
    for (const a of args) {
      const r = parsePrRef(a, this.kit.slug);
      if (!r) {
        this.say(`'${a}' is not a pull request: #<n>, or <owner/name>#<n>`);
        return 2;
      }
      refs.push(r);
    }
    const env = this.deps.env;
    const waitFor = Number(env.SD_WAIT_FOR || 540); // under the 10-minute tool limit
    const poll = Number(env.SD_WAIT_POLL || 60);
    const record = refs.map((r) => recordRef(r, this.kit.slug)).join(" ");
    const labels = refs.map((r) => labelRef(r, this.kit.slug));
    this.writeItem(item, { pr: record, updated_at: this.now() });
    if (!this.itemKey(item, "babysit_since"))
      this.writeItem(item, { babysit_since: this.now(), round_at: this.locks.read(`item-${item}`)?.owner.since ?? "" });
    const since = this.itemKey(item, "round_at");
    const start = nowSeconds(this.deps.clock);
    const waited = epoch(this.itemKey(item, "babysit_since"));
    const maxH = this.kit.babysitMaxHours;
    if (waited !== undefined && Math.floor((start - waited) / 3600) >= maxH) {
      this.writeItem(item, { babysat_out: "yes" });
      this.out(
        `timeout — babysat ${labels.join(" ")} for ${maxH}h (babysit_max_hours). Report where it stands and who it waits on, then finish pr-updated: a later run takes it over when something lands.`,
      );
      return 4;
    }
    const memos = refs.map(() => newMemo());
    const many = refs.length > 1;
    let last = "";
    for (;;) {
      this.locks.stamp(`babysit ${labels.join(" ")}: ${last || "looking"}`);
      let doneN = 0;
      let act = "";
      last = "";
      for (const [i, ref] of refs.entries()) {
        const prefix = many ? `${labels[i]}: ` : "";
        const memo = memos[i] ?? newMemo();
        const v = await this.look(ref, since, memo);
        if (v === undefined) {
          last = join2(last, `${prefix}GitHub unreadable`);
          continue;
        }
        if (v.act && v.done) {
          doneN++;
          if (!many) act = v.text;
        } else if (v.act) {
          if (!act) act = `${prefix}${v.text}`;
        } else last = join2(last, `${prefix}${v.text}`);
      }
      if (!act && many && doneN === refs.length)
        act = "done — every pull request is approved, green and mergeable, or merged: release the issue";
      if (act) {
        this.writeItem(item, { round_at: this.now(), updated_at: this.now() });
        this.locks.stamp(`babysit ${labels.join(" ")}: ${act}`);
        this.out(act);
        return 0;
      }
      if (nowSeconds(this.deps.clock) - start + poll > waitFor) break;
      await this.deps.clock.sleep(poll);
    }
    this.out(`nothing yet — ${last}. Call wait again; do not end the turn.`);
    return 3;
  }

  async lock(): Promise<number> {
    this.needSession();
    const item = this.myItem();
    if (!item) {
      this.say("this session holds no item — call start first");
      return 1;
    }
    await this.sweep(false);
    if (this.locks.take("exclusive", { item })) {
      const dirty = join(this.locks.dir, "exclusive.dirty");
      if (existsSync(dirty)) {
        this.out(
          "lock: yours. Its last holder died mid-use: bring what exclusive names back to a known state before anything else (docs/exclusive.md).",
        );
        rmSync(dirty, { force: true });
      } else this.out("lock: yours.");
      this.writeItem(item, { state: "active", updated_at: this.now() });
      this.locks.stamp("lock");
      return 0;
    }
    this.writeItem(item, { state: "waiting-lock", updated_at: this.now() });
    const o = this.locks.read("exclusive")?.owner;
    this.say(
      `the exclusive lock is held by session ${o?.session ?? ""} for #${o?.item ?? ""}, at "${o?.phase ?? ""}".`,
    );
    this.say("Push what you have and finish waiting-lock: the precheck wakes this item once the lock is free.");
    return 1;
  }

  unlock(): number {
    if (this.locks.read("exclusive") && this.locks.mine("exclusive")) this.locks.drop("exclusive");
    return 0;
  }

  async finish(args: readonly string[]): Promise<number> {
    const outcome = args[0] as Outcome | undefined;
    if (!outcome) {
      this.say("finish: outcome");
      return 2;
    }
    if (!OUTCOMES.includes(outcome)) {
      this.say(`unknown outcome '${outcome}'`);
      return 2;
    }
    let pr = args.slice(1).join(" ");
    const item = this.myItem();
    const slot = this.mySlot();
    let since = slot ? (this.locks.read(`slot-${slot}`)?.owner.since ?? "") : "";
    if (!since && item) since = this.locks.read(`item-${item}`)?.owner.since ?? "";
    const git = this.kit.git;
    if (slot) {
      for (const d of [join(this.kit.slots, slot), ...alsoDirs(git, this.kit.work, slot)]) {
        const why = git.unsaved(d);
        if (why) {
          this.say(
            `${relative(this.kit.work, d)} has ${why}: push it to its branch first — only what is pushed survives this run.`,
          );
          return 1;
        }
      }
    }
    let report = "";
    if (item) {
      if (!pr) pr = this.itemKey(item, "pr");
      // interactive, the operator holds the pull request: no later run would
      // take it over, so it is theirs to bring back (docs/direct-session.md)
      if (
        (outcome === "pr-opened" || outcome === "pr-updated" || outcome === "nothing") &&
        pr &&
        this.itemKey(item, "babysat_out") !== "yes" &&
        this.kit.cfg.mode() !== "interactive"
      ) {
        this.say(`#${item} has pull request #${pr}, and a run keeps its pull request until it is done:`);
        this.say(
          `babysit it — bash "$HOME/scripts/run-state.sh" wait ${pr} — and finish released once it is approved, green and mergeable,`,
        );
        this.say(
          "blocked when it cannot get there, or pr-updated once wait says babysit_max_hours is up (docs/babysit.md).",
        );
        return 1;
      }
      const r = await reported(this.kit, item, outcome, pr, since);
      if (r.kind === "unread") {
        report = "report=unverified";
        this.say(
          "GitHub could not be read, so the report is unverified — the run is closed anyway, and the log says so.",
        );
      } else if (r.kind === "missing") {
        this.say(`not reported yet: ${r.why}.`);
        this.say(
          "Nobody watches this run: GitHub is the only place its outcome is seen. Report there, then finish again.",
        );
        return 1;
      }
    }
    this.unlock();
    if (item) {
      const state =
        outcome === "waiting-lock" || outcome === "needs-info" || outcome === "released" || outcome === "blocked"
          ? outcome
          : "parked";
      this.writeItem(item, {
        state,
        ...(pr ? { pr } : {}),
        session: "-",
        babysit_since: "-",
        round_at: "-",
        babysat_out: "-",
        updated_at: this.now(),
      });
      if (!pr) pr = this.itemKey(item, "pr");
    }
    // a saved slot lets go of its branch, so the item's next run may take any slot
    if (slot) {
      for (const d of [join(this.kit.slots, slot), ...alsoDirs(git, this.kit.work, slot)])
        if (git.unsaved(d) === "") git.run(d, ["switch", "-q", "--detach"]);
    }
    if (item) this.locks.drop(`item-${item}`);
    if (slot) this.locks.drop(`slot-${slot}`);
    this.logLine(outcome, this.kit.me, item, slot, pr.split(/\s+/).filter(Boolean).join(","), since, report);
    // last, so the backup carries this run's TICK.log line
    persistTo(this.deps);
    // a moment a person acts on: the agent posts it, a script never does
    const chat = this.kit.cfg.get("slack_channel");
    if (chat && (outcome === "released" || outcome === "needs-info" || outcome === "blocked")) {
      const ts = await slackThread(this.kit, item, pr, chat);
      const where = ts
        ? `as a reply in thread ${ts} of slack_channel ${chat}`
        : `to slack_channel ${chat}, and record its thread`;
      if (outcome === "released") {
        if (pr) this.say(`notify: if #${pr} is still open, post that it is ready to merge ${where} (docs/notify.md)`);
      } else this.say(`notify: post this ${outcome} ${where} (docs/notify.md)`);
    }
    return 0;
  }

  /**
   * Frees what dead holders left. A dead slot holder is an abandoned run:
   * logged, and counted on its item, which the precheck then lists as
   * half-done. A dead lock holder leaves what `exclusive` names in whatever
   * state its step reached.
   */
  async sweep(print = true): Promise<string[]> {
    const abandoned: string[] = [];
    for (const h of this.locks.all()) {
      if (!(await this.locks.dead(h))) continue;
      const item = h.owner.item;
      if (h.name === "exclusive") {
        mkdirSync(this.locks.dir, { recursive: true });
        appendFileSync(join(this.locks.dir, "exclusive.dirty"), "");
      } else if (h.name.startsWith("slot-")) {
        if (item) {
          const n = Number(this.itemKey(item, "abandoned") || 0);
          this.writeItem(item, {
            item,
            state: "abandoned",
            session: "-",
            abandoned: String(n + 1),
            updated_at: this.now(),
          });
          abandoned.push(`#${item}`);
        }
        this.logLine(
          "abandoned",
          h.owner.session,
          item,
          h.owner.slot,
          "-",
          h.owner.since,
          `reason="session not running, last at '${h.owner.phase}'"`,
        );
      }
      this.locks.drop(h.name);
    }
    if (print) for (const a of abandoned) this.out(a);
    return abandoned;
  }

  held(): number {
    for (const h of this.locks.ofKind("item-")) this.out(h.name.slice("item-".length));
    return 0;
  }

  live(): number {
    this.out(String(this.locks.ofKind("slot-").length));
    return 0;
  }

  /** A live run silent past stuck_after_min: no phase stamp, and its transcript — which moves on every tool call — has not moved either. */
  quiet(): number {
    const now = nowSeconds(this.deps.clock);
    for (const h of this.locks.ofKind("slot-")) {
      let best = Math.max(epoch(h.owner.since) ?? 0, epoch(h.owner.phase_at) ?? 0);
      const t = transcriptMtime(this.kit.home, h.owner.session);
      if (t !== undefined && t > best) best = t;
      if (Math.floor((now - best) / 60) >= this.kit.stuckMin)
        this.out(
          `session ${h.owner.session}, slot ${h.owner.slot}, #${h.owner.item}, at "${h.owner.phase}" since ${h.owner.phase_at}`,
        );
    }
    return 0;
  }

  diagnosed(): number {
    const n = Number(kv(this.kit.gate, "diagnoses") || 0);
    writeKv(this.kit.gate, GATE_KEYS, { diagnosed_at: this.now(), diagnoses: String(n + 1) }, undefined, WRITER);
    mkdirSync(this.kit.work, { recursive: true });
    appendFileSync(this.kit.log, `${this.now()} diagnostic slots=${this.locks.ofKind("slot-").length}\n`);
    return 0;
  }

  show(): number {
    this.out(`slots: ${this.locks.ofKind("slot-").length} of ${this.kit.slotCount} in use`);
    for (const h of this.locks.all()) this.out(`${h.name}: ${bullets(join(h.dir, "owner"))}`);
    if (existsSync(join(this.locks.dir, "exclusive.dirty")))
      this.out("exclusive: dirty — its last holder died mid-use");
    let files: string[] = [];
    try {
      files = readdirSync(this.kit.items)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      // no items yet
    }
    for (const f of files)
      this.out(`#${f.slice(0, -3)}: ${bullets(join(this.kit.items, f), (l) => !l.startsWith("- item:"))}`);
    return 0;
  }
}

interface LookMemo {
  etags: Map<string, string>;
  bodies: Map<string, unknown>;
  verdict: ReturnType<typeof verdict> | undefined;
}
const newMemo = (): LookMemo => ({ etags: new Map(), bodies: new Map(), verdict: undefined });
const join2 = (a: string, b: string) => (a ? `${a}; ${b}` : b);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function bullets(file: string, keep: (l: string) => boolean = () => true): string {
  return readText(file)
    .split("\n")
    .filter((l) => l.startsWith("- ") && keep(l))
    .map((l) => `${l} `)
    .join("");
}

/** When a session's transcript last moved, in epoch seconds: it moves on every tool call. */
export function transcriptMtime(home: string, session: string): number | undefined {
  if (!session) return undefined;
  const root = join(home, ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    try {
      return Math.floor(statSync(join(root, d, `${session}.jsonl`)).mtimeMs / 1000);
    } catch {
      // not in this project
    }
  }
  return undefined;
}

export const runState: Command = async (deps, args) => {
  const rs = new RunState(deps);
  const [verb, ...rest] = args;
  switch (verb) {
    case "start":
      return rs.start(rest);
    case "also":
      return rs.also(rest);
    case "phase":
      return rs.phase(rest);
    case "wait":
      return rs.wait(rest);
    case "lock":
      return rs.lock();
    case "unlock":
      return rs.unlock();
    case "finish":
      return rs.finish(rest);
    case "sweep":
      await rs.sweep();
      return 0;
    case "held":
      return rs.held();
    case "live":
      return rs.live();
    case "quiet":
      return rs.quiet();
    case "diagnosed":
      return rs.diagnosed();
    case "show":
      return rs.show();
    default:
      deps.io.err(USAGE);
      return 2;
  }
};

/** The precheck sweeps and reads the quiet runs through the same verbs. */
export { RunState };
