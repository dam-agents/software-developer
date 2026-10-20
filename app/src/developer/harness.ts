// The harness wiring: the Stop hook, the decision behind it, the install that
// registers it, and the small commands a run calls beside run-state.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "../factory/context.ts";
import { readText } from "../factory/kv.ts";
import { ATTENDED } from "../factory/runtime.ts";
import { Kit } from "./kit.ts";

/** How many times the Stop hook holds a turn before it lets the stop through. */
export const MAX_BLOCKS = 3;

/** The hook's path as settings.json names it: the stable shell entry point. */
export const hookPath = (home: string) => join(home, "scripts", "harness", "claude-code", "enforce-finish.sh");

/**
 * The Stop hook (Claude Code): refuses to end a turn while this session still
 * holds an item. Nobody watches a scheduled run, so a turn that ends mid-work
 * — a summary, a question, "I'll continue next time" — is work nobody hears
 * about until a later run finds it dead. Exit 2 keeps the turn going and
 * shows the model stderr: what it holds, and how to finish.
 *
 * It counts its own blocks on the item's lock. After MAX_BLOCKS it lets the
 * stop through — the harness ends a turn after eight blocks anyway — and the
 * next precheck finds the run dead and hands its item on. Anything unexpected
 * exits 0: this hook may never be what breaks a run.
 *
 * Only an unattended run is held: a session the runtime confirms as attended
 * (the direct chat, Slack) ends its turn to wait for a person or a background
 * task. Any other type, or a runtime that does not answer, is held.
 */
export const enforceFinish: Command = async (deps) => {
  try {
    let sid = "";
    try {
      const input = JSON.parse(deps.stdin()) as { session_id?: unknown };
      sid = typeof input.session_id === "string" ? input.session_id : "";
    } catch {
      return 0;
    }
    if (!sid) return 0;
    const kit = new Kit({ ...deps, env: { ...deps.env, CLAUDE_CODE_SESSION_ID: sid } });
    const lock = kit.locks.ofKind("item-").find((h) => h.owner.session === sid);
    if (!lock) return 0;
    if (ATTENDED.has(await deps.runtime.sessionType(sid))) return 0;
    const n = kit.locks.stopBlocks(lock.name);
    if (n >= MAX_BLOCKS) return 0;
    try {
      writeFileSync(join(lock.dir, "stop_blocks"), `${n + 1}\n`);
    } catch {
      return 0;
    }
    const e = (s = "") => deps.io.err(s);
    e(
      `Stop blocked (${n + 1}/${MAX_BLOCKS}): this run still holds #${lock.owner.item}, last at "${lock.owner.phase}".`,
    );
    e();
    e("No one is watching this session — nothing you write here is read. The run");
    e("ends with its outcome on GitHub, and `run-state.sh finish`, never mid-work:");
    e();
    e("1. Commit and push everything in your slot.");
    e("2. Report on the issue or its pull request: what you did, where it stands,");
    e("   what happens next, with this run's session link");
    e('   (bash "$HOME/scripts/session-link.sh"). A question for a person goes');
    e("   there too, with the needs-info label — never into this turn.");
    e('3. bash "$HOME/scripts/run-state.sh" finish <outcome> [pr]');
    e();
    e("Waiting on a review or a check of your pull request? That is not the end:");
    e('bash "$HOME/scripts/run-state.sh" wait <pr>, and again until it is done.');
    e();
    if (n + 1 >= MAX_BLOCKS) {
      e("This is the last block. If the work cannot go on, finish `blocked`:");
      e("comment the issue with what fails and what you tried, swap the claim");
      e("for the failed label, and finish blocked. That is always possible.");
    } else e("Or carry on with the work, if it is not done.");
    return 2;
  } catch {
    return 0;
  }
};

/**
 * Wires this definition into Claude Code. Idempotent; keeps every other hook,
 * setting and skill. On another harness it says so and exits 0. What it wires
 * takes effect from the next session.
 *
 *   Stop hook     enforce-finish.sh, in ~/.claude/settings.json
 *   our skills    ~/.claude/skills -> ~/.agents/skills, where the bundled
 *                 skills live beside the platform's; left alone when the
 *                 platform already links it
 *   repo skills   work/.claude/skills -> the checkout's own skills. A run's
 *                 working directory is work/, and Claude Code loads project
 *                 skills from there alone, so without the link a run never
 *                 sees the repository's skills.
 */
