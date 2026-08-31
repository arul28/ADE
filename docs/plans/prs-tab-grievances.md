# PRs tab grievance ledger

A running list of PR-tab defects reported from live use, the code behind each
one, the fix, and the surfaces each fix must reach.

## Surface key

| Key | Surface | Reach rule |
|---|---|---|
| **D** | Desktop (`apps/desktop/src/renderer/components/prs/**`) | The reviewed surface. |
| **W** | Web client (hosted SPA built from the same renderer) | A desktop renderer fix lands here automatically. Only capability gates, CSP, and the 1000 KB first-load budget diverge. |
| **M** | Mobile / iOS (`apps/ios/ADE/Views/PRs/**`) | Separate SwiftUI code fed by `prService.getMobileSnapshot()`. Needs its own port. |
| **T** | TUI + CLI (`apps/ade-cli/src/tuiClient/rightPaneFormatters.ts`, `ade prs` in `cli.ts`) | Text only. Parity means correct wording and correct gating, not a layout port. |
| **S** | Service (`apps/desktop/src/main/services/prs/prService.ts`) | Shared by every surface above. A service fix reaches all four. |

Status: `open` → `in progress` → `done`.

---

## Batch 1 — merging, and the unmapped-PR gates

Reported 2026-08-29. Root theme: ADE treats "this PR has no ADE lane" as a
permission level. It is not one. A PR's lane mapping is a **convenience link**,
not an authorization. Every write in the PR tab goes to GitHub over the GitHub
API, and GitHub does not care whether ADE has a lane for it.

### G1 — The override merge button needs two clicks

**Symptom.** Open Merge…, tick "Merge without waiting for requirements to be
met", click **Override & merge**. The button relabels to "Click again to
override" and needs a second click.

**Cause.** `PrMergeDialog.tsx` keeps an `overrideArmed` state with a 4-second
timer; `handlePrimaryClick` arms on the first click and submits on the second.

**Fix.** One click submits. The bypass checkbox is already the deliberate
confirmation — a second confirmation on the same screen adds nothing.

**Surfaces.** D, W. iOS has its own merge sheet; check for the same pattern.

**Status:** done.

---

### G2 — An unmapped PR cannot be merged

**Symptom.** Merging an unmapped PR fails with "This PR isn't mapped to an ADE
lane — open it from its project lane or merge it on GitHub." A red banner
repeats the same message across the top of the detail pane.

**Cause.** `PrDetailPane.handleMerge` throws early when `isUnmapped`. The
service's `land()` is row-based: it calls `getRow(prId)` and throws "PR not
found" for a synthetic `gh:owner/repo#num` id.

**Fix.** Merge unmapped PRs by GitHub coordinates. `land()` resolves its repo
and PR number from either a real row or the synthetic id, and skips only the
steps that genuinely need local state (operation lane id, merge-outcome record,
post-merge lane/branch cleanup). Remove the renderer gate and the banner.

**Surfaces.** S (reaches all), D, W. M and T inherit the service fix.

**Status:** done.

---

### G3 — A merged or closed PR does not move tabs until a refresh

**Symptom.** After a merge or a close, the PR stays in the Open tab. Only a
later GitHub snapshot refetch moves it.

**Cause.** `useGitHubTabListModel` reconciles list state from `prsByIdMap` —
the local `pull_requests` rows. An unmapped PR has no row, so nothing changes
its state, and even a mapped PR waits on the row refresh round-trip.

**Fix.** A renderer-local optimistic terminal-state map, keyed by GitHub
coordinates, written the moment a merge or close succeeds and applied in
`reconcileLinkedPrState`. The row/snapshot refresh then confirms it.

**Surfaces.** D, W. M and T re-read on demand and are unaffected.

**Status:** done.

---

### G4 — No usable way to close a PR

**Symptom.** No close control on the PR the user was looking at.

