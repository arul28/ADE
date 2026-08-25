# ADE plugin alpha test: Tipsy handoff (round 2)

Date: 2026-08-25
Lane/branch: `plugin-platform`, commit `466e0b1c4`
Worktree: `/Users/arul/ADE/.ade/worktrees/alpha-build-1b4714f3`
App under test: freshly built and installed `/Applications/ADE Alpha.app` (packaged, this checkout)
Related prior report: `docs/reports/ade-tipsy-plugin-alpha-ux-retrospective.md` (2026-08-14)
Author: the coding agent that built, installed, debugged and drove Tipsy this round

## Purpose and how to read this

This is a second end-to-end pass at the same experiment the 2026-08-14 retrospective
describes: have an agent build a small real plugin (a drink counter called Tipsy — a
chat-header button, a dropdown "Sober up" action, and a skill that makes the agent act
progressively drunk by level), install it through the real approval flow, and drive it
from the actual running app. The user explicitly framed this round as a platform test,
not a feature request, and asked for a detailed, honestly-attributed bug list for the
plugins engineering team — including which problems were the agent's own mistakes,
which were the skill/docs' fault, and which are real platform bugs.

Every finding below was **verified against the actual running app and the actual source
in this checkout** — file:line citations, real CLI output, and a direct sqlite query
against the live database — not inferred from documentation. Where I got something
wrong mid-session, that is recorded and retracted explicitly rather than quietly
dropped, because a wrong finding left uncorrected is worse than no finding.

## What actually got built and how it went, end to end

1. Ran Phase 0 of the `ade-plugins` skill first: confirmed `apps/desktop/src/shared/plugins/sockets.ts`
   exists in this checkout, and that the `ade` CLI resolving from `PATH` is the alpha
   build (`ade 1.0.0-beta.1`, resolving to a shim pointing at this alpha app), before
   making any claim about what was possible. This is the exact step the prior
   retrospective says was skipped or done too late, and it visibly saved the same class
   of failure this round — no confusion at any point about which branch/app had the
   plugin platform.
2. Mapped every part of the request to a real socket before building anything
   (Phase 1): `chat-header-action` for the button, its `menu` field for the "Sober up"
   dropdown, a synced `drinks` collection for state, an agent `tools[]` entry
   (`getDrunkLevel`) plus a contributed skill for the drunk-behavior timing. Called out
   up front that "the chat background fills with beer" has no socket, and that behavior
   changes only apply from the *next* turn, never the current one — both turned out to
   be correct and were never contradicted later.
3. Built the plugin (`plugin.json`, `index.js`, a skill under `skills/tipsy-drunk-behavior/`),
   installed it through the real approval flow (`ade actions run plugin.install`), and
   verified with `ade plugin doctor ade-tipsy --text` before claiming anything worked.
4. The user then used the real button in the real chat header, across several turns,
   including going all the way from 0 drinks to a real blackout (10) and back to sober
   (0 via "Sober up"). The skill's turn-boundary timing was demonstrated live and
   correctly: my prose only started reading "drunk" starting the turn *after* a press
   registered, never mid-turn, and a fresh `getDrunkLevel` check every turn is what drove
   the tone — this was not scripted or hand-waved, it's the actual mechanism firing.
5. Along the way we surfaced eight distinct issues (below), fixed the two that were my
   own bugs, and left the platform-level ones for the engineering team.
6. At the end, the user had me test uninstall (confirmed to correctly refuse for an
   agent-bound terminal, so they removed all six plugins themselves from their own
   terminal), and I audited the resulting on-disk and database state.

## Bugs and gaps found, with explicit attribution

Format: **what**, **how I confirmed it**, **who's at fault**, **why that attribution**.

### 1. Marketplace "Installed" filter showed 0 when 4 plugins were genuinely installed — Platform bug

**What:** The user filtered the Marketplace by "Installed" and got 0 results, despite
`ade plugin list --text` correctly showing 4 enabled plugins (`ade-linear`,
`ade-theme-contrast`, `ade-theme-ink`, `ade-theme-paper`) from before this session.

**Root cause, confirmed by reading the code:**
- `usePluginRegistrySync()` (`apps/desktop/src/renderer/components/plugins/usePluginRegistry.ts:54-62`)
  fetches installed plugins exactly once on app mount via `refreshInstalledPlugins()`.
