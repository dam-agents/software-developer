// run-state: items and slots taken once, given back on every way out, and a
// dead run's locks freed without losing what it wrote.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runState } from "../src/developer/run-state.ts";
import { iso } from "../src/factory/time.ts";
import { inSandbox, type Sandbox } from "./helpers.ts";

const ISSUE = /^repos\/[^/]+\/[^/]+\/issues\/\d+$/;
const COMMENTS = /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/;
const PULL = /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/;

/** run-state as that session: every test session running, a comment from each on GitHub, an unclaimed issue. */
function world(s: Sandbox): void {
  for (const id of ["sess-a", "sess-b", "sess-c"]) s.runtime.running.add(id);
  s.github
    .on(ISSUE, { labels: [] })
    .on(COMMENTS, [{ user: { login: "dev-bot" }, body: "Done. sess-a sess-b sess-c" }])
    .on(/^repos\/[^/]+\/[^/]+\/pulls\?/, [])
    .on(/\/reviews/, [])
    .on(/\/check-runs/, { check_runs: [] })
    .on(/\/status$/, { statuses: [] });
}
const as = (s: Sandbox, session: string, ...args: string[]) =>
  s.run(runState, args, { CLAUDE_CODE_SESSION_ID: session, SD_WAIT_FOR: "3", SD_WAIT_POLL: "1" });
const locks = (s: Sandbox) => (existsSync(s.locks) ? readdirSync(s.locks) : []);

test("start takes the item and a slot, on a new branch", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    const r = await as(s, "sess-a", "start", "7", "feat/7-flag");
    assert.equal(r.rc, 0, r.err);
    assert.match(r.out, new RegExp(`slot 1: ${s.work}/slots/1 on feat/7-flag`));
    assert.equal(s.slot(1), "feat/7-flag");
    assert.equal(s.field("items/7.md", "state"), "active");
    assert.equal(s.field("items/7.md", "slot"), "1");
    assert.equal((await as(s, "sess-a", "held")).out, "7");
  }));

test("one item, one run; a second run takes another item and slot", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    const r = await as(s, "sess-b", "start", "7", "feat/7");
    assert.equal(r.rc, 1);
    assert.match(r.err, /held by session sess-a/);
    assert.equal((await as(s, "sess-b", "start", "8", "feat/8")).rc, 0);
    assert.equal(s.slot(2), "feat/8");
  }));

test("every slot in use refuses, and keeps nothing", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.config("- slots: 1");
    await as(s, "sess-a", "start", "7", "feat/7");
    const r = await as(s, "sess-b", "start", "8", "feat/8");
    assert.equal(r.rc, 1);
    assert.match(r.err, /all 1 slots are in use/);
    assert.ok(!existsSync(join(s.locks, "item-8")), "kept the item it could not work on");
  }));

test("finish gives everything back and logs the run", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    mkdirSync(join(s.work, "slots/1/dist"));
    writeFileSync(join(s.work, "slots/1/dist/out"), "built\n");
    const r = await as(s, "sess-a", "finish", "released", "21");
    assert.equal(r.rc, 0, r.err);
    assert.deepEqual(locks(s), []);
    assert.equal(s.field("items/7.md", "state"), "released");
    assert.equal(s.field("items/7.md", "pr"), "21");
    assert.equal(s.slot(1), "HEAD", "the slot lets go of the branch");
    assert.ok(existsSync(join(s.work, "slots/1/dist")), "the build output went with it");
    assert.match(s.read("work/TICK.log"), /released session=sess-a issue=7 slot=1 pr=21 minutes=/);
    await as(s, "sess-b", "start", "8", "feat/8");
    await as(s, "sess-c", "start", "7");
    assert.equal(s.slot(1), "feat/8", "8 took the first free slot");
    assert.equal(s.slot(2), "feat/7", "7 resumes its branch from the item record");
  }));

test("with slack_channel set, park and finish say what to post, and only for a moment a person acts on", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "APPROVED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "start", "7", "feat/7");
    let r = await as(s, "sess-a", "park", "21");
    assert.doesNotMatch(r.err, /notify:/, "unset: no posts");
    await as(s, "sess-a", "start", "7", "feat/7");
    s.config("- slack_channel: C0123ABCD");
    s.write("work/items/7.md", s.read("work/items/7.md").replace(/^- notified: .*\n/m, ""));
    r = await as(s, "sess-a", "park", "21");
    assert.match(r.err, /notify: post that #21 is ready to merge to slack_channel C0123ABCD, and record its thread/);
    await as(s, "sess-a", "start", "7", "feat/7");
    r = await as(s, "sess-a", "park", "21");
    assert.doesNotMatch(r.err, /notify:/, "said once for the same pull request");
    await as(s, "sess-a", "start", "7", "feat/7");
    r = await as(s, "sess-a", "finish", "released", "21");
    assert.doesNotMatch(r.err, /notify:/, "merged: nothing left for a person to do");
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.on(ISSUE, { labels: [{ name: "agent/failed" }] });
    r = await as(s, "sess-a", "finish", "blocked");
    assert.match(r.err, /notify: post this blocked to slack_channel C0123ABCD, and record its thread/);
    await as(s, "sess-a", "start", "7", "feat/7");
    r = await as(s, "sess-a", "finish", "waiting-lock");
    assert.doesNotMatch(r.err, /notify:/, "nothing for a person to do");
  }));

