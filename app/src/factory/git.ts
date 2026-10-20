// git, run in a directory with the command's environment. The app reads git
// and moves worktrees between branches; it commits and pushes only where a
// kit says so (the work backup), never to the repository it works on.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { line, type Ran, run, text } from "./proc.ts";

export class Git {
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.env = env;
  }

  run(dir: string, args: readonly string[]): Ran {
    return run("git", ["-C", dir, ...args], { env: this.env, timeoutMs: 600_000 });
  }

  ok(dir: string, args: readonly string[]): boolean {
    return this.run(dir, args).code === 0;
  }

  /** The first line of a command's output, "" when it failed. */
  line(dir: string, args: readonly string[]): string {
    const r = this.run(dir, args);
    return r.code === 0 ? line(r) : "";
  }

  text(dir: string, args: readonly string[]): string {
    const r = this.run(dir, args);
    return r.code === 0 ? text(r) : "";
  }

  /** Whether a directory is a checkout or a worktree: it has a `.git`, file or directory. */
  isRepo(dir: string): boolean {
    return existsSync(join(dir, ".git"));
  }

  /**
   * What in a worktree is not on GitHub yet: uncommitted changes, or commits
   * no remote branch has. "" means nothing would be lost.
   */
  unsaved(dir: string): string {
    if (!this.isRepo(dir)) return "";
    if (this.text(dir, ["status", "--porcelain"]) !== "") return "uncommitted changes";
    if (this.line(dir, ["log", "--oneline", "HEAD", "--not", "--remotes"]) !== "") return "commits not pushed";
    return "";
  }

  /** The default branch: origin/HEAD, else what the remote says, else main. */
  defaultBranch(co: string): string {
    const head = this.line(co, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).replace(/^origin\//, "");
    if (head && head !== "origin/HEAD" && head !== "HEAD") return head;
    const sym = /^ref: refs\/heads\/(\S+)/m.exec(this.text(co, ["ls-remote", "--symref", "origin", "HEAD"]));
    return sym?.[1] ?? "main";
  }

  /** The branch checked out, "" when detached or not a repository. */
  branch(dir: string): string {
    return this.line(dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  }

  /** `HEAD` when detached, as `rev-parse --abbrev-ref` says it. */
  abbrevHead(dir: string): string {
    return this.line(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  hasRef(dir: string, ref: string): boolean {
    return this.ok(dir, ["rev-parse", "-q", "--verify", ref]);
  }
}
