// verify: each scope checks what exists by then, and every FAIL names its fix.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verify } from "../src/developer/verify.ts";
import { inSandbox, type Sandbox } from "./helpers.ts";

const LABELS = ["agent/implement", "agent/in-progress", "agent/failed", "needs-review", "agent/needs-info"];
/** GitHub as --live reads it: the login, the push, the reach, the labels. */
function gh(
  s: Sandbox,
  o: {
    login?: string | null;
    push?: boolean;
    reach?: number;
    labels?: string[];
    installation?: number;
    workPush?: boolean;
  } = {},
): void {
  s.github
    .on(/^user$/, o.login === null ? undefined : { login: o.login ?? "dev-bot" })
    .on(/^installation\/repositories/, o.installation === undefined ? undefined : { total_count: o.installation })
    .on(/^repos\/acme\/widgets$/, { permissions: { push: o.push ?? true } })
    .on(/^repos\/acme\/widgets-work$/, { permissions: { push: o.workPush ?? true } })
    .on(
      /^user\/repos/,
      Array.from({ length: o.reach ?? 1 }, () => ({ permissions: { push: true } })),
    )
    .on(
      /^repos\/acme\/widgets\/labels/,
      (o.labels ?? LABELS).map((name) => ({ name })),
    );
}
const v = (s: Sandbox, ...args: string[]) => s.run(verify, args);

test("--config passes a complete CONFIG.md", () =>
  inSandbox(async (s) => {
    const r = await v(s, "--config");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /PASS \(config\)/);
    assert.doesNotMatch(r.out, /sentinel/, "checks nothing onboarding has not created yet");
  }));

test("--config fails what the runtime could not read", () =>
  inSandbox(async (s) => {
    s.setConfig("label_failed", null);
    s.config("- lable_review: typo\n- author: someone-else");
    s.setConfig("repo", "https://github.com/acme/widgets");
    s.setConfig("app_url", "platform.example.com");
    s.config("- cluster_install: make up\n- schedules: tick daily\n- repos_also: acme/*, gadgets");
    const r = await v(s, "--config");
    assert.equal(r.rc, 1);
    assert.match(r.out, /FAIL config\.label_failed — missing — fix:/);
    assert.match(r.out, /unknown key\(s\): lable_review/);
    assert.match(r.out, /duplicated: author/);
    assert.match(r.out, /is not \[host\/\]owner\/name/);
    assert.match(r.out, /app_url — 'platform\.example\.com' is not a URL/);
    assert.match(r.out, /FAIL config\.retired — retired key\(s\): cluster_install/);
    assert.match(r.out, /FAIL config\.schedules — 'daily' is not tick, audit or none/);
    assert.match(r.out, /FAIL config\.repos_also — 'gadgets' is not owner\/name or owner\/\*/);
    assert.doesNotMatch(r.out, /'acme\/\*' is not/);
    assert.doesNotMatch(r.out, /unknown key\(s\): lable_review cluster_install/, "a retired key is not also unknown");
    assert.doesNotMatch(r.out, /Nothing under deploy/, "a prose bullet is not a key");
  }));

test("a full run passes an onboarded instance", () =>
  inSandbox(async (s) => {
    s.onboarded();
    const r = await v(s);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /PASS \(structure\)/);
    assert.match(r.out, /warn schedules — only MCP can list them/);
    assert.match(r.out, /software-developer-tick-10m/);
  }));

test("a full run fails a drifted instance", () =>
  inSandbox(async (s) => {
    s.onboarded();
    mkdirSync(join(s.work, ".git"));
    s.write("kit.yaml", `${s.read("kit.yaml")}local edit\n`);
    s.write(".claude/settings.json", "{}");
    s.write("work/VERSION", "0.9.0\n");
    rmSync(join(s.work, "widgets"), { recursive: true });
    s.write("work/TICK.log", "not a run-state line\n");
    s.write("work/RUN.md", "- run_state: idle\n");
    s.config("- slots: 1");
    mkdirSync(join(s.work, "slots/1"), { recursive: true });
    mkdirSync(join(s.work, "slots/2"), { recursive: true });
    s.write("work/items/3.md", "- item: 3\n- mood: odd\n");
    const r = await v(s);
    assert.equal(r.rc, 1);
    for (const want of [
      /FAIL work — missing, or a git repository/,
      /FAIL harness\.stop — no Stop hook/,
      /FAIL definition\.clean — edited in place/,
      /FAIL work\.VERSION — adopted '0\.9\.0'/,
      /FAIL checkout — no clone of acme\/widgets/,
      /FAIL state\.TICK — 1 line\(s\)/,
      /FAIL state\.RUN — work\/RUN\.md is a record from before slots/,
      /FAIL state\.items — unknown keys in: 3\.md/,
      /FAIL state\.slots — work\/slots\/\{1 2\} are not worktrees/,
      /FAIL state\.slots — 2 slots, more than slots: 1/,
    ])
      assert.match(r.out, want);
  }));

