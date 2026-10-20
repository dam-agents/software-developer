// Child processes: git, gh and the rest, run to their end. Every command the
// app runs goes through here, with the environment of the context that asked
// (a test's sandboxed $HOME, its fake PATH), never this process's own.
import { spawnSync } from "node:child_process";

/** What a finished command left: its exit code and both streams, decoded. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: string;
  readonly timeoutMs?: number;
}

/**
 * Runs a command to its end and never throws. A binary that is not there
 * answers 127 and one that ran out of time 124, as a shell would say it, so a
 * caller reads every failure the same way: a code that is not 0.
 */
export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Ran {
  const r = spawnSync(cmd, args, {
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts.env === undefined ? {} : { env: opts.env as NodeJS.ProcessEnv }),
    ...(opts.input === undefined ? {} : { input: opts.input }),
    ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  if (r.error) {
    const errno = (r.error as NodeJS.ErrnoException).code;
    return { code: errno === "ENOENT" ? 127 : 124, stdout, stderr: stderr || String(r.error.message) };
  }
  if (r.status === null) return { code: 128 + 15, stdout, stderr };
  return { code: r.status, stdout, stderr };
}

/** The first line of a command's output, trimmed: what `$(cmd)` gives a shell. */
export function line(r: Ran): string {
  return r.stdout.replace(/\n+$/, "").split("\n")[0]?.trim() ?? "";
}

/** The output with its trailing newlines removed, as `$(cmd)` gives it. */
export function text(r: Ran): string {
  return r.stdout.replace(/\n+$/, "");
}
