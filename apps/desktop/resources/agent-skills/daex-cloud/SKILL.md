---
name: daex-cloud
description: "Before any Daex Cloud work via `daex cloud`, and when this computer needs more free disk (grow it with `daex cloud resize --free`): the account (plan, computers and the plan's computer limit, credits and what the Daex Cloud iPhone (iOS Simulator) used of them, every plan's price and what it includes, lanes, sizes, agent limits, whether a new lane can start), start, follow, retry or cancel a cloud lane at the size the work needs (Android, Docker), explain a refusal, propose a cleanup (`daex cloud lanes --stale`, then free or delete a lane), manage the lanes, saved chats, CLI copies, backups and server jobs of the account, manage the computers (list, sleep, wake, a resize request, work-state, clear caches, delete). Agents start lanes; they never make a computer. Also on a Daex Cloud computer, before you suggest a hosted service or tool the person needs and has not set up yet (a database, an email API, auth): `daex cloud recommend`."
---

# Daex Cloud

Daex was called ADE: the CLI is `daex`, and `ade …` still works the same (older transcripts and prompts use it).

Daex Cloud gives a lane its own Linux computer on the person's Daex account. The
computer sleeps when idle. The person manages lanes, not computers.

What a plan includes (read the numbers from `plans` in the status, never from
here or memory):
- Unlimited Small computers. They never use the plan's credits.
- A number of cloud computers, asleep or not (`plan.includes.computers`).
  Every computer counts, Small too; each new lane needs one.
- Credits for the bigger sizes (the status calls them `hours`). A Medium uses
  one credit an hour; Large and X-Large use more an hour
  (`sizes[].hoursRate`), Small none. Credits are spent only while a computer
  is awake.
- No plan limits disk: each size has its own disk maximum.
- Outside agents (Daex MCP apps) may use Daex Cloud on paid plans only.
- On some accounts, the Daex Cloud iPhone: an iOS Simulator any machine uses,
  paid from the same credits (section 6). Only when `iphone` is in the status.

You start lanes on Daex Cloud; you never make a computer. Each new lane gets its
own computer at the size you pick (section 2). `daex cloud create`, `copy` and
`move` add a computer that is no new lane's: Daex refuses them for an agent
unless the person says yes on the card in your chat, and with nobody to ask the
answer is no. Don't run them; start a lane instead.

## 1. Read the status first, every time

`daex cloud status --json`. Over Daex MCP: the `ade` tool with `["cloud","status","--json"]`.

- If `canStartLane.ok` is false, tell the person `canStartLane.reason` as it is, and stop.
- Never work around a limit: no other size, no copy, no delete to make room.
- Take sizes, credit rates, credits, computers, limits and prices from this answer, never from memory. Plan questions: `plans` lists each plan's price, computers, credits (`hoursOnSizes` says them as time on each size), whether outside agents may use it and the price of an extra hour (`current` is theirs).
- Say credits as time on a size ("50 hours on a Medium, 20 on a Large"), never as a multiplier, and never say Small uses "0 credits": Small computers never use credits.
- It wakes nothing and costs nothing. Read it again before each new lane.

## 2. Start a lane

`daex chat create --machine cloud --launch-id <a new UUID> --provider <p> --model <id> --prompt "<task>"` starts a lane with a chat (the model is required, as for every launch).
`daex lanes create --machine cloud --launch-id <a new UUID> --name "<name>"` makes the lane alone, with no chat.
Over Daex MCP: the `ade` tool takes exactly `--machine cloud` (and `--size`) on `chat create`, `lanes create` and `chat launch-status`; every other `--machine` is refused. An app is an unattended agent there (the next point).

