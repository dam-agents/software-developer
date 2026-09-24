#!/usr/bin/env bash
# run-state.sh — the one writer of the tick's state files under work/.
#
#   RUN.md    the run in flight: which session holds it, what it is doing and
#             since when. A run announces itself here and nowhere else — the
#             labels say what happened to the work, never whether the run doing
#             it is over.
#   GATE.md   what the precheck has seen between runs: since when the sandbox
#             has read busy, and when it last let a diagnostic run through.
#   TICK.log  one line per closed run, append-only.
#
# RUN.md changes hands only while no turn is running — the precheck claims it
# and abandons it with the sandbox idle, the run writes it while it holds it —
# and only the precheck writes GATE.md, so no two writers race on one file.
# Both are rewritten whole, tmp + mv.
#
#   claim <occurrence>       precheck, on letting a work run through
#   start                    the run's first act: stamps its session on the claim
#   phase <text> [issue]     the run, before each long step
#   finish <outcome> [pr]    the run's last act, on every way out
#   abandon <reason>         closes a record whose run is gone
#   busy | free | diagnosed  precheck bookkeeping between runs
#   show                     both files, for a human
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/config.sh"
. "$HERE/lib/time.sh"

WORK="$HOME/work"
RUN="$WORK/RUN.md"
GATE="$WORK/GATE.md"
LOG="$WORK/TICK.log"
ME="${CLAUDE_CODE_SESSION_ID:-unknown}"

RUN_KEYS="run_state session occurrence claimed_at phase phase_at issue pr outcome ended_at"
GATE_KEYS="busy_since diagnosed_at diagnoses"

# write <file> <from> <keys> [key=value ...] — <file> rewritten with each key's
# value from the pairs when given, from <from> otherwise (/dev/null starts
# clean). A value of `-` drops the key.
write() {
  local file="$1" from="$2" keys="$3" k v pair tmp
  shift 3
  mkdir -p "$WORK" || return 2
  tmp="$(mktemp "$WORK/.$(basename "$file").XXXXXX")" || return 2
  {
    printf '# %s\n\nWritten by scripts/run-state.sh, never by hand.\n\n' "$(basename "$file" .md)"
    for k in $keys; do
      v="$(kv "$from" "$k")"
      for pair in "$@"; do
        [ "${pair%%=*}" = "$k" ] && v="${pair#*=}"
      done
      v="$(printf '%s' "$v" | tr '\n' ' ')"
      if [ -n "$v" ] && [ "$v" != - ]; then printf -- '- %s: %s\n' "$k" "$v"; fi
    done
  } > "$tmp" && mv -f "$tmp" "$file"
}

held() { [ "$(kv "$RUN" run_state)" = running ]; }

mine() {
  local holder
  held || { echo "no run in flight in work/RUN.md — call start first" >&2; return 1; }
  holder="$(kv "$RUN" session)"
  [ "$holder" = "$ME" ] || [ "$holder" = pending ] || {
    echo "work/RUN.md is held by session $holder, not this one" >&2
    return 1
  }
}

# close <outcome> [extra log text] — the record goes idle, the run gets its line
close() {
  local end mins="-" a b
  end="$(now)"
  write "$RUN" "$RUN" "$RUN_KEYS" run_state=idle "outcome=$1" "ended_at=$end" || return 2
  if a="$(epoch "$(kv "$RUN" claimed_at)")" && b="$(epoch "$end")"; then
    mins=$(( (b - a) / 60 ))
  fi
  printf '%s %s session=%s occurrence=%s issue=%s pr=%s minutes=%s%s\n' \
    "$end" "$1" "$(kv "$RUN" session)" "$(kv "$RUN" occurrence)" \
    "$(kv "$RUN" issue | grep . || echo -)" "$(kv "$RUN" pr | grep . || echo -)" \
    "$mins" "${2:+ $2}" >> "$LOG"
}

case "${1:-}" in
  claim)
    write "$RUN" /dev/null "$RUN_KEYS" run_state=running session=pending \
      "occurrence=${2:-unknown}" "claimed_at=$(now)" phase=claimed "phase_at=$(now)"
    ;;
  start)
    if ! held; then
      # nobody claimed for this run: started by hand, or through a broken precheck
      write "$RUN" /dev/null "$RUN_KEYS" run_state=running "session=$ME" \
        occurrence=manual "claimed_at=$(now)" phase=started "phase_at=$(now)"
    elif mine 2>/dev/null; then
      write "$RUN" "$RUN" "$RUN_KEYS" "session=$ME" phase=started "phase_at=$(now)"
    else
      echo "another run holds work/RUN.md: session $(kv "$RUN" session)," \
        "\"$(kv "$RUN" phase)\" since $(kv "$RUN" phase_at). Do not build." >&2
      exit 1
    fi
    ;;
  phase)
    mine || exit 1
    write "$RUN" "$RUN" "$RUN_KEYS" "phase=${2:?phase text}" "phase_at=$(now)" \
      ${3:+"issue=$3"}
    ;;
  finish)
    mine || exit 1
    [ -n "${3:-}" ] && { write "$RUN" "$RUN" "$RUN_KEYS" "pr=$3" || exit 2; }
    close "${2:?outcome}"
    ;;
  abandon)
    held || exit 0
    close abandoned "reason=\"${2:-unknown}\""
    ;;
  busy)
    [ -n "$(kv "$GATE" busy_since)" ] || write "$GATE" "$GATE" "$GATE_KEYS" "busy_since=$(now)"
    ;;
  free)
    rm -f "$GATE"
    ;;
  diagnosed)
    n="$(kv "$GATE" diagnoses)"
    write "$GATE" "$GATE" "$GATE_KEYS" "diagnosed_at=$(now)" "diagnoses=$(( ${n:-0} + 1 ))"
    printf '%s diagnostic busy_since=%s holder=%s\n' "$(now)" \
      "$(kv "$GATE" busy_since | grep . || echo -)" "$(kv "$RUN" session | grep . || echo -)" >> "$LOG"
    ;;
  show)
    cat "$RUN" "$GATE" 2>/dev/null || echo "no tick state yet"
    ;;
  *)
    echo "usage: run-state.sh claim|start|phase|finish|abandon|busy|free|diagnosed|show" >&2
    exit 2
    ;;
esac
