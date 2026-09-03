# Linear page parity

What the plugin's page carries against ADE's compiled Linear, surface by surface,
and what it does not. **The gaps at the bottom drive the acceptance walk** — read
them before judging the page, because each one is a thing the owner will look for
and not find.

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

| Compiled placement | Page surface | Placement | State |
|---|---|---|---|
| Linear rail tab | `issues` | `tab` | Carried |
| Work-rail Linear pane | `issues` | `pane` | Carried (same surface) |
| Top-bar quick view | `quickview` | `popover` | Carried |
| Settings › Integrations | `settings` | `settings-section` | Carried |
| Composer issue picker | `picker` | `composer-picker` | Carried |
| Chat-header issue picker | `picker` | `composer-picker` | Carried |
| Lane row-badge hover card | `badge-card` | `popover` | Carried |
| Transcript issue context | `issue-context` | chat card | Carried |
| Create-lane / Create-PR pickers | `dialog-picker` | `dialog-picker` | Carried |

Every `webviewSurfaceId` a socket names resolves to a declared surface, and the
manifest parses with no errors and no warnings — checked against
`shared/plugins/manifest.ts` and `shared/plugins/sockets.ts` as shipped.

## One launch flow

The compiled Work-rail pane and the compiled quick view both routed every 1..N
launch through the same `BatchLaunchModal`, so the model, the kickoff prompt, the
branch and the lane target were configured once wherever the reader started. The
page keeps that: `useLinearBatchLaunch` is the shared flow, and the tab and the
popover both hand it their issues. The status toast portals to `document.body` in
the tab and renders inline in the popover, which is the only difference.

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

## The quick view

Carried: the panel header, search, nav verbs, the resize handle, the list, the
launch flow, the batch-launch modal, the status toast, the launched-lane
treatment, closing itself after a single successful launch, the reroute to the
lane stack after a launch, and the project-picker button.

## The settings section

Carried: the connection card and its expiry, last-read and last-error rows, the
identity card, the projects list, the API-key form, the GitHub autolinks block,
the four preference toggles (through `config.get`/`config.set`), and the webhook
block with the plugin's own wording and its three delivery-ledger rows.

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

**G4 — no per-provider permission control on the launch form.** Carried.
`sdk.chat.capabilities()` is the whole source: it answers the permission
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

Remaining, and small: the control is ONE shape for every provider (a select
wearing the compiled trigger chrome) rather than a popover menu for Claude and
Codex and a select for the other three, and the per-option detail sentences are
`title` text rather than menu subtitles. The compiled `ModelPicker`'s recents,
grouping and per-provider icons did not move either — the model control is a
select over the same list.

**G5 — the lane picker is a native `<select>`.** Carried. `LaneCombobox` is in
`@ade-dev/ui/lanes`, markup for markup, and the launch form draws it. It still
filters out the project's primary lane, as the compiled picker did. One
difference: the popover's entrance is the stylesheet's own `ade-popover-in`
keyframe rather than the framer-motion spring, because the kit takes no motion
dependency; `PageLane` also carries no lane colour, so a row's mark is the
default rather than the lane's.

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
own `launchPromptClipboard` setting now, defaulting on as the app preference did,
with its toggle in the settings section and its read in the launch flow.

**G8 — the launch dialog has no border beam.** Carried. `LaneDialogShell` is in
`@ade-dev/ui/dialog` with its Radix dialog and its `BorderBeam` at the same size,
variant, duration, strength and radius, and the launch modal draws it.

**G9 — three connected-card rows the compiled design has no slot for.** Carried.
`pageConnection` answers `expiresIn`/`expired` (from the same `expiry` the
settings panel prints) and already carried `checkedAt` and `message`;
`pageAutolinks` answers `lastEvent`, `pendingDeliveries` and `drainError` from
the host's delivery ledger. The connected card draws the first three in the
bordered row the workspace row established, and the webhook block draws the
other three beside its Verification row.

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
or warnings, all eleven sockets survive, and every `webviewSurfaceId` resolves to
a declared surface — checked against `shared/plugins/manifest.ts` and
`shared/plugins/sockets.ts` as shipped.

`openWebview` is gone from the actions, and its absence is the point. A socket
that declares `webviewSurfaceId` now opens the page BY ITSELF and never invokes
its action, so `openIssuesQuickView` and `openIssuePicker` run only on a client
that hosts no page — and an `openWebview` answer there would be a second open of
a surface already up, closing the first. Each answers `navigate` alone now, and
`test/index.test.js` walks every action a page-declaring socket names so an
`openWebview` that grows back fails there.