test("a thread the item already has in Slack takes its posts, and only one the author left in that chat", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.config("- slack_channel: C0123ABCD");
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github
      .on(ISSUE, {
        labels: [],
        user: { login: "dev-bot" },
        created_at: "2026-01-01T00:00:00Z",
        body: "Filed from Slack.\n<!-- slack-thread: C0123ABCD 1700000000.000100 -->",
      })
      .on(COMMENTS, [
        {
          user: { login: "mallory" },
          created_at: "2026-01-03T00:00:00Z",
          body: "<!-- slack-thread: C0123ABCD 1700000000.000999 -->",
        },
        {
          user: { login: "dev-bot" },
          created_at: "2026-01-02T00:00:00Z",
          body: "Ready to merge. sess-a\n<!-- slack-thread: C9999ZZZZ 1700000000.000555 -->",
        },
      ]);
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "APPROVED", "MERGEABLE", GREEN)];
    const r = await as(s, "sess-a", "park", "21");
    assert.equal(r.rc, 0, r.err);
    assert.match(r.err, /ready to merge as a reply in thread 1700000000\.000100 of slack_channel C0123ABCD/);
  }));

test("an item goes back to its own slot when it is free", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-b", "start", "8", "feat/8");
    await as(s, "sess-a", "finish", "nothing");
    await as(s, "sess-b", "finish", "nothing");
    await as(s, "sess-c", "start", "8");
    assert.equal(s.slot(2), "feat/8", "slot 2, its last");
  }));

test("a slot with unsaved work is never switched", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    writeFileSync(join(s.work, "slots/1/new.txt"), "wip\n");
    s.runtime.running = new Set(["sess-b"]);
    const r = await as(s, "sess-b", "start", "8", "feat/8");
    assert.equal(r.rc, 3, "the dead run's slot holds unsaved work");
    assert.match(r.err, /uncommitted changes on feat\/7/);
    assert.ok(existsSync(join(s.work, "slots/1/new.txt")), "the work was thrown away");
    assert.equal(s.slot(1), "feat/7");
  }));

test("a branch on origin is checked out from its tip", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    const c = join(s.home, "c");
    s.git(["clone", "-q", join(s.home, "widgets.git"), c]);
    s.git(["switch", "-q", "-c", "feat/9"], c);
    writeFileSync(join(c, "nine"), "nine\n");
    s.git(["add", "nine"], c);
    s.git(["commit", "-qm", "nine"], c);
    s.git(["push", "-q", "origin", "feat/9"], c);
    const r = await as(s, "sess-a", "start", "9", "feat/9");
    assert.equal(r.rc, 0, r.err);
    assert.ok(existsSync(join(s.work, "slots/1/nine")), "not on the remote tip");
  }));

test("sweep frees a dead run's locks and counts it on its item", () =>
  inSandbox(async (s) => {
    s.lock("slot-1", {
      session: "sess-x",
      item: "7",
      slot: "1",
      since: s.clock.ago(30),
      phase: "building",
      phase_at: s.clock.ago(20),
    });
    s.lock("item-7", { session: "sess-x", item: "7", slot: "1" });
    s.lock("slot-2", { session: "sess-y", item: "8", slot: "2", boot: "boot-0" });
    s.lock("slot-3", { session: "sess-z", item: "9", slot: "3" });
    s.lock("slot-4", { session: "sess-r", item: "10", slot: "4", boot: "boot-0" });
    s.lock("item-10", { session: "sess-r", item: "10", slot: "4", boot: "boot-0" });
    s.runtime.running = new Set(["sess-z", "sess-r"]);
    const r = await s.run(runState, ["sweep"]);
    assert.equal(r.out, "#7\n#8", "names the abandoned items");
    assert.ok(
      !existsSync(join(s.locks, "slot-1")) && !existsSync(join(s.locks, "item-7")),
      "a dead session's locks stayed",
    );
    assert.ok(!existsSync(join(s.locks, "slot-2")), "a lock from an earlier boot, its session gone, stayed");
    assert.ok(existsSync(join(s.locks, "slot-3")), "freed a live run's slot");
    assert.ok(
      existsSync(join(s.locks, "slot-4")) && existsSync(join(s.locks, "item-10")),
      "freed a turn resumed after a restart",
    );
    assert.equal(s.field("items/7.md", "abandoned"), "1");
    assert.equal(s.field("items/7.md", "state"), "abandoned");
    assert.match(s.read("work/TICK.log"), /abandoned session=sess-x issue=7 slot=1/);
  }));

