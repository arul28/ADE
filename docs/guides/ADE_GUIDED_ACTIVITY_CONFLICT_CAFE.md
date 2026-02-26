# ADE Guided Activity: Parallel Lanes, Packs, Conflicts, Graph, PRs

This is a guided, end-to-end activity designed to exercise (nearly) every surface in ADE:
- multi-project switching
- onboarding + provider modes
- lanes/worktrees + stacks/restack
- terminals + session deltas
- packs + freshness
- conflict prediction + merge simulation + AI proposals
- graph orchestration
- PR creation + status + land flows (multiple merge methods)
- history timeline
- agents (natural language rule drafts + execution history)

The repo you build is intentionally tiny, and intentionally conflict-prone.

## Prereqs

- Node.js 20+ (for `node --test`)
- Git 2.28+ (for `git init -b main`)
- Optional but recommended: GitHub + `gh` CLI (to exercise PRs + land flows against a real remote)
- Optional: Hosted/BYOK provider configured (to enable **AI details** in packs and **AI conflict proposals**). Guest Mode still has deterministic packs, versions, events, and conflict prediction.

## The Demo Repo

We’ll scaffold a tiny Node HTTP server called `conflict-cafe`. Most lanes will modify:
- `src/receipt.js`
- `src/router.js`

That makes conflict prediction and resolution unavoidable.

Scaffold script (in this ADE repo):
- `docs/guides/scripts/scaffold-conflict-cafe.sh`

## Activity Overview (4 Lanes / 4 Integration Methods)

Create 4 lanes from `main` and implement four “features” that overlap on purpose:

| Lane | Intent | Files touched (by design) | Integration method (demo) |
|---|---|---|---|
| `lane-tax` | Add tax + total lines | `src/receipt.js`, `src/router.js` | PR land: **merge commit** |
| `lane-coupon` | Add coupon discount support | `src/receipt.js`, `src/router.js` | PR land: **squash** |
| `lane-i18n` | Locale-aware money formatting | `src/receipt.js`, `src/router.js` | **Rebase** then land |
| `lane-request-id` | Request IDs + theme plumbing | `src/receipt.js`, `src/router.js` | **Cherry-pick** (ADE UI) |

You will:
- watch packs evolve as you end terminal sessions
- watch conflicts light up before you merge
- deliberately hit conflicts, then resolve them using ADE’s conflict tooling

## Step 1: Create The Repo (Use A Terminal)

Pick a location. `/tmp` keeps it disposable:

```bash
bash /Users/arul/ADE/docs/guides/scripts/scaffold-conflict-cafe.sh /tmp/conflict-cafe
cd /tmp/conflict-cafe
npm test
```

Optional: create a GitHub remote (recommended for the PRs tab):

```bash
cd /tmp/conflict-cafe
gh repo create conflict-cafe --private --source=. --remote=origin --push
```

## Step 2: Open The Repo In ADE (Top Bar + Onboarding)

1. In ADE, click the **+** in the top bar (Open another project).
2. Select `/tmp/conflict-cafe`.
3. If ADE sends you to **Onboarding**, complete it.
4. Go to **Settings**:
   - Guest Mode is fine for this activity until the AI steps.
   - Switch to Hosted/BYOK only when you want AI details/proposals.

What to look for:
- **TopBar** now shows project tabs; verify you can switch between projects.
- **Settings**: provider mode + GitHub settings (polling interval, auth, etc.).
- The Guest Mode banner should say **AI details disabled** (not “context disabled”).

## Step 3: Play Tab (Processes, Tests, CI Import, Agent Tools)

In **Play**:
1. Click **Scan CI** (or CI import panel) and import the `npm test` job from `.github/workflows/ci.yml`.
2. Ensure you have:
   - A process: `npm run dev`
   - A test suite: `npm test`
3. Start the dev process and confirm logs stream in the log viewer.
4. Run the test suite once so it shows a baseline status.

