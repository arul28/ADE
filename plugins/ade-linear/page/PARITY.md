# Linear page parity

What the plugin's page carries against ADE's compiled Linear, surface by surface,
and what it does not. **The gaps at the bottom drive the acceptance walk** — read
them before judging the page, because each one is a thing the owner will look for
and not find.

2.1.0 brings the page one-to-one with the compiled integration: the launch bug
below, the three chrome slots given back, the host pickers on the launch form,
and the Automations tile that replaced two settings toggles and a paste box.

Compiled sources this was measured against, all still in the binary:
`LinearIssueBrowser.tsx` (1,874), `LinearQuickViewButton.tsx` (814),
`LinearSection.tsx` (905), `BatchLaunchModal.tsx` (647), `linearBatchLaunch.ts`
(565), `LinearIssueBadge.tsx` (280), `LinearPaneModal.tsx` (172),
`LinearIssueSelectModal.tsx` (164), `BatchLaunchStatusToast.tsx` (164),
`UserMessageIssueContext.tsx` (125), `LinearIssueResolveModals.tsx` (25). Three
more are now shared rather than approximated: `LaneCombobox.tsx` (671),
`LaneDialogShell.tsx` (129) and `ChatAttachmentTray.tsx` (825) were ported into
`@ade-dev/ui` and the page draws the kit's copy.

## Placements

| Compiled placement | Page surface | Socket | Placement | State |
|---|---|---|---|---|
| Linear rail tab | `issues` | `work-rail-pane` | `tab` | Carried |
| Work-rail Linear pane | `issues` | `work-rail-pane` | `pane` | Carried (same surface) |
| Settings › Integrations | `settings` | `settings-section` | `settings-section` | Carried |
| Composer issue picker | `picker` | `composer-menu-item` | `composer-picker` | Moved into the menu |
| Chat-header issue verbs | `issue-context` | `chat-menu-item` | `popover` | Moved into the menu |
| Lane row-badge hover card | `badge-card` | `row-badge` | `popover` | Carried |
| Transcript issue context | `issue-context` | `chat-card` | chat card | Carried |
| Create-lane / Create-PR pickers | `dialog-picker` | `dialog-section` | `dialog-picker` | Carried |
| Automations trigger grid | — | `automation-trigger-tile` | tile | New |
| Automations templates gallery | — | `automation-template` ×2 | card | New |
| Top-bar quick view | — | — | — | **Removed** |

Every `webviewSurfaceId` a socket names resolves to a declared surface, and the
manifest parses with no errors and no warnings — checked against
`shared/plugins/manifest.ts` and `shared/plugins/sockets.ts` as shipped.

### The three chrome slots this release gives back

Each was a permanent slot in somebody's chrome, spent by one plugin, and every
plugin installed after Linear wanted the same one.

- **The top bar's Linear button and its quick view popover.** Gone entirely,
  surface and socket. The rail tab and the Work-rail pane are the issue list.
- **The chat header's Linear button and its dropdown.** Now a `chat-menu-item`
  under the chat menu's Issue context submenu, opening the `issue-context` page
  as a popover anchored to the row. All four verbs came with it: open in Linear,
  detach, attach, and the progress comment.
- **The composer's Linear bar button.** Now a `composer-menu-item`,
  "Attach a Linear issue", opening the same picker page it always opened.

`LinearQuickViewPanel.tsx` went with the quick view. The launch flow it held is
not the popover's and never was — the compiled Work-rail pane and the compiled
quick view both routed every 1..N launch through the same `BatchLaunchModal` —
so `useLinearBatchLaunch` moved to `src/lib/linearLaunchFlow.tsx` unchanged and
`BrowserEntry` is its one caller.

## One launch flow

The compiled Work-rail pane and the compiled quick view both routed every 1..N
launch through the same `BatchLaunchModal`, so the model, the kickoff prompt, the
branch and the lane target were configured once wherever the reader started. The
page keeps that: `useLinearBatchLaunch` is the shared flow and the tab hands it
its issues.

### The launch bug this release fixes

**The kickoff prompt was never said.** `flows.spawnAgentOnIssue` launched through
`chat.createSession` with an `initialMessage` beside the arguments — and
`AgentChatCreateArgs` has no message field of any kind, so the host dropped it
and every Linear launch created a silent chat. The CLI half was worse:
`chat.launchCli` names its kickoff `kickoffPrompt` and REFUSES a launch without
one, so `initialInput` failed the whole call.

Both now go through the verb the compiled Linear used
(`LinearQuickViewButton.tsx:412` → `window.ade.agentChat.launch` →
`agentChatService.launchHeadless`): `chat.launchHeadless` with `kickoffText`, and
`chat.launchCli` with `kickoffPrompt`. `launchHeadless` is the only chat verb
that both creates the session and RUNS the first turn — an interactive
`sendMessage` after a create only enqueues the turn until a chat pane mounts and
pumps the queue, which for a batch launch of lanes nobody opens is a kickoff that
never runs. A failed kickoff reaches the page as a `chat` host frame and moves
the row to `agent-error` with the host's own sentence, which is G1 below.

