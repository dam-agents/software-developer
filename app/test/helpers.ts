// The test world: a sandboxed $HOME with a configured work/, and fakes for the
// runtime, GitHub and the clock, so every test runs offline, in-process and
// fast. Commands are called as the CLI calls them, with a Deps built here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Command, type Deps, invoke, shimsLast } from "../src/factory/context.ts";
import type { Conditional, GitHub, GraphQLResult } from "../src/factory/github.ts";
import { kv } from "../src/factory/kv.ts";
import { run } from "../src/factory/proc.ts";
import {
  type EnvironmentInfo,
  type Liveness,
  livenessOf,
  type Runtime,
  type SessionInfo,
} from "../src/factory/runtime.ts";
import { type Clock, iso } from "../src/factory/time.ts";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = join(APP, "..");

export const CONFIG = `Set up during onboarding.

- repo: acme/widgets
- author: dev-bot
- app_url: https://platform.example.com
- mode: autonomous
- label_handoff: agent/implement
- label_claimed: agent/in-progress
- label_failed: agent/failed
- label_review: needs-review
- verify: make check
- stuck_after_min: 120

## Bounds

- Nothing under deploy/ is ours to change.
`;

/** Real time, but a sleep moves it on at once: a nine-minute wait takes no time. */
export class FakeClock implements Clock {
  offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  async sleep(seconds: number): Promise<void> {
    this.offsetMs += seconds * 1000;
  }
  advance(seconds: number): void {
    this.offsetMs += seconds * 1000;
  }
  /** An ISO time that many minutes back (negative: ahead). */
  ago(minutes: number): string {
    return iso(new Date(this.now().getTime() - minutes * 60_000));
  }
}

/** The runtime, from sets of session ids: running a turn, the direct chat, Slack. */
export class FakeRuntime implements Runtime {
  running = new Set<string>();
  chats = new Set<string>();
  slack = new Set<string>();
  down = false;
  /** The messages sent, and whether the platform queues them. */
  readonly messages: { id: string; text: string }[] = [];
  queues = true;

  private type(id: string): string {
    if (this.slack.has(id)) return "channel_slack";
    if (this.chats.has(id)) return "regular";
    return "schedule_cron";
  }
  /** What sessions.list answers: a non-running scheduled session is unknown to it. */
  private find(id: string): { running: boolean; type: string } | undefined {
    const t = this.type(id);
    const running = this.running.has(id);
    return running || t !== "schedule_cron" ? { running, type: t } : undefined;
  }
  async liveness(id: string): Promise<Liveness> {
    return this.down ? "unreachable" : livenessOf(this.find(id));
  }
  async sessionType(id: string): Promise<string> {
    return this.down ? "" : (this.find(id)?.type ?? "");
  }
  async sessions(): Promise<SessionInfo[] | undefined> {
    if (this.down) return undefined;
    const ids = new Set([...this.running, ...this.chats, ...this.slack]);
    return [...ids].map((id) => ({ id, type: this.type(id), running: this.running.has(id) }));
  }
  async message(id: string, text: string): Promise<boolean> {
    this.messages.push({ id, text });
    return this.queues && !this.down;
  }
  /** This agent's Environments, as list_environments answers. */
  envs: EnvironmentInfo[] = [];
  async environments(): Promise<EnvironmentInfo[] | undefined> {
    return this.down ? undefined : this.envs;
  }
}

type Answer = unknown | ((path: string) => unknown);

/**
 * GitHub, from canned answers by path. An answer of undefined is a read that
 * failed. Every call is traced, so a test can say what was — and was not — asked.
 */
export class FakeGitHub implements GitHub {
  readonly calls: string[] = [];
  private readonly routes: { re: RegExp; answer: Answer }[] = [];
  /** GraphQL's answer to the precheck's query; undefined: refused. */
  graphqlData: unknown = { prs: { nodes: [] }, repository: { handoff: { nodes: [] }, claimed: { nodes: [] } } };
  graphqlError = "GraphQL: API rate limit exceeded for installation ID 1.";
  /** `gh pr view`'s answers, one per call, the last repeated; undefined: GraphQL refused. */
  prViews: unknown[] = [];
  private prViewN = 0;
  /** The ETag every 200 carries; a read naming it gets a free 304. */
  etag = "";
  /** Where `gh repo clone <host>/<owner>/<name>` clones from: a bare repository per slug. */
  cloneRoot = "";

  /** Answers paths matching `re` — the latest route that matches wins. */
  on(re: RegExp | string, answer: Answer): this {
    this.routes.unshift({ re: typeof re === "string" ? new RegExp(`^${escapeRe(re)}`) : re, answer });
    return this;
  }

  private answer(path: string): unknown {
    const r = this.routes.find((x) => x.re.test(path));
    if (!r) return undefined;
    return typeof r.answer === "function" ? (r.answer as (p: string) => unknown)(path) : r.answer;
  }