test("a runtime that does not answer frees nothing", () =>
  inSandbox(async (s) => {
    s.lock("slot-1", { session: "sess-x", item: "7", slot: "1" });
    s.runtime.down = true;
    await s.run(runState, ["sweep"]);
    assert.ok(existsSync(join(s.locks, "slot-1")), "freed on a guess");
  }));

test("an idle direct session keeps its locks for two hours", () =>
  inSandbox(async (s) => {
    s.lock("slot-1", { session: "sess-c", item: "7", slot: "1", since: s.clock.ago(119) });
    s.lock("item-7", { session: "sess-c", item: "7", slot: "1", since: s.clock.ago(119) });
    s.lock("slot-2", { session: "sess-d", item: "8", slot: "2", since: s.clock.ago(121) });
    s.lock("slot-3", { session: "sess-e", item: "9", slot: "3", since: s.clock.ago(300) });
    s.runtime.chats = new Set(["sess-c", "sess-d", "sess-e"]);
    s.runtime.running = new Set(["sess-e"]);
    const r = await s.run(runState, ["sweep"]);
    assert.ok(
      existsSync(join(s.locks, "slot-1")) && existsSync(join(s.locks, "item-7")),
      "freed a direct session waiting on its operator",
    );
    assert.ok(!existsSync(join(s.locks, "slot-2")), "a stale direct session's lock stayed");
    assert.ok(existsSync(join(s.locks, "slot-3")), "freed a direct session running a turn");
    assert.equal(r.out, "#8");
  }));

test("an idle Slack session keeps its locks for two hours", () =>
  inSandbox(async (s) => {
    s.lock("slot-1", { session: "sess-c", item: "7", slot: "1", since: s.clock.ago(30) });
    s.lock("slot-2", { session: "sess-d", item: "8", slot: "2", since: s.clock.ago(30) });
    s.runtime.slack = new Set(["sess-c"]);
    await s.run(runState, ["sweep"]);
    assert.ok(existsSync(join(s.locks, "slot-1")), "freed a Slack session's lock");
    assert.ok(!existsSync(join(s.locks, "slot-2")), "kept an idle scheduled session's lock");
  }));

test("one exclusive lock: a second item waits, and a dead holder leaves it dirty", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-b", "start", "8", "feat/8");
    let r = await as(s, "sess-a", "lock");
    assert.equal(r.rc, 0);
    assert.match(r.out, /lock: yours\./);
    r = await as(s, "sess-b", "lock");
    assert.equal(r.rc, 1, "the second waits");
    assert.equal(s.field("items/8.md", "state"), "waiting-lock");
    s.runtime.running = new Set(["sess-b"]);
    r = await as(s, "sess-b", "lock");
    assert.equal(r.rc, 0, "the holder died: it is freed");
    assert.match(r.out, /bring what exclusive names back to a known state/);
    await as(s, "sess-b", "finish", "pr-updated");
    assert.ok(!existsSync(join(s.locks, "exclusive")), "finish kept the lock");
  }));

test("nothing is held without a session id", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    const r = await as(s, "", "start", "7", "feat/7");
    assert.equal(r.rc, 2);
    assert.ok(!existsSync(join(s.locks, "item-7")), "took a lock nobody can prove alive");
  }));

test("finish refuses until the work is pushed and reported", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    writeFileSync(join(s.work, "slots/1/change.txt"), "change\n");
    let r = await as(s, "sess-a", "finish", "pr-updated");
    assert.equal(r.rc, 1, "unpushed");
    assert.match(r.err, /push it to its branch first/);
    rmSync(join(s.work, "slots/1/change.txt"));
    s.github.on(COMMENTS, [{ user: { login: "dev-bot" }, body: "another run, sess-b" }]);
    r = await as(s, "sess-a", "finish", "pr-updated");
    assert.equal(r.rc, 1, "no comment from this run");
    assert.match(r.err, /no comment from this run on #7/);
    assert.ok(existsSync(join(s.locks, "item-7")), "gave the item back unreported");
    s.write("work/items/7.md", `${s.read("work/items/7.md")}- babysat_out: yes\n`);
    s.github.on(PULL, { state: "open", user: { login: "dev-bot" }, body: "Fixes #8\nhttps://p/a/x?s=sess-a" });
    r = await as(s, "sess-a", "finish", "pr-opened", "21");
    assert.equal(r.rc, 1, "the pull request names another issue");
    assert.match(r.err, /does not say Fixes #7/);
    s.github.on(ISSUE, { labels: [{ name: "agent/in-progress" }] });
    r = await as(s, "sess-a", "finish", "blocked");
    assert.equal(r.rc, 1, "blocked, but still claimed and not failed");
    assert.match(r.err, /still carries agent\/in-progress; #7 does not carry agent\/failed/);
    s.github.on(ISSUE, { labels: [{ name: "agent/failed" }] });
    s.github.on(COMMENTS, [{ user: { login: "dev-bot" }, body: "Blocked. sess-a" }]);
    r = await as(s, "sess-a", "finish", "blocked");
    assert.equal(r.rc, 0, r.err);
  }));

test("GitHub unreadable: the run closes, logged as unverified", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.on(COMMENTS, undefined);
    const r = await as(s, "sess-a", "finish", "pr-updated");
    assert.equal(r.rc, 0);
    assert.match(s.read("work/TICK.log"), /report=unverified/);
  }));

