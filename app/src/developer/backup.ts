// Backs work/ up to `work_repo` and restores it from there — the one place
// the app commits and pushes (docs/self-modification.md §4), and only to that
// repository.
//
//   persist   work/ -> commit -> push; `run-state finish` calls it last
//   restore   the backup -> work/, on a fresh volume (ONBOARDING.md)
//
// What travels is CARRIED, by name, and nothing else: an allowlist, which
// every persist also commits as the backup's .gitignore, so no `git add` in
// the clone can pick up another file. Never a directory — the checkout and its
// worktrees live on GitHub already — and never items/ or GATE.md, which
// describe this sandbox's runs and are rebuilt from GitHub. A README.md or
// LICENSE belongs to the backup repository itself and stays. A carried file
// that looks like it holds a credential stops the push.
//
// All git happens in a clone on tmpfs, never in work/: the home volume is
// virtiofs over NFS, and a .git there corrupts under concurrent runs
// (docs/persistence.md). The clone is scratch, re-seeded from the remote on
// every call, so nothing authoritative ever lives in it.
//
// persist always exits 0: a missed backup is retried by the next run, and the
// state is still in work/. It refuses a snapshot that deletes CONFIG.md or
// shortens an append-only log the backup holds: that work/ was never
// restored, and pushing it would bury the history. WORK_BACKUP_ALLOW_DELETE=1
// is the operator saying the loss is intended.
//
// restore exits 0 restored and verified · 2 nothing to restore (no work_repo,
// an empty remote, or one without CONFIG.md) · 1 failed.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Config } from "../factory/config.ts";
import type { Command, Deps } from "../factory/context.ts";
import { Git } from "../factory/git.ts";
import { readText } from "../factory/kv.ts";
import { iso, nowSeconds } from "../factory/time.ts";

export const CARRIED = ["CONFIG.md", "AGENTS.md", "VERSION", "TICK.log", "AUDIT.log"] as const;
const PROTECTED = ["CONFIG.md"];
const APPEND_ONLY = ["TICK.log", "AUDIT.log"];
const LOCK_TTL_MIN = 10;
const RETRIES = 3;

/** A token, a key or a password assignment. Patterns, not proof: a match names the file, never the match. */
const SECRET =
  /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|(password|passwd|secret|token)[ \t]*[:=][ \t]*[^\s<]{8,}/i;

interface Backup {
  readonly deps: Deps;
  readonly work: string;
  readonly local: string;
  readonly lock: string;
  readonly branch: string;
  readonly remote: string;
  readonly ref: string;
  readonly git: Git;
  readonly say: (s: string) => void;
}

function setup(deps: Deps, say: (s: string) => void): Backup | undefined {
  const env = deps.env;
  const work = join(env.HOME ?? "/home/agent", "work");
  const workRepo = Config.load(work).get("work_repo");
  if (!workRepo) {
    say("no work_repo in work/CONFIG.md — work/ is not backed up.");
    return undefined;
  }
  const ref = workRepo.split("/").length >= 3 ? workRepo : `github.com/${workRepo}`;
  const local = env.WORK_BACKUP_LOCAL || "/dev/shm/software-developer-work";
  return {
    deps,
    work,
    local,
    lock: `${local}.lock`,
    branch: env.WORK_BACKUP_BRANCH || "main",
    remote: env.WORK_BACKUP_REMOTE || `https://${ref}`,
    ref,
    git: new Git(env),
    say,
  };
}

const carried = (dir: string) => CARRIED.filter((f) => existsSync(join(dir, f)));
const lines = (f: string) => (existsSync(f) ? (readText(f).match(/\n/g)?.length ?? 0) : 0);

function gitignore(): string {
  return `# Written by scripts/work-backup.sh on every persist, never by hand.\n/*\n${[".gitignore", "README.md", "LICENSE", ...CARRIED].map((f) => `!/${f}\n`).join("")}`;
}

