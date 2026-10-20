// validate-definition — read-only structural validation of an agent
// definition repository, any kit's: the shape the platform and the kit's own
// runs rely on. Prints PASS/WARN/FAIL lines; exit 0 = no FAIL.
//
// The kit is read by the platform BEFORE the agent exists, so everything wrong
// with it fails silently: a kit that misses the schema is dropped from the
// catalog with only a server-side log, and a kit that declares `onboarding`
// stamps the agent onboarded at create. These are line checks, not a YAML
// parse: the platform's own schema is the real gate.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Command, Env } from "./context.ts";
import { run } from "./proc.ts";

interface Out {
  pass(s: string): void;
  warn(s: string): void;
  fail(s: string): void;
}

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/** Every file under a directory, relative to it, skipping .git, node_modules and work/. */
export function walk(root: string, dir = root): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    if (n === ".git" || n === "node_modules" || (dir === root && n === "work")) return [];
    const p = join(dir, n);
    try {
      return statSync(p).isDirectory() ? walk(root, p) : [relative(root, p)];
    } catch {
      return [];
    }
  });
}

/** A block of kit.yaml: its top-level key's line and every line after it up to the next top-level key. */
function block(yaml: string, key: string): string {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return "";
  const end = lines.findIndex((l, i) => i > at && /^[a-z]/.test(l));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

function requiredFiles(o: Out): void {
  for (const f of [
    "CLAUDE.md",
    "AGENTS.md",
    "ONBOARDING.md",
    "README.md",
    "VERSION",
    "CHANGELOG.md",
    ".gitignore",
    "docs/self-modification.md",
    "docs/persistence.md",
    "scripts/verify-onboarding.sh",
  ])
    existsSync(f) ? o.pass(`required file: ${f}`) : o.fail(`missing required file: ${f}`);
}

function gitignore(o: Out): void {
  const gi = read(".gitignore");
  if (!gi) return;
  const lines = gi.split("\n");
  const first = lines.find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (first === "/*") o.pass(".gitignore is an allowlist (first rule is /*)");
  else o.fail(`.gitignore must ignore everything first ('/*'); first rule is: ${first ?? "<none>"}`);
  for (const inc of [
    "!/.gitignore",
    "!/CLAUDE.md",
    "!/AGENTS.md",
    "!/ONBOARDING.md",
    "!/VERSION",
    "!/CHANGELOG.md",
    "!/docs/",
  ])
    lines.includes(inc)
      ? o.pass(`.gitignore re-includes ${inc.slice(2)}`)
      : o.fail(`.gitignore missing re-include: ${inc}`);
  for (const [inc, dir, what] of [
    ["!/scripts/", "scripts", "the agent has no scripts"],
    ["!/.github/", ".github", "the definition has no CI"],
    ["!/app/", "app", "the agent has no app"],
    ["!/bin/", "bin", "the agent has no bin/"],
  ] as const) {
    if (lines.includes(inc)) continue;
    existsSync(dir)
      ? o.fail(`.gitignore missing re-include: ${inc} (${dir}/ exists)`)
      : o.warn(`no ${inc} re-include (fine only if ${what})`);
  }
}

function kitYaml(o: Out): void {
  const kit = read("kit.yaml");
  if (!kit) {
    o.warn(
      "no kit.yaml — the agent must be created by hand (correct only for a private definition whose kit lives in the catalog repo)",
    );
    return;
  }
  o.pass("required file: kit.yaml");
  /^schemaVersion:[ \t]*v1[ \t]*$/m.test(kit)
    ? o.pass("kit.yaml declares schemaVersion v1")
    : o.fail("kit.yaml must declare 'schemaVersion: v1' — the catalog drops a kit it cannot parse");
  const gi = read(".gitignore").split("\n");
  if (gi.length > 1 && !gi.includes("!/kit.yaml"))
    o.fail(".gitignore missing re-include: !/kit.yaml (an untracked kit.yaml is invisible to the catalog)");
  else if (gi.length > 1) o.pass(".gitignore re-includes kit.yaml");
  /^requireConnectionAddress:[ \t]*true[ \t]*$/m.test(kit)
    ? o.pass("kit.yaml requires addressed credential injection")
    : o.fail(
        "kit.yaml must set 'requireConnectionAddress: true' — the gateway would overwrite the credentials its own tools send",
      );
  /^onboarding:/m.test(kit)
    ? o.fail(
        "kit.yaml declares 'onboarding:' — leave it out, or the agent is stamped onboarded at create and loses the gate, the checklist tools and the hold on its schedules",
      )
    : o.pass("kit.yaml leaves 'onboarding' absent (platform-composed briefing → ONBOARDING.md)");
  const seed = block(kit, "seed");
  if (!seed) o.fail("kit.yaml declares no 'seed:' — without one the platform creates an agent with no definition");
  else {
    /^[ \t]+self:[ \t]*true/m.test(seed)
      ? o.pass("kit.yaml seeds itself (seed.self)")
      : o.fail("kit.yaml seed must be 'self: true' — a definition kit never repeats its own URL");
    /^[ \t]+into:[ \t]*home/m.test(seed)
      ? o.pass("kit.yaml seeds into $HOME (seed.into: home)")
      : o.fail(
          "kit.yaml seed must be 'into: home' — this definition IS $HOME, and the default ('work') would put it in the wrong place",
        );
    /^[ \t]+url:/m.test(seed)
      ? o.fail("kit.yaml seed names both 'self' and 'url' — a seed names exactly one")
      : o.pass("kit.yaml seed names exactly one source");
  }
  // id, the sentinel and the schedule prefix all name the same agent; a
  // mismatch means ONBOARDING creates a second copy of every schedule.
  const id = /^id:[ \t]*(\S+)/m.exec(kit)?.[1] ?? "";
  if (!id) o.fail("kit.yaml declares no 'id:'");
  else {
    o.pass(`kit.yaml id: ${id}`);
    const sentinel = /\.([a-z0-9-]+)-onboarded/.exec(read("ONBOARDING.md"))?.[1];
    if (sentinel && sentinel !== id)
      o.fail(`kit.yaml id '${id}' != the agent name in ONBOARDING's sentinel '${sentinel}'`);
    else if (sentinel) o.pass("kit id matches the onboarding sentinel");
    const sched = block(kit, "schedules");
    const bad = sched
      .split("\n")
      .filter((l) => /^[ \t]+-[ \t]*name:/.test(l) && !new RegExp(`^[ \\t]+-[ \\t]*name:[ \\t]*${id}-`).test(l));
    if (bad.length > 0)
      o.fail(
        `schedule names must start with '${id}-' (the prefix ONBOARDING checks for):\n${bad.map((l) => `      ${l}`).join("\n")}`,
      );
    else if (sched) o.pass("every kit schedule name carries the agent prefix");
  }
  // A precheck naming a script that is not in the repo is a broken check on
  // every occurrence — and it fails open, so nobody notices.
  for (const s of new Set(
    [...kit.matchAll(/^[ \t]+precheck:.*?(scripts\/[A-Za-z0-9_./-]+\.sh)/gm)].map((m) => m[1] ?? ""),
  ))
    existsSync(s)
      ? o.pass(`kit precheck script exists: ${s}`)
      : o.fail(`kit.yaml declares a precheck running ${s}, which this repo does not contain`);
}

function versioning(o: Out): void {
  const ver = read("VERSION").split("\n")[0] ?? "";
  if (!existsSync("VERSION")) return;
  /^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)
    ? o.pass(`VERSION is semver: ${ver}`)
    : o.fail(`VERSION is not plain semver: '${ver}'`);
  const log = read("CHANGELOG.md");
  if (!log) return;
  const latest = /^## (\S+)/m.exec(log)?.[1] ?? "";
  ver === latest
    ? o.pass(`VERSION matches newest CHANGELOG heading (${latest})`)
    : o.fail(`VERSION (${ver}) != newest CHANGELOG heading (${latest || "<none>"})`);
  /^\*\*Upgrade:\*\*/m.test(log)
    ? o.pass("CHANGELOG entries carry Upgrade blocks")
    : o.fail("CHANGELOG must carry an '**Upgrade:**' block per version (migration instructions, not a change log)");
}

