---
name: test
description: 'Prove the new code works: enforce the logging/PostHog ground truth, prune dead tests, consolidate fragments, add only tests that prove new contracts, turn accepted /quality correctness findings into named regression tests, then run CI-mirrored shards. Also keeps docs/mobile/CLI/TUI parity in lockstep.'
---

# /test — Test Suite Steward

You are the test steward for ADE. In the dev loop you run after `/quality`, before `/ship`.

**Your job is NOT "add tests for the new code."** It is to leave the test suite *more truthful and smaller* whenever possible. New tests are a last step, not the goal.

The suite has bloated for three reasons. You exist to fight all three:

1. **Dead tests linger** after features are ripped out or refactored.
2. **One feature is fractured across many tiny test files** instead of tested as a feature.
3. **Trivial / over-mocked / always-passing tests** are added that catch nothing.

Every run does three passes in this order: **PRUNE → CONSOLIDATE → ADD**. You may finish at any pass — adding is optional.

**Consume the `/quality` result.** A non-empty `/quality` gate blocks this skill:
the branch still contains a verified finding awaiting an author decision, and
committing a knowingly failing test is not a substitute for fixing it. Resume
after the decision and the corresponding `/quality` fix.

Build a correctness inventory from the completed quality summary. Itemize
**every accepted correctness finding** by a stable finding name and original
`file:line`; aggregate counts such as "5 findings covered" are not sufficient.
For each item, provide exactly one of:

- a named regression test that pins the public contract and would fail on the
  pre-fix behavior, or
- an explicit alternate verification: the exact command/check, the observed
  evidence, and why a regression test is not appropriate.

Existing coverage counts only when you name the specific test and confirm that
it exercises the finding's failure mode. Structural maintainability findings do
not require artificial tests when existing coverage already proves the
behavior-preserving move. No quality result available → derive the same
itemized correctness inventory from the diff and state that quality evidence
was unavailable.

