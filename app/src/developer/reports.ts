// What a run left on GitHub — read here, never written: the app detects, the
// agent acts. Whether an item is ours to work on, whether a run reported its
// outcome before it gives its item back, and which Slack thread an issue's
// posts reply in.
import { closesRefs, issueRefs, login } from "../factory/github.ts";
import type { Kit, Outcome } from "./kit.ts";
import { labelRef, parsePrRef } from "./pulls.ts";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const labelsOf = (v: unknown): string[] => arr(obj(v).labels).map((l) => str(obj(l).name));

/** ours: the item is ours · another: it is another agent's, and why · unread: GitHub could not be read */
export type Ownership =
  | { readonly kind: "ours" }
  | { readonly kind: "another"; readonly why: string }
  | { readonly kind: "unread" };

/**
 * Whether an item is this agent's to work on, read off GitHub. Agents that
 * share the login share the claimed label too: with `label_mine` set, a claim
 * is ours only when it carries that beside it, and an issue an open pull
 * request names is ours only when that pull request is.
 */
export async function ours(kit: Kit, item: string): Promise<Ownership> {
  const gh = kit.deps.github;
  const mine = kit.labelMine;
  let author = kit.author;
  if (!author) {
    author = str(obj(await gh.get(kit.host, "user")).login);
    if (!author) return { kind: "unread" };
  }
  const another = (why: string): Ownership => ({ kind: "another", why });
  if (item.startsWith("pr")) {
    const pull = await gh.get(kit.host, `repos/${kit.slug}/pulls/${item.slice(2)}`);
    if (pull === undefined) return { kind: "unread" };
    const p = obj(pull);
    if (login(str(obj(p.user).login)) !== login(author))
      return another(`pull request #${String(p.number)} was opened by ${str(obj(p.user).login)}`);
    if (mine && !labelsOf(p).includes(mine)) return another(`pull request #${String(p.number)} does not carry ${mine}`);
    return { kind: "ours" };
  }
  const issue = await gh.get(kit.host, `repos/${kit.slug}/issues/${item}`);
  if (issue === undefined) return { kind: "unread" };
  const labels = labelsOf(issue);
  if (mine && labels.includes(kit.labelClaimed) && !labels.includes(mine))
    return another(`it carries ${kit.labelClaimed} without ${mine}: another agent's claim`);
  const pulls = await gh.getAll(kit.host, `repos/${kit.slug}/pulls?state=open&per_page=100`);
  if (pulls === undefined) return { kind: "unread" };
  const theirs = pulls.map(obj).find((p) => {
    if (!issueRefs(str(p.body), kit.slug, kit.slug).includes(item)) return false;
    const byUs = login(str(obj(p.user).login)) === login(author) && (mine === "" || labelsOf(p).includes(mine));
    return !byUs;
  });
  if (theirs) return another(`pull request #${String(theirs.number)}, not ours, names it`);
  return { kind: "ours" };
}

/** reported · missing: what is missing, to post · unread: GitHub could not be read */
export type Reported =
  | { readonly kind: "reported" }
  | { readonly kind: "missing"; readonly why: string }
  | { readonly kind: "unread" };

/**
 * Nobody watches a run: what it did is known only from what it left on
 * GitHub. A report is a comment on the issue or its pull request, by
 * `author`, written or edited since the run started, carrying this session's
 * id — the session link does — or, for pr-opened, the pull request's own
 * body. The labels must say the outcome.
 */