- Size: leave out `--size` to use the person's saved size (`defaultSize`). Small uses no credits, so prefer it; Medium when Small is too slow. Large or X-Large (full computers) only for Android or Docker: pass `--size large` (or `xlarge`) when you start the lane. With no `--size`, a Small whose setup runs out of memory moves to Medium once by itself (the launch says so), and that repository starts at Medium after that; a size you pass stays, so passing `--size small` turns this off.
- Push the branch first. The lane starts from the pushed copy; uncommitted changes stay here.
- The approval card asks the person in your chat, with the size and its credits rate. No answer in 5 minutes means no. The command waits for the answer: keep it running (or keep polling it) until it prints the outcome. A card that closed before anyone answered (your turn stopped, or the computer restarted or moved) is not a no: nothing was done, and you can ask again.
- In a full-auto chat, an automation or a Daex MCP app, nobody watches. Daex answers with the agent limits (`agents` in the status): only sizes in `sizesAllowed`, at most `newComputersLeftToday` new computers today. Each new lane counts one. A person never counts.
- What only the person decides (a size change, deleting a computer this chat didn't make, looser agent limits) still puts a card in a full-auto chat, and the person answers it there. An automation or a Daex MCP app has nobody to ask, so it is refused.
- From a terminal with no Daex chat, it is refused: Daex can't tell a person there from an agent. Tell the person to start it in the Daex app (Run on: Daex Cloud) or in a Daex chat.
- A CLI session (Claude Code, Codex and others in a terminal) can be the first thing in a new cloud lane, but only from the Daex app: the person picks CLI and Run on: Daex Cloud. From the command line, start a chat or the lane alone.
- One computer holds one lane. On a cloud computer, never plain `daex lanes create`: start a new lane on Daex Cloud.
- A Linear issue: pass the whole issue with `--linear-issue-json`; the new lane is bound to it there. A bare issue id is refused.
- The CTO: `createLane` or `spawnChat` with `machine: "cloud"` (and `size`). An automation: "Run on Daex Cloud" in the rule; each run counts as an agent.

## 3. Follow, retry, cancel

- The command prints the launch id first, then waits until the agent starts there (the lane alone: until it is set up). If the join waits, give the person the approval link it prints.
- Follow: `daex chat launch-status <id> --machine cloud`.
- Retry after a failure: the same command with the same `--launch-id`. It goes on from the failed step, on the same computer.
- Cancel, which deletes its computer: `daex chat launch-cancel <id> --machine cloud`. Only the chat that started it, or the person. Daex MCP apps can't.
- The new chat doesn't report back. Read it: `daex chat read <chat id> --machine <computer name>` (a cloud computer is one of the person's machines, so `--machine` takes its name). Over Daex MCP, call `chat_read` with the chat id; it finds the chat's machine itself.

## 4. What a refusal means, and the one next step

| The sentence says | Next step |
|---|---|
| You're using all N of your cloud computers | Tell the person the sentence as it is. The three ways out are theirs: free up a computer from another lane (`daex cloud lanes free <lane>`, with its card), delete a lane (`daex cloud lanes delete <lane>`, with its card), or move to the next plan in Settings › Daex Cloud. Propose which lane (section 5); never pick a smaller size or delete to make room on your own. |
| out of Daex Cloud credits | Tell the person. Credits come back on `hours.resetsAt`. A Small computer keeps working: a lane at `--size small` still starts. |
| Daex Cloud can't be started by outside agents on the Free plan | Pass the sentence on to the person as it is, and stop. Only a paid plan lets outside agents use Daex Cloud. |
| too many of your computers are awake at once | Put a computer you aren't using to sleep (`daex cloud sleep`), then try again. |
| Free credits need a GitHub account | The person connects GitHub in Settings › Integrations › GitHub. |
| Your GitHub account is new, so free credits start on | Tell the person the day. They can add a card (no charge) in Settings › Daex Cloud to start now. Never add one yourself. |
| This GitHub account already has a free plan | Tell the person. Only a paid plan gives credits here; never make another account. |
| Daex couldn't check your GitHub account | Try again in a few minutes. |
| the computer's disk is full | Grow it (`daex cloud resize --free`, What you manage), or clear caches. |
| Sign in to Daex to use Daex Cloud | The person signs in to Daex in the app. |
| isn't available on this account | Tell the person. Never ask for a key. |
| your agents hit today's limit | Tell the person; the sentence names the setting. No retry today. |
| agents may pick up to a size | Pick an allowed size, or ask the person. |
| Daex has no chat to ask you in | See the terminal rule in section 2. |
| the person said no, or nobody answered | Stop. Don't ask again in a loop. |
| credits are used up, and the iPhone uses one a minute | Tell the person, with the reset day. A paid plan can turn on extra credits in Settings › Daex Cloud; the free plan picks a plan. |
| already holds a lane, or belongs to the archived lane | Start a new lane on Daex Cloud, or the person restores that lane. |
| a launch step failed | Run it again with the same `--launch-id`. |
| Agents don't make Daex Cloud computers | Start a lane on Daex Cloud with the size the work needs (section 2). A computer with no lane is the person's to make, in Settings › Daex Cloud. |

