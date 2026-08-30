# ADE Plugin Platform — Dogfood Ledger

Working ledger from a plugin-platform dogfood (session started 2026-08-29). The
exercise: a user gave one vague-but-accurate paragraph describing a "work
journal" feature, an agent built it as a plugin (`plugins/journal`, id
`journal`), and the user then pressed things and reported what broke.

The point of the exercise is the **split**: which failures are the plugin
author's fault, which are a platform capability that does not exist, and which
are a platform bug. Verdicts below were pre-registered before testing where
possible, so an author bug cannot be relabelled a platform bug after the fact.

Status legend: `reported` → `diagnosed` (root cause located) → `filed`.

Severity: **P0** unusable with no workaround · **P1** blocks a shipped plugin
from working · **P2** forces a bad workaround · **P3** papercut.

---

## The one-sentence finding

**Every failure in this ledger is green at every checkable layer and invisible
to the user.** The manifest parses, `ade plugin doctor` reports `✓`, the
contribution row is really in the database — and nothing appears on screen. Not
one of these bugs produced an error message, a log line, or a failed command.
That is the pattern worth fixing, more than any individual entry.

## Index

| | Severity | Whose | What |
|---|---|---|---|
| **A3** | P0 | ADE | A phone's plugin watermark re-seeds ~30M past the DB head on every reconnect. No plugin row can ever sync to mobile, and **there is no workaround** |
| **A4** | P1 | ADE | `lane.changed`, `pr.changed`, `session.changed` have no producer — they never fire. Kills the skill's own CI-badge recipe |
| **A1** | P1 | ADE | A declared `slash-command` executes but is listed nowhere. `getSlashCommands` returns 285 commands, 0 from plugins |
| **A2** | P2 | ADE | A 10-minute host timeout actively cancels the install approval card. Its justification was fixed by PR #1184, which this lane lacks |
| **A5** | P2 | ADE | The `pane` surface kind is parsed and disclosed at install, and drawn by nothing on any client |
| **B1** | P1 | gap | No way for a button to capture a line of text. This is what bent the whole feature |
| **B6** | P2 | docs | The skill documents `chat-card` as if publishing it were enough; it also needs `chat.emitAdeCard` |
| **B2** | P2 | gap | A plugin cannot write its own settings (`config.get` with no `config.set`) |
| **B3** | P2 | gap | Nothing time-relative in a binding's `where`, and no day-change trigger |
| **B5** | P3 | gap | `command-palette-action` receives no session |
| **B4** | P3 | gap | A declared `row-badge` marks every row (confirmed on screen; user found it acceptable) |
| **D1** | P3 | ADE | `doctor`'s Places rung stays ✓ on a disabled plugin |
| **C1–C6** | — | author | Six bugs in the plugin itself, kept for honesty. C1 and C6 are the user-visible ones |

---

## A — Platform bugs (ADE's, not the author's)

### A1 `diagnosed` **P1 — A plugin's `slash-command` never reaches the command menu**

A declared slash command **executes** but is **never listed**, so it is
undiscoverable: the only way to use it is to already know it exists.

Evidence, all from the live machine:

- `plugin.inspectSource` parses the socket cleanly: `{socket: "slash-command",
  surface: "work", command: "note", actionId: "noteCommand", description,
  argumentHint}`. Nothing dropped, no warnings.
- `ade plugin doctor journal --text` → `✓ Places … slash-command in work`.
- **Dispatch works.** The user typed `/note sdfsfsdf` and the note landed in the
  journal. The token also rendered with the composer's known-command
  highlight, so *something* in the renderer resolved it.
- **Listing does not.** `chat.getSlashCommands` for the live session returns
  **285 commands, every one `source: "sdk"`**. Zero `source: "plugin"`. Neither
  `/note` nor the namespaced `/journal:note` appears.
- The user independently reported it is absent from the composer's menu.

So the typed-trigger path and the menu path disagree about whether the command
exists.

