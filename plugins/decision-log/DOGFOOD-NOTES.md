# Plugin platform dogfood — findings for the dev team

Built **Decision Log** (`plugins/decision-log`) from a cold start as a first-time
plugin author following `ade-plugins/SKILL.md`, then ran the dev team's 8-point
checklist on desktop, on an iPhone 17 Pro simulator, and on a real iPhone 16 Pro
(device build from this checkout, driven by the user).
Everything below is something that happened, not a hypothetical.

Environment: ADE Alpha, `ADE_HOME=~/.ade-alpha`, brain `1.0.0-beta.1`
(`ade doctor` notes latest is 1.2.65 — **the running app is behind this
checkout**, which matters for some items below). Caller role `agent`,
`ADE_CHAT_SESSION_ID` set, chat permission mode `bypassPermissions`.

Severity: **P0** breaks a promise the platform makes · **P1** costs real author
time or ships a silent defect · **P2** papercut or docs.

---

## Checklist results, in the order given

| # | Item | Result |
|---|---|---|
| 1 | Install approval card, no network line | **Card worked.** The user was shown it and approved. My "no card" claim was retracted — see RETRACTED below. Content still needs a human eye |
| 2 | Header button opens a one-line text box; cancel does nothing | **Pass** (logic). `{prompt}` returns on press 1 and writes nothing; cancel invokes nothing by contract. Not seen on screen — see "what I could not look at" |
| 3 | Confirmation card appears in the chat | **Pass.** The `decision_logged` card is in this chat's transcript, `authoredBy: {pluginId: decision-log}`, host-stamped |
| 4 | Palette pre-knows your chat | **Pass.** With `subject.kind == "session"` it resolved sessionId → laneId; with `kind: "none"` it declines instead of guessing |
| 5 | Filters switch instantly; yesterday's decision leaves "last 7 days" only after refresh | **Pass, as designed.** `segmented` + `where` filter client-side with no round trip; `$rel` re-evaluates on re-render, not on a timer, so the panel declares `refreshAction` |
| 6 | Lanes badge only on lanes with decisions | **Pass on desktop; blocked on iOS** by the plugin-table replication P0 — `plugin_contributions` is in the same excluded set, so the phone never receives the badge |
| 7 | Settings takes effect with no restart and no Apply button | **Pass, after a rebuild.** `form` cannot do this — see P1-C |
| 8 | Phone renders the Decisions panel with real rows; `ade sync status` counts the phone | **Renders: PASS** — the panel opens from the chat's ⋯ menu and matches desktop. **Real rows: FAIL** — the phone shows a frozen snapshot; see the write-only P0. `sync status` counts the phone once connected |

---

## RETRACTED — "install ran with no approval card"

**This was my error, not a platform bug. The approval card worked correctly.**

I filed this as a P0 saying `plugin.install` installed third-party code with no
consent surface. The user approved a real card, in this chat, for both installs.

How I got it wrong: I searched the transcript for an `ade_card` payload with
`variant: "plugin_install"`, found none, and concluded no card was drawn. The
approval is raised as a **pending-input request**, not as the `ade_card` variant
I grepped for, so I was looking for the wrong record. I then read the
**10-second** install as "returned immediately" when ten seconds is simply how
long a person takes to read a card and press approve — the block-until-answered
behaviour working exactly as documented.

The lesson for anyone reading this ledger: **`plugin.install` blocking for a few
seconds is the card being answered, not the gate being skipped.** To verify the
card, read the pending-input/approval records, or just watch the chat.

