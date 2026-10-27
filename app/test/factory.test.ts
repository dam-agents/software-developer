// The factory's parts on their own: the one `- key: value` parser, how a pull
// request names its issue, a babysitting verdict, the PATH workaround, and the platform's answer to a session message.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restPull, toComment, verdict } from "../src/developer/pulls.ts";
import { Config } from "../src/factory/config.ts";
import { shimsLast } from "../src/factory/context.ts";
import { closesRefs, issueRefs, login, parseJsonStream } from "../src/factory/github.ts";
import { bulletKeys, parseKv } from "../src/factory/kv.ts";
import { environmentsOf, queued } from "../src/factory/runtime.ts";

test("a key reads from its first bullet, tolerant of case, spaces, backticks and a URL", () => {
  const m = parseKv(
    "- Repo : `acme/widgets`  \n* app_url: https://x.example/a:b\n- repo: other\nprose: not a bullet but read\n",
  );
  assert.equal(m.get("repo"), "acme/widgets");
  assert.equal(m.get("app_url"), "https://x.example/a:b");
  assert.deepEqual(bulletKeys("- a: 1\nprose: x\n- Nothing under deploy/ is ours\n* b: 2\n"), ["a", "b"]);
});

test("whole numbers fall back to their default, and mode is interactive unless it says autonomous", () => {
  const c = new Config("x", "- slots: 0\n- stuck_after_min: 0\n- babysit_max_hours: x\n- mode: Autonomous\n");
  assert.equal(c.int("slots", 3, 1), 3);
  assert.equal(c.int("stuck_after_min", 120), 0);
  assert.equal(c.int("babysit_max_hours", 4), 4);
  assert.equal(c.mode(), "autonomous");
  assert.equal(new Config("x", "- mode: sometimes\n").mode(), "interactive");
});

test("a pull request names its issue with Fixes, or Part of, in its own repository or another's", () => {
  assert.deepEqual(issueRefs("Fixes #45\n\nFixes #7", "acme/widgets", "acme/widgets"), ["45", "7"]);
  assert.deepEqual(issueRefs("Part of acme/widgets#3", "acme/widgets", "beta/kits"), ["3"]);
  assert.deepEqual(issueRefs("Fixes #4", "acme/widgets", "beta/kits"), [], "a bare #4 elsewhere is that repository's");
  assert.deepEqual(closesRefs("Part of acme/widgets#3", "acme/widgets", "beta/kits"), []);
  assert.deepEqual(closesRefs("resolved ACME/Widgets#3", "acme/widgets", "beta/kits"), ["3"]);
});

test("a login is one login in every spelling GitHub uses", () => {
  assert.equal(login("Dev-App[bot]"), login("app/dev-app"));
  assert.notEqual(login("dev-app"), login("other"));
});

test("paginated answers parse as one list", () => {
  assert.deepEqual(parseJsonStream('[1,2]\n[3]{"a":"]"}'), [[1, 2], [3], { a: "]" }]);
  assert.equal(parseJsonStream("[1,"), undefined);
});

test("REST's reviews give an approximate decision, and only a merge is done", () => {
  const pr = restPull(
    { number: 1, state: "open", mergeable: true, head: { sha: "a" } },
    [
      { user: { login: "a" }, state: "COMMENTED", submitted_at: "2026-01-01T00:00:00Z" },
      { user: { login: "a" }, state: "APPROVED", submitted_at: "2026-01-02T00:00:00Z" },
    ],
    { check_runs: [{ id: 1, name: "t", status: "completed", conclusion: "success" }] },
    { statuses: [] },
  );
  assert.equal(pr.reviewDecision, "APPROVED");
  const v = verdict(pr, "2026-01-03T00:00:00Z", "dev-bot");
  assert.equal(v.act, false);
  assert.match(v.text, /waiting to be merged/);
  const merged = verdict({ ...pr, state: "MERGED" }, "2026-01-03T00:00:00Z", "dev-bot");
  assert.ok(merged.act && merged.done);
});

