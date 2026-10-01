#!/usr/bin/env bash
# verify-onboarding.sh — does this instance have the shape onboarding promises?
#
# Shape only: files, keys, formats. It never judges the data inside, and it
# never repairs — every FAIL carries the fix to apply, and the caller re-runs it
# until it prints PASS. Onboarding runs it twice, an upgrade that changes what
# onboarding produces runs it again, and the weekly audit runs it every week.
#
#   --config   work/CONFIG.md only: the mid-onboarding scope, before the
#              version file, the sentinel and the checkout exist
#   (none)     the definition checkout, work/ and CONFIG.md
#   --live     all of that, plus: GitHub answers as `author`, the repository
#              takes a push, the labels exist, the runtime answers, and the
#              precheck's detection runs end to end inside its deadline
#
# Exit 0 iff nothing FAILed.
set -u
export LC_ALL=C

LIVE=0; STRUCTURE=1
case "${1:-}" in
  --live) LIVE=1 ;;
  --config) STRUCTURE=0 ;;
  '') ;;
  *) echo "usage: $0 [--config|--live]" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/config.sh"
WORK="$HOME/work"
CONFIG="$WORK/CONFIG.md"
KNOWN="repo author app_url label_handoff label_claimed label_failed label_review
  verify cluster cluster_install cluster_uninstall cluster_delete stuck_after_min"
RUN_KEYS="run_state session occurrence claimed_at phase phase_at issue pr outcome ended_at"
GATE_KEYS="busy_since diagnosed_at diagnoses"

CHECKS=0; FAILS=0; WARNS=0
ok()   { CHECKS=$((CHECKS + 1)); printf 'ok   %s — %s\n' "$1" "$2"; }
fail() { CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); printf 'FAIL %s — %s — fix: %s\n' "$1" "$2" "$3"; }
warn() { WARNS=$((WARNS + 1)); printf 'warn %s — %s\n' "$1" "$2"; }

# keys_in <file> — every `- key:` bullet's key, lowercased, one per line. A
# bullet whose text before the colon has a space is prose, not a key.
keys_in() {
  grep -oE '^[-*][[:space:]]*[A-Za-z0-9_]+[[:space:]]*:' "$1" 2>/dev/null |
    sed -E 's/^[-*][[:space:]]*//; s/[[:space:]]*:$//' | tr '[:upper:]' '[:lower:]'
}

# unknown_in <file> <known keys> — the keys the runtime would never read
unknown_in() {
  keys_in "$1" | while read -r k; do
    case " $(echo $2) " in *" $k "*) ;; *) echo "$k" ;; esac
  done | sort -u | tr '\n' ' ' | sed -E 's/ $//'
}

REPO="$(cfg repo)"
case "$REPO" in */*/*) HOST="${REPO%%/*}"; SLUG="${REPO#*/}" ;; *) HOST=github.com; SLUG="$REPO" ;; esac

# ------------------------------------------------------------------ CONFIG
CFG_FIX="ONBOARDING.md → 3. Write it down"
if [ ! -f "$CONFIG" ]; then
  fail config "work/CONFIG.md is missing" "write it — $CFG_FIX"
else
  for k in repo author app_url label_handoff label_claimed label_failed label_review verify cluster; do
    if [ -n "$(cfg "$k")" ]; then ok "config.$k" "$(cfg "$k")"
    else fail "config.$k" "missing" "add \`- $k: <value>\` — $CFG_FIX"; fi
  done

  if [ -n "$REPO" ] && ! printf '%s' "$REPO" | grep -qE '^([A-Za-z0-9.-]+/)?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    fail config.repo "'$REPO' is not [host/]owner/name" "write the slug alone, no URL"
  fi
  APP="$(cfg app_url)"
  if [ -n "$APP" ] && ! printf '%s' "$APP" | grep -qE '^https?://[^[:space:]]+$'; then
    fail config.app_url "'$APP' is not a URL" "the address from the browser, e.g. https://platform.example.com"
  fi
  case "$(cfg cluster)" in
    '' | none) ;;
    required)
      for k in cluster_install cluster_uninstall cluster_delete; do
        [ -n "$(cfg "$k")" ] ||
          fail "config.$k" "missing, and cluster is required" "ask for it — ONBOARDING.md → 2. Ask"
      done ;;
    *) fail config.cluster "'$(cfg cluster)' is neither none nor required" "write one of the two" ;;
  esac
  S="$(cfg stuck_after_min)"
  case "$S" in
    '' | *[!0-9]*) [ -z "$S" ] || fail config.stuck_after_min "'$S' is not a whole number of minutes" "write 120, or more" ;;
  esac

  u="$(unknown_in "$CONFIG" "$KNOWN")"
  [ -z "$u" ] && ok config.keys "every bullet is a known key" ||
    fail config.keys "unknown key(s): $u — no script reads them" \
      "rename to a key CLAUDE.md → Runtime configuration lists, or rewrite as prose under a heading"
  d="$(keys_in "$CONFIG" | sort | uniq -d | tr '\n' ' ' | sed -E 's/ $//')"
  [ -z "$d" ] || fail config.keys "duplicated: $d — only the first of each is read" "keep one line per key"