The duplicate guard keeps its two sentences apart. `findIssueConflicts` reads a
lane's own Linear attachment *and* the issues linked to sessions inside it, so
"Has lane" and "Has agent" mean what they say, and a session link wins when both
hold. Each now names the lane's worktree in its tooltip when the host reports one.

## The browser (`LinearIssueBrowser`)

Carried, moved rather than rewritten: the three-column layout; the state tabs
(All / Active / Backlog); the project, assignee, priority and sort filters; the
search box with its 220 ms debounce; the grouped list with collapsible state
groups and the flat list; infinite scroll on an `IntersectionObserver` with the
500-issue auto-load ceiling and the explicit "load more" past it; shift-click
range select; multi-select with the batch dock; the per-row action dock; the
conflict badges; the featured/pinned issue; the detail pane with the markdown
description, sub-issues, blockers, labels, properties and the Activity comments
disclosure; the branch-name preview; the empty, error and not-connected states;
every `data-linear-*` attribute; the 90-second read cache and its request-id
guards.

Changed on purpose:

- **Filters and selection** now live in the `ui-state` collection rather than
  `localStorage`, and load asynchronously. The component mounts on the defaults
  and hydrates, guarded by a request counter (a slow read for the previous
  project cannot land on the new one) and a write counter (a hydrate cannot
  clobber a filter the reader changed while it was in flight).
- **The read cache** is keyed on the project root alone. It was keyed on the
  root plus the identity of the `window.ade.cto` object, which had exactly one
  possible value inside a guest.
- **Code blocks** in a description render as plain `<pre><code>` rather than
  through Shiki. The highlighter is a renderer component with its own worker; a
  guest cannot reach it. Same box, same metrics, no syntax colour.

Added, because the plugin's own vocabulary panel (`panels/issue.js`) has them and
the compiled browser does not — losing them would have made 2.0.0 a regression
against 1.2.0: the detail pane's **state**, **priority**, **Assign to me** and
**Comment** controls, using the panel's own copy.

## The launch form

Every control is one of the HOST's pickers now — `ui.pickProvider()`,
`ui.pickModel()`, `ui.pickReasoningEffort({provider, model})`,
`ui.pickPermissionMode({provider})` and `ui.pickLane()` — drawn as a chip that
prints the choice and opens the app's own popover over the page. Fast mode stays
a toggle, because it is a boolean and not a list.

That closes the last two gaps the page shipped with, G4 and G5, and it closes
them by DELETING the page's copy rather than by improving it: the model list,
the lane list, a provider's permission vocabulary and a model's reasoning ladder
are ADE's facts, and every plugin that redrew them drew a control that looked
almost like the app's and drifted from it on the next release. `ModelPicker`'s
recents, grouping and per-provider icons come for free, because it IS
`ModelPicker`.

Two consequences worth naming:

- **The form seeds no model.** It used to pick the first Claude row of a catalog
  it fetched itself. The host's picker owns that default, so the Launch button
  is disabled until the reader chooses, with a sentence saying so — rather than
  a press that silently skips the row.
- **The provider comes from the picker, not from the model id.** A model
  answered by `ui.pickModel()` names the provider it belongs to.
  `resolveLaunchProviderAndModel`, which derived it from the catalog, is now the
  fallback for a host that answers no picker verb.

The clipboard toggle moved INTO the form, beside the prompt it copies: it is
still the plugin's own `launchPromptClipboard` setting, written through
`config.set` so it is remembered between launches, and it is no longer in the
settings section two screens from the only act it affects.

## The settings section

Carried: the connection card and its expiry, last-read and last-error rows, the
identity card, the projects list, the API-key form, the GitHub autolinks block,
and the default-team control.

Changed on purpose, and this is the card's whole shape now — connection, GitHub
reference links, one line pointing at Automations:

- **The two issue-transition toggles are deleted.** `moveToStartedOnLaunch` and
  `moveToDoneOnMerge` are gone from the manifest, from the panel and from the
  page. Each is an `automation-template` instead, so the rule that rewrites a
  ticket other people read is one the reader can see, name and switch off — not
  a checkbox on another screen. The launch no longer moves an issue as a side
  effect, and the plugin no longer subscribes to `pr.changed` at all.
- **The clipboard toggle moved to the launch form.** See above.
- **The webhook block moved to Automations.** The endpoint, its signing secret
  and its delivery ledger are the `automation-trigger-tile`'s, whose own
  `statusAction` answers them. What is left here is one line saying where they
  went and whether anything is registered yet.

