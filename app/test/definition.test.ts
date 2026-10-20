// The definition agrees with itself: the places that name config keys and the
// places that name schedules say the same thing, and it validates clean.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KNOWN, kitSchedules } from "../src/developer/verify.ts";
import { validate } from "../src/factory/validate.ts";
import { commands } from "../src/registry.ts";
import { ROOT } from "./helpers.ts";

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

test("the verifier knows exactly the keys onboarding writes", () => {
  const block = /```markdown\n([\s\S]*?)\n```/.exec(read("ONBOARDING.md"))?.[1] ?? "";
  const onb = [...block.matchAll(/^- ([a-z_]+):/gm)].map((m) => m[1]).sort();
  assert.ok(onb.length > 0, "found no keys in ONBOARDING's example");
  assert.deepEqual([...KNOWN].sort(), onb);
});

test("CLAUDE.md documents every key", () => {
  const c = read("CLAUDE.md");
  const section = c.slice(c.indexOf("## Runtime configuration"), c.indexOf("## Run types"));
  for (const k of KNOWN)
    assert.ok(section.includes(`\`${k}\``), `\`${k}\` is not in CLAUDE.md → Runtime configuration`);
});

test("every schedule's task points at a procedure that exists", () => {
  const kit = read("kit.yaml");
  for (const m of kit.slice(kit.search(/^schedules:/m)).matchAll(/^ {4}task: (.*)$/gm)) {
    const task = m[1] ?? "";
    const h = /CLAUDE\.md → "([^"]*)"/.exec(task)?.[1];
    if (h) assert.match(read("CLAUDE.md"), new RegExp(`^## ${h}$`, "m"), task);
    for (const f of task.match(/docs\/[a-z-]+\.md/g) ?? []) assert.ok(read(f), `no ${f}: ${task}`);
  }
});

test("the audit checks every schedule the kit creates", () => {
  const audit = read("docs/audit.md");
  for (const n of kitSchedules(ROOT)) assert.ok(audit.includes(`\`${n}\``), `docs/audit.md does not name ${n}`);
});

test("the definition validates clean", () => {
  const fails: string[] = [];
  validate(ROOT, Object.keys(commands), { pass: () => {}, warn: () => {}, fail: (s) => fails.push(s) });
  assert.deepEqual(fails, []);
});
