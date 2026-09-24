#!/usr/bin/env bash
# verify-onboarding.sh: each scope checks what exists by then, and every FAIL
# names its fix.
. "$(dirname "$0")/helpers.sh"

IDLE='{"idle":true,"backgroundWork":[]}'
setcfg() { sed -i.bak "s#^- $1: .*#- $1: $2#" "$HOME/work/CONFIG.md"; }

CASE="--config passes a complete CONFIG.md"; sandbox
verify --config
is "$RC" 0 "exit"
has "$OUT" "PASS (config)" "summary"
lacks "$OUT" "sentinel" "checks nothing onboarding has not created yet"
done_

CASE="--config fails what the runtime could not read"; sandbox
sed -i.bak '/^- label_failed:/d' "$HOME/work/CONFIG.md"
echo "- lable_review: typo" >> "$HOME/work/CONFIG.md"
echo "- author: someone-else" >> "$HOME/work/CONFIG.md"
setcfg repo "https://github.com/acme/widgets"
setcfg app_url "platform.example.com"
setcfg cluster required
verify --config
is "$RC" 1 "exit"
has "$OUT" "FAIL config.label_failed — missing — fix:" "missing key"
has "$OUT" "unknown key(s): lable_review" "typo'd key"
has "$OUT" "duplicated: author" "duplicate"
has "$OUT" "is not [host/]owner/name" "repo shape"
has "$OUT" "app_url — 'platform.example.com' is not a URL" "url shape"
has "$OUT" "config.cluster_install — missing, and cluster is required" "cluster keys"
lacks "$OUT" "Nothing under deploy" "a prose bullet is not a key"
done_

CASE="a full run passes an onboarded instance"; sandbox; onboarded
verify
is "$RC" 0 "exit"
has "$OUT" "PASS (structure)" "summary"
has "$OUT" "warn schedules — only MCP can list them" "says what it cannot check"
has "$OUT" "software-developer-tick-10m" "names the schedules"
done_

CASE="a full run fails a drifted instance"; sandbox; onboarded
mkdir "$HOME/work/.git"
echo "local edit" >> "$HOME/kit.yaml"
echo "0.9.0" > "$HOME/work/VERSION"
rm -rf "$HOME/work/widgets"
echo "not a run-state line" >> "$HOME/work/TICK.log"
printf -- '- run_state: maybe\n' > "$HOME/work/RUN.md"
verify
is "$RC" 1 "exit"
has "$OUT" "FAIL work — missing, or a git repository" "work/.git"
has "$OUT" "FAIL definition.clean — edited in place" "dirty definition"
has "$OUT" "FAIL work.VERSION — adopted '0.9.0'" "version drift"
has "$OUT" "FAIL checkout — no clone of acme/widgets" "missing clone"
has "$OUT" "FAIL state.TICK — 1 line(s)" "foreign log line"
has "$OUT" "FAIL state.RUN — run_state is neither" "malformed record"
done_

CASE="--live passes when GitHub and the runtime answer"; sandbox; onboarded
STUB_STATUS="$IDLE" verify --live
is "$RC" 0 "exit"
has "$OUT" "ok   live.auth — acting as dev-bot" "identity"
has "$OUT" "ok   live.precheck — exit 1" "precheck ran end to end"
[ ! -f "$HOME/work/RUN.md" ] || fail "the probe claimed a run"
done_

CASE="--live fails what would break the ticks"; sandbox; onboarded
STUB_LOGIN=other-bot STUB_PUSH=false STUB_REACH=3 \
STUB_LABELS="$(printf 'agent/implement\nagent/in-progress\nagent/failed')" verify --live
is "$RC" 1 "exit"
has "$OUT" "acting as other-bot, but author is 'dev-bot'" "identity mismatch"
has "$OUT" "FAIL live.push — no push" "push"
has "$OUT" "warn live.scope — the connection can push to 3 repositories" "scope"
has "$OUT" "FAIL live.label_review — no label 'code-guardian-review'" "label"
has "$OUT" "FAIL live.runtime" "runtime down"
done_

exit "$FAILED"
