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
`UserMessageIssueContext.tsx` (125), `LinearIssueResolveModals.tsx` (25).

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
| Transcript issue context | `issue-context` | chat card | Carried, reduced (see G6) |
| Create-lane / Create-PR pickers | — | — | **Not carried (G12)** |

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
hold.

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
treatment, and closing itself after a single successful launch.

## The settings section

Carried: the connection card, the identity card, the projects list, the API-key
form, the GitHub autolinks block, the three preference toggles (through
`config.get`/`config.set`), and the webhook block with the plugin's own wording.

Changed on purpose: **OAuth does not poll.** The compiled section started a
session and polled `getLinearOAuthSession` every 1.5 s. The plugin's sign-in is
host-driven — the action answers `{authSession}`, the host opens it, and the
child settles it on its own `auth.completed` — so the page awaits one call and
then refetches. The compiled five-minute give-up and its sentence are kept as a
timeout rather than a poll.

## The gaps

Each of these is a real difference the owner can see. None is papered over.

**G1 — a failed kickoff turn shows "Ready".** The compiled quick view followed
`window.ade.agentChat.onEvent` and moved a launched issue to `agent-error` on an
`error`, a `status: failed` or a `done: failed`. The bridge has no agent-chat
event stream, so the page moves `initializing-agent` → `done` on a host lane or
session change and can never draw the error state. *Needs: a `chat` or `session`
kind on `host.subscribe`, or an agent-chat event on the bridge.*

**G2 — no reroute to the lane stack after a launch.** The compiled panel sent the
reader to `#/lanes?drawer=stack`. There is no deeplink for a tab plus a drawer,
so a single launch closes the popover and a batch keeps it open behind the toast.
*Needs: a lanes deeplink that can name a drawer.*

**G3 — the project-picker button is inert.** It called `setShowWelcome(true)` and
navigated to `#/work`; neither has a deeplink. It dismisses and does nothing
else. *Needs: a deeplink for the project picker.*

**G4 — no per-provider permission control on the launch form.** The compiled
`BatchLaunchModal` drew the native Claude / Codex / Cursor / Droid / OpenCode
permission pill. `pageLaunchAgent` accepts one `permissionMode` string, so the
whole control is gone, and **fast mode is gone with it** — it is a model-registry
fact the page cannot read. Reasoning effort is offered as a fixed
none/low/medium/high ladder rather than the registry's per-model list.

**G5 — the lane picker is a native `<select>`.** `LaneCombobox` is 671 lines of
renderer component with its own search and keyboard model; the page offers a
plain select over the same lanes. It does filter out the project's primary lane,
as the compiled picker did.

**G6 — the transcript pane draws only the Linear chip.** `ChatAttachmentTray`
carries file refs, pending images, image-URL chips and orchestration
annotations, and `useChatRuntimeScope` pins the machine. All of that is renderer
state a guest cannot see. The GitHub half is another plugin's.

**G7 — the launch-prompt clipboard toggle is gone.** It read
`useAppStore(s => s.launchPromptClipboardEnabled)`, an app preference; the
plugin declares no matching setting.

**G8 — the launch dialog has no border beam.** `LaneDialogShell` is built on
`@radix-ui/react-dialog`; the page rebuilds it as a portal with a backdrop and
Esc, with identical classes, minus the animation.

**G9 — three connected-card rows the compiled design has no slot for.**
`expiresIn` / `expired`, `lastSyncAt` and `lastError`, plus the webhook panel's
"Last event", "Waiting (unacked)" and "Drain" rows, are in the plugin's
vocabulary panel and not in the page. *Needs: `pageAutolinks` and
`pageConnection` to carry them, and a place in the compiled design to put them.*

**G10 — `PageLane.path` is always null.** `PluginLaneSummary` is a fixed
allowlist that excludes the worktree path, so nothing in the page can show where
a lane lives on disk.

**G11 — some issue fields are thinner than the compiled ones.**
`projectSlug` is derived from the project name (the shared GraphQL selection
takes `project { id name }`); `blockerIssueIds` and `hasOpenBlockers` are always
empty and false; `cycleId` is null; and a quick-view project's
`priority`/`issueCount`/`completedIssueCount` and a team's
`color`/`issueCount`/`cyclesEnabled`/`private` are null. *Needs: a wider
selection in `linearApi.js`.*

**G12 — the Create-lane and Create-PR dialog pickers are not carried.** They are
`dialog-section` sockets over ADE's own dialogs, and the page tier has no dialog
placement. They stay on the vocabulary panel.

**G13 — a badge card opened with only an issue id cannot resolve.** The card
looks the issue up by KEY (`searchIssues({query})`). A row-badge pointer that
carries an id and no key anywhere on the lane row draws "No Linear issue on this
lane."

**G14 — the settings section reports its height two ways, and neither is a
bridge verb.** It writes the measured height onto `documentElement.style.height`
and posts an `ade:plugin-webview-height` message. *Needs: a height verb on the
bridge, or a host that measures the document.*

**G15 — the manifest's `webviewSurfaceId` and `openWebview.placement` are inert
until the desktop placements land.** The manifest and the actions declare both;
the renderer that draws a popover, a settings-section guest and a composer picker
is Wave 1 work in flight. Until it lands, every socket falls back to its
`panelId` and the page is reachable only as the rail tab.