Changed on purpose: **OAuth does not poll.** The compiled section started a
session and polled `getLinearOAuthSession` every 1.5 s. The plugin's sign-in is
host-driven — the action answers `{authSession}`, the host opens it, and the
child settles it on its own `auth.completed` — so the page awaits one call and
then refetches. The compiled five-minute give-up and its sentence are kept as a
timeout rather than a poll.

## The gaps

**G1 — a failed kickoff turn shows "Ready".** Carried. `host.subscribe` takes a
`chat` kind whose coalesced frames carry `turns[]` of `{sessionId, state,
message}`, and `BatchLaunchAgentReadinessTracker.observeChatTurn` reads them: a
`failed` state moves the row to `agent-error` with the host's own sentence. The lane/session
inference stays as the fallback for a host that reports no chat frames, and the
chat frame outranks it — the tracker keeps its session→issue mapping after an
inferred "Ready" precisely so a failure arriving seconds later can correct it.
An `overflow` frame carries no turns at all and is ignored: a batch big enough
to overflow cannot say which of its kickoffs failed, and a row left where the
inference put it beats one told a state no frame reported.

**G2 — no reroute to the lane stack after a launch.** Carried, through
`ade://lane/<id>?drawer=stack`. The compiled panel routed to `#/lanes?drawer=stack`,
a renderer route that names a TAB; a deeplink names a lane, so the reroute fires
at the end of the launch once a lane exists, on the first one created.

**G3 — the project-picker button is inert.** Carried, through `ade://welcome`.

**G4 — no per-provider permission control on the launch form.** CLOSED by
deletion: the control is `ui.pickPermissionMode({provider})`, which is the app's
own popover rather than a select this page keeps in step. The paragraphs below
describe the shape it replaced, and the field rule at the end of them still
holds — the value a reader picks is the provider's NATIVE one and goes in the
argument that provider's `permissionField` names.

`sdk.chat.capabilities()` was the whole source: it answers the permission
vocabulary per provider and fast mode plus the reasoning ladder per model, so
`pageModels` no longer guesses a provider from a model id's prefix and
`pageCapabilities` keeps no option table of its own. The form draws the
provider's own list, a fast toggle only for a model that has the tier, and the
model's own reasoning rungs — an empty ladder draws no picker rather than
falling back to none/low/medium/high. Deprecated models are dropped, and the
read is cached because it is static for the life of an app version.

The value a reader picks is the provider's NATIVE one and goes in the launch
argument that provider's `permissionField` names — `claudePermissionMode`,
`droidPermissionMode`, `cursorModeId`, `opencodePermissionMode`, and the unified
`permissionMode` only for Codex, whose options are presets. Sending Claude's
`acceptEdits` as `permissionMode` would be refused, which is why the field is
copied from the capability rather than kept as a table here.

The control is the host's picker for every provider, so Claude, Codex and the
other three share one chip that opens ADE's own popover. Recents, grouping and
per-provider icons come with `ui.pickModel()` because it *is* `ModelPicker`.

**G5 — the lane picker is a native `<select>`.** CLOSED by deletion. It was a
select, then the kit's `LaneCombobox` over a lane list this page fetched, and it
is `ui.pickLane()` now — the app's own picker over the app's own lanes, so the
two can no longer disagree about which lanes exist or what one is called. The
form still reads `pageLanes` for the duplicate guard and to know whether
"Existing lane" is a real option; the project's primary lane is excluded there,
as the compiled picker excluded it.

**G6 — the transcript pane draws only the Linear chip.** The tray itself is
carried: `AttachmentTray` and `IssueAttachmentChip` are the compiled markup in
`@ade-dev/ui/attachments`, and the pane draws the kit's copy, so the app's
composer and this pane can no longer drift. The kit carries the rest of the set
beside them — the file chip, the image thumbnail and its copy affordance, the
pending-image preview, the image-URL chip, the orchestration-annotation chip and
the GitHub brand of the issue chip.

What the PANE still draws is only the Linear chips, and the reason is data rather
than markup: a transcript's file refs, staged images and annotations are the
renderer's own state, and the only fact a guest can read about a past turn is
which Linear issues were linked to its session. The GitHub chips are another
plugin's to draw. *Needs: a bridge read of a turn's own attachments.*

**G7 — the launch-prompt clipboard toggle is gone.** Carried. It is the plugin's
own `launchPromptClipboard` setting, defaulting on as the app preference did,
and its toggle is in the LAUNCH FORM beside the prompt it copies rather than in
the settings section — the only prompt it copies is a Linear kickoff, and a
switch two screens from the act it governs is a switch nobody finds. It writes
through `config.set`, so it is remembered between launches.

**G8 — the launch dialog has no border beam.** Carried. `LaneDialogShell` is in
`@ade-dev/ui/dialog` with its Radix dialog and its `BorderBeam` at the same size,
variant, duration, strength and radius, and the launch modal draws it.