function claudeMd(o: Out): void {
  const c = read("CLAUDE.md");
  if (!c) return;
  for (const s of ["trust boundary", "Hard invariants", "Runtime configuration", "Map of"])
    c.toLowerCase().includes(s.toLowerCase())
      ? o.pass(`CLAUDE.md has: ${s}`)
      : o.fail(`CLAUDE.md missing mandatory section: ${s}`);
  const n = c.split("\n").length - (c.endsWith("\n") ? 1 : 0);
  n <= 170
    ? o.pass(`CLAUDE.md is slim (${n} lines)`)
    : o.warn(`CLAUDE.md is ${n} lines (>170) — move procedure text into docs/`);
}

function leftovers(o: Out, files: readonly string[]): void {
  const text = (exts: RegExp, skip: (f: string) => boolean) =>
    files
      .filter((f) => exts.test(f) && !skip(f))
      .flatMap((f) =>
        read(f)
          .split("\n")
          .map((l, i) => ({ f, i: i + 1, l })),
      );
  const self = (f: string) =>
    f.endsWith("validate.ts") || f.endsWith("validate.test.ts") || f.endsWith("validate-definition.sh");
  const marks = text(/\.(md|sh|ya?ml|ts)$/, self).filter(({ l }) => /\{\{[A-Z_]+\}\}|TODO\(creator\)/.test(l));
  if (marks.length > 0)
    o.fail(
      `unresolved placeholders / TODO(creator) markers remain:\n${marks.map((m) => `      ./${m.f}:${m.i}:${m.l}`).join("\n")}`,
    );
  else o.pass("no unresolved placeholders or TODO(creator) markers");
  text(/\.(md|sh|ts)$/, self).some(({ l }) => /code-guardian/i.test(l))
    ? o.warn("definition mentions 'code-guardian' — copied text? (fine only as an explicit credit)")
    : o.pass("no stray reference-implementation mentions");
  // The definition serves any repository: a project's own tool or command
  // named outside the changelog and the tests is one project's setup leaking in.
  const tooling = text(
    /\.(md|sh|ya?ml|ts)$/,
    (f) => self(f) || f === "CHANGELOG.md" || /(^|\/)tests?\//.test(f),
  ).filter(({ l }) => /\b(mise (run|trust)|k3s|helm|istio|kubectl)\b/.test(l));
  if (tooling.length > 0)
    o.fail(
      `names one project's tooling — make it generic, or leave it to the repository's own instructions:\n${tooling.map((m) => `      ./${m.f}:${m.i}:${m.l}`).join("\n")}`,
    );
  else o.pass("names no project's tooling");
}

