#!/usr/bin/env bash
# github.sh — the GitHub reads the precheck and `run-state.sh wait` share.
# Sourced, never run; needs lib/config.sh first, for JQ_LOGIN.
#
# GraphQL and REST are separate hourly budgets, and `author` may be an app's
# bot whose installation every agent on it draws from, GraphQL first: `gh pr`
# and `gh issue` spend only that one. So a pull request's state also reads over
# REST, in the shape `gh pr view --json` gives, when GraphQL cannot answer; and
# a conditional REST read (`If-None-Match`) whose answer is `304 Not Modified`
# costs nothing at all, which is what lets babysitting look once a minute.

# rest_pulls <host> <slug> — every open pull request, one JSON array
rest_pulls() {
  gh api --hostname "$1" --paginate "repos/$2/pulls?state=open&per_page=100" 2>/dev/null | jq -s 'add // []'
}

# rest_issues <host> <slug> <label> — open issues carrying it, newest first, in
# `gh issue list --json number,title,url,labels` shape (pull requests left out)
rest_issues() {
  gh api --hostname "$1" "repos/$2/issues?state=open&per_page=50&labels=$(jq -rn --arg l "$3" '$l | @uri')" 2>/dev/null |
    jq 'map(select(.pull_request | not) | {number, title, url: .html_url, labels: [.labels[]? | {name}]})'
}

# rest_pr <host> <slug> <pull json> — the pull request with its reviews and the
# head commit's checks, through JQ_REST_PR: three calls
rest_pr() {
  local sha n reviews checks status
  n="$(printf '%s' "$3" | jq -r .number)" && sha="$(printf '%s' "$3" | jq -r .head.sha)" || return 2
  reviews="$(gh api --hostname "$1" "repos/$2/pulls/$n/reviews?per_page=100" 2>/dev/null)" || return 2
  checks="$(gh api --hostname "$1" "repos/$2/commits/$sha/check-runs?per_page=100" 2>/dev/null)" || return 2
  status="$(gh api --hostname "$1" "repos/$2/commits/$sha/status" 2>/dev/null)" || return 2
  jq -n --argjson pull "$3" --argjson reviews "$reviews" --argjson checks "$checks" --argjson status "$status" \
    '{$pull, $reviews, $checks, $status}' | jq "$JQ_LOGIN$JQ_REST_PR"
}

# REST's pull request, reviews, check runs and combined status, as `gh pr view
# --json` spells them. REST has no review decision; `approximate` says this one
# is read off the reviews alone — no required count, no code owners — so it may
# word a verdict, never decide that a pull request is done.
# shellcheck disable=SC2034
JQ_REST_PR='
  ([.reviews[]? | select(.state != "PENDING")] | group_by(.user.login | login) | map(max_by(.submitted_at))
    | map({author: {login: .user.login}, state, submittedAt: .submitted_at})) as $latest
  | ([$latest[] | .state] | if index("CHANGES_REQUESTED") then "CHANGES_REQUESTED"
      elif index("APPROVED") then "APPROVED" else "REVIEW_REQUIRED" end) as $decision
  | {
    number: .pull.number, title: .pull.title, url: .pull.html_url, body: (.pull.body // ""),
    state: (if .pull.merged_at then "MERGED" elif .pull.state == "closed" then "CLOSED" else "OPEN" end),
    mergeable: (if .pull.mergeable == true then "MERGEABLE" elif .pull.mergeable == false then "CONFLICTING" else "UNKNOWN" end),
    headRefOid: .pull.head.sha,
    reviewDecision: $decision,
    latestReviews: $latest,
    statusCheckRollup: (
      ([.checks.check_runs[]?] | group_by(.name) | map(max_by(.id))
        | map({name, status: (.status | ascii_upcase), conclusion: ((.conclusion // "") | ascii_upcase),
               startedAt: .started_at, completedAt: .completed_at}))
      + [.status.statuses[]? | {context, state: (.state | ascii_upcase), startedAt: .created_at}]),
    approximate: true
  }'

# cget <dir> <name> <host> <path> — a conditional read, remembered in <dir>
# (<name>.json, <name>.etag) for the life of one `wait`: 0 changed, or read for
# the first time · 1 unchanged, a free 304 · 2 unreadable
cget() {
  local d="$1" name="$2" out code etag
  etag="$(cat "$d/$name.etag" 2>/dev/null)"
  out="$(gh api --hostname "$3" -i ${etag:+-H "If-None-Match: $etag"} "$4" 2>/dev/null)"
  code="$(printf '%s\n' "$out" | head -1 | cut -d' ' -f2)"
  case "$code" in
    304) return 1 ;;
    200) ;;
    *) return 2 ;;
  esac
  printf '%s\n' "$out" | tr -d '\r' | sed '1,/^$/d' > "$d/$name.json"
  printf '%s\n' "$out" | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p' | head -1 > "$d/$name.etag"
  return 0
}
