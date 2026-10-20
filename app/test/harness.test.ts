// The Claude Code wiring: the Stop hook keeps a turn that holds an item
// going, up to a limit; install registers it and links the skills.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { enforceFinish, install, repoAllowed, sessionLink } from "../src/developer/harness.ts";
import { verify } from "../src/developer/verify.ts";
import { inSandbox, type Sandbox } from "./helpers.ts";

const stop = (s: Sandbox, sid: string, tasks: { command: string }[] = [], env: Record<string, string> = {}) =>
  s.run(enforceFinish, [], env, JSON.stringify({ session_id: sid, stop_hook_active: false, background_tasks: tasks }));

test("a session holding nothing stops", () =>
  inSandbox(async (s) => {
    s.lock("item-7", { session: "sess-b", item: "7" });
    const r = await stop(s, "sess-a");
    assert.equal(r.rc, 0);
    assert.equal(r.err, "");
  }));

test("a session holding an item is kept going, three times", () =>
  inSandbox(async (s) => {
    s.runtime.running.add("sess-a");
    s.lock("item-7", { session: "sess-a", item: "7", phase: "verify" });
    let r = await stop(s, "sess-a");
    assert.equal(r.rc, 2);
    assert.match(r.err, /Stop blocked \(1\/3\): this run still holds #7, last at "verify"/);
    assert.match(r.err, /run-state\.sh" finish/);
    assert.match(r.err, /run-state\.sh" park <pr>/, "waiting on a person is a way out too");
    await stop(s, "sess-a");
    r = await stop(s, "sess-a");
    assert.equal(r.rc, 2, "third");
    assert.match(r.err, /This is the last block/);
    r = await stop(s, "sess-a");
    assert.equal(r.rc, 0, "then it lets the stop through; the precheck finds the run dead");
  }));

test("the direct session stops freely, even holding an item", () =>
  inSandbox(async (s) => {
    s.runtime.running.add("sess-a");
    s.runtime.chats.add("sess-a");
    s.lock("item-7", { session: "sess-a", item: "7", phase: "verify" });
    const r = await stop(s, "sess-a");
    assert.equal(r.rc, 0);
    assert.equal(r.err, "");
  }));

test("a Slack session stops freely, even holding an item", () =>
  inSandbox(async (s) => {
    s.runtime.slack.add("sess-a");
    s.lock("item-7", { session: "sess-a", item: "7", phase: "verify" });
    assert.equal((await stop(s, "sess-a")).rc, 0);
  }));

test("a runtime that does not answer holds the run as before", () =>
  inSandbox(async (s) => {
    s.runtime.down = true;
    s.lock("item-7", { session: "sess-a", item: "7" });
    assert.equal((await stop(s, "sess-a")).rc, 2);
  }));

test("a parked item with its waiter running stops; parked with nothing to wake it does not", () =>
  inSandbox(async (s) => {
    s.runtime.running.add("sess-a");
    s.lock("item-7", { session: "sess-a", item: "7", parked_at: s.clock.ago(1), phase: "parked: in-review" });
    let r = await stop(s, "sess-a");
    assert.equal(r.rc, 2, "parked, but nothing will wake it");
    assert.match(r.err, /#7 is parked, but nothing will wake this session/);
    assert.match(r.err, /wait --park/);
    r = await stop(s, "sess-a", [{ command: 'bash "$HOME/scripts/run-state.sh" wait --park' }]);
    assert.equal(r.rc, 0, "the harness lists its waiter: at rest");
    s.write("locks/item-7/owner", `${s.read("locks/item-7/owner")}- waiter: 4242\n- waiter_boot: boot-1\n`);
    assert.equal((await stop(s, "sess-a", [], { SD_LIVE_PIDS: "4242" })).rc, 0, "its waiter's pid is alive");
    assert.equal((await stop(s, "sess-a", [], { SD_LIVE_PIDS: "" })).rc, 2, "its waiter died");
    s.write("locks/item-7/owner", `${s.read("locks/item-7/owner")}- wake_at: ${s.clock.ago(-90)}\n`);
    assert.equal((await stop(s, "sess-a", [], { SD_LIVE_PIDS: "" })).rc, 0, "a wake-up is booked");
  }));

test("parked does not excuse a slot or the exclusive lock still held", () =>
  inSandbox(async (s) => {
    s.runtime.running.add("sess-a");
    s.lock("item-7", { session: "sess-a", item: "7", parked_at: s.clock.ago(1) });
    s.lock("exclusive", { session: "sess-a", item: "7" });
    const r = await stop(s, "sess-a", [{ command: "run-state.sh wait --park" }]);
    assert.equal(r.rc, 2);
    assert.match(r.err, /you hold the exclusive lock/);
  }));

test("garbage in never blocks", () =>
  inSandbox(async (s) => {
    assert.equal((await s.run(enforceFinish, [], {}, "not json")).rc, 0);
  }));

const forced = { FORCE_INSTALL: "1" };

test("install registers the hook once, beside the settings already there", () =>
  inSandbox(async (s) => {
    s.write(
      ".claude/settings.json",
      JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "/other.sh" }] }] } }),
    );
    await s.run(install, [], forced);
    await s.run(install, [], forced);
    const settings = JSON.parse(s.read(".claude/settings.json")) as {
      model: string;
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    assert.equal(settings.model, "opus", "kept the settings");
    assert.deepEqual(
      settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)),
      ["/other.sh", `${s.home}/scripts/harness/claude-code/enforce-finish.sh`],
      "once, after the other",
    );
  }));