What to look for:
- Process readiness + logs
- Test run history and log output
- (If you have Claude Code installed) the presence of `.claude/commands/*` should show up under agent tooling surfaces.

## Step 4: Agents Tab (Make Packs + Conflicts “Feel Alive”)

In **Agents**:
1. Create an automation agent from natural language, for example:
   - “When a session ends, refresh packs and predict conflicts.”
2. Create another:
   - “On commit, run the unit tests.”
3. Trigger at least one agent manually and check the run history.

What to look for:
- Agent run rows, status, per-action results, and timestamps.

## Step 5: Create 4 Lanes (Worktrees) In Lanes Tab

In **Lanes**:
1. Create lanes: `lane-tax`, `lane-coupon`, `lane-i18n`, `lane-request-id`.
2. Open all 4 lanes in tabs (center pane).
3. In each lane, open **Terminals** sub-tab and create a tracked session.

What to look for:
- Each lane has its own worktree under `.ade/worktrees/...`
- Lane status row updates (dirty, ahead/behind, conflict badge)
- Inspector → Packs shows lane/project packs per lane

Optional (stacks/restack showcase):
- Instead of creating all lanes from `main`, create `lane-coupon` using **Create Child Lane** off `lane-tax`.
- Make a small commit in `lane-tax`, then click **Restack** in `lane-coupon` and observe:
  - the rebase operation in History
  - conflict behavior when the parent and child touch the same lines

## Step 6: Make Conflicts Inevitable (Edit The Same Hot Spots)

You can do these edits in **Files** (recommended) or using the **Lanes Diff** quick-edit + Save.

The easiest way to guarantee line-level conflicts is to ensure every lane edits the same baseline snippet in `src/receipt.js`:

```js
const subtotalCents = order.qty * order.priceCents;

lines.push(`Item: ${order.item} x${order.qty} @ ${formatMoneyCents(order.priceCents)}`);
lines.push(`Subtotal: ${formatMoneyCents(subtotalCents)}`);
```

And also edits the same call site in `src/router.js`:

```js
const receipt = buildReceipt(order, { theme: "classic", requestId: null });
```

### Lane: `lane-tax`

Goal: add tax + total.

Edit `src/receipt.js` in `buildReceipt()`:
- Add `taxRateBps` default (825)
- Add `Tax:` and `Total:` lines

Edit `src/router.js` in `handleOrder()`:
- Pass `taxRateBps: 825` into `buildReceipt(order, opts)`

### Lane: `lane-coupon`

Goal: add coupon discount.

Edit `src/receipt.js` in `buildReceipt()`:
- Read `opts.couponCode`
- If coupon is `TENOFF`, subtract 10% from subtotal and print a `Discount:` line

Edit `src/router.js` in `handleOrder()`:
- Accept `couponCode` from JSON payload and pass it to `buildReceipt`

### Lane: `lane-i18n`

Goal: locale-aware money formatting.

Edit `src/receipt.js`:
- Change `formatMoneyCents(cents)` to accept `opts` and use `Intl.NumberFormat`
- Update all calls to pass `opts`

Edit `src/router.js`:
- Accept `locale` from JSON payload and pass it to `buildReceipt`

### Lane: `lane-request-id`

Goal: request IDs + theme plumbing.

1. Add `src/requestId.js`:

```js
"use strict";
const crypto = require("node:crypto");

function createRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = { createRequestId };
```

2. Update `src/router.js`:
- Generate a requestId per request and pass it to `buildReceipt`
- Accept `theme` from JSON payload and pass it through

3. Update `src/receipt.js`:
- Include requestId in the banner (or keep the existing “Request:” line but make it consistent)

## Step 7: Terminals + Session Deltas (Prove ADE Is Tracking Reality)

For each lane:
1. Run `npm test` in a tracked terminal session.
2. End the session (close terminal or exit).

Then in **Terminals** (global tab):
- Filter by lane and inspect the session delta card (files changed, insertions/deletions, failure lines).