- That store action (`apps/desktop/src/renderer/state/appStore.ts:2194-2200`) calls
  `listInstalledPlugins()`, whose own doc comment states it "absorbs a missing namespace
  and a rejected call... resolves to an empty registry... rather than leaving
  `pluginsLoaded` false forever." That is: a real IPC failure or a boot-time race against
  the plugin host is indistinguishable, in the store, from "genuinely zero plugins are
  installed." Both produce `{installedPlugins: [], pluginsLoaded: true}`.
- The Marketplace's "Installed" chip (`apps/desktop/src/renderer/components/plugins/marketplaceModel.ts:439-440`)
  reads directly off that array.
- The only thing that forces a retry is a plugin change event
  (`usePluginRegistry.ts:56-61`). My later `plugin.install` for Tipsy fired exactly that
  event, which is why the count corrected itself from 0 to 5 (4 pre-existing + Tipsy) at
  that exact moment, with no other action taken in between.

**Attribution: platform bug.** This is a real race/failure-swallowing bug in the
renderer's plugin-registry bootstrap, not anything the user or I did. Recommend
distinguishing "asked and got a real empty list" from "asked and it failed/raced" —
right now both collapse to the same state, and there's no visible retry or error
surfaced anywhere.

### 2. The user's plugin theme silently reverted to default at the same moment — Same root cause as #1

**What:** Right after approving the Tipsy install, the user's already-selected plugin
theme visibly changed (reverted toward default), with no action on their part that
should have touched theming.

