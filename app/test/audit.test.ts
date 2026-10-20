// audit: the week in numbers, and a failed read reported as not measured.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { audit } from "../src/developer/audit.ts";
import { graphqlOf, inSandbox, type Sandbox } from "./helpers.ts";

/** A local remote for the definition, its main at the given VERSION. */
function origin(s: Sandbox, version: string): void {
  const bare = join(s.home, "origin.git");
  s.git(["init", "-q", "--bare", bare]);
  s.git(["remote", "add", "origin", bare]);
  s.git(["push", "-q", "origin", "HEAD:refs/heads/main"]);
  s.git(["-C", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  if (version !== s.read("VERSION").trim()) {
    const c = join(s.home, "oc");
    s.git(["clone", "-q", bare, c]);
    s.write("oc/VERSION", `${version}\n`);
    s.git(["commit", "-qam", "bump"], c);
    s.git(["push", "-q", "origin", "HEAD:main"], c);
  }
}
function live(s: Sandbox): void {
  s.github
    .on(/^repos\/acme\/widgets$/, { permissions: { push: true } })
    .on(/^user\/repos/, [{ permissions: { push: true } }])
    .on(
      /^repos\/acme\/widgets\/labels/,
      ["agent/implement", "agent/in-progress", "agent/failed", "needs-review", "agent/needs-info"].map((name) => ({
        name,
      })),
    );
}

test("a busy week, counted", () =>
  inSandbox(async (s) => {
    s.onboarded();
    origin(s, s.read("VERSION").trim());
    live(s);
    const a = (m: number) => s.clock.ago(m);
    s.write(
      "work/TICK.log",
      [
        `${a(20000)} pr-opened session=old issue=1 pr=2 minutes=99`,
        `${a(3000)} pr-opened session=a issue=3 pr=4 minutes=30`,
        `${a(2000)} nothing session=b issue=- pr=- minutes=1`,
        `${a(1500)} abandoned session=c issue=5 pr=- minutes=40 reason="sandbox idle"`,
        `${a(1000)} diagnostic busy_since=x holder=-`,
        `${a(500)} pr-updated session=d issue=3 pr=4 minutes=12`,
        `${a(400)} resumed session=d issue=3 slot=1 pr=4 minutes=0 cause=waiter`,
        `${a(300)} resumed session=d issue=3 slot=1 pr=4 minutes=0 cause=operator`,
        `${a(200)} resumed session=e issue=3 slot=2 pr=4 minutes=0 cause=fresh prev=d`,
        "",
      ].join("\n"),
    );
    s.github
      .on(/^search\/issues/, {
        items: [
          { number: 4, created_at: a(12000) },
          { number: 9, created_at: a(12000) },
        ],
      })
      .on(/^x/, null);
    s.github.prViews = [{ reviewDecision: "REVIEW_REQUIRED" }, { reviewDecision: "APPROVED" }];
    s.github.graphqlData = graphqlOf(
      [
        { number: 4, title: "x", url: "u", reviewDecision: "REVIEW_REQUIRED", latestReviews: [], body: "Fixes #3" },
        { number: 9, title: "y", url: "u", reviewDecision: "APPROVED", latestReviews: [], body: "Fixes #8" },
      ],
      [],
      [
        { number: 3, title: "Three", url: "u" },
        { number: 5, title: "Five", url: "u" },
      ],
    );
    const r = await s.run(audit, []);
    assert.match(r.out, /PASS \(live\)/, "runs the verifier first");
    assert.match(
      r.out,
      /runs: abandoned: 1 diagnostic: 1 nothing: 1 pr-opened: 1 pr-updated: 1 resumed: 3/,
      "counts the week only",
    );
    assert.match(r.out, /median 1, longest 40/);
    assert.match(
      r.out,
      /resumes: 2 continued in their own session \(waiter 1, booked wake-up 0, a person 1\), 1 taken over by a fresh one/,
    );
    assert.doesNotMatch(r.out, /warn runs\.resumed/, "most kept their context");
    assert.match(r.out, /warn runs\.abandoned — 1 run\(s\)/);
    assert.match(r.out, /session=c/);
    assert.match(r.out, /warn runs\.diagnostic — 1/);
    assert.match(r.out, /warn prs\.waiting — older than a week, not approved: #4$/m);
    assert.match(r.out, /warn issues\.orphaned — claimed, no pull request: #5/);
    assert.match(r.out, /ok {3}definition\.version/);
  }));

test("a failed read is not measured, never none", () =>
  inSandbox(async (s) => {
    s.onboarded();
    origin(s, "99.0.0");
    live(s);
    s.github.graphqlData = undefined;
    const r = await s.run(audit, []);
    assert.match(r.out, /warn prs\.waiting — not measured/);
    assert.match(r.out, /warn issues\.orphaned — not measured/);
    assert.match(
      r.out,
      new RegExp(
        `warn definition\\.version — checked out ${s.read("VERSION").trim().replaceAll(".", "\\.")}, latest 99\\.0\\.0`,
      ),
    );
    assert.match(r.out, /runs: none closed this week/);
  }));

test("the backup holds the current CONFIG.md", () =>
  inSandbox(async (s) => {
    s.onboarded();
    origin(s, s.read("VERSION").trim());
    live(s);
    s.config("- work_repo: acme/widgets-work");
    s.github
      .on(/^repos\/acme\/widgets-work$/, { permissions: { push: true } })
      .on(/^user\/repos/, [{ permissions: { push: true } }, { permissions: { push: true } }]);
    s.github.on(/contents\/CONFIG\.md/, { content: Buffer.from(s.read("work/CONFIG.md")).toString("base64") });
    assert.match((await s.run(audit, [])).out, /ok {3}backup\.config/);
    s.github.on(/contents\/CONFIG\.md/, { content: Buffer.from("old\n").toString("base64") });
    assert.match((await s.run(audit, [])).out, /warn backup\.config — acme\/widgets-work holds another CONFIG\.md/);
    s.github.on(/contents\/CONFIG\.md/, undefined);
    assert.match((await s.run(audit, [])).out, /warn backup\.config — not measured/);
  }));