  async get(_host: string, path: string): Promise<unknown> {
    this.calls.push(`api ${path}`);
    return clone(this.answer(path));
  }
  async getAll(_host: string, path: string): Promise<unknown[] | undefined> {
    this.calls.push(`api --paginate ${path}`);
    const a = clone(this.answer(path));
    return a === undefined ? undefined : Array.isArray(a) ? a : [a];
  }
  async getIfChanged(_host: string, path: string, etag: string): Promise<Conditional> {
    this.calls.push(`api -i ${path}`);
    if (etag && etag === this.etag) return { status: 304, etag, body: undefined };
    const a = clone(this.answer(path));
    return a === undefined ? { status: 0, etag: "", body: undefined } : { status: 200, etag: this.etag, body: a };
  }
  async graphql<T>(_host: string, _query: string, vars: Readonly<Record<string, string>>): Promise<GraphQLResult<T>> {
    this.calls.push(`api graphql q=${vars.q ?? ""}`);
    if (this.graphqlData === undefined) return { error: this.graphqlError };
    return { data: clone(this.graphqlData) as T };
  }
  async prView(_host: string, slug: string, n: number, _fields: string): Promise<unknown> {
    this.calls.push(`pr view ${n} -R ${slug}`);
    if (this.prViews.length === 0) return undefined;
    const v = this.prViews[Math.min(this.prViewN, this.prViews.length - 1)];
    this.prViewN++;
    return clone(v);
  }
  async clone(_host: string, slug: string, dir: string): Promise<boolean> {
    this.calls.push(`repo clone ${slug}`);
    return run("git", ["clone", "-q", join(this.cloneRoot, `${slug}.git`), dir]).code === 0;
  }

  count(re: RegExp): number {
    return this.calls.filter((c) => re.test(c)).length;
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clone = (v: unknown): unknown => (v === undefined ? undefined : structuredClone(v));

/** Issues and pull requests in `gh --json` shape, answered as the precheck's GraphQL query asks. */
export function graphqlOf(
  prs: readonly Record<string, unknown>[] = [],
  handoff: readonly Record<string, unknown>[] = [],
  claimed: readonly Record<string, unknown>[] = [],
): unknown {
  const nodes = (labels: unknown) => ({ nodes: labels ?? [] });
  return {
    prs: {
      nodes: prs.map((p) => ({
        ...p,
        latestReviews: { nodes: p.latestReviews ?? [] },
        repository: p.repo ? { nameWithOwner: p.repo } : null,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: ((p.statusCheckRollup ?? []) as Record<string, unknown>[]).map((c) =>
                      c.context ? { context: c.context, state: c.state, createdAt: c.startedAt } : c,
                    ),
                  },
                },
              },
            },
          ],
        },
        statusCheckRollup: undefined,
      })),
    },
    repository: {
      handoff: { nodes: handoff.map((i) => ({ ...i, labels: nodes(i.labels) })) },
      claimed: { nodes: claimed.map((i) => ({ ...i, labels: nodes(i.labels) })) },
    },
  };
}

export interface Result {
  readonly rc: number;
  readonly out: string;
  readonly err: string;
}