export const install: Command = async (deps) => {
  const env = deps.env;
  const o = (s: string) => deps.io.out(s);
  if (env.CLAUDECODE !== "1" && !env.FORCE_INSTALL) {
    o("not the Claude Code harness — nothing installed");
    return 0;
  }
  const home = env.HOME ?? "/home/agent";
  const kit = new Kit(deps);
  let rc = 0;
  const settingsFile = join(home, ".claude", "settings.json");
  const hook = hookPath(home);
  mkdirSync(dirname(settingsFile), { recursive: true });
  let settings: Record<string, unknown> = {};
  const raw = readText(settingsFile);
  try {
    settings = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as { hooks?: { command?: string }[] }[]) : [];
    if (stop.some((g) => (g.hooks ?? []).some((h) => h.command === hook))) o("Stop hook: already installed");
    else {
      settings.hooks = { ...hooks, Stop: [...stop, { hooks: [{ type: "command", command: hook, timeout: 15 }] }] };
      const tmp = `${settingsFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
      renameSync(tmp, settingsFile);
      o(`Stop hook: installed -> ${hook}`);
    }
  } catch {
    o(`Stop hook: could not update ${settingsFile} — left unchanged`);
    rc = 1;
  }
  const ours = join(home, ".claude", "skills");
  if (exists(ours)) o("our skills: ~/.claude/skills already there");
  else {
    symlinkSync("../.agents/skills", ours);
    o("our skills: linked ~/.claude/skills -> ~/.agents/skills");
  }
  if (!existsSync(join(ours, "implement-issue", "SKILL.md"))) {
    o("our skills: implement-issue does not resolve through ~/.claude/skills");
    rc = 1;
  }
  const name = kit.repo.split("/").pop() ?? "";
  const link = join(kit.work, ".claude", "skills");
  const src = name ? [".claude/skills", ".agents/skills"].find((d) => isDirectory(join(kit.work, name, d))) : undefined;
  if (!src) o(`repo skills: ${name || "no checkout"} ships none`);
  else if (exists(link) && !lstatSync(link).isSymbolicLink()) {
    o(`repo skills: ${link} exists and is not a link — left alone; move it aside and run this again`);
    rc = 1;
  } else {
    mkdirSync(join(kit.work, ".claude"), { recursive: true });
    if (exists(link)) unlinkSync(link);
    symlinkSync(`../${name}/${src}`, link);
    o(`repo skills: linked work/.claude/skills -> ${name}/${src} (${readdirSync(link).length} skills)`);
  }
  return rc;
};

/**
 * The platform link to the session a run is happening in — the line a pull
 * request carries so a reviewer can read how it was written. The session id
 * is the harness's own; a harness that does not export it still gets a
 * working link, to the agent rather than to the run.
 */
export const sessionLink: Command = async (deps) => {
  const kit = new Kit(deps);
  const app = kit.cfg.get("app_url").replace(/\/+$/, "");
  const agent = deps.env.PLATFORM_AGENT_ID ?? "";
  if (!app || !agent) {
    deps.io.err("no link: work/CONFIG.md names no app_url");
    return 1;
  }
  deps.io.out(kit.me ? `${app}/a/${agent}?s=${kit.me}` : `${app}/a/${agent}`);
  return 0;
};

/** Whether the direct session may act on a repository: `repo`, or one `repos_also` names. */
export const repoAllowed: Command = async (deps, args) => {
  if (args.length !== 1 || !args[0]) {
    deps.io.err("usage: repo-allowed.sh <owner/name>");
    return 2;
  }
  if (new Kit(deps).allows(args[0])) {
    deps.io.out(`allowed: ${args[0]}`);
    return 0;
  }
  deps.io.err(`not allowed: ${args[0]} — neither \`repo\` nor named by \`repos_also\` in work/CONFIG.md`);
  return 1;
};

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return readdirSync(p) !== undefined;
  } catch {
    return false;
  }
}

/** settings.json registers the hook: what verify checks. */
export function hookInstalled(home: string): boolean {
  try {
    const s = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
      hooks?: { Stop?: { hooks?: { command?: string }[] }[] };
    };
    return (s.hooks?.Stop ?? []).some((g) => (g.hooks ?? []).some((h) => h.command === hookPath(home)));
  } catch {
    return false;
  }
}
