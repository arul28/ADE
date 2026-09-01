# Plugins README vs code — disagreements found during the 2026-09-01 doc pass

The README (3e6e3be99) now states what the code does. This file records the old claims so nobody restores them. Item 9 is a code-comment drift that still needs a code edit.

# Where the code and the old plugins README disagreed

Found while updating `docs/features/plugins/README.md` for waves 1-3 (branch
`plugin-platform`, HEAD at time of writing 54df53935; README committed as
3e6e3be99). Every row is a claim the README made that the code contradicts. I
did not silently pick a side: the README now describes what the code does, and
the old claim is recorded here.

**9 items.**

---

## 1. Socket taxonomy: seven kinds, six surfaces

**Old claim.** "Seven kinds (`toolbar-action`, `row-badge`, `row-menu-item`,
`detail-section`, `empty-state`, `filter-chip`, `file-viewer`) across six
surfaces (`work`, `lanes`, `files`, `prs`, `automations`, `cto`). The taxonomy
is closed and small … a seventh kind is a platform change with a parity cost on
four clients."

**What the code does.** `PLUGIN_SOCKET_KINDS` holds **18** kinds and
`PLUGIN_SURFACE_IDS` holds **8** surfaces. The kinds fall into five groups:
rows/lists/detail panes (the seven the README named), chat and the agent
(`composer-action`, `chat-header-action`, `chat-card`, `slash-command`), ambient
placement (`command-palette-action`, `settings-section`, `work-rail-pane`,
`drawer-tab`, `activity-entry`), the canvas (`graph-node`), and dialogs
(`dialog-section`). The two extra surfaces are `app` and `settings`, which carry
no entity.

**Where.** `apps/desktop/src/shared/plugins/sockets.ts:41-93`.

**Note.** The README also contradicted itself: its own Sockets section later
described `command-palette-action` receiving `args.subject` with "the palette's
context is `{kind: "surface", surface: "app"}`" — a kind and a surface its
opening sentence said did not exist.

**Fixed at** README lines 1599-1624 (a five-group table plus the surface
explanation).

---

## 2. iOS socket coverage: "two of the seven"

**Old claim.** "**iOS draws two of the seven socket kinds.** `row-badge` and
`row-menu-item` render; `toolbar-action`, `detail-section`, `empty-state`,
`filter-chip`, and `file-viewer` decode as `.unsupported` and draw nothing."

**What the code does.** The support table marks all five of those named as not
drawn as `ios: true`. iOS draws **11 of 18**: `toolbar-action`, `row-badge`,
`row-menu-item`, `detail-section`, `empty-state`, `filter-chip`, `file-viewer`,
`composer-action`, `chat-header-action`, `chat-card`, `activity-entry`. The
seven it does not draw are `slash-command`, `command-palette-action`,
`settings-section`, `work-rail-pane`, `drawer-tab`, `graph-node`,
`dialog-section` — the phone has no host for any of them.

**Where.** `PLUGIN_SOCKET_CLIENT_SUPPORT`,
`apps/desktop/src/shared/plugins/sockets.ts:276-339`; the iOS side is
`PluginSocketKind` in `apps/ios/ADE/Models/PluginRecords.swift:333-359`, whose
`init(rawValue:)` falls to `.unsupported`.

**Fixed at** README limitations, first two bullets of the client-coverage group.

---

## 3. TUI sockets: "no sockets"

**Old claim.** "**The TUI renders 10 of 13 and no sockets.** … `/plugin-view` is
the only plugin surface there."

**What the code does.** The TUI draws **three** socket kinds — `row-badge`,
`row-menu-item` and `toolbar-action` — on the `lanes` and `work` surfaces only,
which are the surfaces it lists rows for. `PLUGIN_TUI_SOCKET_KINDS` is derived
from the support table rather than hand-listed, so it cannot drift from it.

**Where.** `apps/desktop/src/shared/plugins/sockets.ts:302-304` (all four
clients `true` for those three kinds); `apps/ade-cli/src/tuiClient/pluginSockets.ts:79-80`.

