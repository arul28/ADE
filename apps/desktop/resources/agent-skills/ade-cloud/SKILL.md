---
name: ade-cloud
description: "Before any ADE Cloud work via `ade cloud`, and when this computer needs more free disk (grow it with `ade cloud resize --free`): the account (plan, hours, disk, ADE Cloud iPhone (iOS Simulator) minutes, every plan's price and what it includes, computers, lanes, sizes, agent limits, whether a new lane can start), start, follow, retry or cancel a cloud lane at the size the work needs (Android, Docker), explain a refusal, propose a cleanup, manage the computers (list, sleep, wake, a resize request, work-state, clear caches, delete). Agents start lanes; they never make a computer."
---

# ADE Cloud

ADE Cloud gives a lane its own Linux computer on the person's ADE account. The
computer sleeps when idle and uses plan hours only while awake. The person
manages lanes, not computers. The plan also has ADE Cloud iPhone minutes: an
iOS Simulator any machine uses (section 6).

You start lanes on ADE Cloud; you never make a computer. Each new lane gets its
own computer at the size you pick (section 2). `ade cloud create`, `copy` and
`move` add a computer that is no new lane's: ADE refuses them for an agent
unless the person says yes on the card in your chat, and with nobody to ask the
answer is no. Don't run them; start a lane instead.

## 1. Read the status first, every time

`ade cloud status --json`. Over ADE MCP: the `ade` tool with `["cloud","status","--json"]`.

- If `canStartLane.ok` is false, tell the person `canStartLane.reason` as it is, and stop.
- Never work around a limit: no other size, no copy, no delete to make room.
- Take sizes, hours rates, hours, iPhone minutes, limits and prices from this answer, never from memory. Plan questions: `plans` lists each plan's price, hours, disk, iPhone minutes and prices past the plan (`current` is theirs).
- It wakes nothing and costs nothing. Read it again before each new lane.

## 2. Start a lane

`ade chat create --machine cloud --launch-id <a new UUID> --provider <p> --model <id> --prompt "<task>"` starts a lane with a chat (the model is required, as for every launch).
`ade lanes create --machine cloud --launch-id <a new UUID> --name "<name>"` makes the lane alone, with no chat.
Over ADE MCP: the `ade` tool takes exactly `--machine cloud` (and `--size`) on `chat create`, `lanes create` and `chat launch-status`; every other `--machine` is refused. An app is an unattended agent there (the next point).

- Size: leave out `--size` to use the person's saved size (`defaultSize`). Medium when Small is too slow. Large or X-Large (full computers) only for Android or Docker: pass `--size large` (or `xlarge`) when you start the lane. With no `--size`, a Small whose setup runs out of memory moves to Medium once by itself (the launch says so), and that repository starts at Medium after that; a size you pass stays, so passing `--size small` turns this off.
- Push the branch first. The lane starts from the pushed copy; uncommitted changes stay here.
- The approval card asks the person in your chat, with the size and its hours rate. No answer in 5 minutes means no.
- In a full-auto chat, an automation or an ADE MCP app, nobody watches. ADE answers with the agent limits (`agents` in the status): only sizes in `sizesAllowed`, at most `newComputersLeftToday` new computers today. Each new lane counts one. A person never counts.
- What only the person decides (a size change, deleting a computer this chat didn't make, looser agent limits) still puts a card in a full-auto chat, and the person answers it there. An automation or an ADE MCP app has nobody to ask, so it is refused.
- From a terminal with no ADE chat, it is refused: ADE can't tell a person there from an agent. Tell the person to start it in the ADE app (Run on: ADE Cloud) or in an ADE chat.
- A CLI session (Claude Code, Codex and others in a terminal) can be the first thing in a new cloud lane, but only from the ADE app: the person picks CLI and Run on: ADE Cloud. From the command line, start a chat or the lane alone.
- One computer holds one lane. On a cloud computer, never plain `ade lanes create`: start a new lane on ADE Cloud.
- A Linear issue: pass the whole issue with `--linear-issue-json`; the new lane is bound to it there. A bare issue id is refused.
- The CTO: `createLane` or `spawnChat` with `machine: "cloud"` (and `size`). An automation: "Run on ADE Cloud" in the rule; each run counts as an agent.

## 3. Follow, retry, cancel

- The command prints the launch id first, then waits until the agent starts there (the lane alone: until it is set up). If the join waits, give the person the approval link it prints.
- Follow: `ade chat launch-status <id> --machine cloud`.
- Retry after a failure: the same command with the same `--launch-id`. It goes on from the failed step, on the same computer.
- Cancel, which deletes its computer: `ade chat launch-cancel <id> --machine cloud`. Only the chat that started it, or the person. ADE MCP apps can't.
- The new chat doesn't report back. Read it: `ade chat read <chat id> --machine <computer name>` (a cloud computer is one of the person's machines, so `--machine` takes its name). Over ADE MCP, call `chat_read` with the chat id; it finds the chat's machine itself.

