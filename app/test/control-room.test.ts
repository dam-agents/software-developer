// The control room: one picture of the instance from its locks, items, slots,
// TICK.log and GitHub, read-only, and an API that changes nothing run-state owns.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { buildPage, ControlRoom, handler, readLog, resumeCounts, Store } from "../src/developer/control-room.ts";
import { APP, inSandbox, type Sandbox } from "./helpers.ts";

/** GitHub's answer to the control room's one query. */
function world(s: Sandbox, prs: Record<string, unknown>[] = [], repo: Record<string, unknown> = {}): void {
  const empty = { totalCount: 0, nodes: [] };
  s.github.graphqlData = {
    rateLimit: { remaining: 4000, limit: 5000, resetAt: "2026-09-24T11:00:00Z" },
    open: { nodes: prs },
    merged: { nodes: [] },
    repository: { handoff: empty, claimed: empty, info: empty, failed: empty, ...repo },
  };
}
const pr = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `PR ${n}`,
  url: `https://gh/pr/${n}`,
  body: "Fixes #7",
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  repository: { nameWithOwner: "acme/widgets" },
  latestReviews: { nodes: [] },
  comments: { nodes: [] },
  commits: {
    nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "t", conclusion: "SUCCESS" }] } } } }],
  },
  ...extra,
});
const room = (s: Sandbox, env: Record<string, string> = {}) => new ControlRoom(s.deps(env), Store.open(":memory:"));
// biome-ignore lint/suspicious/noExplicitAny: a snapshot is JSON the page reads; the tests read it the same way
type Snap = Record<string, any>;

test("a slot running its Environment check reads as verifying, with no exclusive lock", () =>
  inSandbox(async (s) => {
    world(s);
    s.config("- verify_environment: make e2e ENV={environment}");
    s.item("7", { state: "working", session: "sess-a", branch: "feat/7" });
    s.lock("item-7", { session: "sess-a", item: "7", since: s.clock.ago(30) });
    s.lock("slot-1", { session: "sess-a", item: "7", since: s.clock.ago(30), phase: "verify_environment" });
    s.runtime.running.add("sess-a");
    const snap = (await room(s).snapshot(true)) as Snap;
    assert.equal(snap.flight.find((x: Snap) => x.item === "7").stage, "verifying");
    assert.equal(snap.exclusive.lock, null, "no exclusive lock is taken");
    assert.equal(snap.config.verify_environment, "make e2e ENV={environment}");
  }));

test("each slot shows its own Environment when the instance verifies in them", () =>
  inSandbox(async (s) => {
    world(s);
    s.config("- verify_environment: make e2e ENV={environment}");
    s.runtime.envs = [
      {
        name: "slot-1",
        state: "running",
        expiresAt: "2026-11-02T15:35:24.761Z",
        endpoints: [{ name: "app", url: "https://app-slot-1-abc.env.example.com" }],
      },
      { name: "other", state: "running", expiresAt: "", endpoints: [] },
    ];
    const snap = (await room(s).snapshot(true)) as Snap;
    assert.equal(snap.slots[0].environment.name, "slot-1");
    assert.equal(snap.slots[0].environment.endpoints[0].url, "https://app-slot-1-abc.env.example.com");
    assert.equal(snap.slots[1].environment, null, "a slot whose Environment is not made yet");
    s.runtime.down = true;
    const unread = (await room(s).snapshot(true)) as Snap;
    assert.equal(unread.slots[0].environment, undefined, "an unanswered platform is not measured, never none");
    s.setConfig("verify_environment", "");
    s.runtime.down = false;
    const off = (await room(s).snapshot(true)) as Snap;
    assert.ok(!("environment" in off.slots[0]), "no Environments are read when the instance does not verify in them");
  }));

