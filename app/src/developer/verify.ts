// verify — does this instance have the shape onboarding promises?
//
// Shape only: files, keys, formats. It never judges the data inside, and it
// never repairs — every FAIL carries the fix to apply, and the caller re-runs
// it until it prints PASS. Onboarding runs it twice, an upgrade that changes
// what onboarding produces runs it again, and the weekly audit runs it every
// week.
//
//   --config   work/CONFIG.md only: the mid-onboarding scope, before the
//              version file, the sentinel and the checkout exist
//   (none)     the definition checkout, work/ and CONFIG.md
//   --live     all of that, plus: GitHub answers as `author`, the repository
//              takes a push, the labels exist, the runtime answers, and the
//              precheck's detection runs end to end inside its deadline
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { Report } from "../factory/checks.ts";
import { splitRepo } from "../factory/config.ts";
import type { Command, Deps } from "../factory/context.ts";
import { bulletKeys, readText } from "../factory/kv.ts";
import { hookInstalled } from "./harness.ts";
import { GATE_KEYS, ITEM_KEYS, Kit } from "./kit.ts";
import { precheck } from "./precheck.ts";

/** Every key CONFIG.md may hold. `docs/self-modification.md` §2: CLAUDE.md, ONBOARDING and this list name the same keys. */
export const KNOWN = [
  "repo",
  "author",
  "app_url",
  "mode",
  "label_handoff",
  "label_claimed",
  "label_failed",
  "label_review",
  "label_needs_info",
  "label_mine",
  "verify",
  "exclusive",
  "verify_exclusive",
  "verify_environment",
  "verify_exclusive_paths",
  "slots",
  "babysit_max_hours",
  "stuck_after_min",
  "work_repo",
  "slack_channel",
  "slack_handoff",
  "schedules",
  "skill_grill",
  "skill_file_issue",
  "repos_also",
] as const;

/** Keys 3.0.0 retired — CHANGELOG.md → 3.0.0 says what each became. */
export const RETIRED = ["cluster", "cluster_install", "cluster_uninstall", "cluster_delete", "verify_cluster"] as const;

