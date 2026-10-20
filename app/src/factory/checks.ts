// A verifier's report: one line per check, `ok`, `warn` or `FAIL`, every FAIL
// carrying the fix to apply, and a summary. Shape only — a check never
// repairs, and the caller re-runs until it prints PASS.
import type { Io } from "./context.ts";

export class Report {
  checks = 0;
  fails = 0;
  warns = 0;
  private readonly io: Io;

  constructor(io: Io) {
    this.io = io;
  }

  ok(id: string, what: string): void {
    this.checks++;
    this.io.out(`ok   ${id} — ${what}`);
  }

  fail(id: string, what: string, fix: string): void {
    this.checks++;
    this.fails++;
    this.io.out(`FAIL ${id} — ${what} — fix: ${fix}`);
  }

  warn(id: string, what: string): void {
    this.warns++;
    this.io.out(`warn ${id} — ${what}`);
  }

  /** The summary line, and the exit code: 0 iff nothing failed. */
  summary(scope: string): number {
    if (this.fails === 0) {
      this.io.out(`PASS (${scope}) — ${this.checks} checks, ${this.warns} warning(s)`);
      return 0;
    }
    this.io.out(
      `RESULT (${scope}): ${this.fails} of ${this.checks} checks FAILED — apply each fix above, then re-run until it prints PASS.`,
    );
    return 1;
  }
}