/**
 * The scripts are shims onto `bin/sd`: each must parse, and each must name a
 * command the CLI has, or a schedule calling it breaks on every occurrence.
 */
function shims(o: Out, files: readonly string[], commands: readonly string[], env: Env): void {
  for (const s of files.filter((f) => f.startsWith("scripts/") && f.endsWith(".sh"))) {
    run("bash", ["-n", s], { env }).code === 0 ? o.pass(`bash -n: ${s}`) : o.fail(`syntax error: ${s} (bash -n)`);
    const target = /bin\/sd"? ([a-z-]+)/.exec(read(s))?.[1];
    if (target !== undefined && !read(s).includes('exec "$BASH"'))
      o.fail(`${s} must run bin/sd as \`exec "$BASH" …\`: a second \`env bash\` trips the image's mise shim`);
    if (target === undefined) continue;
    commands.includes(target)
      ? o.pass(`${s} -> sd ${target}`)
      : o.fail(`${s} calls \`sd ${target}\`, which bin/sd does not have`);
  }
}

function deadLinks(o: Out, files: readonly string[]): void {
  let dead = 0;
  for (const f of files.filter((x) => x.endsWith(".md"))) {
    for (const m of read(f).matchAll(/\]\(([^)]+)\)/g)) {
      const l = m[1] ?? "";
      if (/^(https?:|mailto:|#)/.test(l) || /[<…${ ]/.test(l)) continue;
      const target = l.split("#")[0] ?? "";
      if (!target) continue;
      if (!existsSync(join(dirname(f), target)) && !existsSync(target)) {
        o.fail(`dead link in ./${f}: ${l}`);
        dead++;
      }
    }
  }
  if (dead === 0) o.pass("no dead relative links in any .md file");
}