Lead for whoever picks this up:
`apps/desktop/src/main/services/chat/pluginSlashCommands.ts` exists and its own
header documents the intended design — fold plugin commands into the single
`mergeSlashCommands` call in `agentChatService.getSlashCommands` so they work on
all six providers. That merge is not visible in the result. The same header
flags the likely culprit:

> The declaration read is daemon-free on purpose. `getSlashCommands` runs in
> both the desktop main process and the daemon, and only the daemon builds a
> plugin host.

So check whether the merge is running in the process that actually answered.

**Stale-app ruled out.** `strings` on the running
`/Applications/ADE Alpha.app/Contents/Resources/app.asar` finds
`pluginSlashCommands`, `namespacedSlashCommand` and
`PluginSlashCommandDeclaration` all present. The merge ships in the binary that
answered with 285 sdk-only commands, so this is a live defect in shipped code,
not an app that predates the fix.

Related: `namespacedSlashCommand()` re-offers a colliding command as
`/journal:note`. With 285 core commands, name collisions will be routine, so
whatever fix lands should also make the namespaced form discoverable — a user
who types `/note` and gets nothing has no way to learn the real name.

### A3 `diagnosed` **P0 — A phone's plugin watermark is seeded from the PEER's version space, so plugin rows can never reach it**

The headline finding of the iOS run, and a regression of the exact failure
`e4b816f77` was written to fix.

**Symptom.** The user pressed "Log it" twice on their iPhone, saw the success
banner both times, and saw neither note in the phone's Journal view.

**Both notes were written correctly.** They are on the Mac, with the right
timestamps and flags:

```
blocked  2026-08-30T13:13:51Z  Hehehsusisisisu
note     2026-08-30T13:13:07Z  Test from phone
```

So the write path, the action round-trip and the success message were all
honest. What fails is the phone ever *receiving* a `plugin_collections` row.

**Root cause.** On this machine:

| | value |
|---|---|
| Phone's `sync_peer_plugin_watermarks.through_db_version` | **45,250,073** |
| Newest `plugin_collections` row (`__crsql_clock.db_version`) | 15,323,469 |
| Newest row in **any** table in the whole database | 15,324,906 |

The watermark sits **29,925,167 versions past the head of the entire
database** — roughly 3× beyond any row that exists. The plugin-only catch-up
export looks for plugin rows with `db_version > through_db_version`, finds
nothing, and will keep finding nothing until the Mac's version counter triples.
**The phone is permanently starved of plugin rows**, and nothing reports an
error: the export "succeeds" with an empty batch every time.

**Stale-app ruled out here too.** `sync_peer_plugin_watermarks` is present in
the running `app.asar`, and the desktop binary was built 2026-08-29 14:30 —
41 minutes after `e4b816f77` landed at 13:49. The fix is running; the bug is
inside it.

45.2M is not a plausible number in this database's version space, but it is a
very plausible one in the *phone's own*. The peer cursor is client-supplied at
hello (the commit message says so), and a cr-sqlite `db_version` is only
meaningful in the version space of the site that issued it. Seeding a local
watermark from a remote cursor compares two unrelated counters. The commit's
`min(stored, peer cursor)` seed is presumably where it enters: with nothing
stored yet, the peer's number wins.

Note the watermark's `updated_at` is `13:14:59` — *after* the 13:13 notes — so
it also advanced on a batch that carried nothing, meaning the "advances only
when a batch carried plugin rows" guard did not hold either.

**Fix direction.**
1. Never seed or advance a local watermark from a peer-supplied cursor. Clamp
   to the local plugin tables' own head: `min(peerCursor, localPluginHead)`, or
   simply ignore the peer's number and start at 0 — a full plugin catch-up is
   cheap (15 rows here) and self-healing.
2. Add the invariant that makes this class impossible to ship again: a
   watermark greater than the local database head is nonsense. Assert it, log
   it, and clamp it.
3. Regression test: a peer that hellos with an absurd cursor must still receive
   every plugin row.

