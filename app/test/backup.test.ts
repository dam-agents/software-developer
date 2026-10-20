// work-backup: what travels, what never does, and a backup that is never
// overwritten by a work/ that was not restored.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { workBackup } from "../src/developer/backup.ts";
import { runState } from "../src/developer/run-state.ts";
import { inSandbox, type Sandbox } from "./helpers.ts";

/** A sandbox whose work_repo is a local bare repository. */
function backed(s: Sandbox): void {
  s.config("- work_repo: acme/widgets-work");
  s.git(["init", "-q", "--bare", join(s.home, "remote.git")]);
  mkdirSync(join(s.home, "shm"));
  s.env.WORK_BACKUP_REMOTE = join(s.home, "remote.git");
  s.env.WORK_BACKUP_LOCAL = join(s.home, "shm/clone");
}
const backup = (s: Sandbox, mode: string, env: Record<string, string> = {}) => s.run(workBackup, [mode], env);
const files = (s: Sandbox) =>
  s
    .git(["-C", join(s.home, "remote.git"), "ls-tree", "--name-only", "main"])
    .stdout.split("\n")
    .filter(Boolean)
    .join(" ");
const commits = (s: Sandbox) =>
  Number(s.git(["-C", join(s.home, "remote.git"), "rev-list", "--count", "main"]).stdout.trim() || 0);
const w = (s: Sandbox, f: string, text: string) => writeFileSync(join(s.work, f), text);

test("without work_repo, nothing is backed up", () =>
  inSandbox(async (s) => {
    let r = await backup(s, "persist");
    assert.equal(r.rc, 0);
    assert.match(r.out, /no work_repo/);
    r = await backup(s, "restore");
    assert.equal(r.rc, 2);
  }));

test("persist carries work/'s files, and nothing else", () =>
  inSandbox(async (s) => {
    backed(s);
    w(s, "TICK.log", "1 line\n");
    w(s, "VERSION", "v\n");
    w(s, "RUN.md", "- run_state: idle\n");
    w(s, "GATE.md", "- busy_since: x\n");
    w(s, ".RUN.md.abc", "tmp\n");
    mkdirSync(join(s.work, "widgets/.git"), { recursive: true });
    w(s, "widgets/f", "x\n");
    w(s, "notes.txt", "stray\n");
    s.item("7", {});
    let r = await backup(s, "persist");
    assert.equal(r.rc, 0);
    assert.match(r.out, /backed up/);
    assert.equal(files(s), ".gitignore CONFIG.md TICK.log VERSION", "only the allowlist travels");
    assert.match(s.git(["-C", join(s.home, "remote.git"), "show", "main:.gitignore"]).stdout, /^\/\*$/m);
    assert.ok(!existsSync(join(s.work, ".git")), "made work/ a git repository");
    r = await backup(s, "persist");
    assert.match(r.out, /nothing to back up/);
    assert.equal(commits(s), 1);
    w(s, "TICK.log", "1 line\n2 line\n");
    rmSync(join(s.work, "VERSION"));
    await backup(s, "persist");
    assert.equal(commits(s), 2, "a change is a new commit");
    assert.equal(files(s), ".gitignore CONFIG.md TICK.log", "a file gone from work/ leaves the backup");
  }));

test("a work/ that was never restored does not overwrite the backup", () =>
  inSandbox(async (s) => {
    backed(s);
    w(s, "TICK.log", "a\nb\n");
    await backup(s, "persist");
    w(s, "TICK.log", "a\n");
    const r = await backup(s, "persist");
    assert.equal(r.rc, 0);
    assert.match(r.out, /refused/);
    assert.match(r.out, /TICK\.log/);
    assert.equal(commits(s), 1, "nothing pushed");
    await backup(s, "persist", { WORK_BACKUP_ALLOW_DELETE: "1" });
    assert.equal(commits(s), 2, "the operator may allow it");
  }));

