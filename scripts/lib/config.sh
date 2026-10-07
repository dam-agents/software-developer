#!/usr/bin/env bash
# config.sh — the one reader of the `- key: value` files under work/: CONFIG.md,
# which onboarding writes, and items/*.md / GATE.md, which scripts/run-state.sh
# writes. Sourced, never run. A value parses the same way in every script that
# reads it because there is only this copy of the parser.
#
# A key is read from its first `- <key>: <value>` bullet; a `*` bullet, spaces
# around the key and the key's case are tolerated. Everything after the key's
# colon is the value, so a URL survives. Backticks and trailing whitespace are
# stripped.

# kv <file> <key>
kv() {
  [ -f "$1" ] || return 0
  grep -m1 -iE "^[-*]?[[:space:]]*$2[[:space:]]*:" "$1" 2>/dev/null |
    sed -E "s/^[-*]?[[:space:]]*[^:]+:[[:space:]]*//" |
    tr -d '`' |
    sed -E 's/[[:space:]]+$//'
}

# cfg <key> — a key of work/CONFIG.md
cfg() { kv "$HOME/work/CONFIG.md" "$1"; }

# cfg_mode — `autonomous` only when CONFIG.md says so, else `interactive`: an
# instance nobody chose to set loose watches nothing
cfg_mode() { case "$(cfg mode | tr '[:upper:]' '[:lower:]')" in autonomous) echo autonomous ;; *) echo interactive ;; esac; }

# A login as GitHub spells it differently by API: a GitHub App's bot is
# `name[bot]` over REST and `app/name` in gh's JSON, and case never matters.
# Prepend to a jq program; `login` maps every spelling to one.
# shellcheck disable=SC2034
JQ_LOGIN='def login: ascii_downcase | sub("^app/"; "") | sub("\\[bot\\]$"; "");'

# cfg_allows <owner/name> — whether the direct session may act on a repository:
# `repo` itself, or one `repos_also` names — `owner/name` or `owner/*`, split by
# spaces or commas, case ignored. Scheduled runs and Slack never ask: theirs is
# `repo` alone (CLAUDE.md → Hard invariants).
cfg_allows() {
  local - want p; set -f   # `owner/*` is a pattern, never a path
  want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$want" in ?*/?*) ;; *) return 1 ;; esac
  for p in "$(cfg repo)" $(cfg repos_also | tr ',' ' '); do
    p="$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')"
    [ -n "$p" ] || continue
    case "$p" in
      */\*) case "$want" in "${p%\*}"?*/*) ;; "${p%\*}"?*) return 0 ;; esac ;;
      *) [ "$want" = "$p" ] && return 0 ;;
    esac
  done
  return 1
}