const SLUG = /^([A-Za-z0-9.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const unknownIn = (text: string, known: readonly string[]) =>
  [...new Set(bulletKeys(text).filter((k) => !known.includes(k)))].sort().join(" ");

export const verify: Command = async (deps, args) => {
  let live = false;
  let structure = true;
  const flag = args[0] ?? "";
  if (flag === "--live") live = true;
  else if (flag === "--config") structure = false;
  else if (flag !== "") {
    deps.io.err("usage: verify-onboarding.sh [--config|--live]");
    return 2;
  }
  const r = new Report(deps.io);
  const kit = new Kit(deps);
  configChecks(kit, r);
  if (structure) structureChecks(kit, r);
  if (live) await liveChecks(deps, kit, r);
  return r.summary(live ? "live" : structure ? "structure" : "config");
};

function schedulesDefault(kit: Kit): string {
  return kit.cfg.mode() === "interactive" ? "none" : "tick audit";
}

function configChecks(kit: Kit, r: Report): void {
  const cfg = kit.cfg;
  const fixCfg = "ONBOARDING.md → 3. Write it down";
  if (!cfg.exists) {
    r.fail("config", "work/CONFIG.md is missing", `write it — ${fixCfg}`);
    return;
  }
  const mode = cfg.mode();
  // interactive, nothing hands work off or fails it unattended: only the claim is labelled
  const need = [
    "repo",
    "author",
    "app_url",
    "label_claimed",
    "verify",
    ...(mode === "interactive" ? [] : ["label_handoff", "label_failed"]),
  ];
  for (const k of need) {
    if (cfg.get(k)) r.ok(`config.${k}`, cfg.get(k));
    else r.fail(`config.${k}`, "missing", `add \`- ${k}: <value>\` — ${fixCfg}`);
  }
  const repo = cfg.get("repo");
  if (repo && !SLUG.test(repo))
    r.fail("config.repo", `'${repo}' is not [host/]owner/name`, "write the slug alone, no URL");
  const workRepo = cfg.get("work_repo");
  if (!workRepo) r.ok("config.work_repo", "unset — work/ is not backed up (docs/persistence.md → Backup)");
  else if (!SLUG.test(workRepo))
    r.fail("config.work_repo", `'${workRepo}' is not [host/]owner/name`, "write the slug alone, no URL");
  else if (workRepo === repo)
    r.fail(
      "config.work_repo",
      "is repo itself — the backup would push to the default branch of the repository you work on",
      "name a repository of its own",
    );
  else r.ok("config.work_repo", workRepo);
  const slack = cfg.get("slack_channel");
  if (!slack) r.ok("config.slack_channel", "unset — no Slack posts (docs/notify.md)");
  else if (!/^[A-Z0-9]+$/.test(slack))
    r.fail(
      "config.slack_channel",
      `'${slack}' is not a chat id`,
      "the id describe_channel lists for it, e.g. C0123ABCD, not #name",
    );
  else r.ok("config.slack_channel", `${slack} — that Slack reaches it, only describe_channel can tell`);
  const handoff = cfg.get("slack_handoff");
  if (["", "anyone", "people", "off"].includes(handoff)) {
    if (!slack) {
      if (handoff) r.warn("config.slack_handoff", "set, but slack_channel is not — nobody can hand off");
    } else
      r.ok("config.slack_handoff", `${handoff || "anyone"} may hand off an issue from Slack (docs/slack.md → Routing)`);
  } else
    r.fail(
      "config.slack_handoff",
      `'${handoff}' is not anyone, people or off`,
      "write one of them, or leave it out for anyone",
    );
  const app = cfg.get("app_url");
  if (app && !/^https?:\/\/\S+$/.test(app))
    r.fail(
      "config.app_url",
      `'${app}' is not a URL`,
      "the address from the browser, e.g. https://platform.example.com",
    );
  const whole = (k: string, zeroOk: boolean, what: string, fix: string) => {
    const v = cfg.get(k);
    if (v && (!/^[0-9]+$/.test(v) || (!zeroOk && Number(v) === 0))) r.fail(`config.${k}`, `'${v}' is not ${what}`, fix);
  };
  whole("stuck_after_min", true, "a whole number of minutes", "write 120, or more");
  whole("babysit_max_hours", false, "a whole number of hours", "write 4, or leave it out");
  whole("slots", false, "a whole number of slots", "write 3, or leave it out");
  if (cfg.get("verify_exclusive") && !cfg.get("exclusive"))
    r.fail(
      "config.verify_exclusive",
      "set, but exclusive names nothing — no lock would guard it",
      "add `- exclusive: <what is shared>`, or drop verify_exclusive",
    );
  if (cfg.get("verify_exclusive_paths") && !cfg.get("verify_exclusive") && !cfg.get("verify_environment"))
    r.fail(
      "config.verify_exclusive_paths",
      "set, but neither verify_exclusive nor verify_environment names the check it requires",
      "add the check, or drop verify_exclusive_paths",
    );
  const inEnvironment = cfg.get("verify_environment");
  if (inEnvironment && !inEnvironment.includes("{environment}"))
    r.fail(
      "config.verify_environment",
      "names no {environment} — every slot's check would run against the same place",
      "write `{environment}` where the command takes the Environment's name (docs/environments.md)",
    );
  const m = cfg.get("mode");
  if (["autonomous", "interactive"].includes(m.toLowerCase())) r.ok("config.mode", m);
  else if (!m)
    r.fail(
      "config.mode",
      "missing — read as interactive, so nothing is watched",
      "add `- mode: autonomous` to watch GitHub, or `- mode: interactive` (CHANGELOG.md → 4.0.0)",
    );
  else r.fail("config.mode", `'${m}' is not autonomous or interactive — read as interactive`, "write one of them");
  const sched = cfg.list("schedules");
  for (const w of sched)
    if (!["tick", "audit", "none"].includes(w))
      r.fail(
        "config.schedules",
        `'${w}' is not tick, audit or none`,
        "list the ones wanted, e.g. `- schedules: tick audit`",
      );
  if (mode === "interactive" && sched.includes("tick"))
    r.fail(
      "config.schedules",
      "lists tick, but mode is interactive — nothing it finds is ever worked on",
      "drop tick, or set `- mode: autonomous`",
    );
  else r.ok("config.schedules", cfg.get("schedules") || `unset — ${schedulesDefault(kit)}`);
  for (const p of cfg.list("repos_also")) {
    if (/^[^/]+\/[^/]+$/.test(p)) continue;
    r.fail("config.repos_also", `'${p}' is not owner/name or owner/*`, "write e.g. `- repos_also: owner/*`");
  }
  const retired = RETIRED.filter((k) => cfg.get(k));
  if (retired.length > 0)
    r.fail("config.retired", `retired key(s): ${retired.join(" ")}`, "migrate them — CHANGELOG.md → 3.0.0");
  const unknown = unknownIn(cfg.text, [...KNOWN, ...RETIRED]);
  if (!unknown) r.ok("config.keys", "every bullet is a known key");
  else
    r.fail(
      "config.keys",
      `unknown key(s): ${unknown} — no script reads them`,
      "rename to a key CLAUDE.md → Runtime configuration lists, or rewrite as prose under a heading",
    );
  const keys = cfg.keys();
  const dup = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))].sort().join(" ");
  if (dup) r.fail("config.keys", `duplicated: ${dup} — only the first of each is read`, "keep one line per key");
}