/**
 * Cross-file section references ("<file>.md → **Label**"). They are prose,
 * not anchors, so a renamed section breaks them silently.
 */
function sectionRefs(o: Out, files: readonly string[]): void {
  const docs = files.filter((f) => /^(CLAUDE|AGENTS|README|ONBOARDING)\.md$|^docs\/[^/]+\.md$/.test(f));
  const anchors = (p: string) =>
    read(p)
      .split("\n")
      .flatMap((l) => [/^#{1,6} +(.*)$/.exec(l)?.[1], /^\*\*([^*]+)\*\*/.exec(l)?.[1]])
      .filter((x): x is string => x !== undefined)
      .map((a) => a.replace(/ +/g, " "));
  let n = 0;
  let bad = 0;
  for (const f of docs) {
    const flat = read(f).replace(/\n/g, " ").replace(/ +/g, " ");
    for (const m of flat.matchAll(/\[?`?([A-Za-z0-9_./-]+\.md)`?\]?(?:\([^)]*\))? → \*\*([^*]+)\*\*/g)) {
      const t = m[1] ?? "";
      const label = m[2] ?? "";
      const path = [join(dirname(f), t), t, join("docs", t)].find((c) => existsSync(c));
      if (!path) {
        o.fail(`${f}: unresolvable file in '${m[0]}'`);
        bad++;
        continue;
      }
      n++;
      if (!anchors(path).some((a) => a.startsWith(label))) {
        o.fail(`${f} -> ${path}: no section '${label}'`);
        bad++;
      }
    }
  }
  if (bad === 0) o.pass(`${n} cross-file section references resolve`);
}

function sentinel(o: Out): void {
  const c = /\.[a-z0-9-]+-onboarded/.exec(read("CLAUDE.md"))?.[0];
  const s = /\.[a-z0-9-]+-onboarded/.exec(read("ONBOARDING.md"))?.[0];
  if (!existsSync("ONBOARDING.md") || !existsSync("CLAUDE.md")) return;
  if (!s) o.fail("ONBOARDING.md defines no .<name>-onboarded sentinel guard");
  else if (!c || c === s) o.pass(`onboarding sentinel consistent (${s})`);
  else o.fail(`sentinel mismatch: CLAUDE.md '${c}' vs ONBOARDING.md '${s}'`);
}

/** Runs every check on the definition at `root`, against the commands the CLI has. */
export function validate(root: string, commands: readonly string[], out: Out, env: Env = process.env): void {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const files = walk(".");
    requiredFiles(out);
    gitignore(out);
    kitYaml(out);
    versioning(out);
    claudeMd(out);
    leftovers(out, files);
    shims(out, files, commands, env);
    deadLinks(out, files);
    sectionRefs(out, files);
    sentinel(out);
  } finally {
    process.chdir(cwd);
  }
}

export const validateDefinition: Command = async (deps, args) => {
  const root = resolve(args[0] ?? ".");
  if (!existsSync(root)) {
    deps.io.out(`FAIL  no such directory: ${root}`);
    return 1;
  }
  const { commands } = await import("../registry.ts");
  let fails = 0;
  let warns = 0;
  validate(
    root,
    Object.keys(commands),
    {
      pass: (s) => deps.io.out(`PASS  ${s}`),
      warn: (s) => {
        warns++;
        deps.io.out(`WARN  ${s}`);
      },
      fail: (s) => {
        fails++;
        deps.io.out(`FAIL  ${s}`);
      },
    },
    deps.env,
  );
  deps.io.out("");
  deps.io.out(`validate-definition: ${fails} fail, ${warns} warn`);
  return fails === 0 ? 0 : 1;
};