**Root cause:** The exact same hook (`usePluginRegistry.ts:64-74`) derives the applied
theme from `installedPlugins` + the user's persisted `pluginThemeId`. Because
`installedPlugins` was empty at boot (see #1), `themeDefinitionFor([], pluginThemeId)`
found no match and the built-in palette applied. The same install event that fixed the
Marketplace count also re-ran this effect with the now-correct plugin list, which is why
the user's actual theme "came back" at the same instant they approved installing Tipsy —
it looked causally related but wasn't; it was the same stale-registry bug surfacing
twice through two different UI reads of the same array.

**Attribution: platform bug**, not a second bug — one bug, two visible symptoms.

### 3. The plugin-install approval card drops nearly all of its own content — Platform bug

**What:** The user's screenshot of the approval card showed only a title ("Install Tipsy
0.1.0?"), a generic "A" avatar, and generic ACCEPT / ACCEPT ALL / DECLINE buttons — no
description, no source, no trust statement, no "Adds:" list, no rationale for why
approval was needed, and no link to the plugin.

**Root cause, confirmed by reading the code the host actually runs:**
- `pluginInstallApproval.ts` correctly builds all of that: `buildPluginInstallApprovalBody`
  (`apps/desktop/src/shared/plugins/installDisclosure.ts:213-232`) assembles the
  description, a source line, a trust line, an "Adds:" bulleted list, and (when the
  plugin declares skills) the "this affects agents starting their next turn" note. It
  also sets specific option labels ("Install" / "Don't install") with per-option
  rationale text (`pluginInstallApproval.ts:266-281`).
- None of that reaches the screen. `agentChatService.ts:47666`:
  ```
  description: args.kind === "plan_approval" ? args.body : (questions[0]?.question ?? args.body),
  ```
  Because `pluginInstallApproval.ts` always supplies `questions[0].question` (set equal
  to the title), this ternary always picks the title over the rich `body` for any
  non-`plan_approval` approval — so the entire disclosure text is discarded, silently,
  every time, for every plugin.
- The renderer compounds it: `AgentChatComposer.tsx:5163-5177` hardcodes "Accept" /
  "Accept all" / "Decline" and never reads the specific `questions[0].options[].label`
  or `.description` that were actually supplied. The header avatar is a generic
  `<ProviderLogo family={pendingInput.source} />` (source `"ade"` for a plugin install),
  not the plugin's own icon or a Marketplace mark. There is no link into the plugin's
  Marketplace page anywhere on this card.
- Notably, a *different* component in the same codebase — `PluginInstallChatCard.tsx`
  (used for an unrelated "agent suggests a plugin inline" feature) — already has an
  "Open it" button that navigates to the plugin's Marketplace page. The capability
  exists; it just isn't reused for the actual gated `plugin.install` approval.

**Attribution: platform bug**, and I'd call it the most product-impactful one on this
list, since it means the disclosure the platform is designed to show a user before they
grant filesystem/network access to arbitrary code currently shows almost nothing.

**User-requested product asks arising from this** (see "Product/UX ideas" below):
plugin-specific icon or Marketplace logo instead of the generic "A"; a stated rationale
for why the install needs approval; a link to view the plugin in the Marketplace from
the card itself; button labels that read "Approve and install" / "Deny" rather than
generic Accept/Accept all/Decline.

### 3a. Correction — a claim I made and then retracted

I initially reported the Electron Control (`ade-app-control`) install as a "silent
bypass" of the approval gate, because my Bash tool call returned a completed success
result and I didn't notice a pending approval was in flight during that window. The user
corrected me: they did see and accept a real approval popup for it — it just had no
content, i.e. it's another instance of bug #3, not a distinct trust-boundary bypass. I
verified this is consistent with the code: `plugin.install` is unconditionally
CTO-only + approval-gated for every source kind including `builtin`
(`apps/desktop/src/main/services/adeActions/registry.ts`: `plugin: ["install"]` in both
`ADE_ACTION_CTO_ONLY` and `ADE_ACTION_APPROVAL_GATED`), so there is no exemption path —
my initial claim was simply wrong. Recording this so the false alarm doesn't get
propagated into the engineering backlog as if it were a separate finding.

### 4. Split-button dropdown menu items have no way to carry a custom icon — Platform gap, not a plugin mistake

**What:** The "Sober up" item in the button's dropdown always rendered a generic
puzzle-piece icon, regardless of anything in Tipsy's manifest.

**Root cause, confirmed by reading the type definitions:**
- `PluginActionButtonMenuItem` (`apps/desktop/src/shared/plugins/sockets.ts:444-454`) is
  `{label, actionId, danger?}` — there is no `icon` field in the schema at all, and
  `parsePluginActionButtonMenu` (`sockets.ts:509-527+`) never reads one.
- Any menu item, for any plugin, therefore always falls back to
  `DEFAULT_PLUGIN_ICON = PuzzlePiece` (`apps/desktop/src/renderer/components/plugins/pluginIcons.tsx:157`).

**Attribution: platform limitation, not something a plugin author can avoid.** There was
no manifest field I could have set. Worth adding an optional `icon` field to
`PluginActionButtonMenuItem`, resolved through the same 64-token list the primary
button already uses.

### 5. The split button's chevron renders as a visually separate control — Platform chrome gap

**What:** The main "Take a drink" button and its dropdown chevron appear as two
independently-bordered pill buttons with a visible gap between them, rather than one
joined control with an internal divider — even though functionally they act as one
(shared busy state, same contribution).

**Root cause, confirmed by reading the component:** `PluginChatHeaderActions.tsx:154-176`
renders the main `<button>` (`BUTTON_CLASS`, its own `rounded-md border`) and
`<SocketSplitMenu>` (`CHEVRON_CLASS`, its own separate `rounded-md border`) as sibling
elements joined only by a flex `gap-1`. There is no shared container or seamless joint.

**Attribution: platform chrome gap, shared code affecting every plugin's split
buttons**, not specific to Tipsy. Purely visual — the underlying behavior (busy-state
sharing, primary press semantics) is correct.

### 6. `drink`/`soberUp` read the session id from the wrong path — My bug, partly a docs ambiguity

**What:** Every real button press silently did nothing — no error surfaced anywhere,
just no visible state change (the user's "I clicked it, nothing happened").

**Root cause:** My `index.js` read `args?.context?.session?.id`. The actual shape,
confirmed in `apps/desktop/src/shared/plugins/context.ts:44-50`, is that the session
context object **is** `{kind: "session", id, title, provider, status}` directly — there
is no `.session` nesting. My code silently found `sessionId` undefined and returned
`{ok: false}` without writing anything or throwing (so no toast, no log line — nothing
visibly wrong from the outside).

**Attribution: primarily my mistake** — I misread the reference table (`session: id,
title, provider, status` for `chat-header-action`) as describing a nested field named
`session`, rather than the flat context object's own fields. **Secondary docs
ambiguity worth flagging:** that table format doesn't visually distinguish "these are
the fields directly on `context`" from "these live under a `.session` key," and nothing
in the skill shows a literal worked JSON example of `args` for a socket action handler.
A single literal example (`{context: {kind: "session", id: "...", ...}}`) next to that
table would have prevented this exact class of mistake.

### 7. The `status` CLI word read `argv` at the wrong level — My bug, docs also imprecise here

**What:** `ade ade-tipsy status <sessionId>` returned a usage error even with a valid
session id passed.

**Root cause:** My handler was `async status(argv) { ... }`, treating the single
parameter as the raw array. The actual delivery, confirmed in
`apps/desktop/src/main/services/plugins/pluginHostService.ts:1126-1133` and
`.../childRuntime/pluginChildBootstrap.ts:314-325`, is that the host builds
`{...args, ...(argv ? {argv} : {})}` and calls `handler(frame.args)` — so `argv` arrives
as a **property** of the single args object, not as the object itself. After fixing
that, a second latent bug in my own `.find()` logic surfaced (it matched the literal
word `"status"` — which is itself part of `argv` — before reaching the real session id);
fixed by taking the last non-flag token instead of the first.

**Attribution: my mistake**, but again the skill's phrasing — "The plugin receives the
raw argv, so it owns its own usage text" — reads as if the action's parameter *is* the
array, when it's a property of it. And the scaffold `ade plugin create` generates
(`plugin.json`'s default `cli: ["status"]` field, an `index.js` with `actions.status`)
does not itself model correct `argv` access, so there's no working example to copy from
even in the platform's own quick-start. Worth fixing the wording and, ideally, having
the scaffolded starter action demonstrate the real shape.

### 8. `ade plugin reload` does not resync a `local`-source plugin from its source directory — Platform footgun, cost real time

**What:** I fixed bug #6, reloaded, reinstalled — did not work, again — did not work
five separate times. The behavior appeared unchanged no matter what I edited.

**Root cause:** I diffed the installed copy against my source and found
`~/.ade-alpha/plugins/ade-tipsy/index.js` still had the **original, pre-fix** code, byte
for byte, despite five `ade plugin reload ade-tipsy` calls in between. `reload` re-reads
whatever is *already sitting in the install directory* and restarts the child — it does
**not** re-copy from the original `local` source path. Only `ade plugin dev` (the
live-watch loop) does that sync. Running `ade plugin install /Users/arul/plugins/ade-tipsy`
again (same plugin id, same path, so pre-approved and no new prompt) was what actually
pushed the fix.

**Attribution: platform footgun.** Nothing in `reload`'s own help text or the skill's
"Develop" section warns that `reload` and a `local` source can silently diverge like
this. Recommend one of: (a) `reload` re-copies from source when the record's `source.kind
=== "local"`, since there's no reason to keep serving stale bytes from a path the plugin
was installed from, or (b) at minimum, `reload`/`doctor` detect and report "installed
copy differs from source path" for local installs. This alone cost roughly five
redundant reload/verify cycles.

### 9. `plugin_presence` rows are not cleaned up on uninstall — Platform bug, verified directly against the database

**What:** After the user uninstalled all six plugins, I queried the live sqlite database
directly rather than trusting the CLI summary alone.

```
$ sqlite3 .../ade.db "SELECT plugin_id, COUNT(*) FROM plugin_collections GROUP BY plugin_id;"
(empty)
$ sqlite3 .../ade.db "SELECT plugin_id, COUNT(*) FROM plugin_contributions GROUP BY plugin_id;"
(empty)
$ sqlite3 .../ade.db "SELECT plugin_id, COUNT(*) FROM plugin_panels GROUP BY plugin_id;"
(empty)
$ sqlite3 .../ade.db "SELECT * FROM plugin_presence;"
machine_key       plugin_id           version  enabled  updated_at
44bafcf7...       ade-linear          1.0.1    1        2026-08-14T07:19:03.919Z
44bafcf7...       ade-theme-ink       1.0.1    1        2026-08-14T07:19:03.919Z
44bafcf7...       ade-theme-paper    1.0.1    1        2026-08-14T07:19:03.919Z
44bafcf7...       ade-theme-contrast  1.0.1    1        2026-08-14T07:19:16.499Z
```

Collections, contributions, and panels were all correctly purged (empty) for every
uninstalled plugin — that part of cleanup works. But `plugin_presence` still has four
rows, all `enabled: 1`, with `updated_at` timestamps from **11 days before** today's
uninstalls — meaning uninstalling today didn't touch these rows at all; they're stale
survivors from the original 2026-08-14 install. (`ade-tipsy` and `ade-app-control` never
appear in this table at all — likely because presence publish is gated on a version
change, per a comment in `pluginHostService.ts`, so a plugin installed and removed
without ever changing version between the two never got a row in the first place; a
minor, separate observation, not a claim of a second bug.)

**Attribution: platform bug.** `plugin_presence` is missing from whatever cleanup path
correctly empties `plugin_collections`/`plugin_contributions`/`plugin_panels` on
uninstall. **Real user-facing impact:** on a multi-device account, another machine
reading this machine's presence rows would see it as still having Linear and all three
themes enabled, when they've actually been removed — this is exactly the kind of stale
signal the Marketplace's machine-coverage rail is built to avoid, and it currently can't
be avoided for this case.

### Confirmed working correctly (not bugs — recorded so they aren't re-litigated)

- **Uninstall's operator-only refusal is correct and was not bypassable.** I tried
  `ade plugin remove ade-tipsy` from this agent-bound terminal and got a clean flat
  refusal: `{"kind":"plugin_role_denied","requiredRole":"cto","sessionBound":true}`. I
  did not attempt to unset the session env vars to route around it — that would have
  been me granting myself a permission the user didn't give me, which the skill
  explicitly warns against.
- **The skill's turn-boundary timing claim is true, not just documented.** I drove the
  drink count from 0 → 1 → ... → 4 → 9 → 10 (blackout) → 0 (sober) across separate
  turns, calling `getDrunkLevel` for real at the start of each one (visible in the
  transcript), and my prose tone changed exactly at turn boundaries and never mid-turn.
  This is the single most important claim in the whole skill and it held up under real,
  repeated, adversarial-ish testing (the user deliberately pushed it to the boundary
  twice).
- **The beer icon token rendered consistently and correctly** on desktop this round —
  contrast with the prior 2026-08-14 report, where the same `beer` token rendered as a
  Phosphor beer stein on desktop but an SF Symbol that read as tea/coffee on iOS. I did
  not test iOS this round, so I can't confirm cross-platform parity is fixed, only that
  the desktop half — which was also fine before — remained fine.
- **The chat-header-action socket and its split-button `menu` field, both of which did
  not exist for the prior report's author**, now exist, are documented, and worked
  exactly as the user asked: a button in the chat header (not a composer or a new pane),
  with a dropdown holding "Sober up." This directly resolves two of the sharpest
  complaints in the 2026-08-14 retrospective ("the visible action was not in the
  requested chat header," "the requested dropdown/sober-up affordance was absent").

## What I'd flag for tool-call / agent-workflow efficiency

- **`ade actions run plugin.invoke` with a synthetic context is the fastest way to
  verify action logic** — I eventually used it to reproduce bugs #6 and #7 directly,
  without needing the user to click anything or waiting on a UI round trip. I should
  have reached for this *first*, before ever asking the user to click the real button;
  I only adopted it partway through after "I clicked it, nothing happened" cost a whole
  round trip that a 10-second CLI invoke would have caught. Worth stating this
  explicitly in the skill as the recommended first verification step, ahead of asking a
  human to test anything in the UI.
- **`ade plugin doctor`'s "Places" rung can't distinguish "the action never fired" from
  "the action fired and legitimately published nothing."** Both look like "0 rows
  published right now." A cheap improvement: since the host already has structural error
  codes for every invoke, doctor could report the timestamp/outcome of the last invoke
  attempt per declared action. That would have caught bug #6 in the first doctor run
  instead of requiring a real click, a user report, and a manual CLI reproduction.
- **The reload/source-divergence trap (#8) is the single biggest efficiency loss this
  round** — five reload cycles produced identical (wrong) behavior with no signal that
  anything was stale. A `doctor` rung (or a `reload` warning) comparing source-path
  mtime/hash against the installed copy for `local` sources would have caught this on the
  first reload instead of the sixth attempt.
- **The context-shape (#6) and argv-shape (#7) ambiguities both cost multiple avoidable
  tool calls.** A single literal, copy-pasteable JSON example of `args` for each socket
  kind, and of `args` for a `cli` word action, would remove an entire class of
  first-time-author mistakes like the two I made here.

## Product/UX ideas raised this session (for the handoff, not implemented)

- **Right-click / quick-action menu on a plugin row** (in the Marketplace or wherever
  plugins are listed) for common single-plugin operations like Remove, Disable, Reload —
  the user explicitly asked for this rather than needing to open a full detail page.
- **A real install-approval card**: plugin-specific icon (or a Marketplace mark) instead
  of the generic ADE "A"; the actual description/source/trust/Adds content that's
  already computed server-side (see bug #3) actually reaching the screen; a stated
  one-line reason *why* approval is being asked, useful for less experienced users
  encountering an unfamiliar plugin like Electron Control; a link to view the plugin in
  the Marketplace right from the card; buttons reading "Approve and install" / "Deny"
  rather than generic Accept/Accept all/Decline.
- **Per-control custom color**, not just per-plugin `accent` or a whole-app `theme`.
  Today an action-button payload (`toolbar-action`/`composer-action`/`chat-header-action`)
  has no color/tone field at all — a plugin can't even tint its own button without
  shipping a full theme that recolors the entire app. Panel components get a limited
  `tone` enum; buttons get none.
- **Further custom UI beyond `webview`** — `webview` is desktop-only and can't touch
  chrome like a header button, badge, or dropdown; it can only draw inside the plugin's
  own tab/pane. Something like "the button visually fills up like a glass as the count
  rises" is not buildable anywhere in the platform today; the nearest approximation is
  swapping label text or icon token, which is what Tipsy actually does.

## Reproduction facts (for engineers to re-verify quickly)

- Plugin source: `/Users/arul/plugins/ade-tipsy/` (this machine, untracked, outside this
  ADE lane, same pattern as the prior report's Tipsy source).
- Installed copy while under test: `/Users/arul/.ade-alpha/plugins/ade-tipsy/` (now
  removed — user uninstalled all six plugins at the end of this session).
- Chat session used for the live test: `e755df3f-5d72-4af7-87ba-c842ca8bd37c`.
- `ade plugin doctor ade-tipsy --text` mid-session (after the context.id fix, before the
  count reached 10):
  ```
  ✓ Source           the folder /Users/arul/plugins/ade-tipsy
  ✓ Installed here   version 0.1.0, turned on
  ✓ Running          the plugin's own process is up
  ✓ Places           chat-header-action in work; 1 row published right now
  – Panels           this plugin draws no panels
  ✓ In this project  1 place, 0 panels, 1 stored row
  ✓ Agent skills     1 skill · Affects agents from their next turn — running turns keep their current behavior.
  Renders on: desktop ✓ (chat-header-action) · web ✓ (chat-header-action) · iPhone ✓ (chat-header-action) · terminal ✗
  ```
- Post-uninstall database audit (all six plugins removed):
  `plugin_collections`, `plugin_contributions`, `plugin_panels` — all empty.
  `plugin_presence` — 4 stale rows (`ade-linear`, `ade-theme-ink`, `ade-theme-paper`,
  `ade-theme-contrast`), all `enabled: 1`, `updated_at` unchanged since 2026-08-14 (see
  bug #9).
- `ade plugin list --text` post-uninstall: `No plugins installed on this machine.`
  `state.json`: `{"version": 2, "plugins": {}}`. `~/.ade-alpha/plugins/` contains only
  cache/state files, no leftover per-plugin directories — on-disk cleanup for the
  install-registry side is correct.

## Relationship to the 2026-08-14 retrospective

This round resolved several of that report's sharpest complaints outright: the chat-header
socket and its dropdown now exist and worked as requested; branch/app provenance was
established up front and never caused confusion; the turn-boundary timing model was
demonstrated live rather than just asserted; and the beer icon rendered correctly on
desktop. What's new this round is a set of bugs that only show up once you actually
drive the thing end to end with real clicks and a real database query rather than
reading source and reasoning about it — the reload/source-divergence trap (#8) and the
stale presence rows (#9) in particular were only found by directly comparing installed
bytes against source bytes and directly querying sqlite, not by anything visible in the
UI or in `doctor`.