The one genuine observation left in this section is a *reporting* gap, not a
security one: there is no read-back an agent can use to confirm its own install
was carded. Everything I could query (`plugin.get`, `plugin.list`, the doctor,
the transcript's card rows) shows the install succeeded and says nothing about
how it was authorised. **Ask:** put the approval outcome on the install result
(`approvedBy`/`approvalRequired`) so an agent can report the truth instead of
inferring it from wall-clock time, as I did, wrongly.

Checklist item 1 still needs a human to confirm the card's *content* — the
"DECISIONS · APPROVAL" title, the icon, and the absence of a network line
(correct: Decision Log declares no `network`).

---

## Confirmed on a real iPhone 16 Pro (device build from this checkout)

The user drove this; I read the code behind each symptom.

### P1 — every plugin card's byline draws a puzzle piece, always

`AdeCard.tsx:155` — `AdeCardAttribution({ label })` renders a hardcoded
`<PuzzlePiece size={10}/>` and takes **no icon parameter at all**. The plugin's
manifest `icon` is never consulted, so *"via Decision Log"* shows a puzzle piece
even though the manifest declares `"icon": "note"`, a valid token. This is not
the documented unknown-token fallback — a correct token cannot win, because
nothing reads it.

Every plugin card on the platform therefore looks like an unfinished plugin.
**Ask:** pass the plugin's icon through to the byline and fall back to the
puzzle piece only when the token really is unknown.

### P1 — a plugin card's `rows` and its panel's `$context` both render empty

Logging "Hi" from the phone produced a card that reads:

```
✓ Decision logged
  Hi
  Logged.
  🧩 via Decision Log
```

`Logged.` was the `emptyText` of the card panel's `keyValue`, so the panel
mounted and its `$context` binding produced **zero rows**. The card's own
`rows` did not draw either. The stored payload has both — verified from the
transcript, not inferred:

```json
"subtitle": "Hi",
"panel": {"panelId":"card","context":{"Decision":"Hi","Lane":"alpha-build","Logged":"Aug 30, 2026"}},
"rows": [{"icon":"info","text":"Lane","detail":"alpha-build"},
         {"icon":"info","text":"Logged","detail":"Aug 30, 2026"}]
```

So the emitter is correct and the render drops both. Both clients look wired for
it — desktop passes `renderContext: panel.context` into `PluginPanelHost`
(`PluginChatCard.tsx:148`) and iOS merges the card context over the session in
`PluginChatCardPanel.init` — which is what makes this worth a real look rather
than a docs fix.

Net effect: **the only per-card content a plugin can show is `title`,
`subtitle` and `fallbackText`.** `rows` and `$context` are documented as the way
to make a card about *this* thing, and neither reached the screen. Worked around
by folding the lane and date into the subtitle.

### P1 — two documented ceilings are not enforced by the writer

Probed directly against the running host with a temporary action (since removed).
The collection budgets behave exactly as documented — but two others do not.

| Probe | Documented | Actual |
|---|---|---|
| Collection value 70,012 B | refuse past 64 KiB | ✅ `plugin_budget_exceeded`, message names both numbers |
| Undeclared collection | refused, not created | ✅ `not_permitted`, names the manifest field |
| Reserved `ade.memory` name | refused both directions | ✅ `not_permitted`, names the replacement API |
| Undeclared panel id | refused | ✅ `not_permitted` |
| **Contribution payload ~5 KB** | **"One contribution payload: 4 KiB"** | ❌ **accepted and stored** |
| **Panel schema with 400 nodes** | **`maxNodes` 200, "invalid everywhere, identically"** | ❌ **accepted and stored, all 400** |

Two different problems:

- **The contribution cap is simply not applied.** Budgets are advertised as
  "writer-enforced, inside the transaction… never silently truncated", and the
  4 KiB one is not enforced at all. Every byte replicates to every device, so
  this is the ceiling most worth having.
- **Vocabulary ceilings are render-time only.** `panels.update` stored a
  400-node body verbatim. Since an over-ceiling schema is *panel-fatal* at
  render, the author's reward is every client quietly showing the fallback card
  with nothing anywhere saying why — and `ade plugin doctor` still reports
  `✓ Panels 3 published of 3`. Collections refuse at the write with a precise
  message; panels accept silently and fail later on four clients.

**Ask:** enforce the contribution cap in the writer like the collection ones,
and validate a schema against `VOCAB_LIMITS` at `panels.update` so the author
gets `plugin_budget_exceeded` at the call instead of a blank panel on a phone.

Confirmed working as documented, for the record: the degradation ladder itself
(an unknown component and a malformed known component are both accepted at
write and are meant to become markers at render), and `plugin.reload` restoring
a panel from its `schemaFile` after a runtime `panels.update`.

### Contract probe round — 15 checks against the running host

Run with temporary actions and a deliberately invalid manifest, both since
removed. **Thirteen of fifteen behaved exactly as documented.** The two that
did not are the writer-enforcement gaps above.

| Contract | Result |
|---|---|
| `tools[]` cap 24 | ✅ 26 declared → 2 dropped, one warning each |
| `automationTriggers[]` cap 8 | ✅ 9 → 1 dropped |
| `searchProviders[]` cap 2 | ✅ 3 → 1 dropped; `plugin.get` shows exactly 2 |
| Keybinding: bare key `j` | ✅ refused, *"not a shortcut a plugin can bind"* |
| Keybinding: reserved `Mod+C` | ✅ refused |
| Keybinding: two chords, one action | ✅ `duplicate-action`, later ones dropped |
| `openUrl` `https:` | ✅ allowed |
| `openUrl` `http:` / `javascript:` / `file:` / `data:` / `ade:` | ✅ all five refused |
| `openUrl` over 2,048 chars | ✅ refused |
| `message` over 400 chars | ✅ truncated to 400 (not refused) |
| Action timeout, non-exempt kind | ✅ `plugin_timeout` at ~62 s for a 65 s handler |
| Collection value over 64 KiB | ✅ refused, message names both numbers |
| Undeclared / reserved collection, undeclared panel | ✅ all `not_permitted`, each naming the fix |
| **Contribution payload ~5 KB** | ❌ accepted (see above) |
| **Panel schema, 400 nodes** | ❌ accepted (see above) |

Two notes on the keybinding result, so it is not over-read:

- **`Mod+K` — ADE's own command palette — was accepted into the manifest** and
  `plugin.get` reports it as a live binding of this plugin. That is **not** a
  stolen chord: `resolvePluginKeybindings` runs in the renderer
  (`usePluginKeybindings.ts:287`) against a live core-chord index, so it is
  refused at bind time in the app. What is missing is **visibility** — nothing
  in `plugin.get`, `ade plugin doctor` or the reload warnings tells an author
  their chord lost. They see a declared binding that silently never fires.
  **Ask:** surface the `core-conflict` refusal (which the resolver already
  builds a sentence for) on the doctor, the way `Places` surfaces disabled
  sockets.
- The per-entry warnings are genuinely good: each names the field, the cap and
  that the *entry* dropped rather than the plugin. This is the pattern the two
  unenforced ceilings should copy.

### Uninstall — behaves exactly as documented on the owning machine

Run for real against the installed plugin (not a throwaway), so it exercised
live synced data, a published contribution and a copy already on a phone.

| | Before | After uninstall | After reinstall |
|---|---|---|---|
| Registry row | enabled | gone | restored |
| Install directory | present | deleted | recreated |
| Contributions | 1 lane badge | `[]` | 0 |
| Panels | 3 published | `null` | 3 |
| Collection rows | 2 decisions | — | **0** |

The reinstall returning **0 decisions** is what proves the store was destroyed
rather than merely unpublished: a fresh install of byte-identical code found an
empty collection. The approval card fired on the removal *and* on the reinstall,
each blocking until answered — consistent with "never remembered", and the
second data point retiring my earlier false claim that installs are not carded.

**Still open:** whether the deletion reaches the phone. Given plugin data never
replicates *to* iOS (the P0 above), the sharp question is whether a phone can be
left holding a frozen copy of a plugin's data after the plugin is gone from the
machine that owned it. Not answered here.

### P2 — a degraded doctor rung reports the wrong reason

After the uninstall, `ade plugin doctor decision-log` prints:

```
– Last run   this copy of ADE does not keep track of plugin action runs
```

That sentence is documented for a **host too old to track runs**. This host
tracks them fine — it printed real `Last run` detail minutes earlier. The rung
conflates "the plugin is not installed" with "this ADE cannot do that", which
sends an author to check their app version instead of their install. Every
other rung on that same output degrades correctly (`✗ Installed here — not on
this computer — run: ade plugin install <source>`), which is what makes this one
stand out.

### Not tested, and why
- **`{prompt}` one-hop, `{composer}` verbs, `{resetState}`, `{navigate}`.**
  All enforced client-side, so a headless `plugin.invoke` returns whatever the
  action returned and proves nothing. Read rather than run: the one-hop rule is
  `if (extraArgs?.prompt !== undefined) return;` in `PluginPanelHost.tsx:374`,
  which is correct.

### P1 — plugin menu items did nothing for ~2 minutes after launch

The user's words: *"for the first 2 mins clicking them did nothing, i spammed
it, but randomly it started working after that."* No spinner, no toast, no
error — the rows are drawn and pressing them is a no-op until, at some point,
it starts working.

A drawn control that silently does nothing is indistinguishable from a broken
plugin, and spamming it is the rational response. Whatever the cause (child not
yet activated, contributions not yet resolved, the socket still connecting), the
menu row should either not be drawn yet or should say it is not ready.

### P0 — plugin data is effectively WRITE-ONLY from the phone

Sharpened by a second observation that ruled out my first explanation. The
user reversed a decision **from iOS**: they got the success message, and the
row turned amber **on the desktop** — but the row on iOS never changed, then or
since. So this is not replication lag and not a first-sync race:

- **phone → Mac works.** A plugin action runs on the owning machine (RPC), and
  its write lands and is visible on desktop immediately.
- **Mac → phone never arrives.** Not a newly inserted row, not an *update to a
  row the phone already has mirrored*, not after waiting, not after
  pull-to-refresh.

The phone can change plugin data it cannot see change. It renders a frozen
snapshot while happily writing to live data — the worst possible split, because
every write appears to succeed and none of them ever show up.

**The mechanism is documented in the host, in `syncHostService.ts:600-620`.**
The mobile replica reseed deliberately excludes the plugin tables
(`MOBILE_REPLICA_RESEED_EXCLUDED_TABLES_NO_PLUGINS`) so two data-heavy plugins
cannot blow the shared reseed budget for every phone. The reseed then **acks the
phone all the way to `targetDbVersion`**, so the ordinary incremental export —
which starts at that cursor — never revisits the skipped versions. The comment
is explicit that this used to mean *"a plugin pane on that phone stayed empty
forever"*, and that the debt is now recorded per peer as
`pluginTablesThroughDbVersion` and repaid by `sendPluginTablesCatchUp`.

Everything needed is present on both sides — so **this is not a version gap**:

| Symbol | Running brain (1.0.0-beta.1) | This checkout |
|---|---|---|
| `pluginTables` hello capability | present (36 refs) | present |
| `pluginTablesThroughDbVersion` | present (18 refs) | present |
| `sendPluginTablesCatchUp` | present (4 refs) | present |
| iOS advertises `pluginTables` | `SyncService.swift:16927` | — |

So the capability is advertised, the debt mechanism exists, and plugin rows
still never reach the phone. **The catch-up is not repaying the debt for this
peer** — that is the inference to verify, and it is where I would start.

This also explains the lane badge that never appeared in my simulator pass:
`plugin_contributions` is in the same excluded table set, so it is owed the same
debt.

**Compounding it, and why the user could not work around it:**
`PluginPaneStore.mirrorOrFetchedEntries` (below) only live-reads when the mirror
is *entirely empty*. Once any row is mirrored, the stale mirror is the answer
forever and the panel's `refreshAction` is powerless — which is exactly what the
user hit when refreshing changed nothing.

### P1 — the mirror wins even when it is known to be incomplete

Second half of the P0 above, and the reason no user-side workaround exists.
`PluginPaneStore.swift:661`:

```swift
let local = sync.pluginCollectionEntries(binding: binding, pluginId: pluginId, limit: limit)
guard local.isEmpty, fetchesMissingRows else { return local }
```

The live read fires **only when the mirror is entirely empty**. One replicated
row is enough to make the mirror authoritative, so a collection mid-replication
is drawn as a complete list. The reader sees a plausible, well-formed,
*wrong* list with no staleness marker, no spinner and no way to tell.

The method's own comment says the fallback exists so a panel does not "render
while its list is empty" — it closes the blank-pane case and opens a worse one:
blank is obviously broken, and silently-missing-the-newest-row is not.

It is especially sharp for a **write-then-read on the same device**: the user
logs a decision from the phone, the confirmation card appears in the transcript
immediately (a different sync path), and the Decisions panel still does not list
it. That reads as the plugin losing the write.

Two details that narrow it:

- `fetchesMissingRows` defaults to **`false`**, and `PluginPaneSheet.swift:27`
  is the only caller that passes `true`. So the Decisions pane (opened from the
  chat's ⋯ menu) *does* have live reads enabled — the `local.isEmpty` guard is
  the sole reason it did not run. Nothing else is misconfigured.
- The same default means a **`chat-card` panel never live-reads at all**
  (`PluginChatCardPanel` takes the default), so a card bound to a real
  collection renders from the mirror or not at all.

**Ask:** when the machine is reachable, either reconcile mirror + live rather
than choosing between them, or live-read whenever the panel was opened after a
local write, or at minimum mark the list as possibly-stale. `guard
local.isEmpty` is the whole bug.

### Item 8 — RESOLVED: the Decisions panel does render on iOS

The user confirmed on the device: the chat's ⋯ menu carries **"Log decision"**
and **"Open decision log"**; the first opens a one-line box titled *"What did
you decide?"* with **Log** and **Cancel**; the second opens the Decisions panel,
which *"looks exactly the same as the log menu in the desktop app"*.

So the panel vocabulary really does render identically across desktop and iOS
from one JSON document — the platform's central promise, and it holds. My
earlier simulator conclusion ("no plugin surface renders on iOS") was wrong; I
had been looking at the Lanes list and the Work toolbar, not inside a chat.

### Item 8 — plugin surfaces appear ONLY in the chat's ⋯ menu

Confirmed by the user on the device. That covers the `chat-header-action` and
the `chat-card`. Still unconfirmed: whether **"Open decision log"** appears in
that menu and whether tapping it opens the Decisions panel with real rows — the
manifest declares a `tab` surface with `mobile: true` plus a split-button menu
entry that returns `{navigate: {panelId: "log"}}`.

---

## iOS simulator pass — INCONCLUSIVE, I tested the wrong screens

**Do not action this section as written.** I looked at the Lanes list and the
Work toolbar. The plugin's chat surfaces — the `chat-header-action` (a row in
the chat's **⋯ overflow menu** on iOS, not a header button) and the `chat-card`
(in the **transcript**) — are *inside a chat*, and I never opened one. That is
where item 8 actually lives, and it is untested.

What I did see, which may or may not be a real gap once the chat screens are
checked:

- **Lanes** loads all four lanes, and `alpha-build` shows `dirty` and `↑137` —
  but **no decision badge**, while the desktop has exactly one published
  `row-badge` row for that lane id.
- **Work's toolbar** shows only the bell and gear, and `PluginEntryMenuButton`
  draws *"nothing at all when there are none"*.

Both are consistent with "contributions had not arrived yet on a phone that had
just connected", which I did not rule out. Retest from inside a chat first.

For reference, everything is present in this checkout and correctly wired:

- `PluginRecords.swift`, `PluginVocabularyView.swift`, `PluginPaneSheet.swift`,
  `PluginSocketViews.swift` all exist.
- `LaneListViewParts.swift:253` really does pass
  `pluginContributions.badges(.lane, lane.id)` into the row.
- The iOS decoder supports every construct these panels use: `segmented`,
  `onChange`, `keyValue`, `$state`, `$rel`, `since`/`before`, `allowActions`,
  `overflow`, `badge`, `confirm`.
- The packaged brain implements the commands the phone asks for: `plugins.list`,
  `plugins.presenceList`, `plugins.contributions`, `plugins.invoke`.

Tried and did not change the Lanes/toolbar result: waiting after connect,
switching tabs, a full app relaunch with the connection already established.
**But the chat screens — the ones that matter for item 8 — were never opened,
so nothing here is a conclusion.**

### Two iOS bugs found along the way, unrelated to plugins

**P1 — "Lane view error: The operation couldn't be completed.
(Swift.CancellationError error 1.)"** with a Retry button, on switching to
Lanes. A cancelled task is not a failure and should never reach the user as an
error card. Retry loads the lanes fine.

**P2 — a button labelled "Pair again" does not pair.**
`MobileAccessGateView.swift:79-92`: when the credential is unreadable the label
becomes "Pair again", but the action is
`if hasPairedHost { onContinue() } else { present the sheet }`. In my run it
re-opened the connect sheet I had just completed — the exact dead end the
comment above it says the label exists to prevent.

### Corrected — one thing I got wrong mid-run

I first saw *"This iPhone is paired with a computer, but the saved key for it
can no longer be read"* looping forever, and was about to file it as a P0. It
was **my build**: the first compile used `CODE_SIGNING_ALLOWED=NO`, which breaks
keychain access on the simulator. An ad-hoc-signed rebuild walks straight
through the gate. **Not a product bug** — flagging it only so nobody chases it.

### `ade sync status` and the connecting phone

Item 8 asks that `sync status` count the phone *while it is connecting*.
Observed: `connected peers 1` once the connection is established, `0` otherwise.
I never caught a counted "connecting" state — the window was shorter than a
poll, so I can neither confirm nor deny that half.

---

## P1 — `lane.list` answers a plugin with an EMPTY LIST, not an error

The obvious way to resolve lane names. From a plugin it is project-scoped, gets
no `projectId`, and returns `[]` **without throwing**. Every decision's subtitle
silently read `Lane 1b4714f3` instead of `alpha-build`; `ade plugin doctor` was
green at every rung and no log line anywhere said why.

The fix is `lane.getSummary({laneId})`, which needs no project id — but nothing
points you there, and a plugin has no obvious way to *get* a `projectId` at
activate time (change events carry one, but only once something changes).

**Ask:** refuse with `invalid_args` naming `projectId`, or document which
actions a plugin can reach without a project. A silent empty array is the worst
of the three.

## P1 — `PluginSchedule`'s id field is `id`, but the API says `scheduleId`

`schedules.delete(scheduleId: string)` is the signature, so `row.scheduleId` is
what you write when iterating `schedules.list()`. The field is `id`. Deleting
`undefined` throws `"scheduleId" must be a non-empty string.` — which reads like
*your argument* was malformed, not like you read the wrong field.

Unnoticed, the old schedule survives every settings save and walks into the
8-live ceiling one change at a time. **My unit test missed it because my stub
invented `scheduleId`** — a mistake the docs invite, since the parameter name is
the only spelling an author ever sees.

**Ask:** name the parameter `id`, or have the refusal say *"a schedule row's id
field is `id`"*.

## P1-C — `form` cannot apply on change, so item 7 is unbuildable with it

"No restart **and no Apply button**" is not expressible with `form`: `submit` is
required, so every form-shaped settings panel grows a button. The only control
that applies instantly is `segmented` + `onChange`.

I rebuilt the settings section out of two `segmented` controls, which passes —
but it costs the field labels, help text and validation `form` gives for free,
and a boolean has to be spelled `"on"`/`"off"` strings.

**Ask:** an optional `applyOnChange` on `form`, or `toggle`/`select` nodes with
`onChange` outside a form.

## P2 — a plugin `chat-card` without `panel` silently loses everything but one line

An unknown `variant` renders `fallbackText` **only** — unless the card carries a
`panel`, in which case the full frame (subtitle, rows, metrics) draws. A
plugin's variant is unknown *by definition*, so the natural first implementation
(title + subtitle + rows, no panel) renders as one grey line. The renderer
comment explains it; the skill mentions it in passing.

**Ask:** state it plainly — *a plugin card without `panel` is `fallbackText` and
nothing else.*

Related, and worth a line in the docs: **a card is a snapshot, not a live view.**
After I fixed the lane-name bug, the stored row corrected itself but the card
already in the transcript still says `Lane 1b4714f3`. That is correct behaviour
for a chronological row — but an author will assume the card follows the data.

## P2 — smaller things

- **`plugin.listContributions` requires `surface`** and does not say so until it
  refuses. The doctor's Places rung counts published rows, so "show me those
  rows" is the natural next call.
- **Local proof capture reports available, then fails.** `ade proof status` says
  `localFallback: {available: true, state: "present"}`; `ade proof capture` fails
  with `screencapture failed: could not create image from display` (Screen
  Recording permission). Status should reflect the permission, not just the
  binary. **This is why there are no desktop screenshots in this report.**
- **`ade-ios-simulator` skill is advertised but not in the checkout.**
  `apps/desktop/resources/agent-skills/` has 9 skills and that is not one of
  them, so the iOS loop had to be worked out from scratch.
- **The `color` contrast gate is silent.** A refused colour is dropped with no
  log, no doctor rung, and a clean-parsing manifest. I had to write a scratch
  vitest against `sanitizePluginActionColor` to check one hex. A doctor rung or
  `ade plugin lint` would close this.
- **An unknown `icon` token draws a puzzle piece on every client** with nothing
  validating it at install time. The doctor could warn.
- **Module-level state survives `reload`.** My caches persisted across a reload
  and made a lane rename invisible. Clearing them in `activate` is the fix;
  worth a line in the skill: *treat `activate` as a fresh host.*
- **`account directory http_error · HTTP 403 · Sign in to your ADE account
  again`** on this machine throughout. Not plugin-related, flagged in case it is
  the known dev-Clerk-override class of bug.

---

## What worked well — keep this

1. **`ade plugin doctor` is the best thing in the platform.** Its `Panel reach`
   rung caught the one design mistake I would not have found alone: a
   chat-header `{navigate}` opens the *tab* and takes the reader off the
   conversation, and a `work-rail-pane` is what keeps them on it. Nothing else
   in the loop surfaces that. The `Renders on:` line being derived from
   `PLUGIN_SOCKET_CLIENT_SUPPORT` rather than prose is exactly right.
2. **`plugin.invoke` with a synthetic context.** Pressing my own buttons from a
   shell found both P1 bugs above before a human clicked anything. Keep this a
   mandate.
3. **`{prompt}` one-hop capture** was precisely the right primitive for this
   feature. Branching on `args.prompt` is a two-line protocol; correct first try.
4. **The install → reload loop.** One approval, then `plugin.reload` per edit,
   with `warnings` on the result as the place a refused resync shows up.
5. **The budget and degradation docs are unusually honest.** "A full store is a
   normal state" plus `ifFull: "evictOldest"` meant the retention path was right
   the first time instead of discovered at 4,000 rows.
6. **`row-badge` publish-`null`-to-clear**, and the "a declared badge marks no
   rows" rule. Loudly documented, and it made "lanes with none show nothing"
   work with no special-casing.
7. **The `where` grammar** (`$state`, `$rel`, `since`/`before`) did the whole of
   item 5 with zero plugin code and no round trip. This is the best-designed
   corner of the vocabulary.

---

## What I could not look at

- **The desktop app on screen.** `ade proof capture` cannot capture (permission,
  above), so every desktop result is from the data layer: `plugin.getPanel`,
  `plugin.listContributions`, `plugin.invoke` and the transcript. I never saw
  the button, the tab, the badge or the card *drawn*.
- **The web client.** Not opened.
- Consequently items 2 and 3 are verified as behaviour, not as pixels.
