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
KNOWN="repo author app_url label_handoff label_claimed label_failed label_review label_needs_info
  verify verify_cluster cluster cluster_install cluster_uninstall cluster_delete slots stuck_after_min work_repo"
ITEM_KEYS="item state branch slot pr session seen_at abandoned updated_at"
GATE_KEYS="diagnosed_at diagnoses"

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
WORK_REPO="$(cfg work_repo)"
case "$WORK_REPO" in */*/*) WHOST="${WORK_REPO%%/*}"; WSLUG="${WORK_REPO#*/}" ;; *) WHOST=github.com; WSLUG="$WORK_REPO" ;; esac

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
  if [ -z "$WORK_REPO" ]; then
    ok config.work_repo "unset — work/ is not backed up (docs/persistence.md → Backup)"
  elif ! printf '%s' "$WORK_REPO" | grep -qE '^([A-Za-z0-9.-]+/)?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    fail config.work_repo "'$WORK_REPO' is not [host/]owner/name" "write the slug alone, no URL"
  elif [ "$WORK_REPO" = "$REPO" ]; then
    fail config.work_repo "is repo itself — the backup would push to the default branch of the repository you work on" "name a repository of its own"
  else
    ok config.work_repo "$WORK_REPO"
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
  S="$(cfg slots)"
  case "$S" in
    '') ;;
    *[!0-9]* | 0) fail config.slots "'$S' is not a whole number of slots" "write 3, or leave it out" ;;
  esac
  if [ -n "$(cfg verify_cluster)" ] && [ "$(cfg cluster)" != required ]; then
    fail config.verify_cluster "set, but cluster is not required — nothing would ever run it" "set cluster: required with its commands, or drop verify_cluster"
  fi

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

  [ ! -f "$WORK/RUN.md" ] ||
    fail state.RUN "work/RUN.md is a record from before slots — nothing reads it" "remove it (CHANGELOG.md → 2.0.0)"
  bad=""
  for f in "$WORK"/items/*.md; do
    [ -f "$f" ] || continue
    [ -z "$(unknown_in "$f" "$ITEM_KEYS")" ] || bad="$bad $(basename "$f")"
  done
  [ -z "$bad" ] || fail state.items "unknown keys in:$bad" "the items are written only by scripts/run-state.sh — delete the file; GitHub rebuilds it"
  if [ -f "$WORK/GATE.md" ]; then
    u="$(unknown_in "$WORK/GATE.md" "$GATE_KEYS")"
    [ -z "$u" ] && ok state.GATE "well-formed" ||
      fail state.GATE "unknown key(s): $u" "delete work/GATE.md; the precheck starts it again"
  fi
  if [ -n "$REPO" ]; then
    CO="$WORK/${REPO##*/}"
    if [ -d "$WORK/slots" ]; then
      bad=""; n=0
      for d in "$WORK"/slots/*; do
        [ -e "$d" ] || continue
        n=$((n + 1))
        [ "$(cd "$d" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)" = "$(cd "$CO/.git" 2>/dev/null && pwd -P)" ] ||
          bad="$bad $(basename "$d")"
      done
      want="$(cfg slots)"; want="${want:-3}"
      [ -z "$bad" ] || fail state.slots "work/slots/{${bad# }} are not worktrees of the checkout" "remove them; run-state.sh start creates slots"
      [ "$n" -le "$want" ] || fail state.slots "$n slots, more than slots: $want" "remove the highest with git worktree remove, once nothing unsaved is in them"
      [ -z "$bad" ] && [ "$n" -le "$want" ] && ok state.slots "$n of $want created"
    fi
    extra="$(git -C "$CO" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' |
      grep -vxF "$(cd "$CO" 2>/dev/null && pwd -P)" | grep -v "/work/slots/[0-9]*$" | tr '\n' ' ')"
    [ -z "$extra" ] || fail state.worktrees "worktrees outside work/slots: $extra" \
      "push what is in them, then git worktree remove — the slots are the only worktrees (CLAUDE.md → Rules)"
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
    want=1
    if [ -n "$WORK_REPO" ]; then
      want=2
      wpush="$(gh api --hostname "$WHOST" "repos/$WSLUG" --jq .permissions.push 2>/dev/null)"
      [ "$wpush" = true ] && ok live.work_repo "$WORK_REPO takes a push" ||
        fail live.work_repo "no push to $WORK_REPO (${wpush:-no answer}) — every backup fails" \
          "operator-only: create it private, and grant the connection write on its contents"
    fi
    reach="$(gh api --hostname "$HOST" "user/repos?per_page=100" --jq '[.[] | select(.permissions.push)] | length' 2>/dev/null)"
    case "$reach" in
      "$want") ok live.scope "the connection pushes to repo$([ "$want" = 2 ] && echo ' and work_repo') alone" ;;
      '' | *[!0-9]*) warn live.scope "could not count the repositories the connection can push to" ;;
      *) warn live.scope "the connection can push to $reach repositories — README → The GitHub connection asks for $want" ;;
    esac
    have="$(gh label list -R "$REPO" --limit 500 --json name --jq '.[].name' 2>/dev/null)"
    if [ -z "$have" ]; then
      warn live.labels "could not list the labels of $REPO"
    else
      for k in label_handoff label_claimed label_failed label_review label_needs_info; do
        l="$(cfg "$k")"
        [ "$k" = label_needs_info ] && l="${l:-agent/needs-info}"
        [ -n "$l" ] || continue
        printf '%s\n' "$have" | grep -qxF "$l" && ok "live.$k" "$l exists" ||
          fail "live.$k" "no label '$l' on $REPO — nothing will ever apply it" "create it, or correct the key"
      done
    fi
  fi

  if curl -fsS --max-time 5 --get --data-urlencode 'input={"sessionId":"verify-onboarding"}' \
      "${PLATFORM_RUNTIME_URL:-}/api/trpc/sessions.list" 2>/dev/null | jq -e '.result.data.sessions | type == "array"' >/dev/null 2>&1; then
    ok live.runtime "the runtime lists sessions — a dead run's slot can be freed"
  else
    fail live.runtime "no answer from \$PLATFORM_RUNTIME_URL/api/trpc/sessions.list — no dead run's slot is ever freed" "operator-only: report it; the runtime serves this for every agent"
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
