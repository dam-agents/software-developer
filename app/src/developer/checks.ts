// The required check: a change on `verify_exclusive_paths` passes
// `verify_environment`, else `verify_exclusive`, on the commit it ships, before
// a pull request goes to review. `run-state.sh checked` records each result on
// the item and in TICK.log; park and finish read the record, and the weekly
// audit reads the log. A check that could not run is never silent.
import type { Git } from "../factory/git.ts";

/** One `checked` record: `<check> <pass|fail|skipped> <commit> <cause>`. */
export interface Checked {
  readonly check: string;
  readonly result: "pass" | "fail" | "skipped";
  readonly commit: string;
  readonly cause: string;
}

export const RESULTS = ["pass", "fail", "skipped"] as const;

export function parseChecked(v: string): Checked | undefined {
  const [check = "", result = "", commit = "", ...rest] = v.split(" ");
  if (!check || !(RESULTS as readonly string[]).includes(result) || !commit) return undefined;
  return { check, result: result as Checked["result"], commit, cause: rest.join(" ") };
}

/** A `verify_exclusive_paths` entry as a test of a path: `dir/` a prefix, `*` within a segment, `**` across them, else the path or a directory of it. */
export function pathMatcher(entries: readonly string[]): (path: string) => boolean {
  const res = entries.map((e) => {
    if (e.includes("*")) {
      const src = e
        .split("**")
        .map((part) =>
          part
            .split("*")
            .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*"),
        )
        .join(".*");
      return new RegExp(`^${src}$`);
    }
    const base = e.replace(/\/+$/, "");
    return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`);
  });
  return (path) => res.some((re) => re.test(path));
}

/** The files a slot's branch changes against the default branch that need the required check; undefined when git could not say. */
export function requiredChanges(git: Git, dir: string, entries: readonly string[]): string[] | undefined {
  if (entries.length === 0) return [];
  const dflt = git.defaultBranch(dir);
  const r = git.run(dir, ["diff", "--name-only", `origin/${dflt}...HEAD`]);
  if (r.code !== 0) return undefined;
  const hit = pathMatcher(entries);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && hit(l));
}
