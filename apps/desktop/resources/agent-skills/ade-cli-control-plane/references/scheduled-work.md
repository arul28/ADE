# Scheduled work and drafts

## Scheduled work

To make a message arrive in a chat later as if the user sent it, use
`ade drafts` (see the drafts paragraphs below), not scheduled work. Scheduled work
is for waking *yourself* to do work later.

Persistent ADE chats and tracked provider CLI sessions can schedule their own
durable wakeups. Use the typed `ade chat scheduled-work create|list|cancel`
commands or the generic `chat.createScheduledWork`, `chat.listScheduledWork`,
and `chat.cancelScheduledWork` actions. Pause or resume that session with
`ade chat scheduled-work pause|resume <session>` or
`chat.setScheduledWorkPaused`. `ade chat scheduled-work status <session>` (or
`chat.getScheduledWorkState`) shows pause state, the next wake, and active
jobs for either a chat or tracked provider CLI session.

Omitting the target in an ADE-bound agent defaults create/list to
`ADE_CHAT_SESSION_ID`; an agent cannot schedule another session, and an
ordinary untracked shell fails instead of creating orphaned work. Chat delivery
starts a new turn at the next safe turn boundary. Tracked provider CLI delivery
waits for the provider's visible composer boundary, or resumes the same ended
CLI session before sending the prompt. Both survive brain restarts, and
recurring schedules expire seven days after creation. Users can pause chat jobs
in Chat Info or all scheduled work in Settings; CLI-owned jobs remain
manageable through these commands and the Settings recovery list.

Prefer a relative one-shot whenever the intent is "wake me in N minutes":
`--in 12m` in the typed CLI or `delaySeconds: 720` in the action. This avoids
timezone conversion entirely. Absolute one-shots use `--at` / `runAt` and must
include `Z` or an explicit UTC offset. Five-field cron is interpreted in the
ADE brain machine's local timezone, not UTC unless that machine itself uses UTC.
The create result prints the computed next run in both local and ISO form;
verify that time before ending the turn.

```
ade chat scheduled-work create --in 12m --prompt "Check CI and report" --text
ade actions run chat.createScheduledWork --input-json '{"delaySeconds":720,"prompt":"Check CI and report"}' --text
ade chat scheduled-work create --at "2026-07-23T01:05:00-04:00" --prompt "Check CI and report" --text
ade chat scheduled-work create --cron "9,29,49 * * * *" --prompt "Check CI and report" --text
ade chat scheduled-work list --all --text
ade chat scheduled-work cancel <session> <id> --text   # session first; inside your own chat, 'cancel <id>' is enough
ade chat scheduled-work pause "$ADE_CHAT_SESSION_ID" --text
```

Composer drafts and their scheduled sends are a separate surface: `ade drafts
list | create | schedule | update | delete | now | show` (actions `chat.*Draft`)
saves unsent text, arms a send for a fire time, or manages an armed one.

Pick deliberately between the two. A draft send is *the user's message arriving
later*: it lands as a real user turn in the target chat, shows in the user's
Drafts list where they can read, edit, retime or cancel it, and only the
machine it names delivers it. `ade drafts schedule <id> --in 2h --target
<chatId>` (or `--new-chat --lane <laneId> --provider <p> --model <m>`); the
target is always explicit, and `--in` avoids timezone arithmetic. A scheduled
wake (`ade chat scheduled-work create`, or Claude's `ScheduleWakeup` /
`CronCreate` / `/loop`) is *you doing work later*: it is not a message from the
user and does not appear in their drafts. Never paste secrets into an unsent
draft, and remember that a send you arm is indistinguishable from one the user
armed.

In a Claude chat, the native `ScheduleWakeup`, `CronCreate` and `/loop` are
mirrored into ADE's durable scheduler. `durable: true` also persists Claude's
own copy, but ADE's delivery does not depend on it. Due jobs start a new turn at
the next turn boundary even if the chat was busy. The SDK's `CronList` is
advisory; ADE state wins. `CronCreate` always creates a new job, so replace one
with `CronList` + `CronDelete` first. Users pause schedules in Chat Info or
project-wide in Settings.
