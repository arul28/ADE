# Review page parity

What the plugin's page carries against ADE's compiled Review, surface by surface,
and what it does not. **The gaps at the bottom drive the acceptance walk** — read
them before judging the page, because each one is a thing the owner will look for
and either find, or find deliberately absent.

Compiled sources this was measured against, all still in the binary:
`ReviewPage.tsx` (2,265), `ReviewFindingCard.tsx` (759),
`ReviewLearningsPanel.tsx` (267), `PrRequestAiReviewDialog.tsx` (214),
`ReviewLaunchModelControls.tsx` (81), `reviewFindingLabels.ts` (77),
`reviewFindingCopy.ts` (70), `reviewTypes.ts` (51), `reviewApi.ts` (114),
`reviewRouteState.ts` (13). Two more are shared rather than approximated:
`LaneDialogShell.tsx` (129) and `vcsIcons.tsx` were ported into `@ade-dev/ui`
and the page draws the kit's copy.

## Placements

| Compiled placement | Page surface | Placement | Panel behind it | State |
|---|---|---|---|---|
| Review rail tab | `runs` | `tab` | `runs` | Carried |
| Work-rail Review pane | `runs` | `pane` | `runs` | Carried (same surface) |
| Launch review dialog | drawn inside `runs` | modal | `launch` | Carried |
| PR detail "ADE review" button | `launch` | `popover` | `launch` | Carried |
| PR row menu "ADE review…" | — | — | `launch` | Panel only, by design (G6) |
| Command palette "Review runs" | `runs` | `tab` | `runs` | Carried |
| Command palette "Launch a review" | `launch` | `popover` | `launch` | Carried |
| Learnings | drawn inside `runs` | pane swap | `learnings` | Carried |
| Run detail (findings, feedback) | drawn inside `runs` | pane | `run` | Carried |

Every `webviewSurfaceId` a socket names resolves to a declared surface, and the
manifest parses with no errors and no warnings — checked against
`shared/plugins/manifest.ts` and `shared/plugins/sockets.ts` as shipped, and
asserted in `test/panels.test.js`.

## The runs browser (`ReviewPage.tsx`)

Carried, moved rather than rewritten: the two-pane split with its draggable
sidebar; the run list with its target line, lane, status pill, finding count,
first two severity counts and target-mode chip; the run header with its status,
mode, publish-behavior and model chips, the complete/partial/failed/cancelled
sentence, the compare-target description, the evidence line with its
process-copy guard, the error line and the `Run <id> · Started … · Completed …`
footer; the Rerun button; the scope diagram; the "Review process" disclosure
with the five reviewer cards and the context-artifact cards; the "Reviewer
outputs" disclosure with pass, adjudication and merged-result cards; the
publications section with its six meta cards and summary body; the findings
section with its severity filter, the filtered-findings checkbox, "Copy all
findings", the running/queued banner with Cancel, the failed banner with Retry,
and all five empty states; the artifacts disclosure; the transcript section with
its chat-session and per-reviewer buttons; the `Refresh runs` and `Launch new
review` header buttons; and every tolerant reader in `normalizeRun` /
`normalizeDetail`.

Changed on purpose:

- **The selected run and the sidebar width** live in the `ui-state` collection
  rather than in the route and `localStorage`, and load asynchronously. The
  browser mounts on the defaults and hydrates; a run named by `context` outranks
  the stored one, so a page the host opened AT a run never lands on last week's.
- **The split is a flex row with a drag handle**, not `react-resizable-panels`.
  The library is a renderer dependency with its own window-level listeners; the
  clamps (280–520px) and the persistence are the compiled ones.
- **Two navigations became deeplinks.** "Open in files" was
  `navigate("/files", {state})` and is `ade://files?path=…&laneId=…`; "Open in
  Work" was `selectLane` + `focusSession` + `navigate("/work")` and is
  `ade://lane/<id>?session=<id>`. A guest cannot push a renderer route.

Added, because the run header had the values and no slot for two of them: the
run's **reasoning effort** and its **fast tier** are chips beside the model,
where the compiled page drew a disabled second copy of the whole model control.

## The finding card (`ReviewFindingCard.tsx`)

Carried whole: the severity pill and its five tones, the finding-class chip with
its tooltip, the feedback badge, the "filtered" chip and the suppression band,
the Action block, the primary-evidence block with its four tones, the details
disclosure (review handling, inline diff with its add/del/meta/highlight
colouring, tool signals with their pass/warn/fail tones, the evidence trail, the
review note), the copy button with its 1.5-second confirmation, and the four
verbs with the feedback modal — its three kinds, seven reasons, snooze-days
field, three suppression scopes and the "required for Other" note rule.

## The launch form (`ReviewPage.tsx` + `PrRequestAiReviewDialog.tsx`)

The compiled pair were two components building the same `{target, config}` from
the same fields, and they had already drifted — the dialog hard-coded
`auto_publish` and the page hard-coded `local_only`, and only one of them had a
commit-range picker. They are one form here with a `pr` mode.