test("--live passes when GitHub and the runtime answer", () =>
  inSandbox(async (s) => {
    s.onboarded();
    gh(s);
    const r = await v(s, "--live");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /ok {3}live\.auth — acting as dev-bot/);
    assert.match(r.out, /ok {3}live\.precheck — exit 1/);
  }));

test("--live fails what would break the ticks", () =>
  inSandbox(async (s) => {
    s.onboarded();
    gh(s, {
      login: "other-bot",
      push: false,
      reach: 3,
      labels: ["agent/implement", "agent/in-progress", "agent/failed"],
    });
    s.runtime.down = true;
    const r = await v(s, "--live");
    assert.equal(r.rc, 1);
    assert.match(r.out, /acting as other-bot, but author is 'dev-bot'/);
    assert.match(r.out, /FAIL live\.push — no push/);
    assert.match(r.out, /warn live\.scope — the connection can push to 3 repositories/);
    assert.match(r.out, /FAIL live\.label_review — no label 'needs-review'/);
    assert.match(r.out, /FAIL live\.runtime/);
    assert.match(r.out, /FAIL live\.label_needs_info — no label 'agent\/needs-info'/);
  }));

test("a worktree outside the slots fails; verify_exclusive needs exclusive", () =>
  inSandbox(async (s) => {
    s.onboarded();
    s.originCheckout();
    s.git(["-C", join(s.work, "widgets"), "worktree", "add", "-q", "--detach", join(s.work, "widgets-extra")]);
    s.config("- verify_exclusive: make e2e");
    const r = await v(s);
    assert.match(r.out, /FAIL state\.worktrees — worktrees outside work\/slots/);
    assert.match(r.out, /FAIL config\.verify_exclusive — set, but exclusive names nothing/);
  }));

test("slack_channel is a chat id when set", () =>
  inSandbox(async (s) => {
    assert.match((await v(s, "--config")).out, /ok {3}config\.slack_channel — unset/);
    s.config("- slack_channel: #dev");
    assert.match((await v(s, "--config")).out, /FAIL config\.slack_channel — '#dev' is not a chat id/);
    s.setConfig("slack_channel", "C0123ABCD");
    const r = await v(s, "--config");
    assert.equal(r.rc, 0);
    assert.match(r.out, /ok {3}config\.slack_channel — C0123ABCD/);
  }));

test("slack_handoff is anyone when missing, and one of three when set", () =>
  inSandbox(async (s) => {
    s.config("- slack_channel: C0123ABCD");
    assert.match((await v(s, "--config")).out, /ok {3}config\.slack_handoff — anyone may hand off/);
    s.config("- slack_handoff: everybody");
    assert.match((await v(s, "--config")).out, /FAIL config\.slack_handoff — 'everybody' is not anyone, people or off/);
    s.setConfig("slack_handoff", "people");
    const r = await v(s, "--config");
    assert.equal(r.rc, 0);
    assert.match(r.out, /ok {3}config\.slack_handoff — people may hand off/);
  }));

test("slack_automerge is off when missing, and off, people or user ids when set", () =>
  inSandbox(async (s) => {
    s.config("- slack_channel: C0123ABCD");
    assert.match((await v(s, "--config")).out, /ok {3}config\.slack_automerge — off — nobody may ask/);
    s.config("- slack_automerge: everybody");
    assert.match(
      (await v(s, "--config")).out,
      /FAIL config\.slack_automerge — 'everybody' is not off, people or Slack user ids/,
    );
    s.setConfig("slack_automerge", "U0123ABCD, U0456EFGH");
    const r = await v(s, "--config");
    assert.equal(r.rc, 0);
    assert.match(r.out, /ok {3}config\.slack_automerge — U0123ABCD U0456EFGH may ask for auto-merge/);
  }));