**Reproduced from clean state — this is live code, not historical corruption.**

The reset experiment was run and it settles the question:

| step | time | watermark |
|---|---|---|
| Reset by hand | 13:5x | `0` |
| Held at 0, phone backgrounded | for 50 min | `0` |
| **Phone foregrounded / re-hello** | 14:33:53 | — |
| **Re-seeded within 7 seconds** | 14:34:00 | **45,963,567** |

Against a `plugin_collections` head of 15,330,189 and a **global** head of
15,334,894 across every table, the re-seeded value overshoots by **30,633,378**.
It also came back *higher* than the original 45,250,073, consistent with it
tracking the phone's own advancing `db_version` — a counter in a different
site's version space, meaningless locally.

Two consequences:

1. **The seeding code is broken now**, not once in the past. Any device that
   hellos re-poisons its own watermark immediately. A migration that clamps
   existing rows would not be enough on its own.
2. **There is no user-side workaround.** Resetting the watermark does not help:
   it is overwritten on the next hello, seconds later. An affected phone cannot
   be repaired from the outside, which raises this above a normal P0 — the
   feature is unusable on mobile until the code is fixed.

**Retracted:** an earlier draft of this entry offered
`UPDATE sync_peer_plugin_watermarks SET through_db_version = 0` as an immediate
unblock. That was wrong, and the experiment above is what disproved it. The
write succeeds and is undone on the next reconnect.

### A4 `diagnosed` **P1 — Three of the four SDK change events have no producer**

`ade.events.on("lane.changed" | "pr.changed" | "session.changed", …)` never
fires. The names are typed, validated and documented; nothing emits them.

Evidence — every `event:` emit site in `pluginHostService.ts`:

```
1944  install.changed
2186  turn.start
2190  turn.end
2196  tool.before
2266  chat.turn
2294  chat.interrupt
```

`lane.changed`, `pr.changed` and `session.changed` appear in exactly two places
in the entire repo, both in `shared/plugins/sdk.ts` — the union at :406 and the
type-guard at :589. There is no emit site anywhere under `apps/`.

The plumbing is otherwise complete, which is what makes this so easy to miss:
the child bootstrap has a working `case "event"` frame handler, the host has a
real `supervisor.send({type: "event", …})` path with coalescing and an
`overflow` flag, and `install.changed` and the three runtime hooks travel it
fine. A plugin subscribing to the other three registers a listener, gets no
error, and simply never hears anything.

**This kills the documented recipes.** The `ade-plugins` skill's own "Row badges
from CI" example is `ade.events.on("pr.changed", …)` — copy it and you get a
plugin that publishes nothing, forever, silently. Any plugin that reacts to
lanes, PRs, or chat sessions is dead on arrival.

Discovered because this plugin's "when a lane gets archived, log it" feature
never fired. (It had an author bug too — see C5 — but the event would not have
arrived either way.)

**Fix direction.** Either wire the three emits to the existing change buses, or
remove them from the SDK type union and say so — a validated event name with no
producer is worse than an absent one, because it type-checks.

### A5 `diagnosed` **P2 — The `pane` surface kind is parsed, disclosed, and never drawn**

`{"kind": "pane"}` is accepted by the manifest parser (`SURFACE_KINDS`), and the
install disclosure card describes it to the user
(`installDisclosure.ts:163,432`) — but nothing renders it.

- **Desktop:** the Work rail reads `usePluginPanelSlots("work",
  "work-rail-pane", …)` only (`WorkSidebar.tsx:310`). It never looks at
  `surfaces[]`. The only other `"pane"` matches in the renderer are
  `PaneTilingLayout` / `paneTreeOps`, which are the window-tiling concept and
  unrelated.
- **iOS:** `PluginEntryMenu.swift` keys the plugin menu off **panel count**
  (`panelCount > 0`), not surface kind, so a `pane` surface neither adds nor
  removes anything there.