fi

# --------------------------------------------------------------- structure
if [ "$STRUCTURE" = 1 ]; then
  DEF_FIX="docs/persistence.md → Definition version & upgrade"
  if [ -d "$HOME/.git" ]; then
    ok definition "checked out at \$HOME"
    first="$(grep -vE '^[[:space:]]*(#|$)' "$HOME/.gitignore" 2>/dev/null | head -1)"
    [ "$first" = "/*" ] && ok definition.gitignore "allowlist" ||
      fail definition.gitignore "first rule is '${first:-none}', not /* — a git add in \$HOME can stage secrets" "update the definition — $DEF_FIX"
    dirty="$(git -C "$HOME" status --porcelain 2>/dev/null | head -5 | tr '\n' ' ')"
    [ -z "$dirty" ] && ok definition.clean "nothing changed in place" ||
      fail definition.clean "edited in place: $dirty" \
        "move the change to a pull request (docs/persistence.md → Evolving the definition), then git -C \$HOME checkout -- <file>"
  else
    fail definition "no checkout at \$HOME" "operator-only: re-create the agent from the kit"
  fi

  S="$HOME/.software-developer-onboarded"
  if [ -f "$S" ] && grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' "$S"; then
    ok sentinel "$(cat "$S")"
  else
    fail sentinel "missing or not a UTC timestamp" "ONBOARDING.md → 5. Finish"
  fi

  if [ -d "$WORK" ] && [ ! -e "$WORK/.git" ]; then ok work "a plain directory"
  else fail work "missing, or a git repository — the shared volume corrupts a .git under concurrent runs" "remove work/.git; never git in work/"; fi
  [ -f "$WORK/AGENTS.md" ] && ok work.AGENTS "present" ||
    fail work.AGENTS "missing — a harness started in work/ never finds CLAUDE.md" "seed it — $CFG_FIX"
  v="$(head -1 "$WORK/VERSION" 2>/dev/null)"; want="$(head -1 "$HOME/VERSION" 2>/dev/null)"
  [ -n "$v" ] && [ "$v" = "$want" ] && ok work.VERSION "$v" ||
    fail work.VERSION "adopted '${v:-none}', checked out '${want:-none}'" "migrate — $DEF_FIX"

  if [ -n "$REPO" ]; then
    CO="$WORK/${REPO##*/}"
    if [ -d "$CO/.git" ] && git -C "$CO" config --get remote.origin.url 2>/dev/null | grep -qF "$SLUG"; then
      ok checkout "work/${REPO##*/}"
    else
      fail checkout "no clone of $REPO at work/${REPO##*/}" "ONBOARDING.md → 4. Clone it"
    fi
  fi

  if [ -f "$WORK/RUN.md" ]; then
    u="$(unknown_in "$WORK/RUN.md" "$RUN_KEYS")"
    case "$(kv "$WORK/RUN.md" run_state)" in
      running | idle) [ -z "$u" ] && ok state.RUN "$(kv "$WORK/RUN.md" run_state)" ||
        fail state.RUN "unknown key(s): $u" "RUN.md is written only by scripts/run-state.sh — remove the lines" ;;
      *) fail state.RUN "run_state is neither running nor idle" "bash \$HOME/scripts/run-state.sh abandon \"malformed record\"" ;;
    esac
  fi
  if [ -f "$WORK/GATE.md" ]; then
    u="$(unknown_in "$WORK/GATE.md" "$GATE_KEYS")"
    [ -z "$u" ] && ok state.GATE "well-formed" ||
      fail state.GATE "unknown key(s): $u" "bash \$HOME/scripts/run-state.sh free"
  fi
  if [ -f "$WORK/TICK.log" ]; then
    bad="$(grep -cvE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z [a-z-]+ ' "$WORK/TICK.log")"
    [ "$bad" = 0 ] && ok state.TICK "$(wc -l < "$WORK/TICK.log" | tr -d ' ') lines" ||
      fail state.TICK "$bad line(s) run-state.sh did not write" "remove them; the log is append-only through run-state.sh"
  fi

  names="$(sed -n '/^schedules:/,$s/^  - name: //p' "$HOME/kit.yaml" 2>/dev/null | tr '\n' ' ' | sed -E 's/ $//')"
  warn schedules "only MCP can list them — check with list_schedules that these exist: ${names:-none in kit.yaml}"
