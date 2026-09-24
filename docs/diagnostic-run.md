# The diagnostic run

A prompt that opens with **DIAGNOSTIC RUN** is not a work run. The sandbox has
read busy with nothing moving for longer than `stuck_after_min`, and every tick
has stepped aside since. Do not build, do not claim, do not call
`run-state.sh start`.

Find what is holding it — the session and phase the prompt names, whether a
build it started is still a live process, the background work the runtime
listed — and report plainly what is stuck, since when, and what would free it.
The report is the whole job; freeing the sandbox is the operator's call.

One exception: when the run named in `work/RUN.md` is provably gone — no
process of its own left, a transcript that stopped, nothing it started still
running — close its record with `run-state.sh abandon "<what you found>"`, so
the next tick can resume its issue.
