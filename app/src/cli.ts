#!/usr/bin/env node
// The one entry point: `bin/sd <command> [args…]`. Every script under
// scripts/ is a two-line shim onto a command here, so the paths deployed
// instances already call — a schedule's precheck, the Stop hook, the docs'
// `bash "$HOME/scripts/run-state.sh" …` — keep working while the code lives
// in TypeScript.
import { type Command, invoke, realDeps } from "./factory/context.ts";
import { commands } from "./registry.ts";

export async function main(
  argv: readonly string[],
  table: Readonly<Record<string, Command>> = commands,
): Promise<number> {
  const [name, ...args] = argv;
  const deps = realDeps();
  const cmd = name === undefined ? undefined : table[name];
  if (!cmd) {
    deps.io.err(`usage: sd <command> [args…] — commands: ${Object.keys(table).sort().join(", ")}`);
    return 2;
  }
  try {
    return await invoke(cmd, deps, args);
  } catch (e) {
    deps.io.err(`sd ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return 70;
  }
}

process.exitCode = await main(process.argv.slice(2));
