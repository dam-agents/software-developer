// What every command runs with: its environment, a clock, the runtime, GitHub
// and somewhere to write. The CLI builds the real ones; a test builds fakes.
// Nothing below reads process.env or the system clock directly, so a command
// is a function of its context and the files under its $HOME.
import { readFileSync } from "node:fs";
import { GhCli, type GitHub } from "./github.ts";
import { HttpRuntime, type Runtime } from "./runtime.ts";
import { type Clock, systemClock } from "./time.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export interface Io {
  /** A line on stdout: what the caller reads. */
  out(line: string): void;
  /** A line on stderr: what a person or the model is told. */
  err(line: string): void;
}

export interface Deps {
  readonly env: Env;
  readonly clock: Clock;
  readonly runtime: Runtime;
  readonly github: GitHub;
  readonly io: Io;
  /** stdin, read whole: a hook's input. */
  readonly stdin: () => string;
}

/** A command: its arguments in, an exit code out. */
export type Command = (deps: Deps, args: readonly string[]) => Promise<number>;

/**
 * WORKAROUND (environment, not this definition): the image puts mise's shim
 * directory ahead of /usr/bin, holding shims for coreutils no active tool
 * provides, so every git or gh the app starts would start mise first. Shims
 * go last: a real binary wins, a tool only a shim has still runs.
 */
export function shimsLast(path: string): string {
  const dirs = path.split(":");
  const shims = dirs.filter((d) => /\/mise\/shims$/.test(d));
  if (shims.length === 0) return path;
  return [...dirs.filter((d) => !/\/mise\/shims$/.test(d)), ...shims].join(":");
}

export function realDeps(): Deps {
  const env: Env = { ...process.env, PATH: shimsLast(process.env.PATH ?? "") };
  return {
    env,
    clock: systemClock,
    runtime: new HttpRuntime(env.PLATFORM_RUNTIME_URL ?? "", 5000, env.PLATFORM_MCP_URL ?? ""),
    github: new GhCli(env),
    io: {
      out: (s) => process.stdout.write(`${s}\n`),
      err: (s) => process.stderr.write(`${s}\n`),
    },
    stdin: () => {
      try {
        return readFileSync(0, "utf8");
      } catch {
        return "";
      }
    },
  };
}

/** A usage error, or a precondition a command cannot meet: exits with its code. */
export class Exit extends Error {
  readonly code: number;

  constructor(code: number, message = "") {
    super(message);
    this.code = code;
  }
}

/** Runs a command, turning an Exit it throws into its code: what the CLI and the tests both call. */
export async function invoke(cmd: Command, deps: Deps, args: readonly string[]): Promise<number> {
  try {
    return await cmd(deps, args);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    if (e.message) deps.io.err(e.message);
    return e.code;
  }
}