**Cause.** A close button exists in `PrDetailMergeRail`, but it is gated:
`onClose={pr.laneId ? handleClosePr : undefined}`. It disappears for every
unmapped PR. It also sat below the merge button as a second full-width row.

**Fix.** Put merge and close on one row, split 70/30, with merge on the left.
Close opens a confirmation dialog. Ungate it (see G5).

**Surfaces.** D, W. M: iOS has no close control either — port it.

**Status:** done.

---

### G5 — Everything else gated on the lane mapping

**Symptom.** An unmapped PR cannot be commented on ("Map this PR to a lane to
comment"), closed, reopened, or have its checks rerun.

**Cause.** Two layers gate on the mapping:

- Renderer: `PrDetailPane` passes `undefined` for `onClose`, `onReopen`, and
  `onRerunChecks` whenever `pr.laneId` is null; `PrDetailTimelineRails` passes
  a `lockedMessage` to the comment composer.
- Service: `addComment`, `closePr`, `reopenPr`, `rerunChecks`, `updateTitle`,
  `updateBody`, `setLabels`, `requestReviewers`, and `submitReview` all start
  with `requireRow(args.prId)`.

**Fix.** One resolver (`resolvePrTarget`) that accepts a row id or a synthetic
`gh:` id and returns repo + PR number + the row when one exists. Every
GitHub-only mutation uses it. Local bookkeeping stays conditional on the row.

**Genuinely lane-dependent — left gated, by design, not by accident:**

| Action | Why a lane is required |
|---|---|
| Update branch (rebase strategy) | Rebases the lane worktree locally. The `merge` strategy is a GitHub API call and is now allowed unmapped. |
| Delete local branch | There is no local branch without a worktree. Remote deletion stays available. |
| Fix in chat / AI resolver | Starts an agent in the lane worktree. |
| Manage lane | Operates on the lane itself. |

**Surfaces.** S (reaches all), D, W. M and T inherit the service fix.

**Status:** done.

---

### G6 — The mapping concept itself

**Reported.** "What does a mapped PR even mean? I have yet to see one useful
advantage, and it feels prevalent in the PRs tab."

**Finding.** Every capability mapping unlocks is *local*: conflict prediction,
rebase-based branch update, the Rebase and Integration tabs, agent work in the
worktree, post-merge cleanup, chat provenance. All of it reduces to "ADE has a
local checkout of this branch". Mapping was a second name for that, promoted to
a status with a warning colour.

Two supporting facts: `git merge-tree` takes refs, not worktrees, so conflict
prediction never needed a lane either; and GitHub already answers PR-to-base
mergeability, which ADE reads.

**Decision.** Remove the user-facing concept. Keep the internal link — it routes
reads by coordinate, ties chats to the PR they produced, and carries the
`was: <lane> · N chats · N proof` provenance on merged PRs.

Removed: the amber `unmapped` row badge, the "Not mapped to a lane" header
warning, the lane picker and Map button, the Unmap button, the "Map this PR to a
lane to comment" composer lock, the "Map this PR to a lane" CI-log message, the
iOS "Unmapped" chip and banner, and the CLI/TUI mapping wording.

Kept: one quiet outline button, "Open as lane", which checks the PR's branch out
locally. Small, uncoloured, no warning beside it.

**Surfaces.** D, W, M, T.

**Status:** done.

---

### G7 — Merging silently deleted the remote branch

**Symptom.** Found while answering G6. Not reported, because nothing in the UI
ever said it was happening.

**Cause.** `runPostMergeCleanup` fired `DELETE /repos/{owner}/{repo}/git/refs/
heads/{head}` after every successful merge. No flag, no prompt, no setting. Lane
archiving, by contrast, was already opt-in and off in every desktop caller.

**Fix.** `deleteRemoteBranch` is now an explicit argument on `LandPrArgs` and
`runPostMergeCleanup`, defaulting to **false**. No desktop or iOS caller sets it.
The explicit "Delete branch" button on a merged PR remains the way to do it on
purpose, and now works without a lane too (remote-only when there is no local
branch).

The CLI gained a first-class `--delete-remote-branch` flag rather than leaving
the behaviour reachable only through a generic `--arg` escape hatch.

**Surfaces.** S (reaches all), T.

**Status:** done.



---

## Batch 2 — the shape of the view

Reported 2026-08-29, with Linear's PR view as the reference.

### G8 — The UI feels "blobby"

**Symptom.** Every group in the PR detail view is a raised, filled, rounded card
with a drop shadow, and they are stacked three columns deep. Nothing reads as
primary; the nesting carries no meaning.

**Cause.** `floatingPane()` — `background: var(--pr-panel-card)`, a border, a
large radius, and `box-shadow: var(--shadow-panel)` — used 16 times across the
PR components. Buttons compound it: merge and close were both full-width
linear-gradients, so two controls competed to look decisive.

**Fix.** A flat section vocabulary in `prs/shared/prSection.tsx`: `PrSection`
(icon + sentence-case title + meta + action, separated by a hairline rule rather
than a box), `prSectionAction`, `prFlatButton`, `prSolidButton`. Grouping comes
from a label and vertical rhythm. Exactly one filled control on the surface —
the merge button, solid rather than a gradient.

`floatingPane` itself is untouched: the Lanes tab still uses it, and this is a
PR-surface decision.

**Surfaces.** D, W.

**Status:** done.

---

### G9 — Three columns become two, and commits become ticks

**Symptom.** Commits owned a whole left column for what is usually a handful of
short lines, squeezing the thread — the actual content — into the middle.

**Fix.** Two columns.

- **Left:** the timeline, full width, with the commit ticks over its top-left
  corner. They are modelled on ADE chat's user minimap: one tick per commit, a
  hover lens that widens the tick under the pointer, a preview card with the
  short SHA, subject, and time, and click-to-jump. Commits still render inline
  in the thread as commit dividers, so nothing is lost by removing the list.
  G10 below settles the final shape — a floating pill, not a rail.
- **Right:** reviewers / labels / assignees, then checks, then files changed
  (moved from the left column), then the merge rail pinned at the bottom.

The left rail's persisted width key (`ade.prs.overviewLeftRailWidth`) is retired.
The right rail starts wider because it carries files-changed now, and the
thread's minimum grew to 360px. Its width settled at 390px (see G21), which is
also its floor — a rail you can shrink until it hides its own content is a rail
that gets shrunk by accident.

**Surfaces.** D, W.

**Status:** done.


---

## Batch 3 — the tick pill and the PR row

### G10 — Ticks spread down the whole left side

**Symptom.** "They are spread evenly through the whole left side, not at all what
was wanted."

**Cause.** My own overcorrection. The rail originally shrank to fit its ticks (a
24px speck); I made it span the column instead, which fixed invisibility by
creating the opposite problem — a full-height rail for what is usually a handful
of commits.

**Fix.** The rail becomes a **floating pill**: a small rounded rectangle with a
semi-transparent black background, floating over the top-left of the thread, ticks
clustered tightly inside it. It grows with the commit count up to a cap, then
compresses spacing. **It does not render at all below 2 commits** — one commit is
not a thing you navigate between.

The thread's reserved 22px left gutter is gone; the pill is out of flow, so the
thread reclaims that width.

**Surfaces.** D, W.

**Status:** done.

---

### G11 — The PR row card collapses when the list narrows

**Symptom.** Dragging the list column narrow truncates the title to a few
characters while less important things keep their space. "The left sidebar just
becomes kinda useless."

**Fix, in the owner's priority order:**

1. The title takes the card's full width and **always wraps** — no clamp, no
   ellipsis. PR titles are long and the owner wants them readable.
2. The **timestamp moved to the bottom-right**, beside the "open in GitHub"
   button, which is what freed the title's row.
3. Progressive degradation by **CSS container query** on the row's own width:
   - ≤400px — the author avatar goes.
   - ≤340px — the `was: <lane>` name goes.
   - ≤300px — the remaining provenance counts go.
   The PR number and title never drop.

Container queries were chosen over a JS density tier because the width that
matters is the row's own, and a JS tier would put a state update in the path of
every drag frame. `index.css` already uses this pattern elsewhere.

The 30px left indent on the lower rows is gone, so every line starts at the same
left edge.

**Surfaces.** D, W.

**Status:** done. Breakpoints are reasoned, not observed — worth a nudge once the
splitter is dragged for real.

---

## Batch 4 — the CI / Checks tab

Reported with a screenshot of a 22-job CI run. Owner's ambition: "a very simple
dupe of GitHub Actions in ADE... letting you never leave ADE."

### G12 — The list-then-snap flash

**Symptom.** Opening the CI tab shows a flat list of every job for 2–3 seconds,
then it snaps into a graph.

**Cause.** The graph comes from an async `prs.getWorkflowGraph` call while a
fallback built from `checks` renders immediately. The user watches a layout that
is about to be thrown away.

**Fix.** Never show a layout that is about to be replaced. When the real graph is
genuinely unavailable (`source: "none"`) the flat view is the honest final answer,
not a transition, and the UI now says which one it is.

**Status:** done.

---

### G13 — The DAG is not a DAG

**Symptom.** Columns of job rows with no real dependency edges, no pan, no zoom.

**Fix.** Rebuild on **`@xyflow/react`** (React Flow v12), already a dependency and
already used by the Workspace Graph tab. Real edges, pan/zoom, fit-to-view, status
carried by shape as well as colour.

**Constraint.** The PR detail pane is not its own route, and the web client
enforces a hard 1000 KB first-load cap
(`scripts/check-webclient-entry.mjs`). React Flow must be lazy-loaded behind a
dynamic import or the build fails.

**Status:** done.

---

### G14 — Clicking a node will not close it

**Symptom.** A second click on the same node does not hide its details.

**Status:** done.

---

### G15 — A passed job reports itself as failing

**Symptom.** "You click on something green, it will say 'fetching failing steps
output', then show some random output."

**Cause, part one — the copy.** `PrCheckLogDrawer.tsx` hardcodes failure language
regardless of conclusion: "Fetching the failing step's output…" (line ~143) and
"tail of the failing step" (line ~166).

**Cause, part two — the data.** The log excerpt is selected by a failing-step
rule. Run that against a green job and it lands on an arbitrary step, which is the
"random output".

**Fix.** Show the right detail per state. Failed: the failing step and its output.
Passed: the step breakdown with durations, and **no log fetch on open**. Running:
which step is in flight. Skipped/cancelled: say so plainly, invent no failure.

**Bonus:** since most jobs pass, not fetching a log for a passed job removes the
common case entirely from the GitHub budget.

**Status:** done.

---

### G16 — GitHub call budget

Standing constraint on G12–G15, not a defect. The owner: "cannot lead to so many
spammy GitHub calls." The repo has a recorded incident where a failed read
returned an empty array that read as "CI has not started yet", which kept a
5-second poll running unbraked for an hour and consumed the account's entire
hourly quota.

Rules held to: no new poll loops; automatic reads gate on
`isGithubPollStoodDown()` and take intervals from `githubPollPeriodFor(base)`; a
failed read must never be indistinguishable from an empty one.

Two latent instances of that exact bug were found and closed while doing this:
`getWorkflowGraphForCoords` swallowed both its GitHub reads into empty arrays, so
an unreachable GitHub rendered as "this repo has no workflow file"; and the
remote sync handler rebuilt the `getCheckLog` payload field-by-field and dropped
`includeLog`, so a phone asking for a log would have silently no-opped.

**Status:** done.


---

## Batch 5 — review feedback on batches 3 and 4

### G17 — DAG nodes are not clickable

**Symptom.** "You can't click any of them... it worked before, nothing now."

**Cause, verified live over CDP before the app was closed.** React Flow v12 sets
`pointer-events: none` on `.react-flow__node` when `nodesDraggable`,
`nodesConnectable` and `elementsSelectable` are all false — its static-graph
optimisation. The rebuild disabled all three to stop nodes being dragged, and that
silently killed every click.

```
querySelectorAll('.react-flow__node')  → 22 nodes
getComputedStyle(node).pointerEvents   → "none"
```

The inner node is also a `<div>`, not a button, so there was no keyboard path
either.

**Fix.** Restore clicks without restoring dragging, keep background-drag panning,
add real keyboard activation, and add a regression test at the level jsdom can
actually assert (the handler fires), stating plainly what it does not prove.

**Status:** done.

---

### G18 — The ticks came out horizontal

**Symptom.** The owner asked for vertical twice. The pill lays them out
horizontally.

**Cause.** Misreading "clumped together and closely **how they are in chats**, not
spread fully vertically". The chat minimap is a *vertical* stack; "not spread
fully vertically" meant do not stretch to the full column height, not change the
axis. The first attempt read it as an instruction to go horizontal.

**Fix.** Vertical axis, tight pitch, pill grows in height to a cap then compresses
pitch. Everything else about the pill was already right and stays.

**Status:** done.

---

### G19 — The PR row avatar hides far too eagerly

**Symptom.** "There is still space in the top right even with your recent
changes."

**Cause.** The avatar's container-query breakpoint was ≤400px, but the list column
only ranges 260–560px — so it fired almost immediately.

**Fix.** Move the avatar to the card's top-right, where the space actually is,
keep the current title wrap untouched, and drop the breakpoint to roughly the
list's minimum width so it survives until the card is genuinely cramped.

**Status:** done.

---

### G20 — The PR detail header is three lines

**Symptom.** Three stacked rows of chrome above the PR body.

**Fix.** One line: number → title → state badge → hover-only edit pencil →
divider → `head → base` → divider → the three tabs → (pinned right) a GitHub
icon-only external link.

**Dropped:** the repo name, the CI checks badge (the tab already counts them, and
the merge rail carries the real status), and the per-PR refresh button (there is a
global one in the top header).

**Status:** done.

---

### G21 — Column widths

The thread narrows slightly and the right rail widens slightly. Note the rail
width is persisted per project in localStorage, so a stored value overrides a new
default — that has to be handled or the change will appear not to have landed.

**Status:** done.

---

## Follow-ups found while fixing batch 1

Not fixed, because each needs a decision rather than a repair.

1. **Mobile snapshot omits row-less PRs.** `buildMobileSnapshot` builds `prs`
   and `capabilities` from `listRows()`, so a PR with no local row gets no
   capabilities entry. iOS falls back to state-derived availability and behaves
   correctly, but the phone is guessing for exactly the PRs this batch
   unblocked. Fixing it means widening the snapshot to carry GitHub-only PRs.
2. **The TUI cannot address a PR that has no lane.** `/pr` takes no argument and
   identifies the PR through the active lane. That is a selector, not a gate,
   but it means the TUI has no path to a PR ADE did not create. Adding
   `/pr <number>` is a new command surface.
3. **iOS close-PR layout.** Desktop now uses a 70/30 merge/close row with a
   confirmation dialog. iOS already has close in two places with an inline
   confirm row. Matching desktop is a design call.
4. **iOS has no delete-remote-branch control.** It inherits the safe default
   from G7. Whether the merge sheet should carry a default-off toggle is open.
5. **`prSolidButton` has no disabled variant.** The merge button hand-rolls a
   recessed treatment inline. Fine for one caller, worth folding into the
   primitive if a second filled control ever appears.
6. **`prFlatButton` and `prSolidButton` default to different heights** (28 and
   30), so a row pairing them needs a manual override — the merge/close row
   does. A shared control height would remove that.
7. **iOS and the TUI still show the old three-column vocabulary.** Batch 2 is
   desktop and web only. Whether iOS should follow the flat treatment is a
   design call for after the desktop review.
