// precheck — what a tick's schedule runs before it opens a session: exit 0
// there is work, and stdout goes into the prompt · 1 skip the occurrence ·
// anything else broken, the run happens anyway and the reason is recorded.
//
// PRECHECK_PROBE=1 answers only "is there work, and can GitHub be read": no
// slot gate and no state written. verify --live and the audit use it to prove
// the detection end to end.
//
// Up to `slots` runs at once, one item each. Nothing is claimed here: a run
// takes its item and its slot itself, atomically, so two runs let through
// close together simply take different items. What this gate does is free
// what dead runs left, decline while every slot is held, and leave out of the
// list what a live run already holds.
//
// Every slot held, and one of the holders silent past `stuck_after_min`, is
// the one thing declining cannot fix, and it is silent — the panel just
// counts declines — so it lets a DIAGNOSTIC run through, which may not build,
// and whose only job is to say what is stuck. At most one per backoff window,
// doubling from an hour to a day.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command, Deps } from "../factory/context.ts";
import type { GitHub } from "../factory/github.ts";
import { issueRefs, login } from "../factory/github.ts";
import { kv, parseKv, readText } from "../factory/kv.ts";
import { epoch, nowSeconds } from "../factory/time.ts";
import { Kit } from "./kit.ts";
import { commentsSince, failedSince, type PullState, restPull, reviewsSince, toComment } from "./pulls.ts";
import { RunState } from "./run-state.ts";

/** Everything the list needs in one GraphQL request, and only the fields read below. */
export const QUERY = `query($q: String!, $owner: String!, $name: String!, $handoff: String!, $claimed: String!) {
  prs: search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest {
    number title url body reviewDecision state mergeable repository { nameWithOwner }
    latestReviews(first: 100) { nodes { author { login } state submittedAt } }
    comments(last: 20) { nodes { author { __typename login } authorAssociation body updatedAt } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      ... on StatusContext { context state createdAt }
      ... on CheckRun { name status conclusion startedAt completedAt } } } } } } } } } }
  repository(owner: $owner, name: $name) {
    handoff: issues(labels: [$handoff], states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number title url labels(first: 20) { nodes { name } } } }
    claimed: issues(labels: [$claimed], states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number title url labels(first: 20) { nodes { name } } } } } }`;

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
}

