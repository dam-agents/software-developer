// The factory's parts on their own: the one `- key: value` parser, how a pull
// request names its issue, a babysitting verdict, and the PATH workaround.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restPull, verdict } from "../src/developer/pulls.ts";
import { Config } from "../src/factory/config.ts";
import { shimsLast } from "../src/factory/context.ts";
import { closesRefs, issueRefs, login, parseJsonStream } from "../src/factory/github.ts";
import { bulletKeys, parseKv } from "../src/factory/kv.ts";

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

test("REST's reviews give an approximate decision, and an approximate approval is never done", () => {
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
  assert.match(v.text, /review decision is unreadable/);
});

test("mise shims go last on PATH, the rest in order", () => {
  assert.equal(shimsLast("/a:/x/mise/shims:/b:/usr/bin:/bin"), "/a:/b:/usr/bin:/bin:/x/mise/shims");
  assert.equal(shimsLast("/a:/usr/bin:/bin"), "/a:/usr/bin:/bin");
});