**G9 — three connected-card rows the compiled design has no slot for.** Carried.
`pageConnection` answers `expiresIn`/`expired` (from the same `expiry` the
settings panel prints) and already carried `checkedAt` and `message`. The
connected card draws those three in the bordered row the workspace row
established. `lastEvent`, `pendingDeliveries` and `drainError` belong to the
Automations tile; Settings only repeats whether a webhook is registered, and
the last event when one is.

**G10 — `PageLane.path` is always null.** Carried. `PluginLaneSummary` carries
`path`, and the launch modal's conflict tooltip names it. Null means the host
has no local worktree for the lane — a remote binding, or one not created yet —
and every reader hides the line rather than drawing an empty one.

**G11 — some issue fields are thinner than the compiled ones.** Carried.
`ISSUE_FIELDS` takes `project { slugId }` and `inverseRelations`, so `projectSlug`
is Linear's own slug (falling back to the name-derived one only when a workspace
answers none), and `blockerIssueIds` / `hasOpenBlockers` are real —
`inverseRelations` of type `blocks` are the issues standing in the way, and open
means neither completed nor canceled. `cycleId` is carried. The projects and
teams queries ask for `priority`, the two count histories, `color`, `issueCount`,
`cyclesEnabled` and `private` in a WIDE selection with the original as a
fallback, so a workspace whose schema refuses one still gets its projects, its
teams and its workflow states.

**G12 — the Create-lane and Create-PR dialog pickers are not carried.** Carried.
Two `dialog-section` sockets point at a `dialog-picker` surface, discriminated by
the `dialog` field; the entry draws the browser inline and answers
`dialog.submit({ issue })`, reading which dialog it is in from
`context.subject.dialog`. It draws no Cancel: the dialog around it has one, and
`dialog.cancel` does not exist — clearing is `submit({ issue: null })`.

**G13 — a badge card opened with only an issue id cannot resolve.** Carried.
`pageIssueById` reads the stored row and then fetches the single issue from
Linear, neither of which needs a key, and the card asks it first.

**G14 — the settings section reports its height two ways, and neither is a
bridge verb.** Carried. `ui.resize` is the only height channel; the document
write and the `ade:plugin-webview-height` frame are both gone, and
`host/ui.ts:reportHeight` clamps and delivers for all four content-sized
surfaces.

**G15 — the manifest's `webviewSurfaceId` and `openWebview.placement` are inert
until the desktop placements land.** Carried. The manifest parses with no errors
or warnings, all thirteen sockets survive, and every `webviewSurfaceId` resolves
to a declared surface — checked against `shared/plugins/manifest.ts` and
`shared/plugins/sockets.ts` as shipped, in
`renderer/components/plugins/adeLinearWebviewSockets.test.ts`.

`openWebview` is gone from the actions, and its absence is the point. A socket
that declares `webviewSurfaceId` now opens the page BY ITSELF and never invokes
its action, so `openIssuePicker` and `openSessionIssue` run only on a client that
hosts no page — and an `openWebview` answer there would be a second open of a
surface already up, closing the first. Each answers `navigate` alone now, and
`test/index.test.js` walks every action a page-declaring socket names so an
`openWebview` that grows back fails there.

## Automations

New in 2.1.0, and the reason two settings toggles and a paste box could go.

**The trigger tile.** One `automation-trigger-tile` replaces the generic Plugins
tile in the Automations trigger grid: the five triggers as radios, and five
declarative filters — project, team, assignee, label and state — each a select
bound to one of this plugin's own collections. `labels` is a new collection,
read with the catalog, for exactly that filter: a picker cannot be a picker over
rows nothing stores.

**One-press Register.** The tile's `webhook` block names two actions,
`webhookStatus` and `registerWebhook`. Registering generates a 32-byte secret,
creates the workspace webhook through the Linear API on the authorization the
reader already granted, and stores the secret in the same act. That order is not
a preference: Linear shows a webhook's signing secret once, at creation, and the
host FAILS CLOSED on a channel whose secret it cannot find — so a hook this
plugin did not create is rotated rather than adopted, because adopting it would
register silence. An API-key connection is refused before anything is spent at
Linear, in the sentence that names the fix: Linear delivers a data-change
webhook only to an authorization carrying `admin`, and an API key carries no
OAuth grant at all. A port of `linearIngressService.ts:288`, whose flow this is.

**Two templates.** `automation-template` × 2, replacing the deleted toggles: a
`lane.created` rule that moves the lane's Linear issues to the team's first
started state (`stepStartIssueOnLane`, a new step), and a `github.pr_merged` rule
that moves a merged lane's issues to Done (`stepCloseIssueOnMerge`, which existed
and is no longer gated on a setting). Both pass `{{trigger.laneId}}`.