function git(b: Backup, args: readonly string[]) {
  return b.git.run(b.local, [
    "-c",
    "user.name=software-developer",
    "-c",
    "user.email=software-developer@agents.local",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
}

/** mkdir is atomic; a lock older than the TTL is a crashed persist's, taken over by rename, which one taker wins. */
function takeLock(b: Backup): boolean {
  try {
    mkdirSync(b.lock);
    return true;
  } catch {
    // held: stale?
  }
  try {
    const age = (nowSeconds(b.deps.clock) - Math.floor(statSync(b.lock).mtimeMs / 1000)) / 60;
    if (age <= LOCK_TTL_MIN) return false;
    const stale = `${b.lock}.stale.${process.pid}`;
    renameSync(b.lock, stale);
    rmSync(stale, { recursive: true, force: true });
    mkdirSync(b.lock);
    return true;
  } catch {
    return false;
  }
}

/** The clone, on the remote's tip, or a new repository when the remote has no branch yet. */
function seed(b: Backup): boolean {
  if (!b.git.ok(b.local, ["rev-parse", "--git-dir"]) || !existsSync(join(b.local, ".git"))) {
    rmSync(b.local, { recursive: true, force: true });
    mkdirSync(b.local, { recursive: true });
    if (!b.git.ok(b.local, ["init", "-q"]) || !b.git.ok(b.local, ["remote", "add", "origin", b.remote])) return false;
  }
  b.git.run(b.local, ["remote", "set-url", "origin", b.remote]);
  if (b.git.ok(b.local, ["fetch", "-q", "origin", b.branch])) {
    return b.git.ok(b.local, ["checkout", "-q", "-f", "-B", b.branch, "FETCH_HEAD"]);
  }
  if (b.git.ok(b.local, ["ls-remote", "origin"])) {
    b.git.run(b.local, ["checkout", "-q", "-f", "--orphan", b.branch]);
    b.git.run(b.local, ["rm", "-rq", "--cached", "."]);
    return true;
  }
  return false;
}

function persist(b: Backup): void {
  if (!takeLock(b)) {
    b.say("another persist is running — skipping; the next run backs up what it misses.");
    return;
  }
  try {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      if (!seed(b)) {
        b.say(`could not reach ${b.ref} (attempt ${attempt}).`);
        continue;
      }
      const gone: string[] = [];
      if (b.deps.env.WORK_BACKUP_ALLOW_DELETE !== "1") {
        for (const f of PROTECTED) if (existsSync(join(b.local, f)) && !existsSync(join(b.work, f))) gone.push(f);
        for (const f of APPEND_ONLY) if (lines(join(b.work, f)) < lines(join(b.local, f))) gone.push(f);
      }
      const leak = carried(b.work).filter((f) => SECRET.test(readFileSync(join(b.work, f), "utf8")));
      if (leak.length > 0) {
        b.say(
          `refused: what looks like a credential is in ${leak.join(" ")} — remove it from work/; nothing was pushed.`,
        );
        return;
      }
      if (gone.length > 0) {
        b.say(
          `refused: work/ would lose ${gone.join(" ")} the backup holds — it looks unrestored; restore it first (docs/persistence.md → Backup).`,
        );
        return;
      }
      // mirror: what left work/ leaves the backup, what is in work/ is copied in
      for (const f of carried(b.local)) rmSync(join(b.local, f), { force: true });
      for (const f of carried(b.work)) copyFileSync(join(b.work, f), join(b.local, f));
      writeFileSync(join(b.local, ".gitignore"), gitignore());
      if (git(b, ["add", "-A"]).code !== 0) continue;
      if (git(b, ["diff", "--cached", "--quiet"]).code === 0) {
        b.say("nothing to back up.");
        return;
      }
      if (git(b, ["commit", "-qm", `chore(work): back up work/ ${iso(b.deps.clock.now())}`]).code !== 0) continue;
      if (git(b, ["push", "-q", "origin", `HEAD:refs/heads/${b.branch}`]).code === 0) {
        b.say(`backed up to ${b.ref}.`);
        return;
      }
      b.say(`push to ${b.ref} rejected (attempt ${attempt}) — retrying from its new tip.`);
    }
    b.say(`gave up after ${RETRIES} attempts; work/ is intact and the next run retries.`);
  } finally {
    rmSync(b.lock, { recursive: true, force: true });
  }
}

async function restore(b: Backup): Promise<number> {
  let held = false;
  for (let w = 0; w < 5 && !held; w++) {
    held = takeLock(b);
    if (!held) await b.deps.clock.sleep(1);
  }
  try {
    const heads = b.git.run(dirname(b.work), ["ls-remote", b.remote, `refs/heads/${b.branch}`]);
    if (heads.code !== 0) {
      b.say(`could not reach ${b.ref} — work/ left as it is.`);
      return 1;
    }
    if (heads.stdout.trim() === "") {
      b.say(`${b.ref} is empty — nothing to restore.`);
      return 2;
    }
    rmSync(b.local, { recursive: true, force: true });
    if (b.git.run(dirname(b.work), ["clone", "-q", "--branch", b.branch, b.remote, b.local]).code !== 0) {
      b.say(`could not clone ${b.ref} — work/ left as it is.`);
      return 1;
    }
    if (!existsSync(join(b.local, "CONFIG.md"))) {
      b.say(`${b.ref} holds no CONFIG.md — nothing to restore.`);
      return 2;
    }
    mkdirSync(b.work, { recursive: true });
    const files = carried(b.local);
    let bad = 0;
    for (const f of files) {
      try {
        copyFileSync(join(b.local, f), join(b.work, f));
        if (!readFileSync(join(b.local, f)).equals(readFileSync(join(b.work, f)))) bad++;
      } catch {
        bad++;
      }
    }
    if (bad === 0) {
      b.say(`restored ${files.length} file(s) from ${b.ref}.`);
      return 0;
    }
    b.say(`restore incomplete: ${bad} of ${files.length} file(s) did not arrive intact.`);
    return 1;
  } finally {
    if (held) rmSync(b.lock, { recursive: true, force: true });
  }
}

/** persist, as `run-state finish` calls it: its lines on stderr, never failing the run. */
export function persistTo(deps: Deps): void {
  const say = (s: string) => deps.io.err(`work-backup: ${s}`);
  const b = setup(deps, say);
  if (b) persist(b);
}

export const workBackup: Command = async (deps, args) => {
  const mode = args[0] ?? "";
  if (mode !== "persist" && mode !== "restore") {
    deps.io.err("usage: work-backup.sh persist|restore");
    return 2;
  }
  const say = (s: string) => deps.io.out(`work-backup: ${s}`);
  const b = setup(deps, say);
  if (!b) return mode === "restore" ? 2 : 0;
  if (mode === "persist") {
    persist(b);
    return 0;
  }
  return restore(b);
};