So the field is inert on every client while the install card promises it. The
`ade-plugins` skill's placement table actively points authors at it: *"The rail
on desktop and web, and the phone's plugin menu | Yes — a `tab`, or a `pane` for
the Work rail."* An author who follows that gets an invisible surface and no
warning — the manifest parses clean and `doctor` stays green.

**Fix direction.** Either render `pane` surfaces in the Work rail beside
`work-rail-pane` sockets, or drop the kind from `SURFACE_KINDS`, the disclosure
card and the skill. Whichever way, `doctor` should refuse to stay green on a
surface nothing can draw.

### A2 `reported` **P2 — `plugin.install` cancels its own approval card**

An agent cannot install a plugin unless the user happens to be watching at that
exact moment.

**Corrected diagnosis.** An earlier draft of this entry blamed the CLI's RPC
timeout alone. The real mechanism is host-side and deliberate, and it was
pointed out from the `Pending Request Chat Guard` lane
(`060df182-e2f4-4655-a3ef-99536f3a3d20`, PR #1184).

`pluginInstallApproval.ts:67` sets
`PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000`. On expiry the host does
not merely stop waiting — it **actively cancels the card**
(`respondToInput({decision: "cancel"})`, :415), which is the
`pending_input_resolved: {"resolution": "cancelled"}` seen in the chat event
history. So two independent clocks were in play and the earlier entry conflated
them: the CLI's `ade/actions/call` RPC timeout (which kills the *caller*) and
this 10-minute approval timeout (which kills the *card*).

**Its justification is now stale.** The code comment at :434 reads:

> Settle the card rather than abandon it: an unanswered prompt also blocks the
> user's next message in this chat, so leaving it live would wedge the
> conversation on a question whose asker has already given up.

That wedge is precisely what PR #1184 ("Keep a pending-input card visible while
its asker still waits") fixed on `main`. Verified: the commit exists locally
(`1ed80d02c`) and `git merge-base --is-ancestor` confirms **this lane does not
contain it** — `pluginInstallApproval.ts` lives on the unmerged alpha-build lane,
so there was nothing on `main` for that PR to change here.

**Action, once alpha-build rebases onto main:** revisit the 10-minute timeout.
With #1184 in, an unanswered card no longer wedges the conversation, so the
timeout's stated reason no longer holds and it should be raised substantially or
removed. Until then an agent still cannot install a plugin for a user who has
stepped away for ten minutes — which is the ordinary case, and is what happened
twice here.

The brain was healthy and the CLI matched the app (`ade doctor`: CLI green,
Brain green, correct `ADE_HOME`), so this is not the home-mismatch case the
`ade-plugins` skill documents. There is no timeout flag on `ade actions run`.

Consequence: the skill's documented "ask once, then reload" authoring loop only
works with a human present. Install succeeded on the third try solely because
the user was at the keyboard and pressed Approve within seconds.

Fix direction: the approval's lifetime should not be bound to the requesting
CLI process, or the action call needs a timeout that matches the ten-minute
approval window.

---

## B — Missing capabilities (no socket / no API does this)

### B1 `diagnosed` **P1 — No way to capture short text from a button press**

This is the gap that bent the whole feature, and it is worth taking seriously
because the user's request was completely ordinary: *"a Log it button that saves
a one-line note of what I'm doing."*

An action may answer with `{navigate}`, `{composer}`, `{dialog}`, `{openUrl}`,
`{openWebview}`, `{message}`, `{resetState}` — but there is no `{prompt}`. A
button therefore cannot ask "what are you working on?".

Every available workaround is bad:
- Log the chat's **title** (what this plugin does). See C1 — it produces junk.
- `{navigate}` to a panel with a `form`. Takes the user off what they were
  doing to type one line.
- Tell them to use the slash command instead — which A1 makes undiscoverable.

Suggested shape: let an action return `{prompt: {title, placeholder, field}}`
and re-invoke the same handler with the answer. Small surface, and it unlocks
the entire "quick capture" plugin category (journals, todos, bookmarks,
snippets, feedback widgets).

### B2 `diagnosed` **P2 — A plugin cannot write its own settings**

`ade.config.get()` is the only config method; there is no `config.set`. So a
plugin can render a `settings-section` panel with a form, and that form can do
nothing but read. Values must be set in ADE's own generated config form, which
means two forms for one set of settings and no way to make the plugin's own one
authoritative.

Directly caused author bug C3 below.

### B3 `diagnosed` **P2 — Nothing time-relative in a binding's `where`**

The client only compares strings and never computes one, so any "today / this
week" filter must be materialised by the plugin as a literal field on each row
(`today: "today"`, `week: "week"`).

Those fields are a function of *now*, so they go stale at midnight and the
plugin must rewrite them. There is no cheap "the day changed" trigger:
`ade.schedules` floors at 60 seconds, and a panel only re-renders what is
already stored. Every journal, log, activity-feed or "recent items" plugin will
hit this and most will get it wrong.

Suggested shape: either a reserved `$now`-relative comparison in `where`, or a
host-fired `day.changed` event.

### B4 `reported` **P3 — A declared `row-badge` marks every row**

A declared badge draws its manifest `label` as a placeholder on *every* row of
its surface until a published row replaces it. There is no "draw nothing until
published" option, so the author must pick a label that reads acceptably as the
empty state. This plugin chose `"0"`, which puts a `0` chip on every lane row
forever. Conspicuous on a phone.

### B5 `reported` **P3 — `command-palette-action` has no session**

A ⌘K entry receives a `surface` context with no subject, so a palette action
that wants to act on "the chat I am in" has to guess. This plugin tracks the
last `turn.start` and hopes. A palette entry fired while the user is staring at
a chat should be able to know which one.

---

## C — Author bugs (mine, in `plugins/journal`)

Recorded so the exercise stays honest, and because two of them were caused by
the platform gaps above rather than excused by them.

### C1 `diagnosed` **P1 — "Log it" logs the chat's auto-generated title**

The user's journal now literally reads:

```
note   Follow Image Instructions
done   Follow Image Instructions
note   Follow Image Instructions
```

`chat-header-action` receives `{kind, id, title, provider, status}` and cannot
prompt (B1), so the handler used `title` — which for most chats is an
auto-generated summary of the *first message*, not a description of the work.
The result is a journal of useless rows and a standup built from them.

Better shape, available today: **`{navigate}` to the compose panel with the lane
pre-filled**, and let the user type one line. Costs a panel open; produces a
journal worth reading. The current behaviour should have been the fallback, not
the default.

### C2 `reported` **P1 — The button does not explain itself**

User's words: *"i have no clue what it does it has four options and im not sure
what clicking them even does."*

`Log it` / `Blocked` / `Done` / `Write my standup` / `Open the journal` is five
verbs behind one unlabelled split button, with no first-run explanation and no
tooltip. A plugin's first press should not be a guess. Partly a platform
observation — there is no onboarding affordance for a contributed control — but
the naming and grouping were the author's to get right.

### C3 `diagnosed` **P2 — Two settings fields that cannot save**

`applySettings` reads `args.slackWebhookUrl` and writes it to `ade.secrets`, but
`standupTime` and `autoPost` are read from `config.get()` and never written
(B2). Both fields render, accept input, and silently discard it.

Fix: drop them from the panel and point at ADE's own config form, or render them
read-only.

### C4 `diagnosed` **P2 — Notes stay "Today" past midnight**

`rollDayFlags()` rewrites the stale `today`/`week` fields, but only runs on
activate, a note write, or a refresh gesture. Leave ADE open overnight, open the
Journal, and yesterday's notes are still filed under Today. Needs a daily
`ade.schedules` entry — the author wrote the roller and then did not schedule
it. Root cause is B3.

### C5 `diagnosed` **P2 — Archive detection reads a field `lane.list` never returns**

`syncArchivedLanes()` looks for a lane whose `archivedAt` turned from `null` to
a date. Verified against the live host: **`lane.list` excludes archived lanes
entirely** — after archiving a throwaway lane, the list returned 5 lanes and
`[l for l in lanes if l.archivedAt]` was empty. An archived lane does not appear
with a timestamp; it vanishes.

So the correct detection is "a lane that was in my snapshot and is now absent
from the list", not "a lane whose `archivedAt` is set". The author's version
could never have fired even with a working `lane.changed` (A4).

Two independent faults stacked on one feature, which is why it produced no note
and no error: the event never arrives, and the handler would have looked at the
wrong thing if it had.

### C6 `diagnosed` **P1 — The standup card never appears, because a `chat-card` needs an emit the plugin never made**

User pressed ⌘⇧U repeatedly and saw nothing. Everything upstream was fine:

- The keybinding **fired** — `doctor`'s Last run rung read `writeStandup ran 1
  minute ago`.
- The contribution **published against the right chat** —
  `chat-card -> session b8f2cfd5…`, which is the conversation the user was
  looking at.
- And still nothing drew.

`PluginChatCard.tsx:16-38` documents the actual contract, and it takes **two
halves**:

> - **The card** supplies chronology. A transcript row has a position in a
>   conversation; a `plugin_contributions` row does not. So the plugin PLACES
>   the card by emitting an `ade_card` through `chat.emitAdeCard` …
> - **The socket** supplies permission. The panel renders only when the plugin
>   DECLARED a `chat-card` contribution naming this `panelId`.

This plugin only ever did the second. `grep -c emitAdeCard index.js` → **0**. The
published contribution grants permission to draw a panel inside a transcript row
that was never created, so it sits there doing nothing, forever, with no error.

**Fix:** call `ade.actions.invoke("chat", "emitAdeCard", {sessionId, card:
{cardId, variant, state, title, fallbackText, …}})` from `writeStandup`, and keep
the socket declaration for permission.

See B6 — the documentation is what led here.

### B6 `diagnosed` **P2 — The skill documents `chat-card` as if publishing it were enough**

Author-facing docs describe `chat-card` in terms that imply the contribution
alone renders:

- Placement table: *"a card in the conversation | `chat-card`, surface `work` |
  Your panel, inline in the transcript"*
- Socket table: *"`chat-card` | `work` | `{panelId, title?, icon?}` | Your panel,
  drawn as a card in the chat transcript"*
- Hard rule 4's framing: *"The panel kinds carry a panel id and nothing else."*

Neither mentions `chat.emitAdeCard`, and the payload column lists only
`{panelId, title?, icon?}` — so an author does exactly what this one did:
declare the socket, publish the row, and expect a card. There is no runtime
signal that a half-configured `chat-card` will never draw: the manifest parses,
`doctor` reports `✓ Places … chat-card in work`, and the contribution row is
real.

Compare `PluginChatCard.tsx`'s own comment, which states the two-half contract
precisely. The implementation knows; the docs do not say.

**Fix direction.** Say it in the socket table and the placement map — a
`chat-card` is a *permission grant* attached to an `ade_card` the plugin emits,
not a standalone card. Better still, have `doctor` notice: a published
`chat-card` contribution with no matching emitted card in that session is a
detectable dead end, and it is exactly the shape of "green everywhere, invisible
to the user" this ledger keeps recording.

---

## D — Confirmed working

Recorded because a dogfood that only lists failures overstates them.

- **The `where` "All" filter.** A `segmented` whose selected value is `""` makes
  its comparison *inactive*, an `or` of inactive comparisons is inactive, and a
  `where` with nothing active keeps every row. The documented behaviour holds in
  the real renderer — verified by the user.
- **Slash-command dispatch**, including arguments read from the draft
  (`/note sdfsfsdf` landed correctly) and the draft-clearing `{composer}` verb.
- **Chat-header split button** with a four-entry menu, and its `color` surviving
  the 3:1 contrast gate.
- **Per-lane `row-badge` publish**, live count against the real lane.
- **`chat-card` published against the firing session**, with the standup text
  correctly materialised in the panel.
- **⌘K search provider**, **agent tools**, **`ade journal …` CLI words**,
  **5 panels**, **agent skill root**, **`Mod+Shift+U` keybinding accepted with
  no core conflict** — all green on `ade plugin doctor`.
- **`plugin.disable` / `plugin.enable` gating.** Disable stopped the child and
  cleared every published contribution (`listContributions` → `[]`); enable
  brought both back. Both raised their approval card and both cards *survived*,
  because the user was present — which is consistent with A2 being a
  timeout-versus-attention bug rather than an install-specific one.
- **Runtime hooks have real producers.** `turn.start`, `turn.end` and
  `tool.before` are emitted from a live observer wired into `agentChatService`,
  unlike the three dead change events in A4.
- **No rail duplication.** Declaring both a `pane` surface and a
  `work-rail-pane` socket for one panel yields one rail entry, not two — though
  only because the `pane` surface is inert (A5).
- **`row-badge` on the Lanes list.** Confirmed on screen by the user: the lane
  with notes draws its live count (`4`), and lanes without draw the manifest's
  `"0"` placeholder. The declared-badge-marks-every-row behaviour of B4 is
  therefore real and visible, but the user did not find the four `0` chips
  objectionable, so B4 stays a **P3** rather than a design flaw.
- **`keybindings[]` fire.** `Mod+Shift+U` reached `writeStandup` — confirmed via
  the Last run rung, not by anything visible, since C6 swallowed the output. The
  chord was neither refused nor lost.
- **Uninstall is thorough and honest.** The card was raised and answered, and
  everything went with it: registry row, the install directory
  (`~/.ade-alpha/plugins/journal`), **19 collection rows, 2 contribution rows and
  every panel row** — all zero afterwards. `ade journal today` degrades to
  `Unknown command 'journal'`, which is the right answer rather than a stack
  trace. This is the cleanest part of the platform we exercised.

### D1 `reported` **P3 — `doctor`'s Places rung stays ✓ on a disabled plugin**

With the plugin switched off, `Places` still reads
`✓ … 9 declarations; 0 rows published right now`. Nothing is placed anywhere.
`Installed here` and `Running` do both go `✗`, so a reader scanning for the
first failure is not badly misled — but a green rung describing placements that
cannot exist is the same "green while broken" pattern this ledger keeps
finding.

---

## E — Open, not yet tested

- **iOS — partially answered.** Built from this branch (1.1.10 build 4, matching
  what the phone reports to the host) and installed on the user's physical
  iPhone 16 Pro. Confirmed working there: the plugin's surfaces are visible,
  `chat-header-action` is reachable, and pressing it invokes the handler on the
  Mac and writes correctly. Confirmed broken: **no plugin collection row ever
  reaches the phone** — see A3. Everything the phone can show comes from
  manifest declarations (which ride `plugins.list`); everything it cannot comes
  from replicated rows. Still untested behind A3: pull-to-refresh firing
  `refreshAction`, the `pane` surface's contents, `row-badge` on lane rows.
- **Lane tagging from the phone.** Both phone-written notes came out
  `(no lane)`, while desktop presses resolve `alpha-build` correctly. So
  `chat.getSessionSummary` returned no `laneId` for a phone-originated press.
  Unclear yet whether that is the author's handler or the host; worth a look
  once A3 is unblocked.
- **Rail duplication.** This plugin declares both a `pane` surface and a
  `work-rail-pane` socket for the same panel (the first to reach the phone, the
  second for the desktop rail). Whether the Work rail then shows one entry or
  two is unverified.
- **`Mod+Shift+U`** accepted by the manifest but never observed firing.
- **Lane archive → "wrapped up \<lane\>"** note.
- **Slack post + notification** — needs a webhook URL.
