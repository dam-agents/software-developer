// control-room — the operator's view of this instance: what each slot does,
// which items are held or parked, where their pull requests stand, what is
// queued, and what needs a person. A read-only HTTP API on 127.0.0.1, which
// the control-room page (app/control-room/page.html) reads through the
// platform's interactive artifacts; `--once` prints the same picture as JSON.
//
//   GET  /state     the whole picture; the local state is read fresh on every
//                   call, GitHub at most once a minute
//   POST /refresh   the same, GitHub read again now
//   POST /ack       {"keys": [...]}: alarms acknowledged, kept across reloads
//   GET  /history   when each alarm was first and last seen; the actions taken
//   POST /sweep     run-state's own sweep: frees only what the runtime proves gone
//
// It writes nothing run-state owns: the locks, items/, GATE.md and TICK.log
// change only through run-state itself (POST /sweep calls its verb). What only
// the control room knows — acknowledgements, alarm history — lives in
// work/control-room.db, a cache: deleted, it costs the history and nothing else.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Command, Deps } from "../factory/context.ts";
import { issueRefs, login } from "../factory/github.ts";
import { parseKv, readText } from "../factory/kv.ts";
import type { Held } from "../factory/locks.ts";
import { run } from "../factory/proc.ts";
import type { SessionInfo } from "../factory/runtime.ts";
import { epoch, iso, nowSeconds } from "../factory/time.ts";
import { ATTENDED_STALE_MIN, Kit } from "./kit.ts";
import { commentsSince, toComment } from "./pulls.ts";
import { RunState, transcriptMtime } from "./run-state.ts";

export const PORT = 5555;
const GH_TTL_SECONDS = 60;

/** Everything the page reads from GitHub, in one GraphQL request. */
export const QUERY = `query($open: String!, $merged: String!, $owner: String!, $name: String!,
    $handoff: String!, $claimed: String!, $info: String!, $failed: String!) {
  rateLimit { remaining limit resetAt }
  open: search(query: $open, type: ISSUE, first: 50) { nodes { ... on PullRequest {
    number title url isDraft body reviewDecision mergeable headRefName baseRefName updatedAt
    repository { nameWithOwner }
    latestReviews(first: 20) { nodes { author { login } state submittedAt } }
    comments(last: 20) { totalCount nodes { author { __typename login } authorAssociation body updatedAt } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      ... on StatusContext { context state }
      ... on CheckRun { name status conclusion } } } } } } } } } }
  merged: search(query: $merged, type: ISSUE, first: 20) { nodes { ... on PullRequest {
    number title url mergedAt repository { nameWithOwner } } } }
  repository(owner: $owner, name: $name) {
    handoff: issues(labels: [$handoff], states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount nodes { number title url createdAt labels(first: 20) { nodes { name } } } }
    claimed: issues(labels: [$claimed], states: OPEN, first: 50) {
      totalCount nodes { number title url updatedAt labels(first: 20) { nodes { name } } } }
    info: issues(labels: [$info], states: OPEN, first: 30) {
      totalCount nodes { number title url updatedAt labels(first: 20) { nodes { name } } } }
    failed: issues(labels: [$failed], states: OPEN, first: 30) {
      totalCount nodes { number title url updatedAt labels(first: 20) { nodes { name } } } } } }`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const nodes = (v: unknown): Json[] => arr(obj(v).nodes).map(obj);

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED"]);
const OK = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/** How a lock's holder stands, as run-state's dead() would judge it, and why. */
export type Holder = "live" | "parked" | "idle" | "stale" | "dead" | "unknown";

export interface LockView {
  readonly name: string;
  readonly kind: "item" | "slot" | "exclusive" | "other";
  readonly key: string;
  readonly session: string;
  readonly since: string;
  readonly item: string;
  readonly slot: string;
  readonly phase: string;
  readonly phase_at: string;
  readonly held_min: number | null;
  readonly silent_min: number | null;
  readonly stop_blocks: number;
  readonly holder: Holder;
  /** A parked item lock: when, and what keeps it — its waiter, a booked wake-up, or nothing. */
  readonly parked_at: string;
  readonly kept_by: "waiter" | "booking" | "";
  readonly wake_at: string;
}