Carried: the lane field, the three-way target mode, the compare-against toggle
with its lane picker, the scope diagram, the commit-range pair with their
ordering rules (the base list excludes anything at or after the chosen head and
vice versa, a selection that inverts the range repairs the other end, fewer than
two commits disables both), the working-tree explanation, the model and reasoning
controls, the read-only sentence, and the PR mode's locked lane, GitHub-posting
paragraph and `auto_publish`.

## Live progress

The compiled page listened on `window.ade.review.onEvent`. The page subscribes
with `host.subscribe({ kinds: ["review"] })` and refetches on each frame; a host
that refuses the kind leaves the page on a 2,500 ms poll of `pageRuns` — the same
`LIVE_POLL_MS` the child already reschedules for itself, unchanged. The seam test
walks both paths, and the running banner carries `data-review-live` so which one
is on is visible rather than inferred.

## The phone and the terminal

Unchanged, and that is the point. `parseSurfaces` forbids `mobile: true` on a
`webview`, so both surfaces are `mobile: false` and every non-desktop client
renders the `panelId` panel instead. The `runs` panel (the run list), the `run`
panel (the run with its findings and the four feedback buttons), `launch` and
`learnings` all still publish from `index.js`, and nothing was trimmed from them:
the page took over no drawing the panels were doing, so there was nothing to
remove. Review remains the first Review UI iOS and the TUI have ever had.

## The gaps

**G1 — the model control is a trigger, not ADE's `ModelPicker`.** The page draws
a button showing the current model and asks the host to open the real picker
(`ui.pickModel({ value })`, so the list opens on the current row), because the
compiled `ModelPicker` carries recents, per-provider grouping, brand icons, a
search and a fast-mode toggle that a page-local combobox could only approximate
and would then drift from. The same holds for the lane (`ui.pickLane({ value })`)
and the reasoning ladder (`ui.pickReasoningEffort({ model, value })`, asked with
the chosen model, because the rungs are per model). The model answer carries
`fastMode` because ADE's picker sets both in one gesture; the Fast button on the
form stays so a reader can toggle without re-opening the picker. *A host without
the pickers falls back to plain text fields and a native lane select — usable,
and visibly less.*

**G2 — the reviewer transcript opens through a deeplink.** Carried. The compiled
button called `selectLane`, then `focusSession`, then routed to `/work`; the page
sends `ade://session/<sessionId>?lane=<uuid>`, and `deeplinkToNavigationTarget`
turns a session target into the Work tab with that transcript focused — the same
three steps, in one link. The lane is a hint and is sent only when it parses as a
UUID, because ADE's parser fails the whole link on a malformed one rather than
dropping the field.

**G3 — "Open in files" is `ade://file/<path>?line=&lane=`.** Carried, and it
gained the line number the compiled call did not pass: router state carried
`{openFilePath, laneId}` and nothing else, while the file deeplink reveals a
line. Same UUID rule as G2 for `lane`, and `line` is set only when it is
positive, because `line=0` fails the link.

**G3a — the launch popover returns the reader to the run through `ctx`.**
`ade://plugin/<id>/<panel>` passes exactly ONE query key through — `ctx`, a JSON
object capped at 2 KiB — and silently discards every other, so the run id rides
inside it rather than as a `runId` parameter that would have been dropped in
silence. `runIdFromContext` reads it back from the subject for any subject kind,
because a deeplink context arrives without one.

**G4 — a finding whose lane has no worktree opens against the project root.**
`ui.openPathInEditor` needs a `rootPath` and a `relativePath`, and the compiled
page took the lane's `worktreePath` from the app store. The child joins
`sdk.lanes.list()` onto the launch context so each lane carries its `path`,
which covers every local lane. When the host reports none — a remote binding, or
a lane whose worktree has not been created — the page falls back to
`context.project.root`, which is the checkout the reader is looking at. The
press is `{ rootPath, relativePath, target: "default" }`, which is the plugin
bridge's shape (`target` is the editor id, not the file). A host with no
`ui.openPathInEditor` at all leaves the button drawn and the press a no-op,
which is exactly what the compiled card did when `window.ade.app.openPathInEditor`
was absent.

**G5 — the "Context used for this review" cards have no debug payload.** The
compiled card had a `Debug payload` disclosure printing `contentText` and the raw
`metadata` JSON, duplicating what the Artifacts disclosure below already prints
for every artifact including these. Dropped as a duplicate rather than as a loss:
the Artifacts section carries both fields for every artifact.

**G6 — the PR row menu opens the panel, not the page.** `sockets.ts` reads only
`label`, `actionId`, `icon` and `danger` on a `row-menu-item`, so a
`webviewSurfaceId` there would be a field the author wrote and the platform
ignored — and an ignored field fails the zero-warnings gate every official
package has to pass. The row item keeps its action, which opens the `launch`
panel; the PR DETAIL toolbar button, which can carry the field, opens the page.

**G7 — the runs list has no lane or status filter.** The compiled page had none
either: `listRuns` takes both and the tab always passed `{limit: 120}`. Carried
as-is rather than invented, and `pageRuns` forwards both arguments so the filter
is one control away when it is asked for.

**G8 — no `ui.toast` anywhere.** Every failure in the compiled page was an inline
banner, and every one still is: the run-level error strip, the feedback error
above the findings, and the launch form's own error line. A toast would be a
second, quieter place for the same sentences.
