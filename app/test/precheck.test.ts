// precheck: the verdict for every combination of slots, live runs, cached
// items and work on GitHub.
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { precheck } from "../src/developer/precheck.ts";
import { graphqlOf, inSandbox, type Sandbox } from "./helpers.ts";

const ISSUE7 = [{ number: 7, title: "Add a flag", url: "https://gh/7", labels: [{ name: "agent/implement" }] }];
const ISSUES78 = [
  { number: 8, title: "Newer", url: "https://gh/8", labels: [{ name: "agent/implement" }] },
  { number: 7, title: "Older", url: "https://gh/7", labels: [{ name: "agent/implement" }] },
];
type R = Record<string, unknown>;
const gql = (s: Sandbox, prs: R[] = [], handoff: R[] = [], claimed: R[] = []) => {
  s.github.graphqlData = graphqlOf(prs, handoff, claimed);
};
/** Every slot held by a live run, its last sign `quietMin` ago. */
function full(s: Sandbox, quietMin = 5): void {
  for (const k of [1, 2, 3]) {
    s.lock(`slot-${k}`, {
      session: `sess-${k}`,
      item: String(k),
      slot: String(k),
      since: s.clock.ago(400),
      phase: "x",
      phase_at: s.clock.ago(quietMin),
    });
    s.runtime.running.add(`sess-${k}`);
  }
}
const locked = (s: Sandbox) => existsSync(s.locks) && readdirSync(s.locks).length > 0;
const pc = (s: Sandbox, env: Record<string, string> = {}) => s.run(precheck, [], env);

test("nothing to do declines and writes nothing", () =>
  inSandbox(async (s) => {
    const r = await pc(s);
    assert.equal(r.rc, 1);
    assert.ok(!locked(s), "took a lock");
  }));