export async function reported(
  kit: Kit,
  item: string,
  outcome: Outcome,
  prsIn: string,
  since: string,
): Promise<Reported> {
  const gh = kit.deps.github;
  const author = kit.author;
  const mine = kit.labelMine;
  const n = item.startsWith("pr") ? "" : item;
  const prs = item.startsWith("pr") ? prsIn || item.slice(2) : prsIn;
  const missing: string[] = [];
  const refs = (s: string) => s.split(/\s+/).filter((x) => x !== "");
  if (outcome === "pr-opened") {
    if (!prs) return { kind: "missing", why: "pr-opened names no pull request: finish pr-opened <pr>..." };
    let closes = false;
    for (const raw of refs(prs)) {
      const ref = parsePrRef(raw, kit.slug);
      if (!ref) return { kind: "missing", why: `'${raw}' is not a pull request: #<n>, or <owner/name>#<n>` };
      const pull = await gh.get(kit.host, `repos/${ref.slug}/pulls/${ref.number}`);
      if (pull === undefined) return { kind: "unread" };
      const p = obj(pull);
      const other = ref.slug.toLowerCase() !== kit.slug.toLowerCase();
      const body = str(p.body);
      const got: string[] = [];
      if (p.state !== "open") got.push("is not open");
      if (author && login(str(obj(p.user).login)) !== login(author)) got.push(`was not opened by ${author}`);
      if (mine && !labelsOf(p).includes(mine)) got.push(`does not carry ${mine}`);
      if (!body.includes(kit.me)) got.push("carries no session link");
      if (n && !issueRefs(body, kit.slug, ref.slug).includes(n))
        got.push(other ? `does not say Fixes or Part of ${kit.slug}#${n}` : `does not say Fixes #${n}`);
      if (got.length > 0) missing.push(`pull request ${labelRef(ref, kit.slug)} ${got.join(", ")}`);
      if (n && closesRefs(body, kit.slug, ref.slug).includes(n)) closes = true;
    }
    if (n && !closes)
      missing.push(
        `none of them says Fixes #${n} — the one in ${kit.slug} does, or else one of the others, as Fixes ${kit.slug}#${n}`,
      );
  } else {
    let got = false;
    for (const raw of [...(n ? [n] : []), ...refs(prs)]) {
      const ref = parsePrRef(raw, kit.slug);
      if (!ref) return { kind: "missing", why: `'${raw}' is not a pull request: #<n>, or <owner/name>#<n>` };
      const comments = await gh.get(
        kit.host,
        `repos/${ref.slug}/issues/${ref.number}/comments?since=${since}&per_page=100`,
      );
      if (comments === undefined) return { kind: "unread" };
      if (
        arr(comments)
          .map(obj)
          .some((c) => (!author || login(str(obj(c.user).login)) === login(author)) && str(c.body).includes(kit.me))
      ) {
        got = true;
        break;
      }
    }
    if (!got)
      missing.push(
        `no comment from this run on #${n || prs}${prs && n ? ` or its pull request ${prs}` : ""} — say what you did, and what happens next, with this run's session link`,
      );
  }
  if (n && (outcome === "needs-info" || outcome === "blocked" || outcome === "released")) {
    const issue = await gh.get(kit.host, `repos/${kit.slug}/issues/${n}`);
    if (issue === undefined) return { kind: "unread" };
    const labels = labelsOf(issue);
    if (labels.includes(kit.labelClaimed)) missing.push(`#${n} still carries ${kit.labelClaimed}`);
    // the claim is the pair: giving it up drops both
    if (mine && labels.includes(mine)) missing.push(`#${n} still carries ${mine}`);
    if (outcome === "needs-info" && !labels.includes(kit.labelNeedsInfo))
      missing.push(`#${n} does not carry ${kit.labelNeedsInfo}`);
    if (outcome === "blocked" && !labels.includes(kit.labelFailed))
      missing.push(`#${n} does not carry ${kit.labelFailed}`);
  }
  return missing.length === 0 ? { kind: "reported" } : { kind: "missing", why: missing.join("; ") };
}

const THREAD = /<!-- slack-thread: ([A-Z0-9]+) ([0-9]+\.[0-9]+) -->/g;

/**
 * The Slack thread an item's posts go to: the last `<!-- slack-thread: <chat>
 * <ts> -->` that `author` left in the body or a comment of the issue or its
 * pull requests in `repo` (docs/notify.md). None, or GitHub unreadable: "",
 * and the post goes top-level.
 */
export async function slackThread(kit: Kit, itemIn: string, prsIn: string, chat: string): Promise<string> {
  const gh = kit.deps.github;
  const author = kit.author;
  const item = itemIn.startsWith("pr") ? "" : itemIn;
  const prs = itemIn.startsWith("pr") ? prsIn || itemIn.slice(2) : prsIn;
  let ts = "";
  for (const raw of [...(item ? [item] : []), ...prs.split(/\s+/).filter((x) => x !== "")]) {
    const ref = parsePrRef(raw, kit.slug);
    if (!ref || ref.slug !== kit.slug) continue;
    const issue = await gh.get(kit.host, `repos/${ref.slug}/issues/${ref.number}`);
    const comments = await gh.getAll(kit.host, `repos/${ref.slug}/issues/${ref.number}/comments?per_page=100`);
    const posts = [...(issue === undefined ? [] : [issue]), ...(comments ?? [])]
      .map(obj)
      .filter((c) => !author || login(str(obj(c.user).login)) === login(author))
      .sort((a, b) => (str(a.created_at) < str(b.created_at) ? -1 : str(a.created_at) > str(b.created_at) ? 1 : 0));
    let got = "";
    for (const p of posts) {
      const hits = [...str(p.body).matchAll(THREAD)].filter((m) => m[1] === chat);
      const last = hits.at(-1)?.[2];
      if (last) got = last;
    }
    if (got) ts = got;
  }
  return ts;
}
