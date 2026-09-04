# History page parity

What the plugin's page carries against ADE's compiled History, surface by surface,
and what it does not. **The gaps at the bottom drive the acceptance walk** — read
them before judging the page, because each one is a thing the owner will look for
and either find, or find deliberately absent.

Compiled sources this was measured against, all still in the binary:
`HistoryPage.tsx` (592), `TimelineToolbar.tsx` (724), `historyLaneActions.ts`
(647), `useTimelineStore.ts` (470), `EventDetailPanel.tsx` (441),
`historyGitActions.ts` (423), `CommitHistoryView.tsx` (401),
`CommitDetailPanel.tsx` (368), `TimelineGraph.tsx` (230), plus
`TimelineListView.tsx`, `TimelineCompactView.tsx`, `TimelineRow.tsx`,
`EventNode.tsx`, `LaneTrack.tsx`, `WIPRow.tsx`, `ConnectorLine.tsx`,
`HistoryGitContextMenu.tsx`, `commitGraphLayout.ts`, `historySearch.ts`,
`historyUrlHydration.ts`, `historyActivitySources.ts`, `eventTaxonomy.ts`,
`useTimelineLayout.ts`, `timelineTypes.ts`. Two more are shared rather than
approximated: `EmptyState` and `LaneIcon` were ported into `@ade-dev/ui` and
the page draws the kit's copy. The git DAG runs inside the guest; the host
`git-dag` canvas engine is not this page's to delete.

## Placements

| Compiled placement | Page surface | Socket | Placement | State |
|---|---|---|---|---|
| History rail tab | `commits` | — (surface `order`) | `tab` | Carried |
| Command palette "Go to History" | `commits` | `command-palette-action` | route | Carried |
| Activity toggle (in-page) | `commits` / `activity` | — | in-page | Carried |
| Phone | — | — | panel fallback | **Later** (G1) |

**One surface, one rail tab, one palette row** — because that is what the
compiled product was: a `/history` route whose toolbar carried a Commits /
Activity toggle, and one "Go to History" row in ⌘K that navigated to it.

The page tier's first pass grew a second `activity` webview surface and a
Work-rail pane the compiled History never had. Both are gone. They were not
shortcuts into History; they were three Historys — three rail entries, three
`ui-state` rows, three copies of the same DAG, each remembering a different
commit. The `activity` PANEL stays, because iOS and the terminal draw panels
and that is the vocabulary they reach the operation ledger through.

The palette row declares **no** `webviewSurfaceId`, and that is load-bearing.
`usePluginPaletteCommands` opens a row that declares one as a focused OVERLAY
rather than invoking it — reasonable for a plugin whose page belongs nowhere,
wrong for History, which is a tab. Declaring none makes the row invoke
`openCommits`, which answers `{navigate:{panelId:"commits"}}`, which
`navigateToAppTarget` turns into the rail route. Same address as the rail
click, same Back behaviour, no modal.

The manifest parses with no errors and no warnings — checked against
`shared/plugins/manifest.ts` and `shared/plugins/sockets.ts` as shipped, and
asserted in `test/publish.test.js`.

`parseSurfaces` forbids `mobile: true` on a `webview`. The surface is
`mobile: false`. Wave-2 phone scope is Linear and Cursor Cloud; History is later.
iOS and the TUI keep drawing the `panelId` panels (`commits` list, `commit`
detail, `activity` list, `event` detail).

## The page (`HistoryPage.tsx`)

Carried, moved rather than rewritten: the Commits / Activity toggle; the commit
DAG with its virtualized rows, search, branch labels, HEAD chip and context
menu; the operations timeline in graph / list / compact; the toolbar (scope,
status, time range, lane chips, export); the commit detail (message, files,
related operations, git verbs); the event detail (metadata, View commit, Open
work, Open lane); every git verb the compiled context menu had (cherry-pick,
revert, reset, create branch / lane / tag, stash, fetch / pull / push, rebase
and merge continue/abort).

Changed on purpose:

- **Lanes** come from `pageLanes` plus `host.subscribe` kind `lane`, rather than
  `useAppStore`. A guest has no store. The lane History draws is the compiled
  ladder — the lane the host named on the envelope, then the reader's stored
  lane, then the first listed — rather than `lanes[0]` outright, and a lane
  frame that removes the focused lane re-resolves it instead of leaving the git
  menu pointed at a worktree that is gone. See G6 for what the host does not
  say.
- **Every `window.ade.*` call** is one function in `host/actions.ts`. Two
  fan-outs happen in the child so the page pays one round trip:
  `pageCommitGraph` (was `listRecentCommits` + `listBranches`) and
  `pageCommitDetail` (was getCommit + getCommitMessage + listCommitFiles).
  `pageCommitLookup` is the selected-commit check that used to walk the recent
  list and then `getCommit` / `isCommitInLaneHistory`.
- **The selected surface, lane, commit, event and detail width** live in the
  `ui-state` collection rather than in the renderer route and
  `react-resizable-panels` layout id, and load asynchronously. The page mounts
  on the defaults and hydrates; a focus named by `context` outranks the stored
  one, so a page the host opened AT a commit never lands on last week's event.
  The row is keyed `history:<root>:<placement>`, because a rail tab and an
  overlay are two windows onto the same history and each remembers its own
  place. `surfaceId` alone is NOT a focus: it rides on every envelope, so
  trusting it made the stored surface unreachable — it counts only beside a
  pointer or a subject, which is the host actually asking for something.