## 4. What a refusal means, and the one next step

| The sentence says | Next step |
|---|---|
| out of ADE Cloud hours | Tell the person. Hours come back on `hours.resetsAt`. |
| too many of your computers are awake at once | Put a computer you aren't using to sleep (`ade cloud sleep`), then try again. No plan limits how many computers there are. |
| Free hours need a GitHub account | The person connects GitHub in Settings › Integrations › GitHub. |
| Your GitHub account is new, so free hours start on | Tell the person the day. They can add a card (no charge) in Settings › ADE Cloud to start now. Never add one yourself. |
| This GitHub account already has a free plan | Tell the person. Only a paid plan gives hours here; never make another account. |
| ADE couldn't check your GitHub account | Try again in a few minutes. |
| ADE Cloud disk space is full | Propose a cleanup (section 5). |
| Sign in to ADE to use ADE Cloud | The person signs in to ADE in the app. |
| isn't available on this account | Tell the person. Never ask for a key. |
| your agents hit today's limit | Tell the person; the sentence names the setting. No retry today. |
| agents may pick up to a size | Pick an allowed size, or ask the person. |
| ADE has no chat to ask you in | See the terminal rule in section 2. |
| the person said no, or nobody answered | Stop. Don't ask again in a loop. |
| iPhone minutes are used up | Tell the person, with the reset day. A paid plan can turn on extra iPhone minutes in Settings › ADE Cloud; the free plan picks a plan. |
| Extra iPhone minutes reached ... monthly limit | The person raises the limit in Settings › ADE Cloud, or waits for the reset. |
| iPhone minutes need the same check as its free hours | As the GitHub rows above. |
| already holds a lane, or belongs to the archived lane | Start a new lane on ADE Cloud, or the person restores that lane. |
| a launch step failed | Run it again with the same `--launch-id`. |
| Agents don't make ADE Cloud computers | Start a lane on ADE Cloud with the size the work needs (section 2). A computer with no lane is the person's to make, in Settings › ADE Cloud. |

## 5. When space or hours run low

Propose a cleanup to the person first: which lanes, and why each is safe (its
pull request is merged, nothing is unpushed, unused for long, `deletesAt`).
Delete nothing without their yes. Deleting a lane deletes its computer.

ADE Cloud deletes unused computers on its own: on Free after 3 days unused
(warned at 2), on a paid plan after 10 (warned at 7). It commits and pushes
each lane's work to the lane's branch first and keeps the lane; a push that
doesn't go through keeps the computer. Files git ignores (`.env`, a local
database) are never pushed. `dueForDeletion` in the account lists the
warnings; using the computer, or "Keep it" in Settings › ADE Cloud, keeps it.

## 6. The ADE Cloud iPhone

`iphone` in the status: `access` on, or soon (not on this account yet; say so).
With access, `ade devices use ios@cloud`, then `ade apple …` (ade-apple).

- It spends `iphone.minutes` while it runs, building included; they come back
  on `iphone.resetsAt`. At 0 the phone stops, unless extra minutes are on
  (`iphone.extraMinutes`, paid plans: `centsPerMinute` up to
  `monthlyLimitCents`). Free never charges a card.