test("install says so on another harness, and installs nothing", () =>
  inSandbox(async (s) => {
    const r = await s.run(install, [], { CLAUDECODE: undefined, FORCE_INSTALL: undefined });
    assert.equal(r.rc, 0);
    assert.match(r.out, /not the Claude Code harness/);
    assert.ok(!existsSync(join(s.home, ".claude/settings.json")));
  }));

test("install links our skills and the repository's, and leaves a real directory alone", () =>
  inSandbox(async (s) => {
    s.write(".agents/skills/implement-issue/SKILL.md", "");
    s.write("work/widgets/.agents/skills/build-it/SKILL.md", "");
    let r = await s.run(install, [], forced);
    assert.equal(r.rc, 0, r.out);
    assert.ok(existsSync(join(s.home, ".claude/skills/implement-issue/SKILL.md")), "our skill does not resolve");
    assert.ok(existsSync(join(s.work, ".claude/skills/build-it/SKILL.md")), "the repository's skill does not resolve");
    assert.match(r.out, /linked work\/\.claude\/skills -> widgets\/\.agents\/skills \(1 skills\)/);
    mkdirSync(join(s.work, "widgets/.claude/skills/other"), { recursive: true });
    await s.run(install, [], forced);
    assert.ok(
      existsSync(join(s.work, ".claude/skills/other")),
      ".claude/skills is preferred when the repository has it",
    );
    rmSync(join(s.work, ".claude/skills"));
    mkdirSync(join(s.work, ".claude/skills"));
    r = await s.run(install, [], forced);
    assert.equal(r.rc, 1, "a real directory is not replaced");
    assert.match(r.out, /is not a link — left alone/);
  }));

test("verify fails unlinked repository skills", () =>
  inSandbox(async (s) => {
    s.onboarded();
    s.write("work/widgets/.agents/skills/build-it/SKILL.md", "");
    let r = await s.run(verify, []);
    assert.match(r.out, /FAIL harness\.repo_skills/);
    await s.run(install, [], forced);
    r = await s.run(verify, []);
    assert.match(r.out, /ok {3}harness\.repo_skills/);
  }));

test("session-link names the session, or the agent without one", () =>
  inSandbox(async (s) => {
    let r = await s.run(sessionLink, [], { PLATFORM_AGENT_ID: "agent-1", CLAUDE_CODE_SESSION_ID: "sess-a" });
    assert.equal(r.out, "https://platform.example.com/a/agent-1?s=sess-a");
    r = await s.run(sessionLink, [], { PLATFORM_AGENT_ID: "agent-1" });
    assert.equal(r.out, "https://platform.example.com/a/agent-1");
    s.setConfig("app_url", null);
    r = await s.run(sessionLink, [], { PLATFORM_AGENT_ID: "agent-1" });
    assert.equal(r.rc, 1);
    assert.match(r.err, /no app_url/);
  }));

const allowed = async (s: Sandbox, slug: string) => ((await s.run(repoAllowed, [slug])).rc === 0 ? "yes" : "no");

test("repo-allowed: repo always, repos_also only as written, nothing else", () =>
  inSandbox(async (s) => {
    assert.equal(await allowed(s, "acme/widgets"), "yes");
    assert.equal(await allowed(s, "ACME/Widgets"), "yes", "repo, other case");
    assert.equal(await allowed(s, "acme/gadgets"), "no", "a sibling");
    s.config("- repos_also: Beta/*, gamma/one");
    assert.equal(await allowed(s, "beta/gadgets"), "yes");
    assert.equal(await allowed(s, "gamma/one"), "yes");
    assert.equal(await allowed(s, "gamma/two"), "no");
    assert.equal(await allowed(s, "evil/beta"), "no", "the owner as a name");
    assert.equal(await allowed(s, "beta/"), "no");
    assert.equal(await allowed(s, "beta/a/b"), "no");
    assert.equal(await allowed(s, "beta"), "no");
    assert.equal((await s.run(repoAllowed, [])).rc, 2, "usage");
  }));

test("the shims call commands the CLI has", () => {
  const shim = readFileSync(join(import.meta.dirname, "../../scripts/harness/claude-code/enforce-finish.sh"), "utf8");
  assert.match(shim, /bin\/sd" hook-stop/);
});