- **The split is a flex row with a drag handle**, not `PaneTilingLayout` /
  `react-resizable-panels`. The library is a renderer dependency with its own
  window-level listeners; the clamps (280–720px) and the persistence are the
  compiled ones. `PaneTilingLayout`'s 24px pane title bars are drawn by hand —
  "Commit graph" / "Timeline" on the left, "Commit" / "Event detail" on the
  right — and the right pane has an empty state, because two panels that render
  nothing when nothing is selected read as a page that failed to load. The
  width is written to `ui-state` once per drag, on release, not once per
  pointer frame.
- **The keyboard map is the page's own**: `G` `H` returns to the commit graph
  with nothing selected, Escape closes the detail, `Mod+[` closes it too — the
  host's own Back accelerator, which a guest sees and the host does not. See G7.
- **No timer.** The compiled page polled the operation ledger every 4s while
  something was running, because a renderer had no other way to hear that it
  moved. A guest has `host.subscribe`: the `operation` frame refetches, and the
  window `focus` / `visibilitychange` handlers stay. A timer here never stood
  down, since `active` is hard-true for a page.
- **Navigations became deeplinks.** `navigate("/lanes?laneId=…")` is
  `ade://lane/<id>`; a commit is `ade://commit/<sha>?lane=…`; "Open work" is the
  same lane deeplink. A guest cannot push a renderer route. In-page
  `/history?surface=…` stays in-page.
- **Toasts and confirms** are `ui.toast` / `ui.confirm`, ADE's own stack above
  the guest.
- **Supplemental activity** (chats + CTO snapshot) is `pageActivitySupplement`,
  one round trip, rather than `window.ade.agentChat.list` plus `cto.getState`.
- **List-view icons** are a closed map of the names `eventTaxonomy.ts` writes,
  not `import * as PhosphorIcons`. The compiled list looked the names up on the
  whole Phosphor namespace; a guest that does the same inlines every icon the
  package publishes. Same glyphs, a page that loads.

## The phone and the terminal

Unchanged, and that is the point. `parseSurfaces` forbids `mobile: true` on a
`webview`, so the surface is `mobile: false` and every non-desktop client
renders the `panelId` panel instead. The `commits` panel (the git-dag canvas
bound to the collection), the `commit` panel (detail + git verbs), `activity`
and `event` all still publish from `index.js`, and nothing was trimmed from
them: the page took over no drawing the panels were doing, so there was nothing
to remove. History remains the first History UI iOS and the TUI have ever had.

## The gaps

**G1 — no phone canvas.** `mobile: true` on a webview is illegal (`parseSurfaces`
warns; `pilotPackages` fails). Wave-2 phone scope is Linear + Cursor Cloud.
iOS draws the vocabulary `commits` / `activity` panels. History on the phone is
a later wave.

**G2 — "Inspect on lane (git pane)" is `ade://commit/<sha>?lane=<id>`.** The
compiled verb routed to `/lanes?laneId=…&focus=single&commitSha=…`, which is
the Lanes tab's git pane. `shared/deeplinks.ts` does not parse `focus=single`.
The shipped commit target opens the same commit; it does not open the Lanes git
pane. Written up rather than minted as a URL the host would refuse.

**G3 — `/prs` (no owner / repo / number) has no deeplink.** A press that only
knew "there is a PR" and not which one is omitted. Open-PR-for-branch still
goes to the GitHub URL the origin remote names.

**G4 — the selected lane is not ADE's `ui.pickLane`.** The compiled toolbar was
a native `<select>` over the project's lanes, and the page keeps that: History
is choosing which lane's DAG to draw, not launching into one. The host picker
is available and unused here on purpose — a picker that can exclude the
primary and search recents is the wrong control for "which of these lanes am I
looking at".

**G5 — no live pty for a rebase in flight.** The compiled History never
streamed one either: rebase progress on this tab was the operation ledger.
Carried. (`pageOperations` plus the `operation` host event.)

**G6 — the host tells a tab webview no subject.** `PluginTabPage` renders
`PluginWebviewHost` with a placement and a surface id and nothing else, so the
lane selected in Lanes or Work does not reach a page opened from the rail, and
neither does a `ade://plugin/ade-history/commits?ctx=…` deeplink's context. The
ladder above reads the subject the moment the host passes one; until the host
does, the rail tab falls to the reader's stored lane. Host-side, not this
package's to fix.

**G7 — `G` `H` is a page chord, not the palette's chip.** The compiled palette
row advertised the shortcut and the product answered it. A plugin cannot
declare it: `parsePluginChord` refuses anything with whitespace in it, because
the desktop matcher has no notion of a prefix key and a binding only half the
clients can honour is refused on all of them. So the page answers `G` `H`
itself, and it works whenever History has focus — which is when a reader would
press it. The ⌘K row therefore draws no shortcut chip.

**G8 — no `ui.toast` on a read failure.** A commit-graph or operations read that
fails sets the page's empty-state error, as the compiled page did. Mutations
that git refused answer `{ok:false, message}` and the toolbar / detail draws
that sentence. A toast would be a second, quieter place for the same words.