fi

# -------------------------------------------------------------------- live
if [ "$LIVE" = 1 ]; then
  login="$(gh api --hostname "$HOST" user --jq .login 2>/dev/null)"
  if [ -z "$login" ]; then
    fail live.auth "GitHub did not answer on $HOST" "operator-only: grant the GitHub connection (README → The GitHub connection)"
  elif [ "$login" = "$(cfg author)" ]; then
    ok live.auth "acting as $login"
  else
    fail live.auth "acting as $login, but author is '$(cfg author)' — the precheck would never find your pull requests" "set \`- author: $login\`"
  fi

  if [ -n "$SLUG" ]; then
    push="$(gh api --hostname "$HOST" "repos/$SLUG" --jq .permissions.push 2>/dev/null)"
    [ "$push" = true ] && ok live.push "$REPO takes a push" ||
      fail live.push "no push to $REPO (${push:-no answer})" "operator-only: the connection needs write on contents, pull requests and issues"
    reach="$(gh api --hostname "$HOST" "user/repos?per_page=100" --jq '[.[] | select(.permissions.push)] | length' 2>/dev/null)"
    case "$reach" in
      1) ok live.scope "the connection pushes to this repository alone" ;;
      '' | *[!0-9]*) warn live.scope "could not count the repositories the connection can push to" ;;
      *) warn live.scope "the connection can push to $reach repositories — README → The GitHub connection asks for one" ;;
    esac
    have="$(gh label list -R "$REPO" --limit 500 --json name --jq '.[].name' 2>/dev/null)"
    if [ -z "$have" ]; then
      warn live.labels "could not list the labels of $REPO"
    else
      for k in label_handoff label_claimed label_failed label_review; do
        l="$(cfg "$k")"; [ -n "$l" ] || continue
        printf '%s\n' "$have" | grep -qxF "$l" && ok "live.$k" "$l exists" ||
          fail "live.$k" "no label '$l' on $REPO — nothing will ever apply it" "create it, or correct the key"
      done
    fi
  fi

  if curl -fsS --max-time 5 "${PLATFORM_RUNTIME_URL:-}/api/status" 2>/dev/null | jq -e 'has("idle")' >/dev/null 2>&1; then
    ok live.runtime "the runtime answers — the precheck can see the sandbox"
  else
    fail live.runtime "no answer from \$PLATFORM_RUNTIME_URL/api/status — every tick would run ungated" "operator-only: report it; the runtime publishes this for every agent"
  fi

  start=$SECONDS
  (cd "$WORK" && PRECHECK_PROBE=1 bash "$HERE/precheck.sh" >/dev/null 2>"$WORK/.verify-precheck.err")
  rc=$?; took=$((SECONDS - start))
  why="$(tail -c 300 "$WORK/.verify-precheck.err" 2>/dev/null | tr '\n' ' ')"; rm -f "$WORK/.verify-precheck.err"
  case "$rc" in
    0 | 1) ;;
    *) fail live.precheck "exit $rc — a broken precheck fails open, and every tick pays for a turn${why:+: $why}" "fix what it printed, then re-run" ;;
  esac
  if [ "$rc" -le 1 ]; then
    if [ "$took" -ge 120 ]; then fail live.precheck "took ${took}s — past the two-minute deadline it fails open" "report it; the GitHub queries are too slow"
    elif [ "$took" -ge 90 ]; then warn live.precheck "took ${took}s — close to the two-minute deadline"
    else ok live.precheck "exit $rc in ${took}s"; fi
  fi
fi

# ----------------------------------------------------------------- summary
if [ "$LIVE" = 1 ]; then SCOPE=live; elif [ "$STRUCTURE" = 1 ]; then SCOPE=structure; else SCOPE=config; fi
if [ "$FAILS" -eq 0 ]; then
  printf 'PASS (%s) — %d checks, %d warning(s)\n' "$SCOPE" "$CHECKS" "$WARNS"
  exit 0
fi
printf 'RESULT (%s): %d of %d checks FAILED — apply each fix above, then re-run until it prints PASS.\n' "$SCOPE" "$FAILS" "$CHECKS"
exit 1