## 5. When computers or credits run low

Propose a cleanup to the person first: which lanes, and why each is safe (its
pull request is merged, nothing is unpushed, unused for long, `deletesAt`).
Delete nothing without their yes. Deleting a lane deletes its computer.

The cleanup, in order (reads wake nothing):

1. `daex cloud lanes --stale --json`: lanes unused a week or due for cleanup. `daex cloud lanes --json` lists every lane: on a
   computer (`state` awake, asleep, …) or `computer_deleted` (the lane and its
   chats stay; its next message makes a new computer on its branch).
2. `daex cloud lanes git <lane> --json` and `daex cloud backups --json`: what is
   not on GitHub yet.
3. Then one of these. Each shows the person a card in your chat:
   - `daex cloud lanes free <lane>`: keep it for later. Daex pushes its work,
     removes its computer and keeps the lane and its chats; the lane gets a
     new computer the next time a message is sent there. This frees one of
     the plan's computers.
   - `daex cloud lanes delete <lane>`: the lane, its computer and its saved
     chats. Daex checks the work first and names it on the card; the card
     also offers Keep for later. A person always decides, even for a
     computer your chat made. To keep the lane and its chats, use `free`.
     A lane whose computer was deleted has only its chats left: deleting it
     deletes them.

`daex cloud lanes keep <lane>` stops the idle cleanup's delete of a computer
(`deletesAt`). It wakes nothing and uses no credits. `daex cloud lanes start
<lane>` makes a new computer for a lane whose computer was deleted.

Daex Cloud deletes unused computers on its own: on Free after 3 days unused
(warned at 2), on a paid plan after 10 (warned at 7). It commits and pushes
each lane's work to the lane's branch first and keeps the lane; a push that
doesn't go through keeps the computer. Files git ignores (`.env`, a local
database) are never pushed. `dueForDeletion` in the account lists the
warnings; using the computer, or "Keep it" in Settings › Daex Cloud, keeps it.

## 6. The Daex Cloud iPhone

`iphone` is in the status only when the account has the Daex Cloud iPhone.
Without it, the account has none: don't offer it. With it,
`daex devices use ios@cloud`, then `daex apple …` (daex-apple).

- It spends the account's credits while it runs, building included
  (`credits.iphonePerMinute` a minute; `iphone.creditsUsed` this period). They
  come back on `iphone.resetsAt`. When the credits run out the phone stops,
  unless extra credits are on (paid plans). Free never charges a card.
- It stops after 5 minutes with no input and after 2 hours. `daex apple stop`
  when done.

## 7. Recommendations (Daex Cloud Free)

On a Daex Cloud computer, when the person needs a tool or service right now
that the project doesn't have yet (a hosted database, an email API, auth),
you may ask once: `daex cloud recommend --need "<the need, in a sentence>"`.
The pick comes from Gravity's Index, Daex's ad partner, and the server
decides whether there is one (Free plan, the person said yes to sponsored
cards, they are watching).

- Follow the answer's `message`. A pick shows as a Sponsored card in your
  chat. With no card (a CLI session), say it once in your reply, starting
  with "Sponsored:".
- Install, sign up for or set up the pick only when the person asks.
- Never call it to fill a gap, for something already chosen or set up, more
  than once per need, or to praise a pick. No pick: choose on the merits.