export interface Alarm {
  readonly level: "alarm" | "adv";
  readonly code: string;
  readonly text: string;
  readonly item?: string;
  readonly pr?: string;
  key?: string;
  first_seen?: string;
}

function minutesSince(clockNow: number, t: string | number | undefined): number | null {
  const e = typeof t === "number" ? t : epoch(t ?? "");
  return e === undefined ? null : Math.max(0, Math.floor((clockNow - e) / 60));
}

const dur = (m: number) =>
  m < 60
    ? `${m} min`
    : m < 1440
      ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`
      : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;

/** A lock as the page shows it. */
async function lockView(
  kit: Kit,
  h: Held,
  sessions: Map<string, SessionInfo> | undefined,
  now: number,
): Promise<LockView> {
  const o = h.owner;
  const kind =
    h.name === "exclusive"
      ? "exclusive"
      : h.name.startsWith("item-")
        ? "item"
        : h.name.startsWith("slot-")
          ? "slot"
          : "other";
  const signs = [epoch(o.since), epoch(o.phase_at), transcriptMtime(kit.home, o.session)].filter(
    (t): t is number => t !== undefined,
  );
  const last = signs.length ? Math.max(...signs) : undefined;
  const keptBy = o.parked_at ? kit.locks.parkedHolder(o) : "";
  let holder: Holder;
  if (keptBy !== "") holder = "parked";
  else if (sessions === undefined) holder = "unknown";
  else {
    const s = sessions.get(o.session);
    if (s?.running) holder = "live";
    else if (s && (s.type === "regular" || s.type === "channel_slack")) {
      const age = minutesSince(now, o.parked_at || o.since);
      holder = age === null || age >= ATTENDED_STALE_MIN ? "stale" : "idle";
    } else holder = "dead";
  }
  return {
    name: h.name,
    kind,
    key: h.name.includes("-") ? h.name.slice(h.name.indexOf("-") + 1) : h.name,
    session: o.session,
    since: o.since,
    item: o.item,
    slot: o.slot,
    phase: o.phase,
    phase_at: o.phase_at,
    held_min: minutesSince(now, o.since),
    silent_min: last === undefined ? null : minutesSince(now, last),
    stop_blocks: kit.locks.stopBlocks(h.name),
    holder,
    parked_at: o.parked_at,
    kept_by: keptBy,
    wake_at: o.wake_at,
  };
}

function gitSlot(kit: Kit, dir: string) {
  if (!existsSync(join(dir, ".git"))) return { exists: false };
  const g = (args: string[]) => {
    const r = run("git", ["-C", dir, ...args], { env: kit.deps.env, timeoutMs: 10_000 });
    return r.code === 0 ? r.stdout.trim() : "";
  };
  const [head = "", subject = ""] = g(["log", "-1", "--format=%h%x09%s"]).split("\t");
  const ahead = g(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  return {
    exists: true,
    branch: g(["branch", "--show-current"]),
    head,
    subject,
    dirty: g(["status", "--porcelain"])
      .split("\n")
      .filter((l) => l.trim()).length,
    // against the last fetch: a stale tracking ref overcounts, so the page says "ahead of last fetch"
    unpushed: /^[0-9]+$/.test(ahead) ? Number(ahead) : 0,
  };
}

/** The item state machine the page draws its plant from, beside the page. */
export function readMachine(): Json {
  try {
    const m = obj(JSON.parse(readFileSync(new URL("../../control-room/machine.json", import.meta.url), "utf8")));
    if (!Array.isArray(m.states) || !Array.isArray(m.edges)) throw new Error("states and edges must be lists");
    return m;
  } catch (e) {
    return {
      states: [],
      edges: [],
      error: `machine.json unreadable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
    };
  }
}

