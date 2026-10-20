// A pull request's state, in the shape `gh pr view --json` gives it, read
// over GraphQL or rebuilt from REST; and what a babysitting run makes of it.
import { login } from "../factory/github.ts";

export interface Review {
  readonly author: { readonly login: string };
  readonly state: string;
  readonly submittedAt: string;
}

/** A check run (name …) or a commit status (context …), as statusCheckRollup lists them. */
export interface Check {
  readonly name?: string;
  readonly context?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface PullState {
  readonly number?: number;
  readonly title?: string;
  readonly url?: string;
  readonly body?: string;
  readonly repo?: string;
  readonly state?: string;
  readonly mergeable?: string;
  readonly reviewDecision?: string | null;
  readonly headRefOid?: string;
  readonly latestReviews: readonly Review[];
  readonly statusCheckRollup: readonly Check[];
  /** Read off REST alone: its review decision may word a verdict, never decide that one is done. */
  readonly approximate?: boolean;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * REST's pull request, reviews, check runs and combined status, as `gh pr
 * view --json` spells them. REST has no review decision: this one is read off
 * the reviews alone — no required count, no code owners — so it is marked
 * approximate.
 */
export function restPull(pull: unknown, reviews: unknown, checks: unknown, status: unknown): PullState {
  const p = obj(pull);
  const latestBy = new Map<string, Json>();
  for (const r of arr(reviews).map(obj)) {
    if (r.state === "PENDING") continue;
    const who = login(str(obj(r.user).login));
    const prev = latestBy.get(who);
    if (!prev || str(r.submitted_at) >= str(prev.submitted_at)) latestBy.set(who, r);
  }
  const latest: Review[] = [...latestBy.values()].map((r) => ({
    author: { login: str(obj(r.user).login) },
    state: str(r.state),
    submittedAt: str(r.submitted_at),
  }));
  const states = latest.map((r) => r.state);
  const decision = states.includes("CHANGES_REQUESTED")
    ? "CHANGES_REQUESTED"
    : states.includes("APPROVED")
      ? "APPROVED"
      : "REVIEW_REQUIRED";
  const runsByName = new Map<string, Json>();
  for (const c of arr(obj(checks).check_runs).map(obj)) {
    const prev = runsByName.get(str(c.name));
    if (!prev || Number(c.id) >= Number(prev.id)) runsByName.set(str(c.name), c);
  }
  const rollup: Check[] = [
    ...[...runsByName.values()].map((c) => ({
      name: str(c.name),
      status: str(c.status).toUpperCase(),
      conclusion: str(c.conclusion).toUpperCase(),
      startedAt: str(c.started_at),
      completedAt: str(c.completed_at),
    })),
    ...arr(obj(status).statuses)
      .map(obj)
      .map((s) => ({ context: str(s.context), state: str(s.state).toUpperCase(), startedAt: str(s.created_at) })),
  ];
  return {
    number: Number(p.number),
    title: str(p.title),
    url: str(p.html_url),
    body: str(p.body),
    repo: str(obj(obj(p.base).repo).full_name),
    state: p.merged_at ? "MERGED" : p.state === "closed" ? "CLOSED" : "OPEN",
    mergeable: p.mergeable === true ? "MERGEABLE" : p.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    headRefOid: str(obj(p.head).sha),
    reviewDecision: decision,
    latestReviews: latest,
    statusCheckRollup: rollup,
    approximate: true,
  };
}

/** A check's outcome, whichever field carries it. */
export function outcome(c: Check): string {
  return c.conclusion || c.state || "";
}

const FAILED = /^(FAILURE|ERROR|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED)$/;
const FAILED_OR_CANCELLED = /^(FAILURE|ERROR|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED|CANCELLED)$/;

/** The checks that failed after `since`, by name: what the precheck wakes a run for. */
export function failedSince(pr: PullState, since: string, withCancelled = false): string[] {
  const re = withCancelled ? FAILED_OR_CANCELLED : FAILED;
  return pr.statusCheckRollup
    .filter((c) => re.test(outcome(c)) && (c.completedAt || c.startedAt || "") > since)
    .map((c) => c.name || c.context || "");
}

/** Reviews by anyone but `author`, submitted after `since`. */
export function reviewsSince(pr: PullState, since: string, author: string): Review[] {
  return pr.latestReviews.filter((r) => login(r.author.login) !== login(author) && r.submittedAt > since);
}

export type Verdict =
  | { readonly act: true; readonly text: string; readonly done: boolean }
  | { readonly act: false; readonly text: string };

/**
 * What a babysitting run makes of its pull request: something to do now
 * (`act`), or nothing yet. Approved ends the review: a review on an approved
 * pull request is not a round, only a failed check or a conflict is — or a
 * review the REST fallback could not weigh against the decision.
 */
export function verdict(pr: PullState, since: string, author: string): Verdict {
  const fresh = reviewsSince(pr, since, author);
  const failed = failedSince(pr, since, true);
  const green = pr.statusCheckRollup.every((c) => /^(SUCCESS|SKIPPED|NEUTRAL)$/.test(outcome(c)));
  const approved = pr.reviewDecision === "APPROVED";
  const act = (text: string, done = false): Verdict => ({ act: true, text, done });
  const wait = (text: string): Verdict => ({ act: false, text });
  if (pr.state === "MERGED") return act("merged — the pull request is merged: release the issue", true);
  if (pr.state === "CLOSED") return act("closed — closed without merging: read why, release the issue");
  if (failed.length > 0) return act(`checks failed: ${failed.join(", ")}`);
  if (fresh.length > 0 && (!approved || pr.approximate)) {
    const who = [...new Set(fresh.map((r) => r.author.login))].sort().join(", ");
    const what = [...new Set(fresh.map((r) => r.state))].sort().join(", ");
    return act(`reviewed by ${who} (${what}): resolve every finding`);
  }
  if (pr.mergeable === "CONFLICTING") return act("conflicts with the base branch: rebase");
  if (approved && green && pr.approximate)
    return wait("approved by its reviews and green; GitHub's review decision is unreadable (GraphQL), so not yet done");
  if (approved && green && pr.mergeable === "MERGEABLE")
    return act("done — approved, green and mergeable: release the issue", true);
  if (approved && green) return wait("approved and green; GitHub is still computing mergeability");
  if (green) return wait("green, waiting for a review");
  return wait("checks running");
}

/** A pull request named by a run: `#<n>` or `<n>` in `repo`, `<owner/name>#<n>` elsewhere. */
export interface PrRef {
  readonly slug: string;
  readonly number: number;
}

export function parsePrRef(ref: string, root: string): PrRef | undefined {
  const r = ref.replace(/^#/, "");
  const m = /^([^#\s]+\/[^#\s]+)#([0-9]+)$/.exec(r);
  if (m?.[1] && m[2]) return { slug: m[1], number: Number(m[2]) };
  if (/^[0-9]+$/.test(r)) return { slug: root, number: Number(r) };
  return undefined;
}

/** How a pull request is written in an item's record and a log line: `21`, or `owner/name#30`. */
export function recordRef(p: PrRef, root: string): string {
  return p.slug === root ? String(p.number) : `${p.slug}#${p.number}`;
}

/** How it is said to a person: `#21`, or `owner/name#30`. */
export function labelRef(p: PrRef, root: string): string {
  return p.slug === root ? `#${p.number}` : `${p.slug}#${p.number}`;
}
