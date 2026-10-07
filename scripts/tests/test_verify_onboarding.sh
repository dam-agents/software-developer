#!/usr/bin/env bash
# verify-onboarding.sh: each scope checks what exists by then, and every FAIL
# names its fix.
. "$(dirname "$0")/helpers.sh"

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
echo "- cluster_install: make up" >> "$HOME/work/CONFIG.md"
echo "- schedules: tick daily" >> "$HOME/work/CONFIG.md"
verify --config
is "$RC" 1 "exit"
has "$OUT" "FAIL config.label_failed — missing — fix:" "missing key"
has "$OUT" "unknown key(s): lable_review" "typo'd key"
has "$OUT" "duplicated: author" "duplicate"
has "$OUT" "is not [host/]owner/name" "repo shape"
has "$OUT" "app_url — 'platform.example.com' is not a URL" "url shape"
has "$OUT" "FAIL config.retired — retired key(s): cluster_install" "a retired key names its migration"
has "$OUT" "FAIL config.schedules — 'daily' is not tick, audit or none" "schedule roles"
lacks "$OUT" "unknown key(s): lable_review cluster_install" "a retired key is not also unknown"
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
echo '{}' > "$HOME/.claude/settings.json"
echo "0.9.0" > "$HOME/work/VERSION"
rm -rf "$HOME/work/widgets"
echo "not a run-state line" >> "$HOME/work/TICK.log"
printf -- '- run_state: idle\n' > "$HOME/work/RUN.md"
echo "- slots: 1" >> "$HOME/work/CONFIG.md"
mkdir -p "$HOME/work/slots/1" "$HOME/work/slots/2" "$HOME/work/items"
printf -- '- item: 3\n- mood: odd\n' > "$HOME/work/items/3.md"
verify
is "$RC" 1 "exit"
has "$OUT" "FAIL work — missing, or a git repository" "work/.git"
has "$OUT" "FAIL harness.stop — no Stop hook" "the Stop hook"
has "$OUT" "FAIL definition.clean — edited in place" "dirty definition"
has "$OUT" "FAIL work.VERSION — adopted '0.9.0'" "version drift"
has "$OUT" "FAIL checkout — no clone of acme/widgets" "missing clone"
has "$OUT" "FAIL state.TICK — 1 line(s)" "foreign log line"
has "$OUT" "FAIL state.RUN — work/RUN.md is a record from before slots" "old record"
has "$OUT" "FAIL state.items — unknown keys in: 3.md" "foreign item key"
has "$OUT" "FAIL state.slots — work/slots/{1 2} are not worktrees" "fake slots"
has "$OUT" "FAIL state.slots — 2 slots, more than slots: 1" "too many"
done_

CASE="--live passes when GitHub and the runtime answer"; sandbox; onboarded
verify --live
is "$RC" 0 "exit"
has "$OUT" "ok   live.auth — acting as dev-bot" "identity"
has "$OUT" "ok   live.precheck — exit 1" "precheck ran end to end"
[ ! -d "$SD_LOCKS" ] || [ -z "$(ls "$SD_LOCKS")" ] || fail "the probe took a lock"
done_

CASE="--live fails what would break the ticks"; sandbox; onboarded
STUB_RUNTIME_DOWN=1 STUB_LOGIN=other-bot STUB_PUSH=false STUB_REACH=3 \
STUB_LABELS="$(printf 'agent/implement\nagent/in-progress\nagent/failed')" verify --live
is "$RC" 1 "exit"
has "$OUT" "acting as other-bot, but author is 'dev-bot'" "identity mismatch"
has "$OUT" "FAIL live.push — no push" "push"
has "$OUT" "warn live.scope — the connection can push to 3 repositories" "scope"
has "$OUT" "FAIL live.label_review — no label 'needs-review'" "label"
has "$OUT" "FAIL live.runtime" "runtime down"
has "$OUT" "FAIL live.label_needs_info — no label 'agent/needs-info'" "default needs-info label"
done_

CASE="a worktree outside the slots fails; verify_exclusive needs exclusive"; sandbox; onboarded
origin_checkout
git -C "$HOME/work/widgets" worktree add -q --detach "$HOME/work/widgets-extra"
echo "- verify_exclusive: make e2e" >> "$HOME/work/CONFIG.md"
verify
has "$OUT" "FAIL state.worktrees — worktrees outside work/slots" "stray worktree"
has "$OUT" "FAIL config.verify_exclusive — set, but exclusive names nothing" "verify_exclusive"
done_

