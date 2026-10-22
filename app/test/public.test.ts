// public-check: the private shapes a text bound for GitHub must not carry, and
// the two lines the rules ask for, read past.
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicCheck, scan } from "../src/developer/public.ts";
import { inSandbox } from "./helpers.ts";

const APP = "https://dev.apps.cl.acme.example";
const kinds = (text: string) => scan(text, APP).hits.map((h) => h.kind);

test("each private shape is a hit", () => {
  assert.deepEqual(kinds("ask alice@acme.co"), ["e-mail address"]);
  assert.deepEqual(kinds("as viewer@example.com or bob@widgets.test"), [], "the reserved domains are placeholders");
  assert.deepEqual(kinds("the user code (`ABCD-WXYZ`)"), ["one-time code"]);
  assert.deepEqual(kinds("<@U0ABCDEF12> said"), ["Slack id"]);
  assert.deepEqual(kinds("in C0123ABCD9"), ["Slack id"]);
  assert.deepEqual(kinds("see https://acme.slack.com/archives/C0123ABCD9/p1"), ["Slack link"]);
  assert.deepEqual(kinds('{"id":"conn-0a1b2c3d4e5f"}'), ["platform id"]);
  assert.deepEqual(kinds("session 00000000-1111-4222-8333-444444444444"), ["UUID"]);
  assert.deepEqual(kinds("dials 10.43.0.12"), ["private address"]);
  assert.deepEqual(kinds("db.svc.internal is down"), ["internal host"]);
});

test("the platform's own hosts are hits, the session link and the thread marker are not", () => {
  assert.deepEqual(kinds(`✓ Logged in to ${APP}/ as <user>`), ["internal host"]);
  assert.deepEqual(kinds("keycloak.apps.cl.acme.example answers 502"), ["internal host"]);
  assert.deepEqual(
    kinds(`Written by this agent — ${APP}/a/agent-0f1e2d3c4b5a6978?s=00000000-1111-4222-8333-444444444444`),
    [],
  );
  assert.deepEqual(kinds("<!-- slack-thread: C0123ABCD9 1700000000.000100 -->"), []);
  assert.deepEqual(scan("on acme.example", APP).hits, [], "the parent domain is not the platform's");
});

test("a credential is a hit, never printed", () =>
  inSandbox(async (s) => {
    const r = await s.run(publicCheck, [], {}, `line one\ntoken = ghp_${"a".repeat(36)}\n`);
    assert.equal(r.rc, 1);
    assert.match(r.out, /^stdin:2 credential$/m);
    assert.doesNotMatch(r.out, /ghp_/);
  }));

test("what the work needs passes, and another URL is a note", () =>
  inSandbox(async (s) => {
    s.setConfig("app_url", APP);
    const body = [
      "`dam auth login` prints the verification URL and user code (`<code>`).",
      "Fixes #12, see https://github.com/acme/widgets/pull/3 and https://example.org/spec",
      "Commit 1a2b3c4, version 6.2.4, ISO-8601, UTF-8.",
      `Written by this agent — ${APP}/a/agent-1?s=00000000-1111-4222-8333-444444444444`,
    ].join("\n");
    s.write("body.md", body);
    const r = await s.run(publicCheck, [`${s.home}/body.md`]);
    assert.equal(r.rc, 0, r.out);
    assert.match(r.out, /body\.md:2 note — a URL, public only if anyone may open it: https:\/\/example\.org\/spec/);
    assert.doesNotMatch(r.out, /github\.com/);
    assert.match(r.out, /^clean/m);
  }));

test("a hit names its file, line and match", () =>
  inSandbox(async (s) => {
    s.setConfig("app_url", APP);
    s.write("c.md", `ok\nreach ${APP.replace("https://", "")}\n`);
    const r = await s.run(publicCheck, [`${s.home}/c.md`]);
    assert.equal(r.rc, 1);
    assert.match(r.out, /c\.md:2 internal host: dev\.apps\.cl\.acme\.example/);
    assert.match(r.err, /rewrite each with a placeholder/);
  }));