const view = (state: string, decision: string, mergeable: string, checks: unknown[], reviews: unknown[] = []) => ({
  state,
  reviewDecision: decision,
  mergeable,
  headRefOid: "abc",
  statusCheckRollup: checks,
  latestReviews: reviews,
});
const RUNNING = [{ name: "e2e", status: "IN_PROGRESS", conclusion: "" }];
const GREEN = [{ name: "e2e", conclusion: "SUCCESS", completedAt: "2026-09-24T10:00:00Z" }];
const PULL21 = {
  number: 21,
  state: "open",
  mergeable: true,
  head: { sha: "abc" },
  user: { login: "dev-bot" },
  body: "Fixes #7 sess-a",
};

test("a run keeps its pull request until it is done", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.on(PULL, { state: "open", user: { login: "dev-bot" }, body: "Fixes #7 sess-a" });
    const r = await as(s, "sess-a", "finish", "pr-opened", "21");
    assert.equal(r.rc, 1, "opening it is not the end");
    assert.match(r.err, /run-state\.sh" wait 21/);
    assert.ok(existsSync(join(s.locks, "item-7")), "gave the item back");
  }));

test("wait comes back with nothing yet while checks run, then with a review", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", RUNNING)];
    let r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 3);
    assert.match(r.out, /nothing yet — checks running\. Call wait again/);
    assert.match(s.field("items/7.md", "pr"), /21/);
    s.clock.advance(1);
    const review = [{ author: { login: "guardian" }, state: "CHANGES_REQUESTED", submittedAt: iso(s.clock.now()) }];
    s.github.prViews = [
      view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", RUNNING),
      view("OPEN", "CHANGES_REQUESTED", "MERGEABLE", RUNNING, review),
    ];
    r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 0);
    assert.match(r.out, /reviewed by guardian \(CHANGES_REQUESTED\): resolve every finding/);
    s.github.prViews = [view("OPEN", "CHANGES_REQUESTED", "MERGEABLE", RUNNING, review)];
    r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 3, "a review already answered is not new");
  }));

test("approved is a wait for the merge; merged is done, and then finish releases", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.prViews = [view("OPEN", "APPROVED", "MERGEABLE", GREEN)];
    let r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 3, "approved, green and mergeable still waits for a person");
    assert.match(r.out, /approved, green and mergeable: waiting to be merged/);
    s.github.prViews = [view("MERGED", "APPROVED", "UNKNOWN", GREEN)];
    r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 0);
    assert.match(r.out, /merged — the pull request is merged: release the issue/);
    r = await as(s, "sess-a", "finish", "released", "21");
    assert.equal(r.rc, 0, r.err);
  }));

test("a second approval is not a round; findings after approval are", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    await as(s, "sess-a", "start", "7", "feat/7");
    const late = [{ author: { login: "guardian" }, state: "APPROVED", submittedAt: s.clock.ago(-1) }];
    s.github.prViews = [view("OPEN", "APPROVED", "MERGEABLE", GREEN, late)];
    let r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 3, "an approval on an approved pull request is nothing to do");
    const findings = [{ author: { login: "alice" }, state: "COMMENTED", submittedAt: s.clock.ago(-2) }];
    s.github.prViews = [view("OPEN", "APPROVED", "MERGEABLE", GREEN, findings)];
    r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 0, "a review with findings after approval is a round");
    assert.match(r.out, /reviewed by alice \(COMMENTED\)/);
  }));

test("a failed check is something to do", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.prViews = [
      view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", [
        { name: "test", conclusion: "FAILURE", completedAt: s.clock.ago(-1) },
      ]),
    ];
    const r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 0);
    assert.match(r.out, /checks failed: test/);
  }));

test("after babysit_max_hours, wait hands it on and finish lets it go", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.config("- babysit_max_hours: 1");
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "wait", "21");
    s.write(
      "work/items/7.md",
      s.read("work/items/7.md").replace(/^- babysit_since: .*$/m, `- babysit_since: ${s.clock.ago(61)}`),
    );
    let r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 4);
    assert.match(r.out, /babysat #21 for 1h/);
    r = await as(s, "sess-a", "finish", "pr-updated", "21");
    assert.equal(r.rc, 0, r.err);
    await as(s, "sess-b", "start", "7");
    assert.equal(s.field("items/7.md", "babysat_out"), "", "the next run babysits afresh");
  }));

test("wait reads GraphQL only when the pull request changed", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.etag = '"e1"';
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", RUNNING)];
    const r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 3);
    assert.match(r.out, /checks running/);
    assert.equal(s.github.count(/^pr view/), 1, "one GraphQL read for three looks");
  }));