test("a grill skill is the repository's when named, the default otherwise", () =>
  inSandbox(async (s) => {
    s.onboarded();
    assert.match(
      (await v(s)).out,
      /ok {3}harness\.skill_grill — unset — the default, \.agents\/defaults\/grill\/SKILL\.md/,
    );
    s.write("work/.claude/skills/grill-me/SKILL.md", "");
    s.config("- skill_grill: grill-me\n- skill_file_issue: drop-issue");
    let r = await v(s);
    assert.match(r.out, /ok {3}harness\.skill_grill — grill-me, the repository's/);
    assert.match(r.out, /FAIL harness\.skill_file_issue — 'drop-issue' is not a skill in work\/\.claude\/skills/);
    s.setConfig("skill_file_issue", null);
    rmSync(join(s.home, ".agents/defaults/file-issue"), { recursive: true });
    r = await v(s);
    assert.match(
      r.out,
      /FAIL harness\.skill_file_issue — unset, and the default \.agents\/defaults\/file-issue\/SKILL\.md is missing/,
    );
  }));

test("work_repo is checked when set", () =>
  inSandbox(async (s) => {
    s.onboarded();
    s.config("- work_repo: acme/widgets-work");
    gh(s, { reach: 2 });
    let r = await v(s, "--live");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /ok {3}config\.work_repo — acme\/widgets-work/);
    assert.match(r.out, /ok {3}live\.work_repo — acme\/widgets-work takes a push/);
    assert.match(r.out, /ok {3}live\.scope — the connection pushes to repo and work_repo alone/);
    gh(s, { reach: 2, workPush: false });
    r = await v(s, "--live");
    assert.match(r.out, /FAIL live\.work_repo — no push to acme\/widgets-work/);
    s.setConfig("work_repo", "acme/widgets");
    assert.match((await v(s, "--config")).out, /FAIL config\.work_repo — is repo itself/);
  }));

test("--live: a GitHub App's login and reach are not measured, and it is told about label_mine", () =>
  inSandbox(async (s) => {
    s.onboarded();
    gh(s, { login: null, installation: 1 });
    let r = await v(s, "--live");
    assert.match(r.out, /warn live\.auth — acting as a GitHub App/);
    assert.match(r.out, /warn live\.mine — no label_mine/);
    assert.match(r.out, /warn live\.push — not measured/);
    assert.doesNotMatch(r.out, /FAIL live\.push/);
    assert.match(r.out, /ok {3}live\.scope/);
    s.config("- label_mine: agent/mine");
    r = await v(s, "--live");
    assert.match(r.out, /ok {3}live\.mine — only pull requests labelled agent\/mine/);
    assert.match(r.out, /FAIL live\.label_mine — no label 'agent\/mine'/);
    gh(s, { login: null });
    r = await v(s, "--live");
    assert.match(r.out, /FAIL live\.auth — GitHub did not answer/);
  }));

test("interactive: only the claim is labelled, and the tick is refused", () =>
  inSandbox(async (s) => {
    s.onboarded();
    s.setConfig("label_handoff", null);
    s.setConfig("label_failed", null);
    s.setConfig("mode", "interactive");
    gh(s, { labels: ["agent/in-progress", "needs-review"] });
    const r = await v(s, "--live");
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /ok {3}config\.mode — interactive/);
    assert.match(r.out, /ok {3}config\.schedules — unset — none/);
    assert.match(r.out, /disabled: software-developer-tick-10m software-developer-audit-weekly/);
    assert.match(r.out, /ok {3}live\.precheck — interactive/);
    assert.doesNotMatch(r.out, /needs-info/, "no default label demanded");
    s.config("- schedules: tick");
    assert.match((await v(s, "--config")).out, /FAIL config\.schedules — lists tick, but mode is interactive/);
    s.setConfig("mode", "autonomous");
    assert.match((await v(s, "--config")).out, /FAIL config\.label_handoff — missing/);
    s.setConfig("mode", "sometimes");
    assert.match((await v(s, "--config")).out, /FAIL config\.mode — 'sometimes'/);
    s.setConfig("mode", null);
    assert.match((await v(s, "--config")).out, /FAIL config\.mode — missing — read as interactive/);
  }));

test("a bad flag is a usage error", () =>
  inSandbox(async (s) => {
    assert.equal((await v(s, "--bogus")).rc, 2);
    writeFileSync(join(s.work, "x"), "");
  }));