/** The kit's TICK.log, newest first, each line's fields parsed. */
export function readLog(text: string, n = 40): Json[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
    .reverse()
    .map((line) => {
      const [at = "", outcome = "", ...rest] = line.split(" ");
      const rec: Json = { at, outcome, raw: line };
      for (const m of rest.join(" ").matchAll(/(\w+)=("([^"]*)"|\S+)/g)) rec[m[1] ?? ""] = m[3] ?? m[2];
      return rec;
    });
}

/** How resumes went, from TICK.log: continued in the session that wrote the change, or taken over fresh. */
export function resumeCounts(text: string, sinceIso: string) {
  const lines = text.split("\n").filter((l) => l.split(" ")[1] === "resumed" && (l.split(" ")[0] ?? "") > sinceIso);
  const by = (c: string) => lines.filter((l) => new RegExp(`cause=${c}( |$)`).test(l)).length;
  return {
    total: lines.length,
    waiter: by("waiter"),
    booking: by("booking"),
    operator: by("operator"),
    fresh: by("fresh"),
  };
}

interface GhState {
  at: number;
  data?: Json;
  error?: string;
}

/** The control room's state: GitHub cached, the store open, the rest read per call. */
export class ControlRoom {
  readonly deps: Deps;
  private gh: GhState = { at: 0 };
  private readonly store: Store;

  constructor(deps: Deps, store?: Store) {
    this.deps = deps;
    this.store = store ?? Store.open(join(new Kit(deps).work, "control-room.db"));
  }

  private async github(kit: Kit, force: boolean): Promise<GhState> {
    const now = nowSeconds(this.deps.clock);
    if (!force && this.gh.data && now - this.gh.at < GH_TTL_SECONDS) return this.gh;
    if (!kit.repo) {
      this.gh = { at: now, error: "no repo in work/CONFIG.md" };
      return this.gh;
    }
    const [owner = "", name = ""] = kit.slug.split("/");
    const scopes = [`repo:${kit.slug}`];
    for (const p of kit.cfg.list("repos_also"))
      if (p.endsWith("/*")) scopes.push(`org:${p.slice(0, -2)}`);
      else if (p.includes("/")) scopes.push(`repo:${p}`);
    const mine = kit.labelMine ? ` label:"${kit.labelMine}"` : "";
    const author = kit.author || "@me";
    const week = iso(new Date((now - 7 * 86400) * 1000)).slice(0, 10);
    const r = await this.deps.github.graphql<Json>(kit.host, QUERY, {
      open: `${scopes.join(" ")} is:pr is:open author:${author}${mine}`,
      merged: `${scopes.join(" ")} is:pr is:merged author:${author}${mine} merged:>=${week}`,
      owner,
      name,
      handoff: kit.labelHandoff,
      claimed: kit.labelClaimed,
      info: kit.labelNeedsInfo,
      failed: kit.labelFailed,
    });
    this.gh = r.data ? { at: now, data: r.data } : { at: now, error: (r.error ?? "GraphQL refused").slice(0, 300) };
    return this.gh;
  }

  /** The whole picture, as GET /state answers it. */
  async snapshot(force = false): Promise<Json> {
    const kit = new Kit(this.deps);
    const now = nowSeconds(this.deps.clock);
    const listed = await this.deps.runtime.sessions();
    const sessions = listed && new Map(listed.map((s) => [s.id, s]));
    const locks = await Promise.all(kit.locks.all().map((h) => lockView(kit, h, sessions, now)));
    const dirty = existsSync(join(kit.locks.dir, "exclusive.dirty"));
    const n = kit.slotCount;
    const slots = Array.from({ length: n }, (_, i) => {
      const k = String(i + 1);
      return { k: i + 1, ...gitSlot(kit, join(kit.slots, k)), lock: locks.find((l) => l.name === `slot-${k}`) ?? null };
    });
    const items = new Map<string, Map<string, string>>();
    try {
      for (const f of readdirSync(kit.items).filter((f) => f.endsWith(".md")))
        items.set(f.slice(0, -3), parseKv(readText(join(kit.items, f))));
    } catch {
      // no items yet
    }
    const gh = await this.github(kit, force);
    const data = gh.data;
    const repoData = obj(data?.repository);

    // pull requests
    const prs = nodes(data?.open).map((p) => {
      const repo = str(obj(p.repository).nameWithOwner) || kit.slug;
      const ctx = nodes(obj(obj(obj(nodes(p.commits)[0]).commit).statusCheckRollup).contexts);
      const failed: string[] = [];
      let running = 0;
      let passed = 0;
      for (const c of ctx) {
        const st = str(c.conclusion) || str(c.state);
        if (FAILED.has(st)) failed.push(str(c.name) || str(c.context));
        else if (OK.has(st)) passed++;
        else running++;
      }
      const approved = p.reviewDecision === "APPROVED";
      const comments = nodes(p.comments).map(toComment);
      const reviews = nodes(p.latestReviews)
        .filter((r) => login(str(obj(r.author).login)) !== login(kit.author))
        .map((r) => ({ by: str(obj(r.author).login), state: str(r.state), at: str(r.submittedAt) }));
      const people = commentsSince(comments, "", approved);
      return {
        number: Number(p.number),
        repo,
        ref: repo.toLowerCase() === kit.slug.toLowerCase() ? `#${String(p.number)}` : `${repo}#${String(p.number)}`,
        title: str(p.title),
        url: str(p.url),
        draft: p.isDraft === true,
        branch: str(p.headRefName),
        base: str(p.baseRefName),
        decision: str(p.reviewDecision) || "NONE",
        mergeable: str(p.mergeable) || "UNKNOWN",
        checks: ctx.length === 0 ? "none" : failed.length ? "failed" : running ? "running" : "passed",
        checks_failed: failed,
        checks_running: running,
        checks_passed: passed,
        reviews,
        last_comment: people.length ? { by: people.at(-1)?.login, at: people.at(-1)?.at } : null,
        issues: issueRefs(str(p.body), kit.slug, repo),
      };
    });
    const merged = nodes(data?.merged).map((p) => ({
      number: Number(p.number),
      repo: str(obj(p.repository).nameWithOwner),
      title: str(p.title),
      url: str(p.url),
      at: str(p.mergedAt),
    }));
    const issues = (key: string) =>
      nodes(repoData[key]).map((i) => ({
        number: Number(i.number),
        title: str(i.title),
        url: str(i.url),
        labels: nodes(i.labels).map((l) => str(l.name)),
        at: str(i.createdAt) || str(i.updatedAt),
      }));
    const total = (key: string) => {
      const t = obj(repoData[key]).totalCount;
      return typeof t === "number" ? t : null;
    };
    const handoff = issues("handoff");
    const claimed = issues("claimed").filter((i) => !kit.labelMine || i.labels.includes(kit.labelMine));
    const claimedNums = new Set(claimed.map((i) => String(i.number)));
    // the queue is what the precheck would offer: not claimed by anyone, asked or failed, and
    // not held — a run that has just started holds its item before it swaps the labels
    const taken = new Set([kit.labelClaimed, kit.labelNeedsInfo, kit.labelFailed]);
    const held = new Set(locks.filter((l) => l.kind === "item").map((l) => l.key));
    const queue = handoff.filter((i) => !i.labels.some((l) => taken.has(l)) && !held.has(String(i.number)));
    // needs-info and failed carry no claim: ours are the issues this instance ever started
    const infoAll = issues("info");
    const failedAll = issues("failed");
    const needsInfo = infoAll.filter((i) => items.has(String(i.number)));
    const failedOurs = failedAll.filter((i) => items.has(String(i.number)));

    // items in flight: held, claimed, or with an open pull request of ours
    const itemLocks = new Map(locks.filter((l) => l.kind === "item").map((l) => [l.key, l]));
    const slotLocks = locks.filter((l) => l.kind === "slot");
    const excl = locks.find((l) => l.kind === "exclusive") ?? null;
    const prByIssue = new Map<string, typeof prs>();
    for (const p of prs) for (const i of p.issues) prByIssue.set(i, [...(prByIssue.get(i) ?? []), p]);
    const keys = new Set([...itemLocks.keys(), ...claimedNums, ...prByIssue.keys()]);
    for (const p of prs) if (p.issues.length === 0 && p.ref.startsWith("#")) keys.add(`pr${p.number}`);
    const flight = [...keys]
      .sort(
        (a, b) =>
          Number(a.startsWith("pr")) - Number(b.startsWith("pr")) ||
          Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")),
      )
      .map((k) => {
        const lk = itemLocks.get(k) ?? null;
        const it = items.get(k) ?? new Map<string, string>();
        const ps = k.startsWith("pr") ? prs.filter((p) => `pr${p.number}` === k) : (prByIssue.get(k) ?? []);
        const slot = lk ? slotLocks.find((s) => s.session === lk.session && s.item === k) : undefined;
        const state = it.get("state") ?? "";
        let stage: string;
        if (lk && slot) stage = excl?.item === k ? "verifying" : "working";
        else if (lk?.parked_at)
          stage = ps.length > 0 && ps.every((p) => p.decision === "APPROVED") ? "awaiting-merge" : "in-review";
        else if (lk) stage = "item-lock";
        else if (ps.length > 0) stage = ps.every((p) => p.decision === "APPROVED") ? "awaiting-merge" : "in-review";
        else if (["waiting-lock", "needs-info", "blocked"].includes(state)) stage = state;
        else stage = "orphan";
        const iss = claimed.find((i) => String(i.number) === k);
        return {
          item: k,
          title: iss?.title || ps[0]?.title || "",
          url: iss?.url || ps[0]?.url || "",
          stage,
          state,
          branch: it.get("branch") || ps[0]?.branch || "",
          last_slot: it.get("slot") ?? "",
          seen_at: it.get("seen_at") ?? "",
          abandoned: Number(it.get("abandoned") ?? 0) || 0,
          claimed: iss !== undefined,
          lock: lk,
          slot: slot?.key ?? "",
          prs: ps.map((p) => p.ref),
          session: lk?.session || it.get("session") || "",
          watched: lk?.parked_at ? lk.kept_by : "",
        };
      });

    // alarms
    const alarms: Alarm[] = [];
    const frees =
      kit.cfg.mode() === "autonomous"
        ? "the next tick's sweep frees it"
        : "freed by the next start or lock (no tick runs in interactive mode)";
    if (gh.error) alarms.push({ level: "alarm", code: "GH", text: `GitHub unreadable: ${gh.error.slice(0, 140)}` });
    if (!listed)
      alarms.push({
        level: "alarm",
        code: "RUNTIME",
        text: "the platform runtime does not answer: no lock can be judged live or dead",
      });
    if (dirty)
      alarms.push({
        level: "alarm",
        code: "EXCL-DIRTY",
        text: "the exclusive lock's last holder died mid-use: reset it before the next use",
      });
    const gone = new Map<string, LockView[]>();
    for (const l of locks)
      if (l.holder === "dead" || l.holder === "stale")
        gone.set(`${l.holder} ${l.session}`, [...(gone.get(`${l.holder} ${l.session}`) ?? []), l]);
    for (const [k, ls] of gone) {
      const [holder = "", sid = ""] = k.split(" ");
      const what =
        holder === "dead"
          ? "a session that is not running"
          : `an idle chat, the oldest for ${dur(Math.max(...ls.map((l) => l.held_min ?? 0)))}`;
      alarms.push({
        level: "adv",
        code: holder.toUpperCase(),
        text: `session ${sid.slice(0, 8)} holds ${ls.length} lock(s) as ${what}: ${ls.map((l) => l.name).join(", ")}. ${frees}`,
      });
    }
    for (const l of locks) {
      if (l.kind === "slot" && l.holder === "live" && (l.silent_min ?? 0) >= kit.stuckMin)
        alarms.push({
          level: "adv",
          code: "QUIET",
          text: `slot ${l.key} silent ${l.silent_min} min at "${l.phase}"`,
          item: l.item,
        });
      if (l.kind === "exclusive" && (l.held_min ?? 0) >= 60)
        alarms.push({
          level: "adv",
          code: "EXCL-LONG",
          text: `the exclusive lock held ${l.held_min} min by #${l.item}`,
          item: l.item,
        });
      if (l.kind === "item" && l.parked_at && l.kept_by === "booking")
        alarms.push({
          level: "adv",
          code: "NO-WAITER",
          text: `#${l.key} is parked with no waiter running: only its wake-up at ${l.wake_at} will bring its session back`,
          item: l.key,
        });
    }
    // one run, one item: a session holding several items' locks in the turn (parked ones aside)
    const working = new Map<string, string[]>();
    for (const l of locks)
      if (l.kind === "item" && !l.parked_at) working.set(l.session, [...(working.get(l.session) ?? []), l.key]);
    for (const [sid, its] of working)
      if (its.length > 1)
        alarms.push({
          level: "adv",
          code: "MULTI",
          text: `session ${sid.slice(0, 8)} holds ${its.length} item locks (${its.map((i) => (i.startsWith("pr") ? i : `#${i}`)).join(", ")}): one run, one item (CLAUDE.md → The tick)`,
        });
    for (const s of slots)
      if (s.exists && !s.lock && ("dirty" in s ? s.dirty || s.unpushed : false))
        alarms.push({
          level: "alarm",
          code: "UNSAVED",
          text: `slot ${s.k} is free but holds ${"dirty" in s ? s.dirty : 0} changed file(s), ${"unpushed" in s ? s.unpushed : 0} commit(s) on no remote branch`,
        });
    for (const f of flight)
      if (f.stage === "orphan" && f.claimed)
        alarms.push({
          level: "adv",
          code: "ORPHAN",
          text: `#${f.item} claimed, no pull request, no run on it`,
          item: f.item,
        });
    for (const p of prs) {
      if (p.checks === "failed")
        alarms.push({
          level: "alarm",
          code: "RED",
          text: `${p.ref} checks failed: ${p.checks_failed.slice(0, 3).join(", ")}`,
        });
      if (p.mergeable === "CONFLICTING")
        alarms.push({ level: "adv", code: "CONFLICT", text: `${p.ref} conflicts with its base ${p.base}`, pr: p.ref });
    }
    const acked = this.store.record(alarms, iso(this.deps.clock.now()));
    const log = readText(kit.log);
    return {
      generated_at: iso(this.deps.clock.now()),
      config: {
        repo: kit.repo,
        repos_also: kit.cfg.get("repos_also"),
        author: kit.author,
        mode: kit.cfg.mode(),
        label_handoff: kit.labelHandoff,
        label_claimed: kit.labelClaimed,
        label_needs_info: kit.labelNeedsInfo,
        label_failed: kit.labelFailed,
        label_mine: kit.labelMine,
        verify: kit.cfg.get("verify"),
        exclusive: kit.cfg.get("exclusive"),
        verify_exclusive: kit.cfg.get("verify_exclusive"),
        schedules: kit.cfg.get("schedules"),
        slots: n,
        babysit_max_hours: kit.babysitMaxHours,
        stuck_after_min: kit.stuckMin,
        version: readText(join(kit.home, "VERSION")).trim(),
      },
      runtime_ok: listed !== undefined,
      sessions: Object.fromEntries(
        [...new Set([...locks.map((l) => l.session), ...flight.map((f) => f.session)])]
          .filter((id) => sessions?.has(id))
          .map((id) => [id, sessions?.get(id)]),
      ),
      locks,
      exclusive: { lock: excl, dirty, named: kit.cfg.get("exclusive") !== "" },
      slots,
      flight,
      prs,
      merged,
      queue,
      needs_info: needsInfo,
      failed: failedOurs,
      totals: {
        handoff: total("handoff"),
        queue_taken: handoff.length - queue.length,
        needs_info_others: infoAll.length - needsInfo.length,
        failed_others: failedAll.length - failedOurs.length,
      },
      resumes: resumeCounts(log, iso(new Date((now - 7 * 86400) * 1000))),
      log: readLog(log),
      gh: { at: gh.at ? iso(new Date(gh.at * 1000)) : null, error: gh.error ?? null, rate: obj(data?.rateLimit) },
      alarms,
      acked,
      machine: readMachine(),
    };
  }

  /** POST /sweep: run-state's own sweep, the precheck's first step. */
  async sweep(): Promise<{ freed: string[] }> {
    const freed = await new RunState({ ...this.deps, io: { out: () => {}, err: () => {} } }).sweep(false);
    this.store.action("sweep", JSON.stringify({ freed }), iso(this.deps.clock.now()));
    return { freed };
  }

  ack(keys: readonly string[]): number {
    return this.store.ack(keys.slice(0, 200), iso(this.deps.clock.now()));
  }

  history(): Json {
    return this.store.history();
  }
}

/** What only the control room knows, in SQLite (node:sqlite): alarms seen and acknowledged, actions taken. */
export class Store {
  // biome-ignore lint/suspicious/noExplicitAny: node:sqlite's DatabaseSync, loaded lazily so a Node without it still runs the rest
  private readonly db: any;

  private constructor(db: unknown) {
    this.db = db;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS alarm (key TEXT PRIMARY KEY, code TEXT, level TEXT, text TEXT,
        first_seen TEXT, last_seen TEXT, acked_at TEXT);
      CREATE TABLE IF NOT EXISTS action (at TEXT, kind TEXT, detail TEXT);`);
  }

  static open(path: string): Store {
    const { DatabaseSync } = require_sqlite();
    return new Store(new DatabaseSync(path));
  }

  /** An alarm's key, stable across reads: its code, and its text with the minutes that change taken out. */
  static key(a: Alarm): string {
    return `${a.code}|${a.text.replace(/\d+( min| h \d+| d \d+ h)/g, "#")}`;
  }

  /** Upserts what is lit now; returns the keys acknowledged and still lit. */
  record(alarms: Alarm[], now: string): string[] {
    const acked: string[] = [];
    const up =
      this.db.prepare(`INSERT INTO alarm (key, code, level, text, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET text = excluded.text, level = excluded.level, last_seen = excluded.last_seen`);
    const get = this.db.prepare("SELECT acked_at, first_seen FROM alarm WHERE key = ?");
    for (const a of alarms) {
      const k = Store.key(a);
      up.run(k, a.code, a.level, a.text, now, now);
      const row = get.get(k) as { acked_at: string | null; first_seen: string } | undefined;
      a.key = k;
      a.first_seen = row?.first_seen ?? now;
      if (row?.acked_at) acked.push(k);
    }
    return acked.sort();
  }

  ack(keys: readonly string[], now: string): number {
    const up = this.db.prepare("UPDATE alarm SET acked_at = ? WHERE key = ?");
    let n = 0;
    for (const k of keys) n += Number(up.run(now, k).changes);
    this.action("ack", JSON.stringify(keys).slice(0, 2000), now);
    return n;
  }

  action(kind: string, detail: string, now: string): void {
    this.db.prepare("INSERT INTO action VALUES (?, ?, ?)").run(now, kind, detail);
  }

  history(): Json {
    return {
      alarms: this.db
        .prepare(
          "SELECT code, level, text, first_seen, last_seen, acked_at FROM alarm ORDER BY last_seen DESC LIMIT 100",
        )
        .all(),
      actions: this.db.prepare("SELECT at, kind, detail FROM action ORDER BY at DESC LIMIT 30").all(),
    };
  }
}

// node:sqlite is built into Node 22.5+; required lazily, so the kit's other commands never load it
function require_sqlite(): { DatabaseSync: new (path: string) => unknown } {
  return process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => unknown };
}

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) {
    s += String(chunk);
    if (s.length > 64_000) throw new Error("body too large");
  }
  return s;
}

function send(res: ServerResponse, code: number, value: unknown): void {
  const b = JSON.stringify(value);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
}

/** The HTTP API, bound to 127.0.0.1 alone: the platform carries the page's requests to it. */
export function handler(room: ControlRoom) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // inside the try: a target URL cannot parse (`//`, `//[`) is a 400, not a crashed server
      const path = URL.canParse(req.url ?? "/", "http://x") ? new URL(req.url ?? "/", "http://x").pathname : "";
      if (!path) return send(res, 400, { error: "bad request target" });
      if (req.method === "GET" && path === "/state") return send(res, 200, await room.snapshot());
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && path === "/history") return send(res, 200, room.history());
      if (req.method === "POST" && path === "/refresh") return send(res, 200, await room.snapshot(true));
      if (req.method === "POST" && path === "/ack") {
        const keys = obj(JSON.parse((await body(req)) || "{}")).keys;
        if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string"))
          return send(res, 400, { error: "keys must be a list of strings" });
        return send(res, 200, { acked: room.ack(keys) });
      }
      if (req.method === "POST" && path === "/sweep")
        return send(res, 200, { ...(await room.sweep()), state: await room.snapshot() });
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

/**
 * `sd control-room [--once]`: serve the API on 127.0.0.1:5555 until stopped,
 * or print one snapshot. A helper daemon: start it with nohup, never keep it
 * (the platform's `platform-keep` is for jobs that must finish).
 */
export const controlRoom: Command = async (deps, args) => {
  const room = new ControlRoom(deps);
  if (args[0] === "--once") {
    deps.io.out(JSON.stringify(await room.snapshot(true), null, 1));
    return 0;
  }
  if (args.length > 0) {
    deps.io.err("usage: control-room [--once]");
    return 2;
  }
  const port = Number(deps.env.SD_CONTROL_ROOM_PORT || PORT);
  const server = createServer(handler(room));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  deps.io.err(`control-room: listening on 127.0.0.1:${port}`);
  await new Promise(() => {});
  return 0;
};

/** The page, with a snapshot built in so it reads without the server: what an artifact publishes. */
export function buildPage(template: string, snapshot: unknown): string {
  if (template.split("__SNAPSHOT__").length !== 2) throw new Error("page.html: expected exactly one __SNAPSHOT__");
  const blob = JSON.stringify(snapshot).replaceAll("</", "<\\/").replaceAll("<!--", "\\u003c!--");
  // a function, never a string: a `$'` or `$&` in a title would expand to the page around it
  return template.replace("__SNAPSHOT__", () => blob);
}

/** `sd control-room-page [out]`: the page with a fresh snapshot built in, for create_artifact. */
export const controlRoomPage: Command = async (deps, args) => {
  // beside the source, wherever the definition is checked out
  const template = readFileSync(new URL("../../control-room/page.html", import.meta.url), "utf8");
  const page = buildPage(template, await new ControlRoom(deps).snapshot(true));
  const out = args[0];
  if (out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, page);
    deps.io.out(`${out}: ${page.length} bytes`);
  } else deps.io.out(page);
  return 0;
};