test("GraphQL refused, wait reads REST, and an approval there is never done", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github
      .on(PULL, PULL21)
      .on(/\/check-runs/, {
        check_runs: [
          { id: 1, name: "e2e", status: "completed", conclusion: "success", completed_at: "2026-09-24T10:00:00Z" },
        ],
      })
      .on(/\/reviews/, [{ user: { login: "maintainer" }, state: "APPROVED", submitted_at: "2020-01-01T00:00:00Z" }]);
    await as(s, "sess-a", "start", "7", "feat/7");
    let r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 3, "not done");
    assert.match(r.out, /approved, green and mergeable: waiting to be merged/);
    s.github.on(/\/reviews/, [
      { user: { login: "guardian" }, state: "CHANGES_REQUESTED", submitted_at: s.clock.ago(-1) },
    ]);
    r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 0, "a review is still something to do");
    assert.match(r.out, /reviewed by guardian \(CHANGES_REQUESTED\)/);
  }));

test("finish with nothing held still logs the run", () =>
  inSandbox(async (s) => {
    const r = await as(s, "sess-a", "finish", "nothing");
    assert.equal(r.rc, 0);
    assert.match(s.read("work/TICK.log"), /nothing session=sess-a issue=- slot=-/);
  }));

test("label_mine: pr-opened needs the label; a bot's login matches in any spelling", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.setConfig("author", "dev-app[bot]");
    s.config("- label_mine: agent/mine");
    s.github.on(ISSUE, { labels: [] });
    await as(s, "sess-a", "start", "7", "feat/7");
    s.write("work/items/7.md", `${s.read("work/items/7.md")}- babysat_out: yes\n`);
    s.github.on(PULL, { state: "open", user: { login: "Dev-App[bot]" }, labels: [], body: "Fixes #7 sess-a" });
    let r = await as(s, "sess-a", "finish", "pr-opened", "21");
    assert.equal(r.rc, 1, "unlabelled");
    assert.match(r.err, /does not carry agent\/mine/);
    assert.doesNotMatch(r.err, /was not opened by/, "the login matched");
    s.github.on(PULL, {
      state: "open",
      user: { login: "dev-app[bot]" },
      labels: [{ name: "agent/mine" }],
      body: "Fixes #7 sess-a",
    });
    r = await as(s, "sess-a", "finish", "pr-opened", "21");
    assert.equal(r.rc, 0, r.err);
  }));

test("start refuses another agent's work: its claim, its pull request, an unreadable issue", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.setConfig("author", "dev-app[bot]");
    s.config("- label_mine: agent/mine");
    s.github.on(ISSUE, { labels: [{ name: "agent/in-progress" }] });
    let r = await as(s, "sess-a", "start", "7", "feat/7");
    assert.equal(r.rc, 1, "claimed without agent/mine");
    assert.match(r.err, /another agent's claim/);
    assert.equal(s.slot(1), "", "no slot was touched");
    assert.ok(!existsSync(join(s.locks, "item-7")), "the item stays free");
    s.github.on(ISSUE, { labels: [] });
    s.github.on(/^repos\/[^/]+\/[^/]+\/pulls\?/, [
      { number: 99, user: { login: "dev-app[bot]" }, labels: [], body: "Fixes #7" },
    ]);
    r = await as(s, "sess-a", "start", "7", "feat/7");
    assert.equal(r.rc, 1, "named by a pull request without agent/mine");
    assert.match(r.err, /pull request #99, not ours/);
    s.github.on(ISSUE, undefined);
    r = await as(s, "sess-a", "start", "7", "feat/7");
    assert.equal(r.rc, 1, "unreadable is not ours");
    assert.match(r.err, /was not measured/);
    s.github.on(PULL, { number: 21, user: { login: "dev-app[bot]" }, labels: [] });
    r = await as(s, "sess-a", "start", "pr21", "feat/x");
    assert.equal(r.rc, 1, "a pull request item without agent/mine");
    s.github.on(/^repos\/[^/]+\/[^/]+\/pulls\?/, [
      { number: 98, user: { login: "dev-app[bot]" }, labels: [{ name: "agent/mine" }], body: "Fixes #7" },
    ]);
    s.github.on(ISSUE, { labels: [{ name: "agent/in-progress" }, { name: "agent/mine" }] });
    r = await as(s, "sess-a", "start", "7", "feat/7");
    assert.equal(r.rc, 0, `our claim and our pull request: ${r.err}`);
    s.github.on(ISSUE, { labels: [{ name: "agent/mine" }] });
    r = await as(s, "sess-a", "finish", "released");
    assert.equal(r.rc, 1, "releasing drops agent/mine too");
    assert.match(r.err, /still carries agent\/mine/);
  }));