Optional (to show privacy controls):
- Create a **New Terminal (Untracked)** session and run a few commands (ex: `env | head`).
- Confirm the session is marked untracked and does not drive pack refresh.

## Step 8: Packs Tab (Watch Context Evolve)

In each lane’s **Inspector → Packs** tab:
1. Use the **Lane / Project** toggle and skim both packs.
2. Click **Refresh** (deterministic) and confirm freshness timestamps update.
3. Click **Activity**:
   - Confirm you see `refresh_triggered`, `version_created`, and `checkpoint` events after session end.
   - Use **View operation** on an event to jump into **History**.
4. Click **Versions**:
   - Pick two versions and **Run Diff** to see context evolve as work progresses.

Context contract drill (shows marker-preserving context):
1. In the Pack Viewer, copy the pack file path shown under the pack body (it ends in something like `.ade/packs/lanes/<laneId>/lane_pack.md`).
2. Go to **Files** and open that pack markdown file.
3. Edit only content between markers:
   - `<!-- ADE_TASK_SPEC_START -->` / `<!-- ADE_TASK_SPEC_END -->`
   - `<!-- ADE_INTENT_START -->` / `<!-- ADE_INTENT_END -->`
   Add a real checklist for this lane’s work.
4. Go back to **Inspector → Packs**, click **Refresh**, then:
   - Confirm your Task Spec/Intent edits are preserved.
   - Open **Versions** and diff before/after to see deterministic sections change while marker sections persist.

AI details (Hosted/BYOK only):
- Click **Update pack details with AI** and watch:
  - the Hosted Health panel in the Pack Viewer for job status
  - `narrative_requested` / `narrative_update` events in **Activity**

## Step 9: Conflicts Tab (Predict Before You Merge)

In **Conflicts**:
1. Open the risk matrix and confirm you have orange/red cells between the four lanes.
2. Click a high-risk pairing and inspect overlapping files.
3. Run a merge simulation: `main` (Primary) vs one lane.

What to look for:
- conflict status badges on lane rows
- overlap lists (should include `src/receipt.js` and `src/router.js`)
- deterministic prediction artifacts on disk under `.ade/packs/conflicts/predictions/<laneId>.json` (use Files tab to inspect if you want)

AI proposal flow (if Hosted/BYOK):
1. Pick a lane, then select a peer lane in the proposal panel.
2. Click to **Prepare** context (preview) and confirm the file list looks right.
3. Click **Send to AI** (or **Reuse proposal** if it already exists).
4. Apply using one of:
   - **Apply** (unstaged/staged/commit mode)
   - **Apply + Continue** (when you are mid-merge or mid-rebase)
5. If the diff is wrong, use **Undo** to back it out (then try again).

## Step 10: Graph Tab (Orchestrate The Whole Mess)

In **Graph**:
1. Verify all lanes appear as nodes.
2. Switch view modes: Stack / Risk / Activity / All.
3. Click risk edges to open merge simulation.
4. If proposals are available, generate one from the graph panel and preview the diff.

Optional (worktree model showcase):
1. In any terminal (Primary lane is fine), create an external worktree:

```bash
cd /tmp/conflict-cafe
git worktree add ../conflict-cafe-attached -b attached-playground
```

2. In **Lanes**, attach that worktree as an **Attached** lane.
3. Confirm it renders differently in Graph (and can be filtered independently).

## Step 11: Integrate Using 4 Different Methods

You’re going to land everything into `main`. Expect conflicts.

### Method A: PR Land With Merge Commit (`lane-tax`)

In **PRs**:
1. Create a PR for `lane-tax`.
2. Ensure the description is drafted from packs (when enabled).
3. Choose merge method: **merge commit**.
4. Land it.

### Method B: PR Land With Squash (`lane-coupon`)

Repeat the above for `lane-coupon`, but choose merge method: **squash**.