**Fixed at** README limitations.

---

## 4. Vocabulary component counts: 13 / 12 / 10

**Old claim.** "**iOS renders 12 of the 13 v1 components.** `chart` shows a named
marker." and "**The TUI renders 10 of 13.**"

**What the code does.** `NODE_PARSERS` holds **16** components: `stack`, `group`,
`text`, `markdown`, `badge`, `button`, `list`, `table`, `form`, `chart`, `video`,
`image`, `divider`, `keyValue`, `segmented`, `emptyState`. iOS renders **15 of
16** — `PluginRenderSupport.renderableComponents` names 15 and `chart` is the one
deliberate omission. The TUI renders **13 of 16** richly and shows named
placeholders for `video`, `image` and `chart`.

**Where.** `apps/desktop/src/shared/plugins/vocabularyNodes.ts:1292-1619`;
`apps/ios/ADE/Views/Plugins/PluginPaneStore.swift:190-221`;
`apps/ade-cli/src/tuiClient/pluginPane.ts:15-17`.

**Fixed at** README limitations.

---

## 5. Panel-state ceiling: four state keys

**Old claim.** "Ceilings, in `VOCAB_STATE_LIMITS` and spread into `VOCAB_LIMITS`:
4 state keys per panel, 2–8 options per control, 4 top-level `where` clauses,
depth 3, 24 clauses in total, 20 literals per list."

**What the code does.** `maxStateKeys` is **8**, raised deliberately because four
was one filter axis short of the panels people write (an issue browser wants
state, project, assignee, priority, sort and a text search), and because the
`group` node spends no state key so seven collapsible sections still leave the
whole filter budget. The option ceiling is also two numbers now, not one:
`maxStateOptions` 8 for literal options and `maxBoundStateOptions` 50 once
`optionsFrom` has resolved. The README listed neither `optionsFrom` nor the
selection ceilings (`maxSelectionKeys` 2, `maxSelectedRows` 100, `maxBulkActions`
4), which did not exist when it was written.

**Where.** `apps/desktop/src/shared/plugins/vocabularyState.ts:94-158`.

**Fixed at** README lines 1437-1445 (the rewritten ceilings paragraph) plus the
new `optionsFrom` and `list.selectable` subsections above it.

---

## 6. Hosted web client has no plugin route

**Old claim.** "**The hosted web client has no route for a plugin panel.**
`/plugin/:id` is deliberately absent from the shell's route roots because the tab
is gated on a host capability the shell cannot probe before its adapter is up, so
`targetToWebPath` answers null for a `plugin` target rather than landing the
reader on a plausible-looking empty shell." The Client-entry-points table said the
same: "A `plugin` deeplink has no hosted route — `targetToWebPath` answers null
and each caller degrades where the user can see it."

**What the code does.** `/plugin` **is** in `APP_ROUTE_ROOTS`, and
`targetToWebPath` returns `/plugin/<id>?panel=…[&ctx=…]`, byte-identical to what
`resolvePluginDeeplinkRouting` produces on desktop. The comment beside the route
root states the reversal explicitly: leaving it off "made a reload on a panel — or
a shared link to one — drop the reader at the welcome surface with nothing said",
and landing in the App instead lets `PluginTabPage` give the real answer for every
state — the panel, "Not installed here", or "Turned off".

**Where.** `apps/desktop/src/renderer/webclient/shell/WebClientRoot.tsx:134-142`;
`apps/desktop/src/renderer/webclient/shell/webRoutes.ts:129-142`.

**Fixed at** the limitation was **deleted**, and the Web row of the
Client-entry-points table (README line ~1988) was rewritten.

---

## 7. Nothing registers a plugin as a tracker's owner