## Never

- Make a computer: `daex cloud create` (a standard or a full computer), `daex cloud copy` or `daex cloud move`. Start a lane with the size it needs instead. Daex refuses an agent's make unless the person says yes on its card.
- Change the plan, or turn on extra credits: only the person does, in Settings › Daex Cloud.
- Delete a computer you didn't make without the person's yes on its card, or any computer over Daex MCP.
- Change a size (`daex cloud resize --shape`) yourself (growing the disk with `--free` is yours to do). Ask instead: `daex cloud resize --request --size large --reason "<why>"` puts a card in your chat, and the person confirms it. Don't wait in a loop: Daex tells you in the chat when they keep the size, and when the change is done or stopped.
- Wake computers to look at them: the status already knows.
- Sign a provider in for the person, or save a sign-in. The person does it once in Daex (ade://settings/integrations.ade-cloud-sign-ins).
- Print, ask for or pass on a key or token.

## What you manage

You may read and manage every computer on the account: `daex cloud status`,
`list`, `hours`, `limits`, `work-state`, `sleep`, `wake`, `update`, a size
change request (`daex cloud resize --request`), your own disk
(`daex cloud resize --free`), clearing caches with its card, and `delete` with
its card. The account's lanes, saved chats, CLI copies, lane backups and
server jobs too: `daex cloud lanes|chats|sessions|backups|jobs|project`, where
each delete has its card. Each asks the person like a new lane when it uses credits or deletes.
`create`, `copy` and `move` are the person's (see Never).
On a lane's cloud computer that needs more disk (a build, an emulator, a
big install), grow it yourself: `daex cloud resize --free <GB> --reason "<why>"`
(or `--disk <GB>` for a size). It grows with no card, unattended chats too, up
to its size's disk maximum; no plan limits disk and it costs nothing more. At
the size's maximum the answer names it: ask for a bigger size with
`daex cloud resize --request`. The grow restarts the computer: the
command waits, and Daex continues your chat after the restart with a note that
the disk grew. Never ask the person to grow it instead.
On a lane's cloud computer with a full disk, `daex actions run cloud.clear_caches`
deletes package and build caches there (never a repository or dependencies). It
asks the person with a card first; with nobody watching the answer is no. A computer sleeps 3 minutes after its last
activity and wakes on use, so you rarely need `sleep` or `wake`. The one
exception: `daex chat send` or `daex chat message` to a chat on a sleeping cloud
computer does not wake it. The "not found" answer names the computer and the
`daex cloud wake <id>` to run; run it (a wake uses credits, except on a Small), then send again.
`daex cloud work-state` lists the lanes with work not pushed yet. Freeing a computer (keeping its lane) is refused while the agent works: stop it or wait.
With nobody there you cannot change a size: ask with `daex cloud resize --request`, as in Never.
`daex cloud invite --text` shows the person's invite link, friends joined and credits earned. Only the person enters a friend's invite, in Settings › Account.

Cloud computers update themselves when idle or asleep, never while work runs.
`daex cloud status` shows each one's `update` (image, channel, target, state).
Use `daex cloud update <machine>` only to update now or to retry a failed one.

Android needs a full computer. Start the lane at that size: `daex chat create
--machine cloud --size large ...` (`xlarge` for a big build). Your chat needs
Android but runs on a standard computer (`daex android start` says so): tell the
person, commit and push the lane's branch, then start a lane on a full computer
on that branch: `daex lanes create --machine cloud --size large --existing-branch
<branch> --name "<name>"`. Then start a chat there: `daex chat create --machine
<its computer> --lane <its lane id> --provider <p> --model <id> --prompt "<the
task, and what is done>"`, and end your turn. Over Daex MCP, `--machine <its
computer>` is refused: make the lane with the `lanes create` step above, tell
the person it is ready, and ask them to start the chat in it. Never make a computer for it
(`daex cloud create --kind vm`). The old computer stays; offer to delete it from
the new chat.