test("persist builds on the tip another push left, never forces over it", () =>
  inSandbox(async (s) => {
    backed(s);
    w(s, "TICK.log", "a\n");
    await backup(s, "persist");
    const other = join(s.home, "other");
    s.git(["clone", "-q", "-b", "main", join(s.home, "remote.git"), other]);
    writeFileSync(join(other, "VERSION"), "9.9.9\n");
    s.git(["add", "VERSION"], other);
    s.git(["commit", "-qm", "other"], other);
    s.git(["push", "-q", "origin", "HEAD:main"], other);
    w(s, "TICK.log", "a\nb\n");
    await backup(s, "persist");
    assert.equal(commits(s), 3, "on top of the other push");
  }));

test("restore brings work/ back from the backup", () =>
  inSandbox(async (s) => {
    backed(s);
    w(s, "TICK.log", "a\nb\n");
    w(s, "VERSION", "1.0.0\n");
    await backup(s, "persist");
    const saved = s.read("work/CONFIG.md");
    rmSync(join(s.work, "TICK.log"));
    rmSync(join(s.work, "VERSION"));
    rmSync(join(s.home, "shm/clone"), { recursive: true });
    w(s, "CONFIG.md", "- work_repo: acme/widgets-work\n");
    const r = await backup(s, "restore");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /restored 3 file\(s\)/);
    assert.equal(s.read("work/CONFIG.md"), saved);
    assert.equal(s.read("work/VERSION"), "1.0.0\n");
  }));

test("the backup repository's own README and LICENSE stay", () =>
  inSandbox(async (s) => {
    backed(s);
    const seed = join(s.home, "rseed");
    s.git(["init", "-q", "-b", "main", seed]);
    writeFileSync(join(seed, "README.md"), "readme\n");
    writeFileSync(join(seed, "LICENSE"), "l\n");
    s.git(["add", "-A"], seed);
    s.git(["commit", "-qm", "init"], seed);
    s.git(["push", "-q", join(s.home, "remote.git"), "HEAD:main"], seed);
    const r = await backup(s, "restore");
    assert.equal(r.rc, 2, "a repository with no CONFIG.md holds no backup");
    assert.ok(!existsSync(join(s.work, "README.md")), "restored the repository's README");
    await backup(s, "persist");
    assert.equal(files(s), ".gitignore CONFIG.md LICENSE README.md", "kept beside the backup");
  }));

test("a credential in a carried file stops the push", () =>
  inSandbox(async (s) => {
    backed(s);
    s.config(`- note: token = ghp_${"a".repeat(36)}`);
    const r = await backup(s, "persist");
    assert.equal(r.rc, 0);
    assert.match(r.out, /refused: what looks like a credential is in CONFIG\.md/);
    assert.doesNotMatch(r.out, /ghp_/, "never prints the match");
    assert.equal(commits(s), 0, "nothing pushed");
  }));

test("restore from an empty or unreachable remote", () =>
  inSandbox(async (s) => {
    backed(s);
    assert.equal((await backup(s, "restore")).rc, 2, "empty remote");
    const nowhere = { WORK_BACKUP_REMOTE: join(s.home, "nowhere.git") };
    assert.equal((await backup(s, "restore", nowhere)).rc, 1, "unreachable");
    assert.equal((await backup(s, "persist", nowhere)).rc, 0, "persist never fails the run");
  }));

test("finish backs up the run's log line", () =>
  inSandbox(async (s) => {
    backed(s);
    const r = await s.run(runState, ["finish", "nothing"], { CLAUDE_CODE_SESSION_ID: "sess-a" });
    assert.equal(r.rc, 0);
    assert.match(r.err, /backed up/);
    assert.match(s.git(["-C", join(s.home, "remote.git"), "show", "main:TICK.log"]).stdout, / nothing session=sess-a /);
  }));

test("a bad mode is a usage error", () =>
  inSandbox(async (s) => {
    assert.equal((await backup(s, "sideways")).rc, 2);
    assert.ok(readFileSync(join(s.work, "CONFIG.md")));
  }));