**Old claim.** "**Nothing registers a plugin as the owner of a tracker yet.**
`resolveIssueDeeplinkRouting` takes an `owners` list so an `ade://issue/jira/…`
link minted on one machine can open through whichever Jira plugin the receiving
machine has, and no caller populates it. Today the routing falls back to the
plugin the link names, or to a plugin whose id equals the provider."

**What the code does.** The `owners` parameter now **defaults** to
`issueProviderOwnersFromMatchers(input.plugins)`, so ownership is derived from the
same `urlMatchers` declarations that draw a tracker's smart-link chips. There is
deliberately no separate "I own this tracker" field — a plugin that can recognise
a tracker's URLs is a plugin that can draw its issues, and a second declaration
could disagree with the first. The consequence is a different limitation, not
none: a plugin that reads a tracker but recognises none of its URLs owns nothing.
The `linear`-with-nobody-claiming-it fallback to the compiled surface is
unchanged.

**Where.** `apps/desktop/src/renderer/components/app/pluginDeeplinkRoute.ts:177-181`
and the `IssueProviderOwner` doc at `:90-102`;
`apps/desktop/src/renderer/components/plugins/usePluginRegistry.ts:268-280`.

**Fixed at** README limitations — rewritten as "Tracker ownership is derived,
never declared."

---

## 8. `ade.lanes` verb list

**Old claim.** "**A plugin cannot create a lane, only link to one.** `ade.lanes`
is `list`, `get`, `linkIssue`, `unlinkIssue`."

**What the code does.** There is a fifth verb, `listSessionIssues(laneId)`, which
answers the issues linked to the SESSIONS inside a lane, grouped by session. It
exists because a lane summary's `primaryIssue` and `issueLinks` are both
lane-scoped, so a plugin reproducing ADE's PR→Done rule off a summary alone
silently skips every issue a person attached to a single chat. The rest of the
limitation (no lane creation) still holds.

**Where.** `apps/desktop/src/shared/plugins/sdk.ts:1795-1827`; the payload type
`PluginSessionIssues` at `:1229-1255`.

**Fixed at** README limitations, and a new paragraph in "A plugin can link an
issue to a lane" (README ~700-716).

---

## 9. A code-comment drift, not a README one

Not a README claim, so nothing in the doc was wrong — but it is wrong in the
source and worth fixing separately.

**The comment.** `prTransitionsFromChanges` is documented as "exported so the
mapping is testable without an Electron main process: the call site is one arrow
inside `main.ts`'s `onPullRequestsChanged`, which is where the previous state and
the project root meet and nowhere a test can reach."

**What the code does.** Every producer on this bus lives in the daemon, not in
`main.ts`. `apps/desktop/src/main/main.ts` calls neither
`emitPluginEntityChange` nor `prTransitionsFromChanges`. The real call sites are
`apps/ade-cli/src/bootstrap.ts:1178` and `:1195` (lane), `:1803`, `:1816`, `:1824`
(session), `:2108` and `:2205` (PR, the last with transitions).

**Where.** `apps/desktop/src/main/services/plugins/pluginEntityChanges.ts:112-115`.

**What I did.** Documented the daemon as the producer in the README's new "A
change event says what a pull request did" section and left the comment
untouched, since the brief scoped me to the one doc file.

---

## Appendix — two details in the tasking brief that the code states differently

Neither is a README defect; both are recorded so the next writer does not restore
the brief's wording.

- **`maxStateKeys 8` is right, but the selection caps are three separate numbers**,
  not one batch cap: `maxSelectionKeys` 2 (selectable lists per panel),
  `maxSelectedRows` 100 (ticked rows per list), `maxBulkActions` 4 (buttons on the
  bar). `apps/desktop/src/shared/plugins/vocabularyState.ts:131-156`.
- **The markdown cap of 4,000 is CHARACTERS of source, not bytes.**
  `maxMarkdownChars: 4_000`, compared against `source.length` at parse.
  `apps/desktop/src/shared/plugins/vocabularyMarkdown.ts:133`,
  `apps/desktop/src/shared/plugins/vocabularyNodes.ts:1357`.