/** beta/kits as a bare repository the fake's clone reads. */
function kitsOrigin(s: Sandbox): void {
  const seed = join(s.home, "kseed");
  s.git(["init", "-q", "--bare", "-b", "main", join(s.home, "beta/kits.git")]);
  s.git(["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "kits\n");
  s.git(["add", "-A"], seed);
  s.git(["commit", "-qm", "init"], seed);
  s.git(["push", "-q", join(s.home, "beta/kits.git"), "main"], seed);
  s.github.cloneRoot = s.home;
  s.config("- repos_also: beta/*");
}

test("also: another repository beside the slot, on its branch, only as repos_also allows", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    kitsOrigin(s);
    let r = await as(s, "sess-a", "also", "beta/kits");
    assert.equal(r.rc, 1, "no slot yet");
    await as(s, "sess-a", "start", "7", "feat/7");
    r = await as(s, "sess-a", "also", "gamma/kits");
    assert.equal(r.rc, 1, "not allowed");
    assert.match(r.err, /neither `repo` nor named by `repos_also`/);
    r = await as(s, "sess-a", "also", "beta/kits");
    assert.equal(r.rc, 0, r.err);
    assert.match(r.out, new RegExp(`also beta/kits: ${s.work}/also/kits/1 on feat/7`));
    assert.equal(
      s.git(["-C", join(s.work, "also/kits/1"), "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
      "feat/7",
    );
    assert.equal((await as(s, "sess-a", "also", "beta/kits")).rc, 0, "again is the same worktree");
    writeFileSync(join(s.work, "also/kits/1/change.txt"), "change\n");
    s.write("work/items/7.md", `${s.read("work/items/7.md")}- babysat_out: yes\n`);
    r = await as(s, "sess-a", "finish", "pr-updated");
    assert.equal(r.rc, 1, "unpushed there");
    assert.match(r.err, /also\/kits\/1 has uncommitted changes/);
    rmSync(join(s.work, "also/kits/1/change.txt"));
    r = await as(s, "sess-a", "finish", "pr-updated");
    assert.equal(r.rc, 0, r.err);
    assert.equal(s.git(["-C", join(s.work, "also/kits/1"), "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(), "HEAD");
  }));

test("several pull requests: Fixes on one, Part of on the others, and wait waits for all", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    await as(s, "sess-a", "start", "7", "feat/7");
    s.write("work/items/7.md", `${s.read("work/items/7.md")}- babysat_out: yes\n`);
    s.github.on(PULL, { state: "open", user: { login: "dev-bot" }, body: "Fixes #7 sess-a" });
    let r = await as(s, "sess-a", "finish", "pr-opened", "21", "beta/kits#30");
    assert.equal(r.rc, 1, "a bare #7 elsewhere is that repository's");
    assert.match(r.err, /pull request beta\/kits#30 does not say Fixes or Part of acme\/widgets#7/);
    s.github.on(PULL, { state: "open", user: { login: "dev-bot" }, body: "Part of acme/widgets#7 sess-a" });
    r = await as(s, "sess-a", "finish", "pr-opened", "21", "beta/kits#30");
    assert.equal(r.rc, 1, "nothing closes the issue");
    assert.match(r.err, /none of them says Fixes #7/);
    s.write("work/items/7.md", s.read("work/items/7.md").replace(/^- babysat_out: .*\n/m, ""));
    s.github.on(PULL, PULL21);
    s.github.prViews = [
      view("OPEN", "APPROVED", "MERGEABLE", GREEN),
      view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", RUNNING),
    ];
    r = await as(s, "sess-a", "wait", "21", "beta/kits#30");
    assert.equal(r.rc, 3, "one approved is not done");
    assert.match(r.out, /beta\/kits#30: checks running/);
    assert.equal(s.field("items/7.md", "pr"), "21 beta/kits#30");
    s.github.prViews = [view("MERGED", "APPROVED", "UNKNOWN", GREEN)];
    r = await as(s, "sess-a", "wait", "21", "beta/kits#30");
    assert.equal(r.rc, 0);
    assert.match(r.out, /merged — every pull request is merged/);
    assert.equal((await as(s, "sess-a", "wait", "21", "kits#x")).rc, 2, "a malformed ref");
  }));

test("interactive: the operator holds the pull request, so opening it ends the run", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.setConfig("mode", "interactive");
    await as(s, "sess-a", "start", "7", "feat/7");
    s.github.on(PULL, { state: "open", user: { login: "dev-bot" }, body: "Fixes #7 sess-a" });
    const r = await as(s, "sess-a", "finish", "pr-opened", "21");
    assert.equal(r.rc, 0, r.err);
    assert.ok(!existsSync(join(s.locks, "item-7")), "kept the item");
    assert.equal(s.field("items/7.md", "pr"), "21");
  }));

const COMMENTS21 = /^repos\/[^/]+\/[^/]+\/issues\/21\/comments/;

test("park frees the slot and the exclusive lock, keeps the item, and needs the round reported", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-a", "lock");
    s.github.on(COMMENTS, []);
    let r = await as(s, "sess-a", "park", "21");
    assert.equal(r.rc, 1, "no report yet");
    assert.match(r.err, /not reported yet/);
    s.github.on(COMMENTS, [{ user: { login: "dev-bot" }, body: "Round 1 pushed. sess-a" }]);
    r = await as(s, "sess-a", "park", "21");
    assert.equal(r.rc, 0, r.err);
    assert.match(r.out, /parked #7 \(in-review\)/);
    assert.match(r.out, /wait --park/);
    assert.deepEqual(locks(s).sort(), ["item-7"], "the item alone stays");
    assert.equal(s.field("items/7.md", "state"), "in-review");
    assert.equal(s.field("items/7.md", "session"), "sess-a");
    assert.notEqual(s.read("locks/item-7/owner").match(/^- parked_at: /m), null);
    assert.match(s.read("work/TICK.log"), /parked session=sess-a issue=7 slot=1 pr=21 .*state=in-review/);
    // another run cannot take it, and every slot is free for other items
    assert.equal((await as(s, "sess-b", "start", "7", "feat/7")).rc, 1);
    assert.equal((await as(s, "sess-b", "start", "8", "feat/8")).rc, 0);
  }));

test("park refuses unpushed work, and merged pull requests are released, not parked", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    await as(s, "sess-a", "start", "7", "feat/7");
    writeFileSync(join(s.work, "slots", "1", "new.txt"), "x\n");
    let r = await as(s, "sess-a", "park", "21");
    assert.equal(r.rc, 1);
    assert.match(r.err, /push it to its branch first/);
    rmSync(join(s.work, "slots", "1", "new.txt"));
    s.github.prViews = [view("MERGED", "APPROVED", "UNKNOWN", GREEN)];
    r = await as(s, "sess-a", "park", "21");
    assert.equal(r.rc, 1);
    assert.match(r.err, /merged or closed — nothing waits: release the issue/);
    assert.equal((await as(s, "sess-a", "park")).rc, 2, "names no pull request");
  }));

test("approved, it parks awaiting the merge", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "APPROVED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "start", "7", "feat/7");
    const r = await as(s, "sess-a", "park", "21");
    assert.equal(r.rc, 0, r.err);
    assert.equal(s.field("items/7.md", "state"), "awaiting-merge");
  }));