**Run the way CI would.** After the suite work, run only the affected shards, never the full suite (that's `/finalize`'s local gate and `/ship`'s remote CI). Verify every new/edited test file matches a vitest workspace glob so CI actually picks it up.

---

## Logging and analytics gate (always runs)

`docs/logging.md` is ADE's ground truth for operational logging and PostHog product analytics. Before Pass 1:

1. Verify `docs/logging.md` exists and read it in full. A missing file is a failed `/test` run, not an optional docs gap.
2. Review the entire branch diff for meaningful new user decisions, successful mutations, coarse workflow outcomes, screens, or product-level failure categories on desktop, runtime/API, hosted web, TUI, native iOS, and the public site.
3. For applicable behavior, verify it is captured at the durable owner boundary using the existing closed taxonomy, sanitizers, consent path, deduplication, and hard local budgets. Prefer `ade_feature_used` plus coarse properties over a new top-level event. High-frequency reads, renders, polling, streaming, terminal bytes, progress, and retries must be aggregated locally or left untracked.
4. If the change is not analytics-applicable, record the concrete reason in the summary. "No analytics changes" without inspecting the behavior is not sufficient.
5. When the analytics contract changes, update `docs/logging.md`, the relevant allowlists and boundary tests, and `scripts/posthog/dashboard-spec.mjs` when a dashboard depends on the change. Validate the provisioner spec and tests.
6. Confirm no personal PostHog key, public token value, arbitrary user content, raw identifier, path, URL, log message, error message, or recording can enter the diff or outgoing payload.
7. Confirm the change does not increase a global analytics ceiling merely to accommodate a new call site. State the worst-case event volume and the tighter event/key/deduplication limit that contains it.
8. For `apps/web`, preserve direct browser-to-PostHog capture. Do not add Vercel Functions, Edge Functions, Web Analytics, log drains, or a proxy for product events; Preview and Development should remain unconfigured so internal traffic does not consume quota.

The gate applies even when the branch's main purpose is unrelated to analytics. Future agents should leave ADE with broad, decision-useful coverage and a small, predictable event budget.

---

## Execution Mode: Autonomous

Run end-to-end without user interaction. Do not ask, pause, or request clarification — make judgment calls and note assumptions in the final summary. Stop only on a fatal blocker (e.g. cannot determine the changed feature at all).

**Do all the work yourself in the main loop.** Do NOT spawn parallel tester sub-agents — that pattern is what produced the current bloat (more agents → more files → more tests). One agent, one judgment.

**Arguments:** `$ARGUMENTS` — optional feature hint plus optional
`--base <ref>` (for example `/test prs --base codex/stack-parent`). If the
feature hint is empty, infer it from `git diff "$TEST_REVIEW_BASE" --name-only`
**plus `git status --short`** (the latter catches new untracked test/source files
that the tracked diff omits).

### Review scope (ordinary and stacked PRs)

Resolve the review base once before Pass 1. Use the same precedence and
normalization as `/quality`: explicit `--base`, existing PR `baseRefName`, the
current parent from `gh stack view --json`, trusted `ADE_REVIEW_BASE_REF`, then
`main`. Normalize `refs/heads/`, `refs/remotes/origin/`, `origin/`, and plain
branch spellings to a validated plain name. Reject other remotes, symbolic refs,
revision syntax, or anything failing `git check-ref-format --branch`.

Do not stop after an existing PR supplies `baseRefName`; still query `gh stack
view --json`. Set `TEST_EXACT_BASE=true` when the current branch is in that
stack (including a bottom layer targeting `main`) or when the PR targets a
non-default branch. Only an ordinary unstacked PR targeting the repository
default branch retains merge-base behavior. PR and stack parent names/SHAs must
agree when both exist.

```bash
# TEST_BASE_REF is the validated, normalized plain branch name selected above.
# TEST_EXACT_BASE is true for --base, stack metadata/trusted state, a
# non-default PR base, or a PR confirmed in gh-stack.
git check-ref-format --branch "$TEST_BASE_REF"
git fetch origin "refs/heads/$TEST_BASE_REF:refs/remotes/origin/$TEST_BASE_REF"
TEST_BASE_SHA=$(git rev-parse "origin/$TEST_BASE_REF")
if [ "$TEST_EXACT_BASE" = true ]; then
  git merge-base --is-ancestor "$TEST_BASE_SHA" HEAD || {
    echo "stack-coordinator-sync-required: direct parent is not an ancestor of HEAD"
    exit 1
  }
  TEST_REVIEW_BASE="$TEST_BASE_SHA"
else
  TEST_REVIEW_BASE=$(git merge-base HEAD "$TEST_BASE_SHA")
fi
```

Every pass below uses `TEST_REVIEW_BASE`. It must be the current stack entry's
direct parent. When stack metadata is available, require its parent SHA to
equal `TEST_BASE_SHA`; a branch-name match is insufficient. Record parent
branch/SHA, merge-base, exact tested head SHA and
tree SHA, test-evidence SHA, status, and proof links in the summary. Any commit,
rebase, branch change, or lower-parent movement invalidates that evidence and
all evidence above it. A missing or unfetchable parent is a blocker, not
permission to fall back to `main`.

### Host parity and evidence binding

Classify affected behavior across **Windows**, **macOS**, **Linux/headless**,
**iOS**, and **hosted web**. Mark each host applicable, capability-blocked, or
not applicable with a concrete reason; do not use one desktop run as proof for
the matrix. GUI proof requires both (1) direct UI observation and (2) an
independent corroborating log, database, process, IPC, or network signal. Bind
every artifact/link to the exact tested commit SHA and content-tree SHA. A new
commit or rebase makes prior GUI and Computer Use evidence stale even when the
visible diff looks unrelated.

---

## Pass 1: PRUNE (always runs)

Goal: delete tests that no longer earn their place. Verify before each delete.

### 1a. Orphaned tests — sibling source is gone

For every `*.test.ts` / `*.test.tsx` in the changed feature folder AND its parents:

- If the expected sibling source file does not exist (`foo.test.ts` with no `foo.ts`), the test is orphaned.
- If imports in the test resolve to nothing (symbol no longer exported anywhere), the test is orphaned.

**Verify** with `ls` + `grep` for the imported symbols across `apps/`, then `git rm` the file. Do not delete on suspicion alone.

### 1b. Skip / todo / only — committed bit-rot

- `it.skip(...)` / `test.skip(...)` / `it.todo(...)` / `it.only(...)` left in committed code → delete the block (or remove the marker if the test is actually live and someone forgot).
- Exception: `it.skipIf(...)` is conditional on env (FTS, CRSqlite, OS) — leave it.

For each `.skip` you find, check whether the underlying feature still exists. If gone, delete the block. If alive but skipped, that's a bug — either re-enable or delete with a one-line note in the summary.

### 1c. Anti-pattern tests — pass even when broken

Search the suite (or at minimum the changed feature folder) for:

- `expect(true).toBe(true)` and equivalents — delete the test or rewrite to assert what the comment claims.
- Test bodies with zero `expect(...)` — delete or fix.
- `if (!x) return` inside a test body → silent pass when setup fails. Replace with `expect(x, "setup precondition").toBeTruthy()`.
- A test file where `vi.mock(` count > `expect(` count — over-mocked; the test is mostly fixture. Either trim mocks or delete.
- `expect(x).toBeDefined()` / `toBeTruthy()` on a value just constructed two lines above — TS already proves this. Replace with a real behavioral assertion or delete.
- `await Promise.resolve()` immediately followed by `expect(...)` with no real async work in between — fake-async. Verify the test actually exercises the async path; if not, delete.

### 1d. Trivial-assertion files

Spot files where 20+ tests assert constants exist, enum keys are defined, or formatters return strings starting with `#`. Collapse to 1–2 parameterized cases or delete.

### 1e. Render-only React tests

`*.test.tsx` that only `render()` then `getByText` with no interaction or behavior — brittle, low signal. Delete or rewrite as a behavior test.

**At end of Pass 1:** record what was deleted (file + reason) for the summary. Run the affected workspace shard once to confirm nothing else broke (`cd apps/desktop && npx vitest run --shard=1/8`, plus the shard the deletions live in).

---

## Pass 2: CONSOLIDATE

Goal: reduce "many small files for one feature" into feature-level suites.

### 2a. Map the feature folder

For the feature touched by this branch, list every `*.test.*` file in the same service folder. Count `it(` blocks per file.

### 2b. Consolidation triggers

Merge files into one feature suite when ANY of these holds:

- A folder has **>5 test files averaging <15 cases each**.
- Two test files cover the same module from different angles (e.g. `prService.test.ts` + `prService.mergeContext.test.ts`).
- A test file exists for a single internal helper that is only used by one parent module — fold it into the parent's test file.

When merging: keep the assertions that test public contracts, drop ones that re-test internal helpers already covered, name the result after the feature (`prService.test.ts`, not `prService.minorThing.test.ts`).

### 2c. Hard rule — no new sibling files

When Pass 3 wants to add tests, you MUST extend the largest existing test file in the feature folder if one covers the same module. Create a new file ONLY if no existing file covers the module.

### 2d. Anti-fragmentation budget per folder

A feature folder gets ONE test file per major contract. Use this budget:

| Folder size (source files) | Max test files |
|---|---|
| 1–5 source files | 1 test file |
| 6–15 source files | up to 3 test files (only if contracts genuinely diverge) |
| 16+ source files | up to 1 test file per major subsystem (read the README.md "Source file map") |

**If you exceed budget**, you MUST consolidate before finishing — do not leave the folder over budget. Naming pattern:
- `{service}.test.ts` — top-level service contract
- `{service}{Subsystem}.test.ts` — only if Subsystem is a distinct contract (e.g. `prGithubStack.test.ts`, `ctoWorkerLifecycle.test.ts`)

Forbidden naming patterns (these are fragmentation signals):
- `{service}.{minorThing}.test.ts` — folds a minor concern into its own file. Merge into `{service}.test.ts`.
- `{helper}.test.ts` for a helper used by only one parent — fold into the parent's test file.

---

## Pass 3: ADD (only if needed)

Goal: prove the feature's **public contract**. Not its internals.

### 3a. What to test

Identify the *contracts* the new feature introduces:
- New exported function → one test of its happy path, plus the realistic failure modes a caller will hit.
- New state machine / transition → one test per allowed transition, one for the rejected ones (parameterize).
- New IPC handler → request shape in, response shape out, one error path.
- New service wired into existing flows → one integration-level test that exercises the wiring, not 10 unit tests of each helper.

### 3b. Hard caps (override only with a one-line justification in the summary)

- **Max 1 new test file per feature.** Prefer extending an existing file. If extending would push that file past 300 `it(` blocks, that file itself needs consolidation review — flag it but still extend.
- **Max 15 new `it(` blocks total** for the whole feature. If you want more, you're testing internals.
- **Min 3 meaningful assertions per test** (not `toBeDefined` × 3).
- **No test of a private/internal helper** unless it has non-obvious branching that the public API can't easily reach.
- **No render-only React tests.** If the change is purely visual, do not add a test — say so in the summary.
- **Respect the per-folder file budget from Pass 2d.** Adding a new sibling test file to a folder already at budget is forbidden — you MUST extend an existing file instead, even if the fit is imperfect.

### 3c. Patterns

Before writing anything, read 1–2 existing tests in the **same folder** to copy: imports, mocking, setup/teardown, assertion style.

Rules:
- Colocated naming: `{module}.test.ts` next to `{module}.ts`.
- Never mock the module under test.
- Mock only at process boundaries: file system, network, child processes, Electron APIs, IPC.
- Tests must FAIL LOUDLY — assert preconditions explicitly.
- Use `node` environment unless DOM is genuinely required.

### 3d. Run as you write

After each test file is created or extended:

```bash
cd apps/desktop && npx vitest run <file>
```

Fix until passing before moving to the next.

---

## Parity Passes (4–7)

After the test-suite work above, run four parity reviewers that keep docs, iOS, the CLI, and the TUI in lockstep with the desktop changes on this branch. They are independent of one another and of Passes 1–3.

**Preferred: TeamCreate** for these four passes so progress is tracked and a single completion event surfaces the batch. Per the global git-worktrees policy, do not pass worktree isolation. Fallback: parallel `Agent` calls in a single tool-call round if TeamCreate is unavailable.

---

## Pass 4: DOCS

The internal docs live under `docs/` with this structure (rebuilt; do NOT confuse with the public Mintlify site at repo root `docs.json` + `*.mdx`):

```
docs/
├── README.md                          # navigation map
├── PRD.md                             # product entry point — links to every feature
├── ARCHITECTURE.md                    # consolidated system architecture
├── OPTIMIZATION_OPPORTUNITIES.md      # backlog (append-only)
└── features/
    ├── agents/              ├── memory/
    ├── automations/         ├── onboarding-and-settings/
    ├── chat/                ├── personal-chats/
    ├── computer-use/        ├── pull-requests/
    ├── conflicts/           ├── sync-and-multi-device/
    ├── context-packs/       ├── terminals-and-sessions/
    ├── cto/                 ├── workspace-graph/
    ├── files-and-editor/
    ├── history/
    ├── lanes/
    └── linear-integration/
```

Each `features/<name>/` contains a `README.md` (overview + source file map at top) plus 1–4 detail `*.md` files.

Spawn a general-purpose agent with this prompt:

```
You are the documentation updater for the ADE project.

Analyze all changes on the current branch vs the resolved review base and update relevant internal
docs under `docs/`. The public Mintlify site (docs.json + root-level .mdx files)
is out of scope — do NOT touch it.

Step 1: Get changed files
  git diff "$TEST_REVIEW_BASE" --name-only
  git diff "$TEST_REVIEW_BASE" --stat | tail -30

Step 2: Map changed source to internal docs

| Source Directory                                   | Doc Location                                       |
|----------------------------------------------------|----------------------------------------------------|
| apps/desktop/src/main/services/projects/           | docs/features/onboarding-and-settings/             |
| apps/desktop/src/main/services/proof/              | docs/features/proof.md                             |
| apps/desktop/src/main/services/review/             | docs/features/pull-requests/                       |
| apps/desktop/src/main/services/prs/                | docs/features/pull-requests/                       |
| apps/desktop/src/main/services/lanes/              | docs/features/lanes/                               |
| apps/desktop/src/main/services/memory/             | docs/features/memory/                              |
| apps/desktop/src/main/services/cto/                | docs/features/cto/ (+ linear-integration/)         |
| apps/desktop/src/main/services/ai/                 | docs/features/chat/ + features/agents/             |
| apps/desktop/src/main/services/chat/               | docs/features/chat/                                |
| apps/desktop/src/main/services/automations/        | docs/features/automations/                         |
| apps/desktop/src/main/services/computerUse/        | docs/features/computer-use/                        |
| apps/desktop/src/main/services/context/            | docs/features/context-packs/                       |
| apps/desktop/src/main/services/conflicts/          | docs/features/conflicts/                           |
| apps/desktop/src/main/services/files/              | docs/features/files-and-editor/                    |
| apps/desktop/src/main/services/history/            | docs/features/history/                             |
| apps/desktop/src/main/services/onboarding/         | docs/features/onboarding-and-settings/             |
| apps/desktop/src/main/services/pty/                | docs/features/terminals-and-sessions/              |
| apps/desktop/src/main/services/sessions/           | docs/features/terminals-and-sessions/              |
| apps/desktop/src/main/services/processes/          | docs/features/terminals-and-sessions/              |
| apps/desktop/src/main/services/sync/               | docs/features/sync-and-multi-device/               |
| apps/desktop/src/main/services/config/             | docs/features/onboarding-and-settings/             |
| apps/desktop/src/main/services/ipc/                | docs/ARCHITECTURE.md (IPC section)                 |
| apps/desktop/src/main/services/git/                | docs/ARCHITECTURE.md (Git engine section) + lanes/ |
| apps/desktop/src/preload/                          | docs/ARCHITECTURE.md (IPC contract)                |
| apps/desktop/src/shared/                           | docs/ARCHITECTURE.md + touching feature's doc      |
| apps/desktop/src/renderer/components/<area>/       | docs/features/<same-area>/                         |
| apps/desktop/src/renderer/state/                   | docs/ARCHITECTURE.md (UI framework)                |
| apps/ade-cli/src/tuiClient/                        | docs/features/ade-code/README.md + docs/ARCHITECTURE.md (ADE CLI / Build/Test/Deploy) |
| apps/ade-cli/                                      | docs/ARCHITECTURE.md (ADE CLI / Build/Test/Deploy) + docs/features/agents/ |
| .github/workflows/                                 | docs/ARCHITECTURE.md (Build/Test/Deploy)           |
| apps/ios/                                          | docs/features/sync-and-multi-device/ios-companion.md |
| apps/web/                                          | docs/ARCHITECTURE.md (Apps & Processes)            |

Step 3: Update docs in place
- Prefer editing existing docs over creating new ones.
- If a feature gets a genuinely new sub-concept worth its own page, add a new detail doc inside the existing features/<name>/ folder.
- Keep each README.md's "Source file map" section current — it is the primary way an agent orients itself.
- Rewrite prose to reflect current reality (not a changelog of what changed).
- Remove outdated information.
- Do NOT add changelog sections, "Updated on X" notes, or dated markers.
- Do NOT modify docs/OPTIMIZATION_OPPORTUNITIES.md via this agent — it is append-only and human-curated.

Step 4: Run doc validation
  node scripts/validate-docs.mjs

This validator only covers the Mintlify site. For internal docs, self-check:
  - Every features/<name>/README.md still has a "Source file map" section.
  - PRD.md links resolve (grep for broken relative links).

Report what docs were updated and what was changed.
```

---

## Pass 5: MOBILE parity

Spawn a general-purpose agent with this prompt:

```
You are the mobile parity reviewer for the ADE project.

Analyze all work on the current branch vs the resolved direct review base, including changes that are
already under review and any simplifications made during `/finalize`. Determine
whether the iOS companion app under `apps/ios/` needs matching updates.

Step 1: Get branch context
  git diff "$TEST_REVIEW_BASE" --name-only
  git diff "$TEST_REVIEW_BASE" --stat | tail -30
  git log "$TEST_REVIEW_BASE"..HEAD --oneline

Step 2: Identify cross-platform changes
- Shared contracts: apps/desktop/src/shared/**, preload IPC types, sync payloads,
  PR mobile snapshots, chat/session models, lane summaries, config schemas.
- Desktop behavior with a mobile surface: PR workflows, lanes, Work chat,
  files, sync/multi-device, settings exposed on iOS, model/session controls.
- Renderer-only desktop preferences are only mobile-applicable when the iOS app
  has the same user-facing concept and a native implementation path.

Step 3: Inspect iOS equivalents
- Search `apps/ios/ADE` and `apps/ios/ADETests` for the affected model, view,
  service, or workflow names.
- If the branch adds or changes a host/mobile contract, update Swift Codable
  models and iOS tests as needed.
- If the branch touches sync hello features, remote command descriptors, host
  update flows, or any command ADE Mobile invokes, verify the compatibility
  contract: new iOS builds must still connect to older brains in limited mode,
  missing `features.mobileCompatibility` must not fail the handshake, and
  unsupported actions must be gated locally before queue/send.
- If the branch changes user-facing behavior that iOS already exposes, update
  the SwiftUI view using native iOS controls and existing ADE design patterns.
- If the change is not applicable to iOS, explain why in the report.

Step 4: Apply required iOS updates
- Keep edits scoped to `apps/ios/` unless a shared contract fix is required.
- Prefer existing SwiftUI patterns and native controls.
- Preserve Dynamic Type, VoiceOver labels, and 44x44 tap targets.
- Add or update targeted tests in `apps/ios/ADETests` for contract changes.
- For mobile-host compatibility, include tests for both a legacy host that omits
  `mobileCompatibility` and a host/action path that is explicitly unsupported.

Step 5: Validate what you touched
- At minimum: `xcrun swiftc -parse <changed swift files>` when a full Xcode
  build/test run is unavailable.
- Prefer an iOS build/test when the local simulator/runtime environment supports it.

Report:
- iOS files changed, or "No iOS changes required"
- Why each desktop/shared change was applicable or not applicable to mobile
- Validation run and any environment limitations
```

---

## Pass 6: CLI parity

The `apps/ade-cli/` package is the agent-facing surface for ADE. Every desktop
action should be reachable either through a typed subcommand (`ade lanes …`,
`ade prs …`, `ade chat …`, `ade tests …`, `ade run …`, `ade proof …`) or
through the generic `ade actions run <domain.action>` registry exposed by
`adeRpcServer.ts`. When a feature branch adds, renames, or removes a desktop
feature, the CLI silently drifts unless someone updates it in the same PR.
This agent closes that gap.

Spawn a general-purpose agent with this prompt:

```
You are the ADE CLI parity reviewer.

The ADE CLI (apps/ade-cli) is the primary agent-facing interface to the ADE
desktop app. Its goal is to surface every meaningful action inside ADE
desktop — either as a typed subcommand or via the generic
`ade actions run <domain.action>` registry. When desktop changes, the CLI
must change with it. Your job is to detect drift on this branch and patch
apps/ade-cli/ so the CLI stays in lockstep with desktop.

Step 1: Get branch context
  git diff "$TEST_REVIEW_BASE" --name-only
  git diff "$TEST_REVIEW_BASE" --stat | tail -30
  git log "$TEST_REVIEW_BASE"..HEAD --oneline

Step 2: Identify CLI-relevant desktop changes
Treat anything under these paths as a candidate for new / changed / removed
CLI surface:
- apps/desktop/src/main/services/**  (each service is a candidate action
  domain — lanes, prs, chat, tests, proof, run, git, files,
  automations, computerUse, context, conflicts, history, memory, onboarding,
  pty, sessions, processes, sync, config, cto, ai)
- apps/desktop/src/preload/**  and  apps/desktop/src/shared/**  (IPC and
  shared contracts the CLI ultimately calls through)
- New domains/actions registered with the action registry on either side

Step 3: Map each candidate to the CLI
- Typed subcommands live in apps/ade-cli/src/cli.ts (~3300 lines), a
  case-based dispatcher. Existing cases include lanes, git-status, prs-list,
  chat-list, tests-runs, proof-list, actions-list, action-result, etc.
  Locate the closest existing case block and either extend it or add a
  sibling case alongside it.
- The RPC + actions-registry surface lives in
  apps/ade-cli/src/adeRpcServer.ts (~6500 lines), with a no-desktop fallback
  in apps/ade-cli/src/headlessLinearServices.ts. New service actions usually
  need wiring in one or both so `ade actions run <domain.action>` resolves
  them whether or not the desktop socket is up.
- The user-facing inventory lives in apps/ade-cli/README.md under
  "CLI surface". Keep it accurate whenever a typed command is added,
  renamed, or removed.

Step 4: Apply auto-fix edits — scoped to apps/ade-cli/ only
- New feature: add a typed subcommand if the desktop feature is a distinct
  user-facing workflow (lane / PR / chat / test / run / proof /
  automation / etc.). If it is just a new low-level service action, ensure
  it is reachable via the actions registry and skip a typed wrapper.
- Renamed or behavior-changed feature: update the existing case to match
  new parameters, IPC names, or output shape. Keep flag names stable when
  possible — flag any breaking renames in the report.
- Removed feature: delete the dead case and any registry wiring. Do NOT
  leave a stub. Drop the corresponding README line.
- Reuse existing patterns: match surrounding cases for argv parsing,
  --text / --json output mode, error formatting, and --lane / --project-root
  argument handling. Do not invent new dispatch styles.

Step 5: Validate locally before reporting
  cd apps/ade-cli && npm run typecheck
  cd apps/ade-cli && npm test

If tests fail in files you did not touch, leave them — Phase 3 handles
test-suite drift. Do not rewrite unrelated tests.

Out of scope:
- Do NOT edit anything under apps/desktop/.
- Do NOT touch docs/ — the docs agent owns that.
- Do NOT refactor unrelated CLI code.

Report:
- apps/ade-cli/ files changed (or "no CLI changes required")
- For each branch change: desktop change → CLI change, or why not applicable
- Any breaking flag / command renames
- typecheck and test results
```

---

## Pass 7: TUI parity

`apps/ade-cli/src/tuiClient/` is the terminal client for `ade code`. It surfaces lanes, chats, git state, and slash commands in a 28-col Drawer + 38-col RightPane Ink UI. When desktop or ade-cli changes, the TUI must stay in lockstep — most commonly because a new git/lane/PR action becomes available, a slash command is renamed, or a lane summary field is added.

Spawn a general-purpose agent with this prompt:

```
You are the ADE TUI parity reviewer.

`apps/ade-cli/src/tuiClient/` is the terminal client for `ade code`. It surfaces lanes, chats, git
state, and slash commands in a 28-col Drawer + 38-col RightPane Ink UI.
When desktop or ade-cli changes, the TUI must stay in lockstep — most
commonly because a new git/lane/PR action becomes available, a slash
command is renamed, or a lane summary field is added.

Step 1: Get branch context
  git diff "$TEST_REVIEW_BASE" --name-only
  git diff "$TEST_REVIEW_BASE" --stat | tail -30

Step 2: Identify TUI-relevant changes. Treat as candidates:
- apps/desktop/src/shared/types/lanes.ts, /chat, /sync — TUI imports these directly.
- apps/ade-cli/src/adeRpcServer.ts new actions — should appear in BUILTIN_COMMANDS or via /ade.
- New IPC handlers in window.ade.git/.lanes/.app/.prs — TUI may want a slash command + right-pane action wrapper.

Step 3: Map to the TUI surface
- Slash commands: apps/ade-cli/src/tuiClient/commands.ts BUILTIN_COMMANDS.
- Slash dispatch: apps/ade-cli/src/tuiClient/app.tsx (search by name pattern, e.g. `if (name === "/push")`).
- Sidebar rendering: apps/ade-cli/src/tuiClient/components/Drawer.tsx.
- Right pane content kinds: apps/ade-cli/src/tuiClient/components/RightPane.tsx + types.ts (RightPaneContent union).
- ADE API calls: apps/ade-cli/src/tuiClient/adeApi.ts.

Step 4: Apply auto-fix edits — scoped to apps/ade-cli/src/tuiClient/ only.
- New action: add a BUILTIN_COMMANDS entry + dispatch case. Mirror existing
  shape (placement, argumentHint).
- Renamed action: rename in commands.ts and the dispatch handler. Keep the
  user-facing slash name stable when possible — flag breaking renames.
- Removed action: delete the BUILTIN_COMMANDS entry and its dispatch case.
- New LaneSummary or AgentChatSessionSummary fields: surface in Drawer.tsx
  if relevant to lane/chat list rendering, or in lane-details RightPane
  block if relevant to status.

Step 5: Validate
  cd apps/ade-cli && npm run typecheck
  cd apps/ade-cli && npx vitest run src/tuiClient

Out of scope:
- Do NOT edit apps/desktop/ or apps/ios/.
- Do NOT edit unrelated apps/ade-cli code unless the `ade code` launcher in apps/ade-cli/src/cli.ts must change with the TUI.
- Do NOT touch docs/ — the docs agent owns that.

Report:
- apps/ade-cli/src/tuiClient/ files changed (or "no TUI changes required")
- For each branch change: source change → TUI change, or why not applicable
- Any breaking slash-command renames
- typecheck and test results
```

Wait for all four parity agents to complete before moving to Verification.

### Windows parity and Computer Use evidence

If the review scope touches paths, processes, executables, local IPC, native
SQLite, startup services, or Computer Use, the test summary must include a
Windows evidence ledger:

- Run the narrow contract tests locally with injectable `win32`, `darwin`, and
  `linux` cases. Native Windows CI must repeat the Windows-sensitive files on a
  `windows-latest` runner; a Linux simulation alone is insufficient.
- Prove Stable/Beta service identity, per-user/channel pipe naming and listen
  restrictions, `.exe` and argument-array launch resolution, supervisor
  restart/backoff, runtime readiness and stale-PID diagnostics, and packaged
  SQLite/CRR loading whenever those owners changed.
- For Computer Use, list evidence by capability. Windows may explicitly report
  native screenshot/video/OS GUI control as unavailable; do not treat that as
  evidence that App Control or proof-file ingestion is unavailable. Test those
  platform-neutral paths independently.
- Record external evidence honestly. Installed Stable/Beta coexistence,
  second-account named-pipe denial, reboot/restart recovery, signed/installed
  upgrades, and real GUI captures require the corresponding Windows hosts.
  Attach artifact paths when available and list the missing proof as a blocker
  when it is not. Never replace host proof with a mocked assertion.
- Preserve macOS/Linux parity with parameterized contract tests and the
  existing CI shards. A Windows-specific pass does not waive regression
  coverage for launchd, Unix sockets, or Linux capability degradation.

---

## Verification

After all seven passes:

1. **Run the affected shards**, not the full suite (`/finalize` runs everything):
   ```bash
   cd apps/desktop && npx vitest run <new + edited test files>
   ```
   Plus rerun the shard(s) containing files you deleted from, in case a helper was depending on them:
   ```bash
   cd apps/desktop && npx vitest run --shard=<n>/8
   ```

2. **CI coverage check** — vitest workspace + CI are glob-based and shard 8-way (`.github/workflows/ci.yml` runs `npx vitest run --shard=${{ matrix.shard }}/8`). Any colocated `*.test.{ts,tsx}` file inside these globs is auto-picked-up; consolidating or deleting test files NEVER requires CI/workspace edits:
   - `unit-main`: `src/main/**/*.test.{ts,tsx}`
   - `unit-renderer`: `src/renderer/**/*.test.{ts,tsx}`
   - `unit-shared`: `src/shared/**/*.test.{ts,tsx}` and `src/preload/**/*.test.{ts,tsx}`

   MCP server tests live in `apps/mcp-server/` and are picked up by its own vitest config. Update workspace config ONLY if you introduce a path outside these globs (you shouldn't — colocated naming makes this automatic).

3. **Do not run** typecheck, lint, or the full sharded suite — that's `/finalize`'s job.

---

## Reference: where tests live & how to run them

**Desktop** (`apps/desktop/`) — Vitest workspace, 3 projects, `node` env, forks pool, 20s timeout:
- One file: `cd apps/desktop && npx vitest run <file>`
- One project: `cd apps/desktop && npx vitest run --project unit-main`
- Sharded (CI uses 8): `cd apps/desktop && npx vitest run --shard=1/8`

**Web** (`apps/web/`) — marketing site, no tests.

### Feature docs (read for context before adding tests)

| Changed source area | Feature doc |
|---|---|
| services/prs/, renderer prs/ | docs/features/pull-requests/ |
| services/lanes/, renderer lanes/ | docs/features/lanes/ |
| services/chat/, services/ai/, renderer chat/ | docs/features/chat/ + docs/features/agents/ |
| services/cto/, renderer cto/ | docs/features/cto/ + docs/features/linear-integration/ |
| services/memory/ | docs/features/memory/ |
| services/automations/, renderer automations/ | docs/features/automations/ |
| services/conflicts/ | docs/features/conflicts/ |
| services/computerUse/ | docs/features/computer-use/ |
| services/pty/, sessions/, processes/, renderer terminals/ | docs/features/terminals-and-sessions/ |
| services/files/, renderer files/ | docs/features/files-and-editor/ |
| services/sync/, syncRemoteCommandService | docs/features/sync-and-multi-device/ |
| services/onboarding/, services/config/, renderer settings/ | docs/features/onboarding-and-settings/ |
| services/history/ | docs/features/history/ |
| services/context/ | docs/features/context-packs/ |

Each `README.md` has a "Source file map" and a "gotchas / fragile areas" section. If something is flagged as fragile, that invariant deserves a test.

Cross-cutting: `docs/ARCHITECTURE.md` covers IPC, data plane, build/test/deploy — read when touching preload, `shared/ipc.ts`, or `registerIpc`.

---

## Summary (only output to the user)

Output exactly this — nothing else. No phase-by-phase narration.

```
## /test summary

Feature: <name or "inferred from diff">

Pruned:
- <N> orphaned test files removed: <paths>
- <N> .skip/.todo blocks removed: <file:test name>
- <N> anti-pattern tests fixed/removed: <paths + 1-line reason each>

Consolidated:
- <merged files → resulting file>, or "none"

Added:
- <new file or extended file> — <N tests covering: contract A, contract B>
- Or "none — feature was visual / fully covered by consolidation"

Quality correctness findings:
- <stable finding name> (`file:line`) — regression: `<test file> :: <test name>`
- <stable finding name> (`file:line`) — alternate verification: `<exact command/check>` → `<observed evidence>`; no regression test because <specific reason>
- Or "none — /quality accepted no correctness findings"

Parity:
- Logging/PostHog: <instrumentation/docs/dashboard changes, or explicit not-applicable reason> — privacy + cost gate PASS / blocked
- Docs: <files updated, or "none required"> — validation PASS / blocked
- Mobile: <iOS files changed, or "none required"> — validation PASS / blocked
- CLI: <apps/ade-cli files changed, or "none required"> — typecheck + tests PASS / blocked
- TUI: <apps/ade-cli/src/tuiClient files changed, or "none required"> — typecheck + tests PASS / blocked
- Breaking flag/command/slash renames: <list, or "none">

Verification:
- Affected files: PASS (<N> tests)
- Shard re-run: PASS

Notes / assumptions:
- <anything non-obvious>

Next: /ship  (run /finalize first if you want a full local CI gate before pushing)
```

---

## Completion rules

Mark **failed** if you cannot make a meaningful judgment about what changed.
Mark **partial** if Pass 1 left some tests still failing that you could not fix.
Mark **completed** only if all of:

1. Every change you made (delete, edit, add) leaves the suite green on the affected files.
2. No `.skip`/`.only`/`.todo` introduced.
3. No new test file mocks the module it tests.
4. No new test file relies on `expect(true)`-class no-ops.
5. Every new test file matches a vitest workspace glob.
6. The summary is the *only* thing you output.
7. `docs/logging.md` exists, was read, and every analytics-applicable change is covered or has an explicit not-applicable rationale.
8. Every accepted correctness finding from `/quality` appears individually in
   the summary with a named regression test or explicit alternate verification.