- It stops after 5 minutes with no input and after 2 hours. `ade apple stop`
  when done.

## Never

- Make a computer: `ade cloud create` (a standard or a full computer), `ade cloud copy` or `ade cloud move`. Start a lane with the size it needs instead. ADE refuses an agent's make unless the person says yes on its card.
- Change the plan, or turn on or raise extra hours, disk or iPhone minutes: only the person does, in Settings › ADE Cloud.
- Delete a computer you didn't make without the person's yes on its card, or any computer over ADE MCP.
- Change a size (`ade cloud resize --shape`) yourself (growing the disk with `--free` is yours to do). Ask instead: `ade cloud resize --request --size large --reason "<why>"` puts a card in your chat, and the person confirms it.
- Wake computers to look at them: the status already knows.
- Sign a provider in for the person, or save a sign-in. The person does it once in ADE (ade://settings/integrations.ade-cloud-sign-ins).
- Print, ask for or pass on a key or token.

## What you manage

You may read and manage every computer on the account: `ade cloud status`,
`list`, `hours`, `limits`, `work-state`, `sleep`, `wake`, `update`, a size
change request (`ade cloud resize --request`), your own disk
(`ade cloud resize --free`), clearing caches with its card, and `delete` with
its card. Each asks the person like a new lane when it uses hours or deletes.
`create`, `copy` and `move` are the person's (see Never).
On a lane's cloud computer that needs more disk (a build, an emulator, a
big install), grow it yourself: `ade cloud resize --free <GB> --reason "<why>"`
(or `--disk <GB>` for a size). Inside the plan's disk it grows with no card,
unattended chats too. Paid extra disk past the plan asks the person on a card in
a watched chat. With nobody watching, the agent limits answer: inside
`agents.extraDiskMonthCents` (null, the default, means up to the account's own
monthly extra-disk limit; 0 means none) it grows and your chat gets a line with
the cost; past it the answer is no. Extra disk the person never turned on is no
for everyone. At the account's storage limit, or past the agents' extra disk, a
card names the computers that hold the disk. The grow restarts the computer: the
command waits, and ADE continues your chat after the restart with a note that
the disk grew. Never ask the person to grow it instead.
On a lane's cloud computer with a full disk, `ade actions run cloud.clear_caches`
deletes package and build caches there (never a repository or dependencies). It
asks the person with a card first; with nobody watching the answer is no. A computer sleeps 3 minutes after its last
activity and wakes on use, so you rarely need `sleep` or `wake`. The one
exception: `ade chat send` or `ade chat message` to a chat on a sleeping cloud
computer does not wake it. The "not found" answer names the computer and the
`ade cloud wake <id>` to run; run it (a wake uses hours), then send again.
`ade cloud work-state` lists the lanes with work not pushed yet. Freeing a computer (keeping its lane) is refused while the agent works: stop it or wait.
With nobody there you cannot change a size: ask with `ade cloud resize --request`, as in Never.
`ade cloud invite --text` shows the person's invite link, friends joined and hours earned. Only the person enters a friend's invite, in Settings › Account.

Cloud computers update themselves when idle or asleep, never while work runs.
`ade cloud status` shows each one's `update` (image, channel, target, state).
Use `ade cloud update <machine>` only to update now or to retry a failed one.

Android needs a full computer. Start the lane at that size: `ade chat create
--machine cloud --size large ...` (`xlarge` for a big build). Your chat needs
Android but runs on a standard computer (`ade android start` says so): tell the
person, commit and push the lane's branch, then start a lane on a full computer
on that branch: `ade lanes create --machine cloud --size large --existing-branch
<branch> --name "<name>"`. Then start a chat there: `ade chat create --machine
<its computer> --lane <its lane id> --provider <p> --model <id> --prompt "<the
task, and what is done>"`, and end your turn. Over ADE MCP, `--machine <its
computer>` is refused: make the lane with the `lanes create` step above, tell
the person it is ready, and ask them to start the chat in it. Never make a computer for it
(`ade cloud create --kind vm`). The old computer stays; offer to delete it from
the new chat.