CASE="slack_channel is a chat id when set"; sandbox
verify --config
has "$OUT" "ok   config.slack_channel — unset" "off by default"
echo "- slack_channel: #dev" >> "$HOME/work/CONFIG.md"
verify --config
has "$OUT" "FAIL config.slack_channel — '#dev' is not a chat id" "a name is not an id"
setcfg slack_channel C0123ABCD
verify --config
is "$RC" 0 "exit"
has "$OUT" "ok   config.slack_channel — C0123ABCD" "an id"
done_

CASE="a grill skill is the repository's when named, the default otherwise"; sandbox; onboarded
verify
has "$OUT" "ok   harness.skill_grill — unset — the default, .agents/defaults/grill/SKILL.md" "default"
mkdir -p "$HOME/work/.claude/skills/grill-me" && : > "$HOME/work/.claude/skills/grill-me/SKILL.md"
echo "- skill_grill: grill-me" >> "$HOME/work/CONFIG.md"
echo "- skill_file_issue: drop-issue" >> "$HOME/work/CONFIG.md"
verify
has "$OUT" "ok   harness.skill_grill — grill-me, the repository's" "named"
has "$OUT" "FAIL harness.skill_file_issue — 'drop-issue' is not a skill in work/.claude/skills" "a name that is not there"
sed -i.bak '/^- skill_file_issue:/d' "$HOME/work/CONFIG.md"; rm -r "$HOME/.agents/defaults/file-issue"
verify
has "$OUT" "FAIL harness.skill_file_issue — unset, and the default .agents/defaults/file-issue/SKILL.md is missing" "default gone"
done_

CASE="work_repo is checked when set"; sandbox; onboarded
echo "- work_repo: acme/widgets-work" >> "$HOME/work/CONFIG.md"
STUB_REACH=2 verify --live
is "$RC" 0 "exit"
has "$OUT" "ok   config.work_repo — acme/widgets-work" "shape"
has "$OUT" "ok   live.work_repo — acme/widgets-work takes a push" "push"
has "$OUT" "ok   live.scope — the connection pushes to repo and work_repo alone" "scope counts the backup"
STUB_REACH=2 STUB_WORK_PUSH=false verify --live
has "$OUT" "FAIL live.work_repo — no push to acme/widgets-work" "no push"
setcfg work_repo acme/widgets
verify --config
has "$OUT" "FAIL config.work_repo — is repo itself" "never the repository worked on"
done_


CASE="--live: a GitHub App's login and reach are not measured, and it is told about label_mine"; sandbox; onboarded
STUB_LOGIN= STUB_INSTALLATION=1 verify --live
has "$OUT" "warn live.auth — acting as a GitHub App" "no login to compare"
has "$OUT" "warn live.mine — no label_mine" "shared identity"
has "$OUT" "warn live.push — not measured" "no permissions to read"
lacks "$OUT" "FAIL live.push" "not failed"
has "$OUT" "ok   live.scope" "the installation's repositories"
echo "- label_mine: agent/mine" >> "$HOME/work/CONFIG.md"
STUB_LOGIN= STUB_INSTALLATION=1 verify --live
has "$OUT" "ok   live.mine — only pull requests labelled agent/mine" "set"
has "$OUT" "FAIL live.label_mine — no label 'agent/mine'" "the label must exist"
STUB_LOGIN= verify --live
has "$OUT" "FAIL live.auth — GitHub did not answer" "neither a user nor an app"
done_

CASE="interactive: only the claim is labelled, and the tick is refused"; sandbox; onboarded
sed -i.bak '/^- label_handoff:/d; /^- label_failed:/d' "$HOME/work/CONFIG.md"
echo "- mode: interactive" >> "$HOME/work/CONFIG.md"
STUB_LABELS="$(printf 'agent/in-progress\nneeds-review')" verify --live
is "$RC" 0 "exit"
has "$OUT" "ok   config.mode — interactive" "mode"
has "$OUT" "ok   config.schedules — unset — none" "no schedule by default"
has "$OUT" "disabled: software-developer-tick-10m software-developer-audit-weekly" "both off"
has "$OUT" "ok   live.precheck — interactive" "no detection to prove"
lacks "$OUT" "needs-info" "no default label demanded"
echo "- schedules: tick" >> "$HOME/work/CONFIG.md"
verify --config
has "$OUT" "FAIL config.schedules — lists tick, but mode is interactive" "tick refused"
setcfg mode sometimes
verify --config
has "$OUT" "FAIL config.mode — 'sometimes'" "mode shape"
has "$OUT" "FAIL config.label_handoff — missing" "autonomous needs the hand-off label"
done_

exit "$FAILED"
