# The app

Everything this definition runs is one TypeScript CLI, `bin/sd <command>`.
Node runs the source as it is — no build, nothing compiled to keep in step —
and the runtime needs no package: `node_modules` holds only the dev tools
(TypeScript, Biome) that check it.

```sh
cd app && npm ci && npm run check   # typecheck, lint, offline tests
../bin/sd run-state show            # any command, as a script calls it
```

Every script in `scripts/` is a two-line shim onto a command, so the paths a
deployed schedule, the Stop hook and the docs call never change. Node 22.18 or
newer; `bin/sd` finds it on `PATH`, or where mise keeps it.

## Layout

| Path | Holds |
| --- | --- |
| `src/factory/` | What every kit shares: `CONFIG.md` and the `- key: value` files, the locks, the runtime, GitHub through `gh`, git, a verifier's report, the definition validator. Nothing here names this kit. |
| `src/developer/` | This kit: `run-state`, `precheck`, `verify`, `audit`, `work-backup`, the Stop hook and the installer. |
| `src/registry.ts` | Every command, by the name `bin/sd` takes. |
| `src/cli.ts` | The entry point: builds the real context and runs a command. |
| `test/` | `node:test` suites, one per command, against fakes of the runtime, GitHub and the clock in a sandboxed `$HOME`. |

## Rules the code keeps

- **A command is a function of its context.** It gets `Deps` — the
  environment, a clock, the runtime, GitHub, stdout/stderr — and never reads
  `process.env` or the system clock itself. That is what lets a test run a
  nine-minute `wait` in no time, with no network.
- **The app detects, the agent acts.** No command writes to GitHub, commits or
  pushes, except `work-backup`, to `work_repo` alone
  ([`docs/self-modification.md`](../docs/self-modification.md) §4).
- **A failed read is not an answer.** Every GitHub and runtime read returns
  `undefined` or `unreachable` when it could not be made, and the caller says
  "not measured" — never zero, never none, never dead.
- **The state files keep their format.** Locks, `items/`, `GATE.md` and
  `TICK.log` are byte-compatible with what the shell scripts before 6.0.0
  wrote, so an instance updates in place with nothing to migrate.

## Porting a kit

Another kit moves onto the factory the same way this one did, one command at
a time, without its deployed instances noticing:

1. Copy `app/` with `src/factory/` and the tooling; leave `src/developer/` out.
2. Give the kit a directory beside it (`src/<kit>/`), and a `Kit` class that
   reads its `CONFIG.md` keys with their documented defaults.
3. Port one script: its command in `src/<kit>/`, its test in `test/` from
   the old shell test's cases, its entry in `src/registry.ts`, and the script
   itself replaced by the shim — `exec "$(dirname "$0")/../bin/sd" <command> "$@"`.
   The kit keeps every path its `kit.yaml`, hooks and docs name.
4. Repeat until `scripts/` holds only shims; then drop the shell test runner.
5. Add `!/bin/` and `!/app/` to the kit's `.gitignore` allowlist, and its CI
   job, and bump the kit's version with an **Upgrade** step that is `none` when
   the state formats did not change.

The factory changes in one kit first, and is copied to the others from there;
`validate-definition` is the factory's, and checks every kit the same way.
