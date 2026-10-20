// audit — the deterministic half of the weekly audit (docs/audit.md).
//
// Read-only toward GitHub and repair-free: it prints `ok`/`warn`/`FAIL` lines
// and the week in numbers, and the agent adds the checks only it can make
// (schedules over MCP, the cause behind each abandoned run) before reporting.
// It runs verify --live first: the structure, the access and the precheck's
// health are exactly what an instance nobody watches drifts out of.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { splitRepo } from "../factory/config.ts";
import type { Command } from "../factory/context.ts";
import { readText } from "../factory/kv.ts";
import { iso, nowSeconds } from "../factory/time.ts";
import { Kit } from "./kit.ts";
import { precheck } from "./precheck.ts";
import { verify } from "./verify.ts";

/** The week's TICK.log lines: each starts with a fixed-width UTC time, so a string comparison orders them. */
export function weekLines(log: string, cutoff: string): string[] {
  return log.split("\n").filter((l) => l !== "" && (l.split(" ")[0] ?? "") > cutoff);
}

export const audit: Command = async (deps) => {
  const o = (s: string) => deps.io.out(s);
  await verify(deps, ["--live"]);
  const kit = new Kit(deps);
  const cutoff = iso(new Date((nowSeconds(deps.clock) - 7 * 86400) * 1000));
  o("");
  o("== the week");
  const week = weekLines(readText(kit.log), cutoff);
  if (week.length === 0) o("runs: none closed this week");
  else {
    const counts = new Map<string, number>();
    for (const l of week) {
      const outcome = l.split(" ")[1] ?? "";
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    o(
      `runs: ${[...counts.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `${k}: ${v}`)
        .join(" ")}`,
    );
    const mins = week
      .flatMap((l) => [...(/minutes=([0-9]+)/.exec(l) ?? [])].slice(1))
      .map(Number)
      .sort((a, b) => a - b);
    if (mins.length > 0)
      o(`minutes per run: median ${mins[Math.floor((mins.length + 1) / 2) - 1]}, longest ${mins.at(-1)}`);
  }
  const abandoned = week.filter((l) => l.includes(" abandoned "));
  if (abandoned.length === 0) o("ok   runs.abandoned — none");
  else
    o(
      `warn runs.abandoned — ${abandoned.length} run(s) ended without closing their record: ${abandoned
        .map((l) => `${/session=\S+/.exec(l)?.[0] ?? ""} `)
        .join("")}`,
    );
  // How often the session that wrote a change was the one woken to answer what
  // landed on it, and how often a fresh run had to take it over without that
  // context. A fresh one after a parked item is a waiter lost to a restart.
  const resumed = week.filter((l) => l.split(" ")[1] === "resumed");
  if (resumed.length > 0) {
    const by = (c: string) => resumed.filter((l) => new RegExp(`cause=${c}( |$)`).test(l)).length;
    const continued = resumed.length - by("fresh");
    o(
      `resumes: ${continued} continued in their own session (waiter ${by("waiter")}, booked wake-up ${by("booking")}, a person ${by("operator")}), ${by("fresh")} taken over by a fresh one`,
    );
    if (by("fresh") > continued)
      o(`warn runs.resumed — most resumes lost their context: ${by("fresh")} of ${resumed.length} started fresh`);
  }
  const diag = week.filter((l) => l.includes(" diagnostic ")).length;
  if (diag === 0) o("ok   runs.diagnostic — the sandbox never read stuck");
  else o(`warn runs.diagnostic — ${diag} diagnostic run(s): the sandbox read stuck`);
  if (kit.repo && kit.author) {
    // Your pull requests waiting on review for more than a week. A listing
    // that failed is "not measured", never "none".
    const q = `repo:${kit.slug} is:pr is:open author:${kit.author}${kit.labelMine ? ` label:"${kit.labelMine}"` : ""}`;
    const found = (await deps.github.get(kit.host, `search/issues?q=${encodeURIComponent(q)}&per_page=100`)) as
      | { items?: { number: number; created_at: string; pull_request?: unknown }[] }
      | undefined;
    if (found?.items === undefined) o("warn prs.waiting — not measured: could not list pull requests");
    else {
      const stale: string[] = [];
      for (const it of found.items.filter((i) => i.created_at < cutoff)) {
        const view = (await deps.github.prView(kit.host, kit.slug, it.number, "reviewDecision")) as
          | { reviewDecision?: string }
          | undefined;
        if (view?.reviewDecision !== "APPROVED") stale.push(`#${it.number}`);
      }
      o(
        stale.length === 0
          ? "ok   prs.waiting — none older than a week without approval"
          : `warn prs.waiting — older than a week, not approved: ${stale.join(" ")}`,
      );
    }
    // Work a run left claimed with no pull request: the precheck's own resume
    // list, read without a gate and without claiming.
    const lines: string[] = [];
    const rc = await precheck(
      { ...deps, env: { ...deps.env, PRECHECK_PROBE: "1" }, io: { out: (s) => lines.push(s), err: () => {} } },
      [],
    );
    if (rc > 1) o("warn issues.orphaned — not measured: the precheck could not read GitHub");
    else {
      const text = lines.join("\n");
      const at = text.indexOf("Claimed, with no pull request and no run on it");
      const block = at < 0 ? "" : (text.slice(at).split("\n\n")[0] ?? "");
      const resume = [...block.matchAll(/^- (#[0-9]+)/gm)].map((m) => m[1]).join(" ");
      o(
        resume
          ? `warn issues.orphaned — claimed, no pull request: ${resume}`
          : "ok   issues.orphaned — no claimed issue without a pull request",
      );
    }
  }
  // The backup holds the CONFIG.md this instance runs on — the one file
  // nothing else can rebuild. Every closed run pushes it, so a difference is a
  // backup that has been failing.
  const workRepo = kit.cfg.get("work_repo");
  if (workRepo) {
    const w = splitRepo(workRepo);
    const file = (await deps.github.get(w.host, `repos/${w.slug}/contents/CONFIG.md`)) as
      | { content?: string }
      | undefined;
    const held = file?.content ? Buffer.from(file.content, "base64").toString("utf8") : "";
    if (!held) o(`warn backup.config — not measured: could not read CONFIG.md from ${workRepo}`);
    else if (held === kit.cfg.text) o(`ok   backup.config — ${workRepo} holds the current CONFIG.md`);
    else
      o(
        `warn backup.config — ${workRepo} holds another CONFIG.md: the backup is failing — bash $HOME/scripts/work-backup.sh persist says why`,
      );
  }
  const nfs = countNfs(kit.work);
  o(
    nfs === 0
      ? "ok   volume.nfs — no silly-rename leftovers"
      : `warn volume.nfs — ${nfs} .nfs* file(s) under work/: something deleted a file still held open`,
  );
  // The platform seeds $HOME by init and fetch, so origin/HEAD may not exist:
  // ask the remote which branch is its default.
  const git = kit.git;
  const branch = /^ref: refs\/heads\/(\S+)/m.exec(git.text(kit.home, ["ls-remote", "--symref", "origin", "HEAD"]))?.[1];
  if (branch && git.ok(kit.home, ["fetch", "-q", "origin", branch])) {
    const latest = git.text(kit.home, ["show", "FETCH_HEAD:VERSION"]).split("\n")[0] ?? "";
    const here = readText(join(kit.home, "VERSION")).split("\n")[0] ?? "";
    if (!latest) o(`warn definition.version — not measured: ${branch} has no VERSION`);
    else if (latest === here) o(`ok   definition.version — ${here}, the latest`);
    else
      o(
        `warn definition.version — checked out ${here}, latest ${latest}: docs/persistence.md → Definition version & upgrade`,
      );
  } else o("warn definition.version — not measured: could not fetch the definition");
  return 0;
};

function countNfs(dir: string): number {
  let n = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith(".nfs")) n++;
    if (e.isDirectory() && !e.isSymbolicLink()) n += countNfs(join(dir, e.name));
  }
  return n;
}
