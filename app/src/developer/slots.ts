// The slots: worktrees of the checkout at work/slots/<k> (and of another
// repository's at work/also/<name>/<k>), created on first use and never
// removed, because what they keep is the build output. Putting a slot on a
// branch never throws work away: anything not on GitHub stops it, and the run
// is told to save it.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Git } from "../factory/git.ts";
import { isDir } from "../factory/locks.ts";

export type Prepared = { readonly ok: true } | { readonly ok: false; readonly code: 1 | 3 };

export interface PrepareArgs {
  readonly git: Git;
  readonly work: string;
  readonly locksDir: string;
  readonly say: (s: string) => void;
  /** The slot number, its branch, the checkout it is a worktree of, and the directory slots of that checkout live in. */
  readonly k: string;
  readonly branch: string;
  readonly checkout: string;
  readonly base: string;
}

/**
 * Puts slot `k` on `branch`: the remote's tip when it has one, else new from
 * the default branch. Ignored files — the build output — stay; untracked ones
 * go, so nothing strays into the next item's commit. 1 failed · 3 something
 * unsaved is in the way, and the run is to save it.
 */
export function prepare(a: PrepareArgs): Prepared {
  const { git, say, k, branch: b, checkout: co, base } = a;
  const d = join(base, k);
  mkdirSync(base, { recursive: true });
  if (!git.ok(co, ["fetch", "-q", "--prune", "origin"])) {
    say(`git fetch failed in ${relative(a.work, co)}`);
    return { ok: false, code: 1 };
  }
  const dflt = git.defaultBranch(co);
  // the checkout itself stays on the default branch, kept current: its skills
  // are the ones every run loads (scripts/harness/claude-code/install.sh)
  if (git.branch(co) === dflt && git.unsaved(co) === "") git.run(co, ["merge", "-q", "--ff-only", `origin/${dflt}`]);
  if (!git.isRepo(d) && !git.ok(co, ["worktree", "add", "-q", "--detach", d, `origin/${dflt}`])) {
    say(`could not create slot ${k} at ${d}`);
    return { ok: false, code: 1 };
  }
  const why = git.unsaved(d);
  if (why) {
    say(`slot ${k} has ${why} on ${git.abbrevHead(d)} — a run that ended without pushing.`);
    say(
      `In ${d}, commit and push it to its branch (or to wip/<issue> when it is not yours to finish), then start again.`,
    );
    return { ok: false, code: 3 };
  }
  // a branch is checked out in one worktree at a time: a free, saved slot that
  // still has it lets go of it
  for (const name of safeList(base)) {
    const other = join(base, name);
    if (other === d || !isDir(other) || git.abbrevHead(other) !== b) continue;
    if (git.unsaved(other) !== "" || isDir(join(a.locksDir, `slot-${basename(other)}`))) {
      say(`branch ${b} is checked out in ${other}, which is in use or holds unsaved work.`);
      return { ok: false, code: 3 };
    }
    git.run(other, ["switch", "-q", "--detach"]);
  }
  if (git.hasRef(co, `refs/remotes/origin/${b}`)) {
    if (
      git.hasRef(co, `refs/heads/${b}`) &&
      git.line(co, ["log", "--oneline", `refs/heads/${b}`, "--not", "--remotes"]) !== ""
    ) {
      say(`local branch ${b} has commits not on origin — push them before starting on it.`);
      return { ok: false, code: 3 };
    }
    if (!git.ok(d, ["switch", "-q", "-C", b, `origin/${b}`])) return { ok: false, code: 1 };
  } else if (git.hasRef(co, `refs/heads/${b}`)) {
    if (!git.ok(d, ["switch", "-q", b])) return { ok: false, code: 1 };
  } else if (!git.ok(d, ["switch", "-q", "-c", b, `origin/${dflt}`])) return { ok: false, code: 1 };
  git.run(d, ["clean", "-fdq"]);
  return { ok: true };
}

/** Another repository's worktrees for slot `k`: work/also/<name>/<k>, those that exist. */
export function alsoDirs(git: Git, work: string, k: string): string[] {
  const also = join(work, "also");
  return safeList(also)
    .map((name) => join(also, name, k))
    .filter((d) => git.isRepo(d));
}

function safeList(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  } catch {
    return [];
  }
}
