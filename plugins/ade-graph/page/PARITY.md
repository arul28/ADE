# Graph page parity

What the plugin's page carries against ADE's compiled Graph, surface by surface,
and what it does not. **The gaps at the bottom drive the acceptance walk** — read
them before judging the page, because each one is a thing the owner will look for
and either find, or find deliberately absent.

Compiled sources this was measured against, all still in the binary:
`WorkspaceGraphPage.tsx` (the canvas), `graphNodes/LaneNode.tsx`,
`graphNodes/PluginNode.tsx`, `graphNodes/ProposalNode.tsx`,
`graphEdges/RiskEdge.tsx`, `graphDialogs/ConflictPanel.tsx`,
`shared/RiskMatrix.tsx`, `shared/RiskTooltip.tsx`, `graphLayout.ts`,
`graphHelpers.ts`, `graphPrData.ts`, `pluginGraphNodes.ts`, `graphTypes.ts`.
React Flow runs inside the guest; the host workspace engine is not this page's
to delete.

## Placements

| Compiled placement | Page surface | Socket | Placement | State |
|---|---|---|---|---|
| Graph rail tab | `graph` | — (surface `order`) | `tab` | Carried |
| Command palette "Graph" | `graph` | `command-palette-action` | `tab` | Carried |
| Lane popover | `lane` | — | `popover` | Carried (same canvas, focused) |
| Phone sheet | — | — | panel fallback | **Later** (G1) |

Every `webviewSurfaceId` a socket names resolves to a declared surface, and the
manifest parses with no errors and no warnings — checked against
`shared/plugins/manifest.ts` and `shared/plugins/sockets.ts` as shipped.

`parseSurfaces` forbids `mobile: true` on a `webview`. Both surfaces are
`mobile: false`. Wave-2 phone scope is Linear and Cursor Cloud; Graph is later.
iOS and the TUI keep drawing the `panelId` panels (`graph` list, `lane` detail).

The palette socket declares `webviewSurfaceId: "graph"`. A socket that names a
surface opens the page BY ITSELF and never invokes its action on a host that
draws pages, so `openGraph` runs only on a client that hosts no page — and an
`openWebview` answer there would be a second open of a surface already up. It
answers `{navigate:{panelId:"graph"}}` alone.

## The canvas (`WorkspaceGraphPage`)

The canvas is one stacked DAG: search, Filters overlay, Reset view, drag to
reposition (reparent is menu-only), the context menu, the appearance editor, the
conflict panel, the batch dock, the create-child and create-PR prompts, the
merge-simulation card, the minimap, PR overlays on lane cards, and contributed
`graph-node` sockets. View-mode tabs, the overlap web, the pair matrix, the
environments overlay, and drag-to-reparent were removed on purpose.

Changed on purpose:

- **Lanes and the "something moved" signal** come from `pageLanes` plus
  `host.subscribe` kinds `lane`, `pr`, `conflict`, `operation`, rather than
  `useAppStore`. A guest has no store.
- **Every `window.ade.*` call** is one function in `host/actions.ts`. Two
  fan-outs happen in the child so the page pays one round trip:
  `pageSyncStatuses` (was N `git.getSyncStatus` calls) and `pagePrDetail`
  (was four PR reads).
- **Navigations became deeplinks.** `navigate("/lanes?laneId=…")` is
  `ade://lane/<id>`; a PR is `ade://pr/<owner>/<repo>/<number>`. A guest cannot
  push a renderer route.
- **Toasts and confirms** are `ui.toast` / `ui.confirm`, ADE's own stack above
  the guest.
- **Contributed nodes** come from `bridge.sockets.list("graph-node")`, not the
  renderer's plugin registry. An older host lists nothing and the canvas draws
  ADE's own nodes, which is the graph that host could draw anyway.

## The gaps

**G1 — no phone canvas.** `mobile: true` on a webview is illegal (`parseSurfaces`
warns; `pilotPackages` fails). Wave-2 phone scope is Linear + Cursor Cloud.
The page still carries a list subtree (`LanePhoneList`) for a narrow pane/drawer
on desktop; iOS draws the vocabulary `graph` panel. Graph on the phone is a later
wave.

**G2 — the PR inspector is a compact card, not `PrDetailPane`.** The compiled
graph opened the PRs tab's own detail view (files, threads, checks, timeline,
merge box) in a modal over the canvas. Porting it would have meant porting the
PRs tab into this plugin. The card carries the verdict and the two verbs —
submit a review, land it — and "Open in PRs" is the rest, as a deeplink.

**G3 — rebase progress is the operation ledger, not a pty stream.** The compiled
page streamed `window.ade.pty.onData` / `.onExit` for a rebase console. A guest
has no pty. Progress is `pageOperations` plus the `operation` host event, which
is why that kind exists on this page.

**G4 — the inspector lists issue chips and a chat count, not live agent names.**
`LaneAgentList` was fed by `useLaneAgents`, which subscribes to the renderer's
session store. A guest has none. The selected-lane inspector shows attached
Linear issues from `issueLinks` / `primaryIssue` and an ongoing-chat count from
the operation ledger. Per-agent names are a later read.

**G5 — two compiled navigations have no deeplink.** `/prs?tab=integration&proposalId=…`
and `/lanes?…&action=manage` are not URLs `shared/deeplinks.ts` parses. Both
presses are omitted rather than minted as links the host would refuse.

**G6 — no `ui.toast` on a read failure.** A topology read that fails sets the
page's error banner, as the compiled page did. Mutations that git or GitHub
refused answer `{ok:false, message}` and the canvas draws that sentence. A toast
would be a second, quieter place for the same words.

**G7 — contributed nodes refresh on the next open.** There is no host event for
a contribution change yet. A plugin that publishes a `graph-node` while this
page is open is seen when the placement is next created — the same latency a
panel had before the page tier.