test("work lets a run through, oldest issue first, and claims nothing", () =>
  inSandbox(async (s) => {
    gql(s, [], ISSUES78);
    const r = await pc(s);
    assert.equal(r.rc, 0);
    assert.match(r.out, /Take the first item below/);
    assert.equal(/#[78] /.exec(r.out)?.[0], "#7 ", "oldest first");
    assert.ok(!locked(s), "took a lock");
  }));

test("every slot held by a live run declines before any GitHub call", () =>
  inSandbox(async (s) => {
    full(s);
    gql(s, [], ISSUE7);
    assert.equal((await pc(s)).rc, 1);
    assert.deepEqual(s.github.calls, []);
  }));

test("every slot held, one silent past stuck_after_min, asks for a diagnostic", () =>
  inSandbox(async (s) => {
    full(s, 130);
    gql(s, [], ISSUE7);
    const r = await pc(s);
    assert.equal(r.rc, 0);
    assert.match(r.out, /DIAGNOSTIC RUN/);
    assert.match(r.out, /session sess-1, slot 1, #1/);
    assert.deepEqual(s.github.calls, []);
    assert.equal(s.field("GATE.md", "diagnoses"), "1");
    assert.match(s.read("work/TICK.log"), /diagnostic/);
  }));

test("a live run's transcript is a sign of life", () =>
  inSandbox(async (s) => {
    full(s, 130);
    for (const k of [1, 2, 3]) s.write(`.claude/projects/-home-agent-work/sess-${k}.jsonl`, "");
    assert.equal((await pc(s)).rc, 1);
  }));

test("a second diagnostic waits out the doubled window", () =>
  inSandbox(async (s) => {
    full(s, 300);
    s.write("work/GATE.md", `- diagnosed_at: ${s.clock.ago(90)}\n- diagnoses: 1\n`);
    assert.equal((await pc(s)).rc, 1, "90 minutes into a 2-hour window");
    s.write("work/GATE.md", `- diagnosed_at: ${s.clock.ago(125)}\n- diagnoses: 1\n`);
    assert.equal((await pc(s)).rc, 0, "past it");
  }));

test("stuck_after_min is read from CONFIG.md", () =>
  inSandbox(async (s) => {
    full(s, 190);
    s.setConfig("stuck_after_min", "300");
    assert.equal((await pc(s)).rc, 1, "190 quiet minutes is under 300");
  }));

test("a dead run's slot is freed, and its item named", () =>
  inSandbox(async (s) => {
    for (const k of [1, 2, 3]) s.lock(`slot-${k}`, { session: `sess-${k}`, item: String(k), slot: String(k) });
    s.lock("item-1", { session: "sess-1", item: "1", slot: "1" });
    s.runtime.running = new Set(["sess-2", "sess-3"]);
    gql(s, [], [], [{ number: 1, title: "One", url: "https://gh/1" }]);
    const r = await pc(s);
    assert.equal(r.rc, 0, "a slot is free again");
    assert.match(r.out, /A run working on #1 stopped without finishing/);
    assert.match(r.out, /#1 One — a run died on it 1 time\(s\)/);
  }));

test("an item a live run holds is left out", () =>
  inSandbox(async (s) => {
    s.lock("item-7", { session: "sess-a", item: "7" });
    s.runtime.running.add("sess-a");
    gql(s, [], ISSUES78);
    const r = await pc(s);
    assert.equal(r.rc, 0);
    assert.doesNotMatch(r.out, /#7 Older/);
    assert.match(r.out, /#8 Newer/);
  }));

test("an item waiting for the lock is due once it is free, in the state 3.0.0 renamed too", () =>
  inSandbox(async (s) => {
    s.item("5", { state: "waiting-cluster", branch: "feat/5", seen_at: s.clock.ago(30) });
    s.lock("exclusive", { session: "sess-a", item: "6" });
    s.runtime.running.add("sess-a");
    gql(s, [], [], [{ number: 5, title: "Five", url: "https://gh/5" }]);
    assert.equal((await pc(s)).rc, 1, "still taken, and not resumable either");
    rmSync(join(s.locks, "exclusive"), { recursive: true });
    const r = await pc(s);
    assert.equal(r.rc, 0);
    assert.match(r.out, /#5 on feat\/5 — run its exclusive step/);
  }));

test("a claimed issue is resumed only when no pull request names it", () =>
  inSandbox(async (s) => {
    gql(
      s,
      [
        {
          number: 21,
          title: "x",
          url: "https://gh/pr/21",
          reviewDecision: null,
          latestReviews: [],
          body: "Fixes #45\n\nFixes #7",
        },
      ],
      [],
      [
        { number: 7, title: "Seven", url: "https://gh/7" },
        { number: 4, title: "Four", url: "https://gh/4" },
        { number: 45, title: "Forty-five", url: "https://gh/45" },
      ],
    );
    const r = await pc(s);
    assert.equal(r.rc, 0);
    assert.match(r.out, /#4 Four/, "#4 is not named by '#45'");
    assert.doesNotMatch(r.out, /#7 Seven/);
    assert.doesNotMatch(r.out, /#45 Forty-five/);
  }));

test("a pull request wakes a run for what came after its item was last looked at", () =>
  inSandbox(async (s) => {
    const pr = [
      {
        number: 30,
        title: "Thirty",
        url: "https://gh/pr/30",
        reviewDecision: "REVIEW_REQUIRED",
        body: "Fixes #3",
        latestReviews: [{ author: { login: "guardian" }, state: "COMMENTED", submittedAt: "2026-09-24T10:05:00Z" }],
        statusCheckRollup: [
          { name: "test", conclusion: "FAILURE", completedAt: "2026-09-24T10:06:00Z" },
          { name: "lint", conclusion: "SUCCESS", completedAt: "2026-09-24T10:06:00Z" },
          { context: "ci/legacy", state: "ERROR", startedAt: "2026-09-24T09:00:00Z" },
        ],
      },
    ];
    gql(s, pr);
    let r = await pc(s, { PLATFORM_LAST_RUN_AT: "2026-09-24T10:00:00Z" });
    assert.equal(r.rc, 0);
    assert.match(r.out, /#3 — PR #30 Thirty — reviewed; resolve every finding/);
    assert.match(r.out, /checks failed: test —/, "names the newly failed check alone");
    s.item("3", { state: "parked", seen_at: "2026-09-24T10:10:00Z" });
    r = await pc(s, { PLATFORM_LAST_RUN_AT: "2026-09-24T09:00:00Z" });
    assert.equal(r.rc, 1, "its item was looked at since, whatever the last run was");
    gql(s, [
      {
        number: 31,
        title: "Own",
        url: "https://gh/pr/31",
        reviewDecision: null,
        body: "",
        latestReviews: [{ author: { login: "dev-bot" }, state: "COMMENTED", submittedAt: "2026-09-24T10:05:00Z" }],
        statusCheckRollup: [],
      },
    ]);
    r = await pc(s, { PLATFORM_LAST_RUN_AT: "2026-09-24T10:00:00Z" });
    assert.equal(r.rc, 1, "the agent's own comment is not a review");
  }));

test("repos_also: one search covers them, and a pull request there wakes its issue of repo", () =>
  inSandbox(async (s) => {
    s.config("- repos_also: beta/*, gamma/one");
    const review = [{ author: { login: "guardian" }, state: "COMMENTED", submittedAt: "2026-09-24T10:05:00Z" }];
    gql(
      s,
      [
        {
          number: 30,
          repo: "beta/kits",
          title: "Kits",
          url: "https://gh/beta/kits/pull/30",
          reviewDecision: "REVIEW_REQUIRED",
          body: "Part of acme/widgets#3",
          statusCheckRollup: [],
          latestReviews: review,
        },
        {
          number: 31,
          repo: "beta/kits",
          title: "Own issue",
          url: "https://gh/beta/kits/pull/31",
          reviewDecision: "REVIEW_REQUIRED",
          body: "Fixes #4",
          statusCheckRollup: [],
          latestReviews: review,
        },
      ],
      [],
      [
        { number: 3, title: "Three", url: "https://gh/3" },
        { number: 4, title: "Four", url: "https://gh/4" },
      ],
    );
    const r = await pc(s, { PLATFORM_LAST_RUN_AT: "2026-09-24T10:00:00Z" });
    assert.equal(r.rc, 0);
    assert.ok(
      s.github.calls.some((c) => c.includes("q=repo:acme/widgets org:beta repo:gamma/one is:pr")),
      "one search, every scope",
    );
    assert.match(r.out, /#3 — PR beta\/kits#30 Kits — reviewed/);
    assert.doesNotMatch(r.out, /Own issue/, "Fixes #4 there is that repository's own issue");
    assert.doesNotMatch(r.out, /#3 Three/);
    assert.match(r.out, /#4 Four/);
  }));

test("an approved pull request is babysat until merged: a red check or a maintainer's comment is work", () =>
  inSandbox(async (s) => {
    const pr = (extra: Record<string, unknown>) => ({
      number: 40,
      title: "Forty",
      url: "https://gh/pr/40",
      reviewDecision: "APPROVED",
      body: "Fixes #4",
      latestReviews: [{ author: { login: "maintainer" }, state: "APPROVED", submittedAt: "2026-09-24T10:05:00Z" }],
      statusCheckRollup: [],
      ...extra,
    });
    const since = { PLATFORM_LAST_RUN_AT: "2026-09-24T10:00:00Z" };
    gql(s, [pr({})]);
    assert.equal((await pc(s, since)).rc, 1, "approved and quiet: it waits for a person");
    gql(s, [pr({ statusCheckRollup: [{ name: "test", conclusion: "FAILURE", completedAt: "2026-09-24T10:06:00Z" }] })]);
    let r = await pc(s, since);
    assert.equal(r.rc, 0);
    assert.match(r.out, /#4 — PR #40 Forty — checks failed: test/);
    const say = (login: string, association: string, body = "please rename it") => ({
      author: { __typename: "User", login },
      authorAssociation: association,
      body,
      updatedAt: "2026-09-24T10:07:00Z",
    });
    gql(s, [
      pr({ comments: { nodes: [say("passer-by", "NONE"), say("dev-bot", "MEMBER", "Written by this agent — x")] } }),
    ]);
    assert.equal((await pc(s, since)).rc, 1, "after approval, only a maintainer's comment is a work order");
    gql(s, [pr({ comments: { nodes: [say("alice", "MEMBER")] } })]);
    r = await pc(s, since);
    assert.equal(r.rc, 0);
    assert.match(r.out, /#4 — PR #40 Forty — commented after approval; answer every comment/);
  }));

test("a parked item is its session's: the precheck leaves it while something will wake it", () =>
  inSandbox(async (s) => {
    s.item("4", { state: "in-review", pr: "40", session: "sess-a" });
    s.lock("item-4", {
      session: "sess-a",
      item: "4",
      since: s.clock.ago(300),
      parked_at: s.clock.ago(200),
      wake_at: s.clock.ago(-60),
    });
    gql(s, [
      {
        number: 40,
        title: "Forty",
        url: "https://gh/pr/40",
        reviewDecision: "CHANGES_REQUESTED",
        body: "Fixes #4",
        latestReviews: [{ author: { login: "guardian" }, state: "CHANGES_REQUESTED", submittedAt: s.clock.ago(1) }],
        statusCheckRollup: [],
      },
    ]);
    assert.equal((await pc(s)).rc, 1, "its booked wake-up holds it");
    s.write(
      "locks/item-4/owner",
      s.read("locks/item-4/owner").replace(/^- wake_at: .*$/m, `- wake_at: ${s.clock.ago(120)}`),
    );
    assert.equal((await pc(s)).rc, 1, "waiter and booking gone: its session is messaged to come back");
    assert.equal(s.runtime.messages[0]?.id, "sess-a");
    assert.match(s.read("work/TICK.log"), /messaged session=sess-a issue=4 /);
    s.clock.advance(16 * 60);
    const r = await pc(s);
    assert.equal(r.rc, 0, "it did not come: a fresh run takes the review");
    assert.match(r.out, /stopped without finishing/);
    assert.match(r.out, /#4 — PR #40 Forty — reviewed/);
    assert.match(
      s.read("work/TICK.log"),
      /abandoned session=sess-a issue=4 .*reason="parked, its waiter gone and no wake-up booked"/,
    );
  }));

test("merged while parked with nothing to see it: the precheck lists it to release", () =>
  inSandbox(async (s) => {
    s.item("4", { state: "awaiting-merge", pr: "40" });
    gql(s, []);
    const r = await pc(s);
    assert.equal(r.rc, 0);
    assert.match(r.out, /Merged or closed while parked — release:\n- #4 — its pull request is merged or closed/);
  }));

test("what waits on a person is not work", () =>
  inSandbox(async (s) => {
    s.item("5", { state: "blocked" });
    s.item("6", { state: "needs-info" });
    gql(
      s,
      [],
      [
        {
          number: 9,
          title: "Nine",
          url: "https://gh/9",
          labels: [{ name: "agent/implement" }, { name: "agent/failed" }],
        },
      ],
      [
        { number: 5, title: "Five", url: "https://gh/5" },
        { number: 6, title: "Six", url: "https://gh/6" },
      ],
    );
    assert.equal((await pc(s)).rc, 1);
  }));

test("a probe skips the gate and writes nothing", () =>
  inSandbox(async (s) => {
    full(s, 300);
    gql(s, [], ISSUE7);
    let r = await pc(s, { PRECHECK_PROBE: "1" });
    assert.equal(r.rc, 0, "reports the work despite full slots");
    assert.match(r.out, /#7 Add a flag/);
    assert.ok(!existsSync(join(s.work, "GATE.md")), "wrote gate bookkeeping");
    gql(s);
    r = await pc(s, { PRECHECK_PROBE: "1" });
    assert.equal(r.rc, 1, "nothing to do still declines");
  }));

test("no repository configured declines rather than waking a run to say so", () =>
  inSandbox(async (s) => {
    rmSync(join(s.work, "CONFIG.md"));
    gql(s, [], ISSUE7);
    assert.equal((await pc(s)).rc, 1);
  }));

test("label_mine: only labelled pull requests are yours, and a bot is one login", () =>
  inSandbox(async (s) => {
    await pc(s);
    assert.ok(!s.github.calls.some((c) => c.includes("label:")), "no label filter without the key");
    s.setConfig("author", "dev-app[bot]");
    s.config("- label_mine: agent/mine");
    gql(s, [
      {
        number: 32,
        title: "Bot",
        url: "https://gh/pr/32",
        reviewDecision: null,
        body: "Fixes #9",
        latestReviews: [{ author: { login: "app/dev-app" }, state: "COMMENTED", submittedAt: "2026-09-24T10:05:00Z" }],
        statusCheckRollup: [],
      },
    ]);
    const r = await pc(s, { PLATFORM_LAST_RUN_AT: "2026-09-24T10:00:00Z" });
    assert.equal(r.rc, 1, "the bot's own comment, as app/name, is not a review");
    assert.ok(
      s.github.calls.some((c) =>
        c.includes('q=repo:acme/widgets is:pr is:open author:dev-app[bot] label:"agent/mine"'),
      ),
    );
  }));

test("the whole list is one GraphQL request", () =>
  inSandbox(async (s) => {
    gql(s, [], ISSUE7, [{ number: 5, title: "Five", url: "https://gh/5" }]);
    assert.equal((await pc(s)).rc, 0);
    assert.equal(s.github.count(/graphql/), 1);
    assert.equal(s.github.calls.length, 1, `only the one request: ${s.github.calls.join(", ")}`);
  }));

test("GraphQL refused, the same list is read over REST", () =>
  inSandbox(async (s) => {
    s.setConfig("author", "dev-app[bot]");
    s.config("- label_mine: agent/mine");
    s.github.graphqlData = undefined;
    s.github
      .on(/^repos\/acme\/widgets\/pulls\?/, [
        {
          number: 30,
          title: "Thirty",
          html_url: "https://gh/pr/30",
          body: "Fixes #3",
          state: "open",
          head: { sha: "abc" },
          user: { login: "dev-app[bot]" },
          labels: [{ name: "agent/mine" }],
        },
        {
          number: 31,
          title: "Theirs",
          html_url: "https://gh/pr/31",
          body: "Fixes #9",
          state: "open",
          head: { sha: "def" },
          user: { login: "dev-app[bot]" },
          labels: [],
        },
      ])
      .on(
        /^repos\/acme\/widgets\/issues\?.*labels=agent%2Fimplement/,
        ISSUE7.map((i) => ({ ...i, html_url: i.url })),
      )
      .on(/^repos\/acme\/widgets\/issues\?.*labels=agent%2Fin-progress/, [])
      .on(/\/reviews/, [
        { user: { login: "guardian" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-24T10:05:00Z" },
      ])
      .on(/\/check-runs/, {
        check_runs: [
          { id: 1, name: "test", status: "completed", conclusion: "failure", completed_at: "2026-09-24T10:06:00Z" },
        ],
      })
      .on(/\/status$/, { statuses: [] });
    const r = await pc(s, { PLATFORM_LAST_RUN_AT: "2026-09-24T10:00:00Z" });
    assert.equal(r.rc, 0, r.err);
    assert.match(r.out, /read over REST/);
    assert.match(
      r.out,
      /#3 — PR #30 Thirty — reviewed; resolve every finding and re-request review; checks failed: test/,
    );
    assert.doesNotMatch(r.out, /PR #31/, "another agent's, unlabelled");
    assert.match(r.out, /#7 Add a flag/, "the hand-off issue, from REST");
  }));

test("neither GraphQL nor REST answers: broken, not idle", () =>
  inSandbox(async (s) => {
    s.github.graphqlData = undefined;
    const r = await pc(s);
    assert.equal(r.rc, 2);
    assert.match(r.err, /nor REST/);
  }));

test("label_mine: a claim is ours only with the label beside it", () =>
  inSandbox(async (s) => {
    s.config("- label_mine: agent/mine");
    const claimed = [
      {
        number: 7,
        title: "Seven",
        url: "https://gh/7",
        labels: [{ name: "agent/in-progress" }, { name: "agent/mine" }],
      },
      { number: 8, title: "Eight", url: "https://gh/8", labels: [{ name: "agent/in-progress" }] },
    ];
    gql(s, [], [], claimed);
    let r = await pc(s);
    assert.equal(r.rc, 0);
    assert.match(r.out, /#7 Seven/);
    assert.doesNotMatch(r.out, /#8 Eight/);
    s.github.graphqlData = undefined;
    s.github
      .on(/^repos\/acme\/widgets\/pulls\?/, [])
      .on(/^repos\/acme\/widgets\/issues\?.*labels=agent%2Fimplement/, [])
      .on(
        /^repos\/acme\/widgets\/issues\?.*labels=agent%2Fin-progress/,
        claimed.map((i) => ({ ...i, html_url: i.url })),
      );
    r = await pc(s);
    assert.match(r.out, /#7 Seven/, "ours, over REST");
    assert.doesNotMatch(r.out, /#8 Eight/, "another agent's claim, over REST");
  }));

test("interactive: work on GitHub wakes nothing, and nothing is asked of it", () =>
  inSandbox(async (s) => {
    s.setConfig("mode", "interactive");
    gql(s, [], ISSUE7);
    assert.equal((await pc(s)).rc, 1);
    assert.deepEqual(s.github.calls, []);
  }));

test("no mode reads as interactive: nothing is watched", () =>
  inSandbox(async (s) => {
    s.setConfig("mode", null);
    gql(s, [], ISSUE7);
    assert.equal((await pc(s)).rc, 1);
    assert.deepEqual(s.github.calls, []);
  }));
