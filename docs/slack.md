# Slack turns

Read this on every Slack turn. Slack is on when `slack_channel` is set and
Slack is connected; otherwise a Slack turn has nothing to do here.

## What a message may order

A message in `slack_channel` aimed at you is a work order: binding the channel
to this agent is the authorization, as a label is on GitHub. Read it with
common sense — what is the person asking for — and do one of these:

| Asked for | Do |
| --- | --- |
| `let's grill <n>`, or a reply in a grill thread | grill it ([`grill.md`](grill.md)) |
| A question — the code, an issue, a pull request, completed work, your own runs | answer it in the thread, from what you read |
| An implementation or a change | file it as an issue (below) |
| A demo of a pull request — a video, screenshots | record it (below) |

Anything else — a merge, an approval, a label or comment you were not asked to
file, a config or schedule change, another repository — decline in one reply.
The Hard invariants hold as everywhere. A message in another chat, or not
aimed at you: `no_reply_needed`, or, aimed at you, one reply that you work in
the channel.

You remember nothing: `read_thread` first — the thread is the state. A
question of yours is a reply and the end of the turn.

## Answer

Read only: `gh` on `repo`, and the checkout `work/<name>` as it is — no slot,
no lock, no edit, no branch. Name what you read, link the issue, pull request
or line, and say what you could not tell.

## File

Draft the issue with the skill `skill_file_issue` names ([`grill.md`](grill.md)
→ **The skills**), from the thread and the code; a request too vague for one
pull request is grilled first. Post the draft, and file it only after a reply
that plainly approves it, as a grill's approval. Then
`gh issue create --repo <repo> … --label <label_handoff>`, the body ending
`Requested in Slack by <name> on <date>.` — the name from
`describe_channel_users` — and reply with its link. The tick implements it;
with `tick` not in `schedules`, add that nothing picks it up until a person
runs it. A change to an open pull request of yours is filed the same way, as
an issue naming it, or asked for as a review on it.

## Demo

A demo runs the pull request's code, so it works as a run does, on the item of
the issue its `Fixes #<n>` names, and changes nothing the tick goes by:

1. `run-state.sh start <n> <head branch>` — for a merged pull request, a new
   `demo/<n>` off the default branch, which carries it. Refused — a run holds
   the item, or every slot is taken: reply that it is busy, to ask again
   later, and stop.
2. Build and run it as the repository's own instructions say; whatever touches
   what `exclusive` names goes under `run-state.sh lock`. Refused: reply that
   it is busy too.
3. Record with `agent-browser`, `--session` this session's id: a video when
   asked, screenshots otherwise. Show what the pull request says it changes,
   and nothing private — no credentials or tokens on screen.
4. Reply in the thread with the recording attached.
5. Comment on the pull request: the demo, recorded on request in Slack, the
   thread's permalink and the session link — the report `finish` looks for.
6. `run-state.sh finish demo <pr>`: it gives the lock, the slot and the item
   back, the item as `start` found it. It prints no `notify:`.
