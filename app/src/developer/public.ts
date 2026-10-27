// public-check — what a run is about to write on GitHub, read for what must
// stay private (CLAUDE.md → Rules, public; docs/slack.md → What leaves Slack).
//
//   public-check [file…]   each file, or stdin with none
//
// Named shapes only, the way the backup's credential check is: an e-mail
// address, a credential, a one-time code, a Slack id or link, a platform id, a
// UUID, a private address, and any host of the platform's own domain — the
// one `app_url` names, and its siblings. The session link and the
// `<!-- slack-thread: … -->` marker are the two the rules ask for, and are
// read past, as is a line `Environment: <address>` with its
// `<!-- environment: issue-<n> -->` marker (docs/environments.md). Exit 1 names each hit by line, a credential never by its value;
// any other URL is listed as a note, for the run to judge, and leaves exit 0.
// What a shape cannot see — a paraphrase, a name, a quote — stays judgment.
import type { Command } from "../factory/context.ts";
import { readText } from "../factory/kv.ts";
import { SECRET } from "./backup.ts";
import { Kit } from "./kit.ts";

const SHAPES: readonly (readonly [string, RegExp])[] = [
  // the reserved example domains (RFC 2606) are placeholders already
  [
    "e-mail address",
    /[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*\b(example\.(com|org|net)|example|test|invalid)\b)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  ],
  ["one-time code", /\b(?=[A-Z0-9]{0,3}[A-Z])[A-Z0-9]{4}-[A-Z0-9]{4}\b/g],
  ["Slack link", /\b[a-z0-9-]+\.slack\.com\/archives\/\S*/gi],
  ["Slack id", /<[@#!][A-Z0-9]+(\|[^>]*)?>|\b[UWC](?=[A-Z0-9]*[0-9])[A-Z0-9]{8,11}\b/g],
  ["UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ["platform id", /\b[a-z]{2,12}-(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/g],
  [
    "private address",
    /\b10(\.[0-9]{1,3}){3}\b|\b192\.168(\.[0-9]{1,3}){2}\b|\b172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2}\b/g,
  ],
  ["internal host", /\b[a-z0-9.-]+\.(internal|corp|lan)\b/gi],
];

const URL = /https?:\/\/([^/\s)>\]"'`]+)\S*/gi;
const HOST = /\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/gi;
const PUBLIC_HOST = /(^|\.)(github\.com|githubusercontent\.com|slack\.com)$/i;
const MARKER = /<!-- slack-thread: [A-Z0-9]+ [0-9]+\.[0-9]+ -->|<!-- environment: issue-[0-9]+ -->/g;
/** The pull request's link to its Environment (docs/environments.md), on a line of its own. */
const ENVIRONMENT_LINE = /^Environment: https:\/\/\S+$/;

export interface Hit {
  readonly line: number;
  readonly kind: string;
  /** What matched; "" for a credential, which is never printed. */
  readonly text: string;
}

/** The hits in a text, and the URLs to other hosts, for `app_url`'s link to this agent. */
export function scan(text: string, appUrl: string): { hits: Hit[]; notes: Hit[] } {
  const hits: Hit[] = [];
  const notes: Hit[] = [];
  let host = "";
  try {
    host = appUrl ? new globalThis.URL(appUrl).hostname.toLowerCase() : "";
  } catch {
    host = "";
  }
  // the platform's own domain: its host less the first label, when three labels are left —
  // dev.apps.acme.example's siblings, never all of example.com
  const domain = host.split(".").slice(1);
  const own = (h: string) =>
    host !== "" && (h === host || h.endsWith(`.${host}`) || (domain.length >= 3 && h.endsWith(`.${domain.join(".")}`)));
  const link = appUrl
    ? new RegExp(
        `${appUrl.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/a/[a-z0-9-]+(\\?s=[0-9a-f-]{36})?`,
        "g",
      )
    : undefined;
  text.split("\n").forEach((raw, i) => {
    let line = (link ? raw.replace(link, " ") : raw).replace(MARKER, " ");
    if (ENVIRONMENT_LINE.test(line.trim())) return;
    if (SECRET.test(line)) hits.push({ line: i + 1, kind: "credential", text: "" });
    // each match is cut out as it is found: an id inside a Slack link is the link's hit alone
    for (const [kind, re] of SHAPES)
      line = line.replace(re, (m) => {
        hits.push({ line: i + 1, kind, text: m });
        return " ";
      });
    for (const m of line.matchAll(HOST))
      if (own(m[0].toLowerCase())) hits.push({ line: i + 1, kind: "internal host", text: m[0] });
    for (const m of line.matchAll(URL)) {
      const h = (m[1] ?? "").replace(/:[0-9]+$/, "").toLowerCase();
      if (!own(h) && !PUBLIC_HOST.test(h)) notes.push({ line: i + 1, kind: "URL", text: m[0] });
    }
  });
  return { hits, notes };
}

export const publicCheck: Command = async (deps, args) => {
  const appUrl = new Kit(deps).cfg.get("app_url");
  const inputs = args.length === 0 ? [["stdin", deps.stdin()] as const] : args.map((f) => [f, readText(f)] as const);
  let found = 0;
  for (const [name, text] of inputs) {
    const { hits, notes } = scan(text, appUrl);
    found += hits.length;
    for (const h of hits) deps.io.out(`${name}:${h.line} ${h.kind}${h.text ? `: ${h.text}` : ""}`);
    for (const n of notes) deps.io.out(`${name}:${n.line} note — a URL, public only if anyone may open it: ${n.text}`);
  }
  if (found === 0) {
    deps.io.out("clean: no private shape found — a paraphrase, a name or a quote is still yours to judge");
    return 0;
  }
  deps.io.err(
    `${found} private shape(s): rewrite each with a placeholder (<host>, <user>, <code>, <id>) and check again`,
  );
  return 1;
};