test("a parked item shows as parked, its slot free, watched by its waiter", () =>
  inSandbox(async (s) => {
    world(s, [pr(21)]);
    s.item("7", { state: "in-review", pr: "21", session: "sess-a", branch: "feat/7" });
    s.lock("item-7", {
      session: "sess-a",
      item: "7",
      since: s.clock.ago(90),
      parked_at: s.clock.ago(5),
      waiter: "4242",
      waiter_boot: "boot-1",
    });
    const snap = (await room(s, { SD_LIVE_PIDS: "4242" }).snapshot(true)) as Snap;
    const f = snap.flight.find((x: Snap) => x.item === "7");
    assert.equal(f.stage, "in-review");
    assert.equal(f.slot, "", "a parked item holds no slot");
    assert.equal(f.watched, "waiter");
    assert.equal(snap.locks.find((l: Snap) => l.name === "item-7").holder, "parked");
    assert.deepEqual(
      snap.alarms.map((a: Snap) => a.code),
      [],
      "a parked item with its waiter is no alarm",
    );
  }));

test("parked with only a booking is an advisory; with nothing, it reads dead", () =>
  inSandbox(async (s) => {
    world(s, [pr(21, { reviewDecision: "APPROVED" })]);
    s.item("7", { state: "awaiting-merge", pr: "21", session: "sess-a" });
    s.lock("item-7", {
      session: "sess-a",
      item: "7",
      since: s.clock.ago(90),
      parked_at: s.clock.ago(5),
      wake_at: s.clock.ago(-60),
    });
    let snap = (await room(s).snapshot(true)) as Snap;
    assert.equal(snap.flight[0].stage, "awaiting-merge");
    assert.equal(snap.flight[0].watched, "booking");
    assert.match(
      snap.alarms.map((a: Snap) => `${a.code} ${a.text}`).join("\n"),
      /NO-WAITER #7 is parked with no waiter running/,
    );
    s.write(
      "locks/item-7/owner",
      s.read("locks/item-7/owner").replace(/^- wake_at: .*$/m, `- wake_at: ${s.clock.ago(120)}`),
    );
    snap = (await room(s).snapshot(true)) as Snap;
    assert.equal(snap.locks[0].holder, "dead");
    assert.match(snap.alarms.map((a: Snap) => a.code).join(" "), /DEAD/);
  }));

test("the queue is what the precheck would offer; set-aside issues are ours only when this instance started them", () =>
  inSandbox(async (s) => {
    const issue = (n: number, labels: string[]) => ({
      number: n,
      title: `I${n}`,
      url: `u${n}`,
      createdAt: "2026-09-24T09:00:00Z",
      labels: { nodes: labels.map((name) => ({ name })) },
    });
    world(s, [], {
      handoff: {
        totalCount: 60,
        nodes: [
          issue(1, ["agent/implement"]),
          issue(2, ["agent/implement", "agent/in-progress", "agent/other"]),
          issue(5, ["agent/implement"]),
        ],
      },
      info: { totalCount: 2, nodes: [issue(3, ["agent/needs-info"]), issue(4, ["agent/needs-info"])] },
    });
    s.item("3", { state: "needs-info" });
    s.lock("item-5", { session: "sess-a", item: "5" });
    const snap = (await room(s).snapshot(true)) as Snap;
    assert.deepEqual(
      snap.queue.map((i: Snap) => i.number),
      [1],
      "another agent's claim is never queued for us, nor an item a run holds before it claims",
    );
    assert.equal(snap.totals.handoff, 60, "GitHub's count, past the 50 read");
    assert.equal(snap.totals.queue_taken, 2);
    assert.deepEqual(
      snap.needs_info.map((i: Snap) => i.number),
      [3],
    );
    assert.equal(snap.totals.needs_info_others, 1);
  }));

test("the resume counts and the log come from TICK.log", () => {
  const log = [
    "2026-09-20T10:00:00Z resumed session=a issue=7 slot=1 pr=21 minutes=0 cause=waiter",
    "2026-09-23T10:00:00Z resumed session=a issue=7 slot=1 pr=21 minutes=0 cause=operator",
    "2026-09-24T10:00:00Z resumed session=b issue=7 slot=2 pr=21 minutes=0 cause=fresh prev=a",
    '2026-09-24T10:05:00Z abandoned session=c issue=8 slot=- pr=- minutes=4 reason="parked, its waiter gone"',
  ].join("\n");
  assert.deepEqual(resumeCounts(log, "2026-09-21T00:00:00Z"), {
    total: 2,
    waiter: 0,
    messaged: 0,
    booking: 0,
    operator: 1,
    fresh: 1,
  });
  const r = readLog(log);
  assert.equal(r[0]?.outcome, "abandoned");
  assert.equal(r[0]?.reason, "parked, its waiter gone");
  assert.equal(r[1]?.cause, "fresh");
});

