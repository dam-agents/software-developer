// The issues' Environments, issue-<n>, against the agent's limit
// (docs/environments.md → At the limit). An issue that needs one and finds
// every one held takes one back where it costs the least — one no open pull
// request links, a draft's no run works on, an approved pull request's that
// needs no review in it, then an approved one's whose review is done — or,
// none of those, waits, and the pull requests that hold them are named for a
// person to review or merge. Read here, never deleted here: the app detects,
// the agent acts.
import type { EnvironmentInfo } from "../factory/runtime.ts";
import type { Kit } from "./kit.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const MARKER = /<!-- environment: (issue-[0-9]+) -->/g;

/** An open pull request of yours, as much of it as says what its Environment is for. */
export interface OpenPull {
  readonly number: number;
  readonly body: string;
  readonly draft: boolean;
  readonly approved: boolean;
  readonly labels: readonly string[];
}

/** One Environment of an issue, and the open pull request of yours that links it. */
export interface Holder {
  readonly name: string;
  readonly item: string;
  readonly createdAt: string;
  readonly pr?: { readonly number: number; readonly draft: boolean; readonly approved: boolean; readonly ui: boolean };
}

/** The issues' Environments, each with the open pull request whose body links it. */
export function holdersOf(envs: readonly EnvironmentInfo[], prs: readonly OpenPull[], uiLabel: string): Holder[] {
  const byEnv = new Map<string, OpenPull>();
  for (const p of prs) for (const m of p.body.matchAll(MARKER)) if (m[1]) byEnv.set(m[1], p);
  return envs
    .filter((e) => /^issue-[0-9]+$/.test(e.name))
    .map((e) => {
      const p = byEnv.get(e.name);
      // without label_ui_review, every pull request is reviewed in its Environment
      const pr = p && {
        number: p.number,
        draft: p.draft,
        approved: p.approved,
        ui: uiLabel === "" || p.labels.includes(uiLabel),
      };
      return { name: e.name, item: e.name.slice("issue-".length), createdAt: e.createdAt ?? "", ...(pr ? { pr } : {}) };
    });
}

/**
 * Where taking an Environment back costs least, 0 first, and why; undefined
 * when it may not be. `held`: the items a run holds, working or parked;
 * `working`: those a run works on in a slot now.
 */
export function evictable(
  h: Holder,
  held: ReadonlySet<string>,
  working: ReadonlySet<string>,
): { readonly rank: number; readonly why: string } | undefined {
  if (working.has(h.item)) return undefined;
  if (!h.pr) return held.has(h.item) ? undefined : { rank: 0, why: "no open pull request links it" };
  if (h.pr.draft)
    return held.has(h.item) ? undefined : { rank: 1, why: `#${h.pr.number} is a draft no run is working on` };
  if (!h.pr.approved) return undefined;
  return h.pr.ui
    ? { rank: 3, why: `#${h.pr.number} is approved, its review done` }
    : { rank: 2, why: `#${h.pr.number} is approved and needs no review in it` };
}

/** The Environment cheapest to take back for `item`, oldest first within a rank; undefined when none may be. */
export function cheapest(
  hs: readonly Holder[],
  item: string,
  held: ReadonlySet<string>,
  working: ReadonlySet<string>,
): { readonly victim: Holder; readonly why: string } | undefined {
  return hs
    .flatMap((h) => {
      const e = h.item === item ? undefined : evictable(h, held, working);
      return e ? [{ victim: h, ...e }] : [];
    })
    .sort((a, b) => a.rank - b.rank || (a.victim.createdAt < b.victim.createdAt ? -1 : 1))[0];
}

/** What a person can do about each Environment held: the post's lines. */
export function asks(hs: readonly Holder[]): string[] {
  return hs.map((h) =>
    !h.pr
      ? `${h.name}: a run is working on #${h.item}`
      : h.pr.approved
        ? `#${h.pr.number}: approved — merge it`
        : h.pr.draft
          ? `#${h.pr.number}: a draft a run is working on`
          : `#${h.pr.number}: review it`,
  );
}

/** Your open pull requests in `repo` that link an Environment, the review decision read for each ready one; undefined when unread. */
async function openPulls(kit: Kit): Promise<OpenPull[] | undefined> {
  const q = `repo:${kit.slug} is:pr is:open author:${kit.author || "@me"}`;
  const found = await kit.deps.github.get(kit.host, `search/issues?q=${encodeURIComponent(q)}&per_page=100`);
  if (found === undefined) return undefined;
  const out: OpenPull[] = [];
  for (const p of arr(obj(found).items).map(obj)) {
    const body = str(p.body);
    if (!body.includes("<!-- environment: ")) continue;
    const number = Number(p.number);
    const draft = p.draft === true;
    // the review decision is GraphQL's alone, and only a ready one can be approved
    const approved =
      !draft &&
      obj(await kit.deps.github.prView(kit.host, kit.slug, number, "reviewDecision")).reviewDecision === "APPROVED";
    out.push({ number, body, draft, approved, labels: arr(p.labels).map((l) => str(obj(l).name)) });
  }
  return out;
}

export type Room =
  | { readonly kind: "has" }
  | { readonly kind: "free"; readonly count: number }
  | { readonly kind: "evict"; readonly victim: Holder; readonly why: string }
  | { readonly kind: "full"; readonly holders: readonly Holder[] }
  | { readonly kind: "unread"; readonly why: string };

/** Whether issue `item` may have its Environment now, and what makes room for it. */
export async function room(
  kit: Kit,
  item: string,
  held: ReadonlySet<string>,
  working: ReadonlySet<string>,
): Promise<Room> {
  const envs = await kit.deps.runtime.environments();
  if (envs === undefined) return { kind: "unread", why: "the platform did not list Environments" };
  if (envs.some((e) => e.name === `issue-${item}`)) return { kind: "has" };
  // every Environment counts against the limit, an issue's or not
  if (envs.length < kit.environmentsMax) return { kind: "free", count: envs.length };
  const prs = await openPulls(kit);
  if (prs === undefined) return { kind: "unread", why: "the open pull requests could not be read" };
  const hs = holdersOf(envs, prs, kit.labelUiReview);
  const c = cheapest(hs, item, held, working);
  return c ? { kind: "evict", ...c } : { kind: "full", holders: hs };
}