function structureChecks(kit: Kit, r: Report): void {
  const { home, work, cfg, git } = kit;
  const defFix = "docs/persistence.md → Definition version & upgrade";
  const fixCfg = "ONBOARDING.md → 3. Write it down";
  if (isDir(join(home, ".git"))) {
    r.ok("definition", "checked out at $HOME");
    const first = readText(join(home, ".gitignore"))
      .split("\n")
      .find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    if (first === "/*") r.ok("definition.gitignore", "allowlist");
    else
      r.fail(
        "definition.gitignore",
        `first rule is '${first ?? "none"}', not /* — a git add in $HOME can stage secrets`,
        `update the definition — ${defFix}`,
      );
    const dirty = git
      .text(home, ["status", "--porcelain"])
      .split("\n")
      .filter(Boolean)
      .slice(0, 5)
      .map((l) => `${l} `)
      .join("");
    if (!dirty) r.ok("definition.clean", "nothing changed in place");
    else
      r.fail(
        "definition.clean",
        `edited in place: ${dirty}`,
        "move the change to a pull request (docs/persistence.md → Evolving the definition), then git -C $HOME checkout -- <file>",
      );
  } else r.fail("definition", "no checkout at $HOME", "operator-only: re-create the agent from the kit");
  const sentinel = readText(join(home, ".software-developer-onboarded")).replace(/\n$/, "");
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(sentinel)) r.ok("sentinel", sentinel);
  else r.fail("sentinel", "missing or not a UTC timestamp", "ONBOARDING.md → 5. Finish");
  if (isDir(work) && !existsSync(join(work, ".git"))) r.ok("work", "a plain directory");
  else
    r.fail(
      "work",
      "missing, or a git repository — the shared volume corrupts a .git under concurrent runs",
      "remove work/.git; never git in work/",
    );
  const installFix = "bash $HOME/scripts/harness/claude-code/install.sh";
  if (hookInstalled(home)) r.ok("harness.stop", "a turn cannot end while it holds an item");
  else
    r.fail("harness.stop", "no Stop hook in ~/.claude/settings.json — a run can end mid-work, unreported", installFix);
  if (existsSync(join(home, ".claude", "skills", "implement-issue", "SKILL.md")))
    r.ok("harness.skills", "implement-issue loads");
  else
    r.fail(
      "harness.skills",
      "implement-issue does not resolve through ~/.claude/skills — a run cannot use it",
      installFix,
    );
  const repo = kit.repo;
  const name = repo.split("/").pop() ?? "";
  if (repo) {
    const src = [".claude/skills", ".agents/skills"].find((d) => isDir(join(work, name, d)));
    if (src) {
      if (real(join(work, ".claude", "skills")) === real(join(work, name, src)))
        r.ok("harness.repo_skills", `work/.claude/skills -> ${name}/${src}`);
      else
        r.fail(
          "harness.repo_skills",
          "the repository's skills are not linked at work/.claude/skills — no run sees them",
          installFix,
        );
    }
  }
  for (const role of ["grill", "file_issue"]) {
    const sk = cfg.get(`skill_${role}`);
    const def = join(".agents", "defaults", role.replaceAll("_", "-"), "SKILL.md");
    if (!sk) {
      if (existsSync(join(home, def))) r.ok(`harness.skill_${role}`, `unset — the default, ${def}`);
      else
        r.fail(
          `harness.skill_${role}`,
          `unset, and the default ${def} is missing`,
          "restore it from the definition, or name the repository's skill",
        );
    } else if (existsSync(join(work, ".claude", "skills", sk, "SKILL.md")))
      r.ok(`harness.skill_${role}`, `${sk}, the repository's`);
    else
      r.fail(
        `harness.skill_${role}`,
        `'${sk}' is not a skill in work/.claude/skills`,
        `a directory name from: ${list(join(work, ".claude", "skills"))
          .map((s) => `${s} `)
          .join("")}— or leave skill_${role} out`,
      );
  }
  if (existsSync(join(work, "AGENTS.md"))) r.ok("work.AGENTS", "present");
  else r.fail("work.AGENTS", "missing — a harness started in work/ never finds CLAUDE.md", `seed it — ${fixCfg}`);
  const adopted = firstLine(join(work, "VERSION"));
  const checkedOut = firstLine(join(home, "VERSION"));
  if (adopted && adopted === checkedOut) r.ok("work.VERSION", adopted);
  else
    r.fail(
      "work.VERSION",
      `adopted '${adopted || "none"}', checked out '${checkedOut || "none"}'`,
      `migrate — ${defFix}`,
    );
  const co = join(work, name);
  const { slug } = splitRepo(repo);
  if (repo) {
    if (isDir(join(co, ".git")) && git.line(co, ["config", "--get", "remote.origin.url"]).includes(slug))
      r.ok("checkout", `work/${name}`);
    else r.fail("checkout", `no clone of ${repo} at work/${name}`, "ONBOARDING.md → 4. Clone it");
  }
  if (existsSync(join(work, "RUN.md")))
    r.fail(
      "state.RUN",
      "work/RUN.md is a record from before slots — nothing reads it",
      "remove it (CHANGELOG.md → 2.0.0)",
    );
  const badItems = list(kit.items)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => unknownIn(readText(join(kit.items, f)), ITEM_KEYS) !== "");
  if (badItems.length > 0)
    r.fail(
      "state.items",
      `unknown keys in:${badItems.map((f) => ` ${f}`).join("")}`,
      "the items are written only by scripts/run-state.sh — delete the file; GitHub rebuilds it",
    );
  if (existsSync(kit.gate)) {
    const u = unknownIn(readText(kit.gate), GATE_KEYS);
    if (!u) r.ok("state.GATE", "well-formed");
    else r.fail("state.GATE", `unknown key(s): ${u}`, "delete work/GATE.md; the precheck starts it again");
  }
  if (repo) {
    if (isDir(kit.slots)) {
      const slots = list(kit.slots);
      const common = real(join(co, ".git"));
      const bad = slots.filter((s) => {
        const d = join(kit.slots, s);
        const c = git.line(d, ["rev-parse", "--git-common-dir"]);
        return !c || real(c.startsWith("/") ? c : join(d, c)) !== common;
      });
      const want = cfg.get("slots") || "3";
      if (bad.length > 0)
        r.fail(
          "state.slots",
          `work/slots/{${bad.join(" ")}} are not worktrees of the checkout`,
          "remove them; run-state.sh start creates slots",
        );
      if (slots.length > Number(want))
        r.fail(
          "state.slots",
          `${slots.length} slots, more than slots: ${want}`,
          "remove the highest with git worktree remove, once nothing unsaved is in them",
        );
      if (bad.length === 0 && slots.length <= Number(want)) r.ok("state.slots", `${slots.length} of ${want} created`);
    }
    const self = real(co);
    const extra = git
      .text(co, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((p) => p !== self && !/\/work\/slots\/[0-9]*$/.test(p));
    if (extra.length > 0)
      r.fail(
        "state.worktrees",
        `worktrees outside work/slots: ${extra.map((p) => `${p} `).join("")}`,
        "push what is in them, then git worktree remove — the slots are the only worktrees (CLAUDE.md → Rules)",
      );
  }
  if (existsSync(kit.log)) {
    const lines = readText(kit.log).split("\n");
    if (lines.at(-1) === "") lines.pop();
    const bad = lines.filter((l) => !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z [a-z-]+ /.test(l)).length;
    if (bad === 0) r.ok("state.TICK", `${lines.length} lines`);
    else
      r.fail(
        "state.TICK",
        `${bad} line(s) run-state.sh did not write`,
        "remove them; the log is append-only through run-state.sh",
      );
  }
  // `schedules` names the wanted ones by role, tick and audit; missing, both — or, interactive, none
  const on = ` ${cfg.get("schedules") || schedulesDefault(kit)} `;
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const n of kitSchedules(home)) {
    const role = n.includes("audit") ? "audit" : "tick";
    (on.includes(` ${role} `) ? enabled : disabled).push(n);
  }
  r.warn(
    "schedules",
    `only MCP can list them — check with list_schedules: enabled:${enabled.length ? enabled.map((n) => ` ${n}`).join("") : " none"}; disabled:${disabled.length ? disabled.map((n) => ` ${n}`).join("") : " none"}`,
  );
}