test("an acknowledgement outlives a reload, and survives the minutes in its text changing", () =>
  inSandbox(async (s) => {
    world(s, [
      pr(21, {
        checks: undefined,
        commits: {
          nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: "e2e", conclusion: "FAILURE" }] } } } }],
        },
      }),
    ]);
    const store = Store.open(":memory:");
    const r = new ControlRoom(s.deps(), store);
    let snap = (await r.snapshot(true)) as Snap;
    const red = snap.alarms.find((a: Snap) => a.code === "RED");
    assert.ok(red, "a red check is an alarm");
    assert.equal(r.ack([red.key]), 1);
    snap = (await new ControlRoom(s.deps(), store).snapshot(true)) as Snap;
    assert.deepEqual(snap.acked, [red.key]);
    assert.equal(
      Store.key({ level: "adv", code: "STALE", text: "held 61 min" }),
      Store.key({ level: "adv", code: "STALE", text: "held 95 min" }),
    );
  }));

test("sweep goes through run-state, and frees only what the runtime proves gone", () =>
  inSandbox(async (s) => {
    world(s);
    s.runtime.running.add("sess-live");
    s.lock("slot-1", { session: "sess-live", item: "7", slot: "1", since: s.clock.ago(5) });
    s.lock("slot-2", { session: "sess-gone", item: "8", slot: "2", since: s.clock.ago(5) });
    const out = await room(s).sweep();
    assert.deepEqual(out.freed, ["#8"]);
    assert.ok(existsSync(join(s.locks, "slot-1")));
    assert.ok(!existsSync(join(s.locks, "slot-2")));
    assert.match(
      s.read("work/TICK.log"),
      /abandoned session=sess-gone issue=8/,
      "logged by run-state, as the precheck's sweep is",
    );
  }));

test("GitHub unreadable is an alarm, never an empty picture", () =>
  inSandbox(async (s) => {
    s.github.graphqlData = undefined;
    const snap = (await room(s).snapshot(true)) as Snap;
    assert.match(snap.alarms[0].text, /GitHub unreadable/);
    s.runtime.down = true;
    const down = (await room(s).snapshot(true)) as Snap;
    assert.ok(down.alarms.some((a: Snap) => a.code === "RUNTIME"));
  }));

test("the page builds with its snapshot inside, safe to inline", () => {
  const template = readFileSync(join(APP, "control-room", "page.html"), "utf8");
  const page = buildPage(template, { note: "</script><!-- x", title: "Fix $' $& $` <img src=x onerror=alert(1)>" });
  assert.ok(!page.includes("__SNAPSHOT__"));
  assert.ok(!page.includes('"</script>'), "a closing tag in the data cannot end the script");
  const blob = page.slice(
    page.indexOf('id="snapshot">') + 'id="snapshot">'.length,
    page.indexOf("</script>", page.indexOf('id="snapshot">')),
  );
  assert.equal(
    JSON.parse(blob).title,
    "Fix $' $& $` <img src=x onerror=alert(1)>",
    "the snapshot round-trips, its script closed where the page closes it",
  );
  assert.throws(() => buildPage("no placeholder", {}));
});

test("a request target that cannot parse is a 400, and the server keeps serving", () =>
  inSandbox(async (s) => {
    world(s);
    const server = createServer(handler(room(s)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const get = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    try {
      assert.equal(await get("//"), 400);
      assert.equal(await get("//["), 400);
      assert.equal(await get("/health"), 200, "still up");
    } finally {
      server.close();
    }
  }));