/** A sandboxed instance: its own $HOME, work/ configured, and the fakes every command runs with. */
export class Sandbox {
  readonly home: string;
  readonly work: string;
  readonly locks: string;
  readonly clock = new FakeClock();
  readonly runtime = new FakeRuntime();
  readonly github = new FakeGitHub();
  env: Record<string, string | undefined>;

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), "sd-test-"));
    this.work = join(this.home, "work");
    this.locks = join(this.home, "locks");
    mkdirSync(join(this.home, ".claude", "projects", "-home-agent-work"), { recursive: true });
    mkdirSync(this.work, { recursive: true });
    writeFileSync(join(this.work, "CONFIG.md"), CONFIG);
    this.env = {
      HOME: this.home,
      PATH: shimsLast(process.env.PATH ?? "").replace(/:?[^:]*\/mise\/shims/g, ""),
      SD_LOCKS: this.locks,
      SD_BOOT_ID: "boot-1",
      PLATFORM_FIRE_AT: "2026-09-24T10:20:00Z",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    this.github.on(/^user$/, { login: "dev-bot" });
  }

  done(): void {
    rmSync(this.home, { recursive: true, force: true });
  }

  deps(extra: Record<string, string | undefined> = {}, stdin = ""): Deps & { lines: { out: string[]; err: string[] } } {
    const lines = { out: [] as string[], err: [] as string[] };
    return {
      env: { ...this.env, ...extra },
      clock: this.clock,
      runtime: this.runtime,
      github: this.github,
      io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) },
      stdin: () => stdin,
      lines,
    };
  }

  async run(
    cmd: Command,
    args: readonly string[],
    extra: Record<string, string | undefined> = {},
    stdin = "",
  ): Promise<Result> {
    const d = this.deps(extra, stdin);
    const rc = await invoke(cmd, d, args);
    return { rc, out: d.lines.out.join("\n"), err: d.lines.err.join("\n") };
  }

  config(append: string): void {
    writeFileSync(join(this.work, "CONFIG.md"), `${this.read("work/CONFIG.md")}${append}\n`);
  }
  setConfig(key: string, value: string | null): void {
    const lines = this.read("work/CONFIG.md")
      .split("\n")
      .flatMap((l) => (l.startsWith(`- ${key}:`) ? (value === null ? [] : [`- ${key}: ${value}`]) : [l]));
    writeFileSync(join(this.work, "CONFIG.md"), lines.join("\n"));
  }

  read(rel: string): string {
    try {
      return readFileSync(join(this.home, rel), "utf8");
    } catch {
      return "";
    }
  }
  write(rel: string, text: string): void {
    mkdirSync(dirname(join(this.home, rel)), { recursive: true });
    writeFileSync(join(this.home, rel), text);
  }

  /** A key of a file under work/. */
  field(rel: string, key: string): string {
    return kv(join(this.work, rel), key);
  }

  /** A lock as run-state would leave it. */
  lock(name: string, fields: Record<string, string>): void {
    const all = { boot: "boot-1", ...fields };
    this.write(
      `locks/${name}/owner`,
      `# owner\n\n${Object.entries(all)
        .map(([k, v]) => `- ${k}: ${v}\n`)
        .join("")}`,
    );
  }

  /** A work/items/<n>.md. */
  item(n: string, fields: Record<string, string>): void {
    this.write(
      `work/items/${n}.md`,
      `# ${n}\n\n- item: ${n}\n${Object.entries(fields)
        .map(([k, v]) => `- ${k}: ${v}\n`)
        .join("")}`,
    );
  }

  git(args: readonly string[], cwd = this.home) {
    return run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: this.env,
    });
  }

  /** work/widgets cloned from a local bare origin with one commit on main. */
  originCheckout(): void {
    const seed = join(this.home, "seed");
    this.git(["init", "-q", "--bare", "-b", "main", join(this.home, "widgets.git")]);
    this.git(["init", "-q", "-b", "main", seed]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    writeFileSync(join(seed, ".gitignore"), "dist/\n");
    this.git(["add", "-A"], seed);
    this.git(["commit", "-qm", "init"], seed);
    this.git(["push", "-q", join(this.home, "widgets.git"), "main"], seed);
    rmSync(seed, { recursive: true, force: true });
    rmSync(join(this.work, "widgets"), { recursive: true, force: true });
    this.git(["clone", "-q", join(this.home, "widgets.git"), join(this.work, "widgets")]);
  }

  /** The branch slot k is on: HEAD when detached, "" when it does not exist. */
  slot(k: number): string {
    const r = run("git", ["-C", join(this.work, "slots", String(k)), "rev-parse", "--abbrev-ref", "HEAD"], {
      env: this.env,
    });
    return r.code === 0 ? r.stdout.trim() : "";
  }

  /** The rest of what onboarding leaves: the definition at $HOME, committed; the sentinel; work/AGENTS.md and VERSION; the clone. */
  onboarded(): void {
    for (const f of [".gitignore", "VERSION", "kit.yaml"])
      writeFileSync(join(this.home, f), readFileSync(join(ROOT, f)));
    this.write(".agents/skills/implement-issue/SKILL.md", "");
    for (const d of ["grill", "file-issue"]) this.write(`.agents/defaults/${d}/SKILL.md`, "");
    symlinkSync("../.agents/skills", join(this.home, ".claude", "skills"));
    this.git(["init", "-q"]);
    this.git(["add", "-A"]);
    this.git(["commit", "-qm", "definition"]);
    this.write(".software-developer-onboarded", `${iso(new Date())}\n`);
    this.write(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: `${this.home}/scripts/harness/claude-code/enforce-finish.sh` }] },
          ],
        },
      }),
    );
    this.write("work/AGENTS.md", "# pointer\n");
    writeFileSync(join(this.work, "VERSION"), readFileSync(join(this.home, "VERSION")));
    this.git(["init", "-q", join(this.work, "widgets")]);
    this.git(["-C", join(this.work, "widgets"), "remote", "add", "origin", "https://github.com/acme/widgets"]);
  }
}

/** Runs a test body in a fresh sandbox and cleans up after it. */
export async function inSandbox(body: (s: Sandbox) => Promise<void> | void): Promise<void> {
  const s = new Sandbox();
  try {
    await body(s);
  } finally {
    s.done();
  }
}