test("a person's comment is a round; an agent's, a bot's, or a stranger's after approval is not", () => {
  const pr = restPull(
    { number: 1, state: "open", mergeable: true, head: { sha: "a" } },
    [{ user: { login: "guardian" }, state: "APPROVED", submitted_at: "2026-01-02T00:00:00Z" }],
    { check_runs: [{ id: 1, name: "t", status: "completed", conclusion: "success" }] },
    { statuses: [] },
  );
  const c = (login: string, association: string, body: string, type = "User") =>
    toComment({ user: { login, type }, author_association: association, body, created_at: "2026-01-04T00:00:00Z" });
  const since = "2026-01-03T00:00:00Z";
  const quiet = [
    c("dev-bot", "MEMBER", "Round 2 pushed. Written by this agent — https://x"),
    c("codecov", "NONE", "Coverage went up", "Bot"),
    c("passer-by", "NONE", "+1 please merge"),
  ];
  assert.equal(verdict(pr, since, "dev-bot", quiet).act, false, "approved: none of these is a work order");
  const v = verdict(pr, since, "dev-bot", [...quiet, c("alice", "MEMBER", "Please rename the flag before this lands")]);
  assert.ok(v.act && !v.done);
  assert.match(v.text, /commented by alice, after approval: answer every comment/);
  const open = { ...pr, reviewDecision: "REVIEW_REQUIRED" };
  assert.ok(verdict(open, since, "dev-bot", [c("passer-by", "NONE", "Why not a flag?")]).act, "in review: anyone's");
  assert.equal(verdict(pr, "2026-01-05T00:00:00Z", "dev-bot", [c("alice", "MEMBER", "old")]).act, false, "answered");
});

test("mise shims go last on PATH, the rest in order", () => {
  assert.equal(shimsLast("/a:/x/mise/shims:/b:/usr/bin:/bin"), "/a:/b:/usr/bin:/bin:/x/mise/shims");
  assert.equal(shimsLast("/a:/usr/bin:/bin"), "/a:/usr/bin:/bin");
});

test("a session message counts as sent only when the platform says it queued it", () => {
  const answer = (text: string, isError = false) =>
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } })}\n\n`;
  assert.ok(queued(answer(JSON.stringify({ queued: true, sessionId: "s", running: false }))));
  assert.ok(
    queued(JSON.stringify({ result: { content: [{ text: JSON.stringify({ queued: true }) }] } })),
    "plain JSON",
  );
  assert.ok(!queued(answer("this agent has no session s; list_sessions shows the ones it has.", true)));
  assert.ok(!queued(answer(JSON.stringify({ queued: false }))));
  assert.ok(!queued("<html>bad gateway</html>"));
  assert.ok(!queued(""));
});

test("the Environments are what list_environments answers, and a failed answer is not measured", () => {
  const answer = (text: string, isError = false) =>
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } })}\n\n`;
  const listed = [
    {
      id: "agent-x",
      name: "slot-1",
      state: "hibernated",
      expiresAt: "2026-11-02T15:35:24.761Z",
      endpoints: [
        { name: "app", port: 4400, url: "https://app-slot-1-abc.env.example.com" },
        { name: "db", port: 5432, url: null },
      ],
    },
    { id: "agent-y" },
  ];
  assert.deepEqual(environmentsOf(answer(JSON.stringify(listed))), [
    {
      name: "slot-1",
      state: "hibernated",
      expiresAt: "2026-11-02T15:35:24.761Z",
      endpoints: [
        { name: "app", url: "https://app-slot-1-abc.env.example.com" },
        { name: "db", url: null },
      ],
    },
  ]);
  assert.deepEqual(environmentsOf(answer("[]")), []);
  assert.equal(environmentsOf(answer("Environments are off for this owner.", true)), undefined);
  assert.equal(environmentsOf("<html>bad gateway</html>"), undefined);
});