export interface Snapshot {
  readonly prs: readonly PullState[];
  readonly handoff: readonly Issue[];
  readonly claimed: readonly Issue[];
  /** Read over REST because GraphQL refused: what it said. */
  readonly restBecause?: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function issueOf(v: unknown, labels: (v: Json) => unknown[]): Issue {
  const o = obj(v);
  return {
    number: Number(o.number),
    title: str(o.title),
    url: str(o.url) || str(o.html_url),
    labels: labels(o).map((l) => str(obj(l).name)),
  };
}

/** `repos_also` as search qualifiers: `owner/*` searches the owner. */
export function alsoScopes(patterns: readonly string[]): string {
  return patterns
    .flatMap((p) => (p.endsWith("/*") ? [`org:${p.slice(0, -2)}`] : /^[^/]+\/[^/]+$/.test(p) ? [`repo:${p}`] : []))
    .map((s) => `${s} `)
    .join("");
}

export class Unreadable extends Error {}

/**
 * Your open pull requests with their reviews and checks, the hand-off
 * issues, the claimed ones. GraphQL refused — its budget, shared with every
 * agent on an app's installation, spent — the same reads go over REST, a
 * budget of their own. That is also the retry: a blip that fails open costs a
 * whole turn that begins by wondering why.
 */
export async function readGitHub(kit: Kit, authorIn: string): Promise<Snapshot> {
  const gh = kit.deps.github;
  const mine = kit.labelMine;
  const also = alsoScopes(kit.cfg.list("repos_also"));
  const prQ = `is:pr is:open author:${authorIn}${mine ? ` label:"${mine}"` : ""}`;
  const [owner, name] = kit.slug.split("/");
  const g = await gh.graphql<Json>(kit.host, QUERY, {
    q: `repo:${kit.slug} ${also}${prQ}`,
    owner: owner ?? "",
    name: name ?? "",
    handoff: kit.labelHandoff,
    claimed: kit.labelClaimed,
  });
  if (g.data) {
    const data = g.data;
    const prs = arr(obj(data.prs).nodes).map((n): PullState => {
      const o = obj(n);
      const contexts = arr(obj(obj(obj(obj(arr(obj(o.commits).nodes)[0]).commit).statusCheckRollup).contexts).nodes);
      return {
        number: Number(o.number),
        title: str(o.title),
        url: str(o.url),
        body: str(o.body),
        reviewDecision: typeof o.reviewDecision === "string" ? o.reviewDecision : null,
        state: str(o.state),
        mergeable: str(o.mergeable),
        comments: arr(obj(o.comments).nodes).map(toComment),
        repo: str(obj(o.repository).nameWithOwner) || kit.slug,
        latestReviews: arr(obj(o.latestReviews).nodes).map((r) => ({
          author: { login: str(obj(obj(r).author).login) },
          state: str(obj(r).state),
          submittedAt: str(obj(r).submittedAt),
        })),
        statusCheckRollup: contexts.map((c) => {
          const x = obj(c);
          return x.context
            ? { context: str(x.context), state: str(x.state), startedAt: str(x.createdAt) }
            : {
                name: str(x.name),
                status: str(x.status),
                conclusion: str(x.conclusion),
                startedAt: str(x.startedAt),
                completedAt: str(x.completedAt),
              };
        }),
      };
    });
    const repo = obj(data.repository);
    const nodes = (v: Json) => arr(obj(v.labels).nodes);
    return {
      prs,
      handoff: arr(obj(repo.handoff).nodes).map((i) => issueOf(i, nodes)),
      claimed: arr(obj(repo.claimed).nodes).map((i) => issueOf(i, nodes)),
    };
  }
  const because = g.error ?? "";
  let author = authorIn;
  if (author === "@me") author = str(obj(await gh.get(kit.host, "user")).login) || "@me";
  const rest = await readRest(gh, kit, author, mine, also, prQ);
  if (!rest) throw new Unreadable(`gh could not read ${kit.repo}, over GraphQL (${because}) nor REST.`);
  return { ...rest, restBecause: because };
}

async function readRest(gh: GitHub, kit: Kit, author: string, mine: string, also: string, prQ: string) {
  const pulls = await gh.getAll(kit.host, `repos/${kit.slug}/pulls?state=open&per_page=100`);
  const issues = async (label: string) => {
    const v = await gh.get(
      kit.host,
      `repos/${kit.slug}/issues?state=open&per_page=50&labels=${encodeURIComponent(label)}`,
    );
    if (v === undefined) return undefined;
    return arr(v)
      .map(obj)
      .filter((i) => !i.pull_request)
      .map((i) => issueOf({ ...i, url: i.html_url }, (o) => arr(o.labels)));
  };
  const handoff = await issues(kit.labelHandoff);
  const claimed = await issues(kit.labelClaimed);
  if (pulls === undefined || handoff === undefined || claimed === undefined) return undefined;
  const ownPulls = pulls
    .map(obj)
    .filter((p) => login(str(obj(p.user).login)) === login(author))
    .filter((p) => mine === "" || arr(p.labels).some((l) => str(obj(l).name) === mine));
  const prs: PullState[] = [];
  const full = async (slug: string, pull: Json) => {
    const n = Number(pull.number);
    const sha = str(obj(pull.head).sha);
    const reviews = await gh.get(kit.host, `repos/${slug}/pulls/${n}/reviews?per_page=100`);
    const checks = await gh.get(kit.host, `repos/${slug}/commits/${sha}/check-runs?per_page=100`);
    const status = await gh.get(kit.host, `repos/${slug}/commits/${sha}/status`);
    const comments = await gh.get(kit.host, `repos/${slug}/issues/${n}/comments?per_page=100`);
    if (reviews === undefined || checks === undefined || status === undefined) return undefined;
    const p = restPull(pull, reviews, checks, status);
    return { ...p, repo: p.repo || slug, comments: Array.isArray(comments) ? comments.map(toComment) : [] };
  };
  for (const pull of ownPulls) {
    const p = await full(kit.slug, pull);
    if (!p) throw new Unreadable(`gh could not read the pull requests on ${kit.repo} over REST either`);
    prs.push(p);
  }
  // the other repositories' over REST's own search, then one by one
  if (also) {
    const found = await gh.get(kit.host, `search/issues?q=${encodeURIComponent(`${also}${prQ}`)}&per_page=50`);
    if (found === undefined) throw new Unreadable("gh could not read the pull requests in repos_also over REST either");
    for (const it of arr(obj(found).items).map(obj)) {
      const slug = str(it.repository_url).replace(/.*\/repos\//, "");
      if (!slug || slug === kit.slug) continue;
      const pull = await gh.get(kit.host, `repos/${slug}/pulls/${String(it.number)}`);
      const p = pull === undefined ? undefined : await full(slug, obj(pull));
      if (!p) throw new Unreadable("gh could not read the pull requests in repos_also over REST either");
      prs.push(p);
    }
  }
  return { prs, handoff, claimed };
}

interface ItemCache {
  readonly seen: string;
  readonly state: string;
  readonly abandoned: number;
  readonly branch: string;
}

/**
 * What the local cache knows of each item: when a run last looked at it, what
 * state it was left in, how often a run died on it. Missing or lost, every
 * item reads as never seen: GitHub is the truth, and this cache is never pushed.
 */
export function readItems(dir: string): Map<string, ItemCache> {
  const out = new Map<string, ItemCache>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const f of files) {
    const m = parseKv(readText(join(dir, f)));
    out.set(f.slice(0, -3), {
      seen: m.get("seen_at") ?? "",
      state: m.get("state") ?? "",
      abandoned: Number(m.get("abandoned") ?? 0) || 0,
      branch: m.get("branch") ?? "",
    });
  }
  return out;
}

/** The worklist, by section, from what GitHub and the cache say. */
export function worklist(
  kit: Kit,
  snap: Snapshot,
  items: Map<string, ItemCache>,
  held: ReadonlySet<string>,
  since: string,
  author: string,
  lockFree: boolean,
) {
  const root = kit.slug;
  // A pull request is babysat until it is merged (docs/babysit.md). It wakes
  // a run for what happened to it since a run last looked: a review, a
  // person's comment — on an approved one, a maintainer's — or a check that
  // failed, once, so what the agent could not fix is not reported every tick.
  // Its item is the issue of `repo` its body names, and an item held — by a
  // live run, or parked with its session's waiter or wake-up still to come —
  // is left out: that session answers it, with the context that wrote it. One
  // in another repository that names none is not this instance's work.
  const prWork: string[] = [];
  for (const p of snap.prs) {
    const repo = p.repo || root;
    const other = repo.toLowerCase() !== root.toLowerCase();
    const item = issueRefs(p.body, root, repo)[0] ?? (other ? undefined : `pr${String(p.number)}`);
    if (item === undefined || held.has(item)) continue;
    const ref = other ? `${repo}#${String(p.number)}` : `#${String(p.number)}`;
    const s = items.get(item)?.seen || since;
    const approved = p.reviewDecision === "APPROVED";
    const latest = reviewsSince(p, "", author)
      .filter((r) => !approved || r.state !== "APPROVED")
      .map((r) => r.submittedAt)
      .sort()
      .at(-1);
    const reviewed = (latest ?? "") > s;
    const commented = commentsSince(p.comments ?? [], s, approved).length > 0;
    const failed = failedSince(p, s);
    const conflict = p.mergeable === "CONFLICTING" && items.get(item)?.state === "awaiting-merge";
    if (!reviewed && !commented && failed.length === 0 && !conflict) continue;
    const what = [
      ...(reviewed ? ["reviewed; resolve every finding and re-request review"] : []),
      ...(commented ? [`commented${approved ? " after approval" : ""}; answer every comment`] : []),
      ...(failed.length > 0 ? [`checks failed: ${failed.join(", ")}`] : []),
      ...(conflict ? ["approved, now conflicting: rebase"] : []),
    ].join("; ");
    prWork.push(
      `- ${item.startsWith("pr") ? item : `#${item}`} — PR ${ref} ${p.title ?? ""} — ${what} — docs/babysit.md\n  ${p.url ?? ""}`,
    );
  }
  // Items a run parked because the exclusive lock was taken: due again once
  // it is free. `waiting-cluster` is the same state as written before 3.0.0.
  const lockWork = lockFree
    ? [...items.entries()]
        .filter(([k, v]) => (v.state === "waiting-lock" || v.state === "waiting-cluster") && !held.has(k))
        .sort((a, b) => (a[1].seen < b[1].seen ? -1 : a[1].seen > b[1].seen ? 1 : 0))
        .map(([k, v]) => `- #${k} on ${v.branch} — run its exclusive step`)
    : [];
  const blockers = [kit.labelClaimed, kit.labelNeedsInfo, kit.labelFailed];
  const issueWork = snap.handoff
    .filter((i) => !i.labels.some((l) => blockers.includes(l)))
    .filter((i) => !held.has(String(i.number)))
    .toReversed()
    .map((i) => `- #${i.number} ${i.title}\n  ${i.url}`);
  // Work a run started and never finished: claimed, no pull request to show
  // for it, and no live run on it. How often a run has died on it is said,
  // because the second time it is released rather than tried again. With
  // `label_mine` set, a claim is ours only when it carries that too.
  const named = new Set(snap.prs.flatMap((p) => issueRefs(p.body, root, p.repo || root)));
  const mine = kit.labelMine;
  // A parked item whose pull requests all merged or closed, with no session
  // left to see it (its waiter and wake-up gone): release it, at no build cost.
  const openNamed = new Set(
    snap.prs.flatMap((p) =>
      issueRefs(p.body, root, p.repo || root).concat(p.repo && p.repo !== root ? [] : [`pr${String(p.number)}`]),
    ),
  );
  const releaseWork = [...items.entries()]
    .filter(([k, v]) => (v.state === "in-review" || v.state === "awaiting-merge") && !held.has(k) && !openNamed.has(k))
    .map(
      ([k]) =>
        `- ${k.startsWith("pr") ? k : `#${k}`} — its pull request is merged or closed: release the issue — docs/babysit.md`,
    );
  const resumeWork = snap.claimed
    .filter((i) => mine === "" || i.labels.includes(mine))
    .filter((i) => !named.has(String(i.number)))
    .filter((i) => !held.has(String(i.number)))
    .filter(
      (i) =>
        !["waiting-lock", "waiting-cluster", "blocked", "needs-info"].includes(
          items.get(String(i.number))?.state ?? "",
        ),
    )
    .map((i) => {
      const a = items.get(String(i.number))?.abandoned ?? 0;
      return `- #${i.number} ${i.title}${a > 0 ? ` — a run died on it ${a} time(s)` : ""}\n  ${i.url}`;
    });
  return { prWork, lockWork, issueWork, resumeWork, releaseWork };
}

export const precheck: Command = async (deps, _args) => {
  let kit = new Kit(deps);
  const probe = !!deps.env.PRECHECK_PROBE;
  // An interactive instance watches nothing: work reaches it in the direct
  // session alone (docs/direct-session.md), so no occurrence is worth a turn.
  if (kit.cfg.mode() === "interactive") return 1;
  const notes: string[] = [];
  let lockFree = true;
  if (!probe) {
    const rs = new RunState(silenced(deps));
    const abandoned = await rs.sweep(false);
    if (abandoned.length > 0)
      notes.push(
        `A run working on ${abandoned.join(" ")} stopped without finishing (its session is not running any more); its branch and slot hold what it got to.`,
      );
    // a free open slot, or no run starts: a closed one finishes what it holds and takes nothing new
    const taken = new Set(kit.locks.ofKind("slot-").map((h) => h.name.slice("slot-".length)));
    if (kit.openSlots.every((k) => taken.has(k))) return diagnostic(deps, kit);
    lockFree = kit.locks.read("exclusive") === undefined;
  }
  const held = new Set(kit.locks.ofKind("item-").map((h) => h.name.slice("item-".length)));
  if (!kit.repo) {
    // Nothing to work on — CONFIG.md lost or never written. Letting a run
    // through to say so would repeat every ten minutes into a chat nobody
    // reads; the weekly audit's verifier fails the missing key instead.
    const found = repoFromCheckouts(kit);
    if (!found) return 1;
    kit = new Kit(deps, found);
  }
  const repo = kit.repo;
  // The login onboarding recorded, else whoever the token belongs to. `@me` is
  // the last resort: a token without user scope cannot answer it at all.
  let author = kit.author;
  if (!author) author = str(obj(await deps.github.get(kit.host, "user")).login);
  author ||= "@me";
  let snap: Snapshot;
  try {
    snap = await readGitHub(kit, author);
  } catch (e) {
    deps.io.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (snap.restBecause !== undefined)
    notes.push(
      `GitHub's GraphQL budget would not answer (${snap.restBecause.replaceAll("\n", " ").slice(0, 160)}), so this list was read over REST. Prefer \`gh api\` (REST) to \`gh pr\` / \`gh issue\` this run.`,
    );
  const w = worklist(kit, snap, readItems(kit.items), held, deps.env.PLATFORM_LAST_RUN_AT ?? "", author, lockFree);
  if (w.prWork.length + w.lockWork.length + w.issueWork.length + w.resumeWork.length + w.releaseWork.length === 0)
    return 1;
  const o = (s: string) => deps.io.out(s);
  o(`Repository: ${repo}`);
  o("Take the first item below that `run-state.sh start` gives you, and that one alone; another run takes the next.");
  if (notes.length > 0) {
    o("");
    o(notes.join("\n"));
  }
  const section = (title: string, lines: string[]) => {
    if (lines.length === 0) return;
    o("");
    o(title);
    o(lines.join("\n"));
  };
  section("Your open pull requests needing attention:", w.prWork);
  section("Merged or closed while parked — release:", w.releaseWork);
  section("Waiting for the exclusive lock, which is free now:", w.lockWork);
  section("Claimed, with no pull request and no run on it — finish or release:", w.resumeWork);
  section(`Unclaimed issues labelled ${kit.labelHandoff}, oldest first:`, w.issueWork);
  return 0;
};

/** Every slot held: decline, unless a holder is silent — then, once per backoff window, a diagnostic run. */
function diagnostic(deps: Deps, kit: Kit): number {
  const quiet: string[] = [];
  new RunState({ ...deps, io: { out: (s) => quiet.push(s), err: () => {} } }).quiet();
  if (quiet.length === 0) return 1;
  const n = Number(kv(kit.gate, "diagnoses") || 0);
  let waitMin = 60;
  for (let i = 0; i < n && waitMin < 1440; i++) waitMin *= 2;
  waitMin = Math.min(waitMin, 1440);
  const last = epoch(kv(kit.gate, "diagnosed_at"));
  if (last !== undefined && Math.floor((nowSeconds(deps.clock) - last) / 60) < waitMin) return 1;
  new RunState(silenced(deps)).diagnosed();
  const o = (s: string) => deps.io.out(s);
  o("DIAGNOSTIC RUN — do not build, do not start an item, do not take new work.");
  o("");
  o(
    `Every open slot (${kit.openSlots.length} of ${kit.slotCount}) is held, and these runs have shown no sign of life for ${kit.cfg.get("stuck_after_min") || "120"} minutes or more:`,
  );
  for (const q of quiet) o(`- ${q}`);
  o("");
  o("Find out what is holding them and report — docs/diagnostic-run.md.");
  return 0;
}

function repoFromCheckouts(kit: Kit): string {
  let names: string[] = [];
  try {
    names = readdirSync(kit.work);
  } catch {
    return "";
  }
  for (const n of names) {
    const dir = join(kit.work, n);
    if (!kit.git.isRepo(dir) || n === "slots" || n === "also") continue;
    const url = kit.git.line(dir, ["config", "--get", "remote.origin.url"]);
    const slug = url.replace(/^(git@github\.com:|https:\/\/github\.com\/)/, "").replace(/\.git$/, "");
    if (slug) return slug;
  }
  return "";
}

const silenced = (deps: Deps): Deps => ({ ...deps, io: { out: () => {}, err: () => {} } });