/** The schedule names kit.yaml declares, in order. */
export function kitSchedules(home: string): string[] {
  const text = readText(join(home, "kit.yaml"));
  const start = text.search(/^schedules:/m);
  if (start < 0) return [];
  return [...text.slice(start).matchAll(/^ {2}- name: (\S+)/gm)].map((m) => m[1] ?? "");
}

async function liveChecks(deps: Deps, kit: Kit, r: Report): Promise<void> {
  const gh = deps.github;
  const cfg = kit.cfg;
  const { host, slug } = kit;
  const workRepo = cfg.get("work_repo");
  const w = splitRepo(workRepo);
  // A GitHub App installation token has no user to answer as, and reports no
  // permissions on a repository: its identity and its reach are not measured.
  const user = (await gh.get(host, "user")) as { login?: string } | undefined;
  const loginName = user?.login ?? "";
  let app = "";
  if (!loginName) {
    const inst = (await gh.get(host, "installation/repositories")) as { total_count?: number } | undefined;
    app = Number.isInteger(inst?.total_count) ? String(inst?.total_count) : "";
  }
  if (app) {
    r.warn("live.auth", `acting as a GitHub App, which names no login — author '${kit.author}' is not measured`);
    if (kit.labelMine) r.ok("live.mine", `only pull requests labelled ${kit.labelMine} are yours`);
    else r.warn("live.mine", "no label_mine: every pull request this app opens reads as yours, other agents' too");
  } else if (!loginName)
    r.fail(
      "live.auth",
      `GitHub did not answer on ${host}`,
      "operator-only: grant the GitHub connection (README → The GitHub connection)",
    );
  else if (loginName.toLowerCase() === kit.author.toLowerCase()) r.ok("live.auth", `acting as ${loginName}`);
  else
    r.fail(
      "live.auth",
      `acting as ${loginName}, but author is '${kit.author}' — the precheck would never find your pull requests`,
      `set \`- author: ${loginName}\``,
    );
  if (slug) {
    const want = workRepo ? 2 : 1;
    let reach = "";
    if (app) {
      r.warn(
        "live.push",
        `not measured: a GitHub App reports no permissions — check it has write on contents, pull requests and issues of ${kit.repo}${workRepo ? `, and contents of ${workRepo}` : ""}`,
      );
      reach = app;
    } else {
      const push = String(
        ((await gh.get(host, `repos/${slug}`)) as { permissions?: { push?: boolean } } | undefined)?.permissions
          ?.push ?? "",
      );
      if (push === "true") r.ok("live.push", `${kit.repo} takes a push`);
      else
        r.fail(
          "live.push",
          `no push to ${kit.repo} (${push || "no answer"})`,
          "operator-only: the connection needs write on contents, pull requests and issues",
        );
      if (workRepo) {
        const wpush = String(
          ((await gh.get(w.host, `repos/${w.slug}`)) as { permissions?: { push?: boolean } } | undefined)?.permissions
            ?.push ?? "",
        );
        if (wpush === "true") r.ok("live.work_repo", `${workRepo} takes a push`);
        else
          r.fail(
            "live.work_repo",
            `no push to ${workRepo} (${wpush || "no answer"}) — every backup fails`,
            "operator-only: create it private, and grant the connection write on its contents",
          );
      }
      const repos = await gh.get(host, "user/repos?per_page=100");
      reach = Array.isArray(repos)
        ? String(repos.filter((x) => (x as { permissions?: { push?: boolean } }).permissions?.push).length)
        : typeof repos === "number"
          ? String(repos)
          : "";
    }
    if (reach === String(want))
      r.ok("live.scope", `the connection pushes to repo${want === 2 ? " and work_repo" : ""} alone`);
    else if (!/^[0-9]+$/.test(reach))
      r.warn("live.scope", "could not count the repositories the connection can push to");
    else
      r.warn(
        "live.scope",
        `the connection can push to ${reach} repositories — README → The GitHub connection asks for ${want}`,
      );
    const labels = await gh.getAll(host, `repos/${slug}/labels?per_page=100`);
    if (labels === undefined || labels.length === 0) r.warn("live.labels", `could not list the labels of ${kit.repo}`);
    else {
      const have = new Set(labels.map((l) => (l as { name?: string }).name ?? ""));
      for (const k of [
        "label_handoff",
        "label_claimed",
        "label_failed",
        "label_review",
        "label_needs_info",
        "label_mine",
      ]) {
        let l = cfg.get(k);
        if (k === "label_needs_info" && cfg.mode() !== "interactive") l ||= "agent/needs-info";
        if (!l) continue;
        if (have.has(l)) r.ok(`live.${k}`, `${l} exists`);
        else
          r.fail(
            `live.${k}`,
            `no label '${l}' on ${kit.repo} — nothing will ever apply it`,
            "create it, or correct the key",
          );
      }
    }
  }
  if ((await deps.runtime.liveness("verify-onboarding")) !== "unreachable")
    r.ok("live.runtime", "the runtime lists sessions — a dead run's slot can be freed");
  else
    r.fail(
      "live.runtime",
      "no answer from $PLATFORM_RUNTIME_URL/api/trpc/sessions.list — no dead run's slot is ever freed",
      "operator-only: report it; the runtime serves this for every agent",
    );
  if (cfg.mode() === "interactive") {
    r.ok("live.precheck", "interactive — it wakes nothing, so there is no detection to prove");
    return;
  }
  const started = deps.clock.now().getTime();
  const errs: string[] = [];
  const rc = await precheck(
    { ...deps, env: { ...deps.env, PRECHECK_PROBE: "1" }, io: { out: () => {}, err: (s) => errs.push(s) } },
    [],
  );
  const took = Math.round((deps.clock.now().getTime() - started) / 1000);
  const why = errs.join(" ").slice(-300);
  if (rc > 1)
    r.fail(
      "live.precheck",
      `exit ${rc} — a broken precheck fails open, and every tick pays for a turn${why ? `: ${why}` : ""}`,
      "fix what it printed, then re-run",
    );
  else if (took >= 120)
    r.fail(
      "live.precheck",
      `took ${took}s — past the two-minute deadline it fails open`,
      "report it; the GitHub queries are too slow",
    );
  else if (took >= 90) r.warn("live.precheck", `took ${took}s — close to the two-minute deadline`);
  else r.ok("live.precheck", `exit ${rc} in ${took}s`);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return "";
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function firstLine(file: string): string {
  try {
    return readFileSync(file, "utf8").split("\n")[0] ?? "";
  } catch {
    return "";
  }
}
