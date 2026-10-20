// GitHub, through `gh`: the gateway puts the credential on every request, so
// there is no token here to find, hold or leak. GraphQL and REST are separate
// hourly budgets, and an app's bot shares its installation's with every agent
// on it, so every read the kit makes has a REST form, and a conditional REST
// read whose answer is `304 Not Modified` costs nothing.
import { type Ran, run } from "./proc.ts";

export interface Conditional {
  /** 200 changed, or read for the first time · 304 unchanged · 0 unreadable */
  readonly status: 200 | 304 | 0;
  readonly etag: string;
  readonly body: unknown;
}

export interface GraphQLResult<T> {
  readonly data?: T;
  readonly error?: string;
}

export interface GitHub {
  /** A REST read, parsed; undefined when it could not be read. */
  get(host: string, path: string): Promise<unknown>;
  /** Every page of a REST list, as one array; undefined when a page could not be read. */
  getAll(host: string, path: string): Promise<unknown[] | undefined>;
  /** A REST read that costs nothing when nothing changed since `etag`. */
  getIfChanged(host: string, path: string, etag: string): Promise<Conditional>;
  graphql<T>(host: string, query: string, vars: Readonly<Record<string, string>>): Promise<GraphQLResult<T>>;
  /** `gh pr view --json <fields>`: one GraphQL read; undefined when it could not be read. */
  prView(host: string, slug: string, n: number, fields: string): Promise<unknown>;
  clone(host: string, slug: string, dir: string): Promise<boolean>;
}

/** `gh api` and `gh repo clone`, with the environment of the command that asked. */
export class GhCli implements GitHub {
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.env = env;
  }

  private gh(args: readonly string[]): Ran {
    return run("gh", args, { env: this.env, timeoutMs: 60_000 });
  }

  async get(host: string, path: string): Promise<unknown> {
    const r = this.gh(["api", "--hostname", host, path]);
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return undefined;
    }
  }

  async getAll(host: string, path: string): Promise<unknown[] | undefined> {
    const r = this.gh(["api", "--hostname", host, "--paginate", path]);
    if (r.code !== 0) return undefined;
    const pages = parseJsonStream(r.stdout);
    if (pages === undefined) return undefined;
    return pages.flatMap((p) => (Array.isArray(p) ? p : [p]));
  }

  async getIfChanged(host: string, path: string, etag: string): Promise<Conditional> {
    const r = this.gh(["api", "--hostname", host, "-i", ...(etag ? ["-H", `If-None-Match: ${etag}`] : []), path]);
    const raw = r.stdout.replaceAll("\r", "");
    const split = raw.indexOf("\n\n");
    const head = split < 0 ? raw : raw.slice(0, split);
    const status = /^\S+ (\d{3})/.exec(head)?.[1];
    const tag = /^etag: *(.*)$/im.exec(head)?.[1]?.trim() ?? "";
    if (status === "304") return { status: 304, etag: etag, body: undefined };
    if (status !== "200") return { status: 0, etag: "", body: undefined };
    try {
      return { status: 200, etag: tag, body: JSON.parse(split < 0 ? "" : raw.slice(split + 2)) };
    } catch {
      return { status: 0, etag: "", body: undefined };
    }
  }

  async graphql<T>(host: string, query: string, vars: Readonly<Record<string, string>>): Promise<GraphQLResult<T>> {
    const args = ["api", "--hostname", host, "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
    const r = this.gh(args);
    if (r.code !== 0) return { error: (r.stderr || r.stdout).slice(0, 300) };
    try {
      const body = JSON.parse(r.stdout) as { data?: T; errors?: unknown };
      if (body.errors !== undefined || body.data === undefined)
        return { error: JSON.stringify(body.errors).slice(0, 300) };
      return { data: body.data };
    } catch {
      return { error: "GraphQL answered something that is not JSON" };
    }
  }

  async prView(host: string, slug: string, n: number, fields: string): Promise<unknown> {
    const r = this.gh(["pr", "view", String(n), "-R", `${host}/${slug}`, "--json", fields]);
    if (r.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout);
    } catch {
      return undefined;
    }
  }

  async clone(host: string, slug: string, dir: string): Promise<boolean> {
    return this.gh(["repo", "clone", `${host}/${slug}`, dir, "--", "-q"]).code === 0;
  }
}

/** JSON documents written back to back, as `gh api --paginate` prints pages. */
export function parseJsonStream(text: string): unknown[] | undefined {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          return undefined;
        }
      }
    }
  }
  return depth === 0 ? out : undefined;
}

/**
 * A login as GitHub spells it differently by API: an app's bot is
 * `name[bot]` over REST and `app/name` in gh's JSON, and case never matters.
 */
export function login(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");
}

const CLOSING = "fix(?:es|ed)?|close[sd]?|resolve[sd]?";

function refs(body: string | undefined | null, root: string, here: string, kw: string): string[] {
  const re = new RegExp(`(?:${kw}) ([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#([0-9]+)`, "gi");
  const out: string[] = [];
  for (const m of (body ?? "").matchAll(re)) {
    const repo = m[1] ?? here;
    if (repo.toLowerCase() === root.toLowerCase() && m[2]) out.push(m[2]);
  }
  return out;
}

/**
 * The issues of `root` a pull request of `here` names: `Fixes #<n>` in root
 * itself, `Fixes <root>#<n>` from another repository, and `Part of` beside
 * the closing words. How a pull request is paired with its issue — a change
 * here orphans every open one.
 */
export function issueRefs(body: string | undefined | null, root: string, here: string): string[] {
  return refs(body, root, here, `${CLOSING}|part of`);
}

/** The issues of `root` a pull request closes when it merges. */
export function closesRefs(body: string | undefined | null, root: string, here: string): string[] {
  return refs(body, root, here, CLOSING);
}