When it conflicts:
- Use **Conflicts** to generate a proposal (or use the **Graph** conflict panel).
- Apply the proposal into the target lane, then re-run tests and retry landing.

### Method C: Rebase Then Land (`lane-i18n`)

In **Lanes** (lane tab for `lane-i18n`):
1. Pull (rebase) so your branch replays on top of updated `main`.
2. If a rebase conflict occurs, resolve it using:
   - **Files** tab: conflict mode (3-way), or
   - **Conflicts** proposals if available
3. Push the lane, then land it via PRs.

### Method D: Cherry-Pick (ADE UI) (`lane-request-id`)

In **Lanes**:
1. Open `lane-request-id` and ensure its changes are committed.
2. Copy the commit SHA from the recent commits list.
3. Switch to the **Primary (main)** lane and use **Cherry-pick** to apply it.
4. Resolve conflicts (if any) using **Files** conflict mode and/or **Conflicts** proposals.

## Step 12: History Tab (Audit What Just Happened)

In **History**:
1. Filter by lane and inspect:
   - merges / rebases / cherry-picks
   - pack refresh operations
   - automation runs (if they emit operation records)
2. Pick one operation and confirm the pre/post SHA is meaningful.

## Step 13: Cleanup (Archive/Delete Lanes)

In **Lanes**:
1. Archive the four lanes.
2. Optionally delete their worktrees.

In **Graph**:
- Confirm archived lanes disappear (or are dimmed), depending on filter settings.

## Expected End State (Sanity Check)

After all integrations:
- `npm test` should pass on `main`
- `POST /order` should still return a receipt
- The receipt should incorporate (at least):
  - a requestId
  - theme
  - coupon discount (when provided)
  - tax + total
  - locale-aware currency formatting (when provided)

## Notes On “Inevitable Conflicts”

If you are not seeing conflicts:
- Ensure every lane edited the same lines in `src/receipt.js` and `src/router.js`
- Ensure you committed changes per lane (conflict prediction runs off real git state)
- Ensure conflict prediction is enabled (automation agents can help keep it up to date)

## Step 14: Pack + Context Hardening Verification (Refined)

Use this step to validate the new context reliability behavior, not just the UI flow.

Detailed playbook:
- `/Users/arul/ADE/docs/guides/ADE_PACK_CONTEXT_VALIDATION_PLAYBOOK.md`

### Quick UI checks (during this activity)

1. In **Inspector → Packs** for an active lane:
- Run deterministic refresh.
- Confirm Activity includes refresh/version events.
- Confirm marker edits (`ADE_TASK_SPEC`, `ADE_INTENT`) survive refresh.

2. In **Conflicts** for a risky pair:
- Click **Prepare**.
- Confirm the preview includes the specific overlapping files you touched (`src/receipt.js`, `src/router.js`).
- If proposal is blocked, confirm you get an explicit data-gap message (not a speculative patch).

3. In **Settings → Hosted** (if Hosted/BYOK enabled):
- Confirm mirror sync status fields update after **Sync Mirror Now**.
- Confirm cleanup status fields update after **Clean Mirror Data**.
- Watch counters:
  - `context fallback count`
  - `insufficient-context job count`
- Confirm staleness reason is visible when mirror data is old.

### Quick automated checks (ADE repo)

From the ADE repository root:

```bash
cd /Users/arul/ADE/apps/desktop
npm test -- \
  src/main/services/hosted/hostedContextPolicy.test.ts \
  src/main/services/hosted/contextResolution.test.ts \
  src/main/services/hosted/mirrorCleanupPlan.test.ts \
  src/main/services/hosted/promptProvenance.test.ts \
  src/main/services/conflicts/conflictService.test.ts \
  src/main/services/packs/packDeltaDigest.test.ts \
  src/main/services/packs/packExports.test.ts \
  src/main/services/packs/packService.docsFreshness.test.ts
```

Pass condition:
- All tests pass.
- You can point to at least one UI run where the new context/pack telemetry moved as expected.