test("the waiter wakes its session for a comment after approval, and for the merge", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "APPROVED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-a", "park", "21");
    const waiter = (env: Record<string, string> = {}) =>
      s.run(runState, ["wait", "--park"], {
        CLAUDE_CODE_SESSION_ID: "sess-a",
        SD_PARK_FOR: "3",
        SD_WAIT_POLL: "1",
        SD_WAITER_PID: "777",
        ...env,
      });
    let r = await waiter();
    assert.equal(r.rc, 3, "nothing came");
    assert.match(r.out, /Start the waiter again/);
    assert.doesNotMatch(s.read("locks/item-7/owner"), /^- waiter: /m, "an exited waiter leaves no pid behind");
    s.clock.advance(5);
    s.github.on(COMMENTS21, [
      { user: { login: "passer-by" }, author_association: "NONE", body: "+1", created_at: iso(s.clock.now()) },
      {
        user: { login: "alice" },
        author_association: "MEMBER",
        body: "Rename the flag first",
        created_at: iso(s.clock.now()),
      },
    ]);
    r = await waiter();
    assert.equal(r.rc, 0);
    assert.match(r.out, /#7 needs this session — commented by alice, after approval: answer every comment/);
    assert.match(r.out, /run-state\.sh" start 7/);
    assert.match(s.read("locks/item-7/owner"), /^- woke: waiter$/m);
    // the session takes it back: logged as continued, by its waiter
    r = await as(s, "sess-a", "start", "7");
    assert.equal(r.rc, 0, r.err);
    assert.match(s.read("work/TICK.log"), /resumed session=sess-a issue=7 slot=1 pr=21 .*cause=waiter$/m);
    assert.doesNotMatch(s.read("locks/item-7/owner"), /^- (parked_at|woke|waiter):/m, "the turn holds it again");
    // parked again, the merge wakes it
    s.github.on(COMMENTS, [{ user: { login: "dev-bot" }, body: "Renamed. sess-a" }]);
    await as(s, "sess-a", "park", "21");
    s.github.prViews = [view("MERGED", "APPROVED", "UNKNOWN", GREEN)];
    r = await waiter();
    assert.equal(r.rc, 0);
    assert.match(r.out, /merged — the pull request is merged: release the issue/);
  }));

test("a second waiter steps aside, and a waiter whose session took its item back stops", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-a", "park", "21");
    s.write("locks/item-7/owner", `${s.read("locks/item-7/owner")}- waiter: 555\n- waiter_boot: boot-1\n`);
    const r = await s.run(runState, ["wait", "--park"], {
      CLAUDE_CODE_SESSION_ID: "sess-a",
      SD_WAITER_PID: "777",
      SD_LIVE_PIDS: "555",
    });
    assert.equal(r.rc, 5);
    assert.match(r.out, /already has a waiter \(pid 555\)/);
    await as(s, "sess-a", "start", "7");
    const w = await s.run(runState, ["wait", "--park"], { CLAUDE_CODE_SESSION_ID: "sess-a", SD_WAITER_PID: "777" });
    assert.equal(w.rc, 1, "nothing parked any more");
  }));

test("a booked wake-up holds a parked item across a restart, and resumes the same session", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-a", "park", "21");
    s.runtime.running.delete("sess-a");
    assert.equal((await as(s, "sess-a", "booked", "garbage")).rc, 2);
    let r = await as(s, "sess-a", "booked", s.clock.ago(-120), "sched-1");
    assert.equal(r.rc, 0, r.err);
    await as(s, "sess-b", "sweep");
    assert.ok(existsSync(join(s.locks, "item-7")), "the booking holds it: no waiter, the session not running");
    s.clock.advance(121 * 60);
    r = await as(s, "sess-a", "start", "7");
    assert.equal(r.rc, 0, r.err);
    assert.match(s.read("work/TICK.log"), /resumed session=sess-a issue=7 .*cause=booking$/m);
  }));

test("a parked item with nothing left to wake it is handed on, and its next run says so", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-a", "park", "21");
    await as(s, "sess-a", "booked", s.clock.ago(-10));
    s.runtime.running.delete("sess-a");
    s.clock.advance(41 * 60);
    await as(s, "sess-b", "sweep");
    assert.ok(!existsSync(join(s.locks, "item-7")), "the booking is overdue past its grace, its waiter gone");
    assert.match(s.read("work/TICK.log"), /abandoned session=sess-a issue=7 .*parked, its waiter gone/);
    const r = await as(s, "sess-b", "start", "7");
    assert.equal(r.rc, 0, r.err);
    assert.match(s.read("work/TICK.log"), /resumed session=sess-b issue=7 .*cause=fresh prev=sess-a$/m);
  }));

test("a parked item woken while every slot is busy stays parked, not freed", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", GREEN)];
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-a", "park", "21");
    s.write("locks/item-7/owner", `${s.read("locks/item-7/owner")}- waiter: 99\n- waiter_boot: boot-1\n`);
    for (const [sess, n] of [
      ["sess-b", "8"],
      ["sess-c", "9"],
      ["sess-d", "10"],
    ] as const) {
      s.runtime.running.add(sess);
      assert.equal((await as(s, sess, "start", n, `feat/${n}`)).rc, 0);
    }
    const r = await s.run(runState, ["start", "7"], { CLAUDE_CODE_SESSION_ID: "sess-a", SD_LIVE_PIDS: "99" });
    assert.equal(r.rc, 1);
    assert.match(r.err, /#7 stays parked/);
    assert.match(s.read("locks/item-7/owner"), /^- parked_at: /m, "still parked");
    s.runtime.running.add("sess-e");
    assert.equal((await as(s, "sess-e", "start", "7", "feat/7")).rc, 1, "no other run takes it");
  }));

test("wait refuses while the exclusive lock is held", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    await as(s, "sess-a", "start", "7", "feat/7");
    await as(s, "sess-a", "lock");
    const r = await as(s, "sess-a", "wait", "21");
    assert.equal(r.rc, 1);
    assert.match(r.err, /you hold the exclusive lock: unlock it first/);
  }));

test("may-stop: a held run may not; at rest it may", () =>
  inSandbox(async (s) => {
    world(s);
    s.originCheckout();
    s.github.on(PULL, PULL21);
    s.github.prViews = [view("OPEN", "REVIEW_REQUIRED", "MERGEABLE", GREEN)];
    assert.equal((await as(s, "sess-a", "may-stop")).rc, 0, "nothing held");
    await as(s, "sess-a", "start", "7", "feat/7");
    let r = await as(s, "sess-a", "may-stop");
    assert.equal(r.rc, 1);
    assert.match(r.err, /this run still holds #7/);
    await as(s, "sess-a", "park", "21");
    r = await as(s, "sess-a", "may-stop");
    assert.equal(r.rc, 1, "parked with nothing to wake it");
    s.write("locks/item-7/owner", `${s.read("locks/item-7/owner")}- waiter: 99\n- waiter_boot: boot-1\n`);
    r = await s.run(runState, ["may-stop"], { CLAUDE_CODE_SESSION_ID: "sess-a", SD_LIVE_PIDS: "99" });
    assert.equal(r.rc, 0, "its waiter runs");
    r = await s.run(runState, ["may-stop"], {
      CLAUDE_CODE_SESSION_ID: "sess-a",
      SD_LIVE_PIDS: "99",
      SD_BOOT_ID: "boot-2",
    });
    assert.equal(r.rc, 1, "after a restart, the same pid is not its waiter");
  }));

test("unknown verbs and outcomes are usage errors", () =>
  inSandbox(async (s) => {
    assert.equal((await s.run(runState, ["bogus"])).rc, 2);
    assert.equal((await as(s, "sess-a", "finish", "maybe")).rc, 2);
  }));
