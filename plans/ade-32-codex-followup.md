# ADE-32 — Codex migration followup (Tier A finish + design rework + cheap parity)

Status: proposed
Date: 2026-05-12
Predecessors: [`docs/codex migration plan.md`](../docs/codex%20migration%20plan.md), [`plans/ade-32-codex-v130-chat-parity.md`](./ade-32-codex-v130-chat-parity.md)

## Why this doc exists

Tier A landed end-to-end on `ade-32-update-codex-app-server-to-bring-new-codex-features`. An audit (4 agents covering wire, desktop renderer, TUI, and beyond-plan research) surfaced one critical wire bug, multiple design deviations from the original plan, two phases that didn't fully land (9 + 10), 15 silently-dropped event variants in the TUI formatter, and a meaningful "everything looks the same" design rot in the desktop renderer. This doc covers everything we'll finish before merging the migration.

The user also overrode plan §3.4 (drop the `--disable browser_use --disable computer_use` flags everywhere — they should be first-class) and §5.8 (kill the dedicated Codex history surfaces in both TUI and desktop — ADE's existing chat sidebar is the single source of truth).

## Scope at a glance

| Section | What | Effort |
|---|---|---|
| **A** | Wire fixes (browser/computer-use, plan-start event, compaction variant, chatTextBatching regression, Phase 10 opt-out) | S |
| **B** | Renderer extraction to dedicated `Codex*.tsx` files + real visual design pass | M-L |
| **C** | TUI rework (kill ResumePalette, fix 15 missing format cases, pin goal banner, 5-field token meter, plan glyphs, chat-budget fix) | M |
| **D** | Open-in-Codex-CLI button (desktop only, chooser popover) | S |
| **E** | Cheap CLI parity verification + `/side` + `Ctrl+O/L` | S |
| **F** | Cheap Tier B (deprecation channels, `thread/inject_items`, `completion_report`/`turn_diff_summary` rendering, `/review diff` variant) | S-M |
| **G** | Tests for everything new | S |

**Dropped from Tier A**: ResumePalette (TUI), HistoryModal (desktop), all user-facing thread-list UI, all `/fork` / `/rollback` / `/unarchive` / `/resume` slash commands. Auto-resume already works via `agentChatService.ts:16661-16728`; ADE's chat sidebar is the picker. The wire methods (`thread/list/read/fork/rollback/unarchive`) get removed from the service in this PR — they can come back in a future PR with a real UI consumer.

**Deferred to other branches / future PRs**: subagent rendering rewrite (separate branch in flight), MCP-in-app, Hooks UI, Plugins/Apps browser, realtime voice, environments, dynamic tools, memory mode.

---

## Section A — Wire fixes

### A.1 Drop `--disable browser_use --disable computer_use` everywhere
**File**: `apps/desktop/src/main/services/chat/agentChatService.ts:11611-11614`

Today these flags are nested inside the `if (missionCodexHome)` block. Mission sessions disable them; normal sessions don't (an accidental inversion). User's directive: drop both flags entirely. Users should never be locked out of Codex's first-class tools.

```diff
- if (missionCodexHome) {
-   appServerArgs.push("--disable", "browser_use", "--disable", "computer_use");
- }
```

Update the test that codifies the regression: `agentChatService.test.ts:2125-2135` should assert **neither flag is present** in `appServerArgs`.

### A.2 Plan event on `item/started`
**File**: `agentChatService.ts:10589-10609`

Today the `Plan` item is only normalized on `eventKind === "completed"`. Plan §5.1 says emit a `plan` event with `state: "active"` on `item/started` too, so the renderer's plan card mounts immediately. Fix: add an `item/started` branch that emits `{ type: "plan", state: "active", explanation: null, steps: [], streamingText: "" }`.

Also align state literals. The implemented union in `chat.ts` uses `"active" | "delta" | "updated" | "complete"` to distinguish streaming deltas from structured updates; keep renderers exhaustive across all four states, or narrow the union only if Codex no longer needs those intermediate states.

### A.3 Distinct `codex_context_compaction` variant
**Files**: `apps/desktop/src/shared/types/chat.ts`, `agentChatService.ts:10579-10585`

Current implementation reuses the existing `context_compact` event with `trigger: "auto"` hardcoded — loses the start-of-compaction boundary and the manual-vs-auto distinction. Add a distinct `codex_context_compaction` variant per plan §5.2:

```ts
| {
    type: "codex_context_compaction";
    turnId: string;
    state: "started" | "completed";
    trigger: "manual" | "auto";   // 'manual' when triggered by /compact slash
  }
```

`thread/compact/start` → set `trigger: "manual"` on the started event. Other compaction triggers → `trigger: "auto"`.

### A.4 `chatTextBatching` plan no-flush regression
**File**: `apps/desktop/src/main/services/chat/chatTextBatching.ts:56-67`

The removed `case "plan_text"` no-flush branch was not re-added for the new `plan` events carrying `streamingText`. Plan deltas interleaved with assistant text now force-flush. Fix: add `case "plan"` to the no-flush set when `streamingText` is present.

### A.5 Phase 10 — `optOutNotificationMethods` for `--print`
**Files**: `agentChatService.ts:11820`, `apps/ade-cli/src/cli.ts:5132-5150`

Add `--print` flag to `ade chat send`. Thread `runtimeMode: "interactive" | "print"` through into the initialize handshake. When `print`, populate `optOutNotificationMethods` with the four delta methods from plan §5.10:

```ts
optOutNotificationMethods: [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
]
```

### A.6 Remove unused thread-list wire methods + slash routes
**File**: `agentChatService.ts:7981-8166`, `12082-12092`

Tear out:
- `/resume`, `/fork`, `/rollback`, `/unarchive` slash handlers
- `listCodexThreads`, `readCodexThread`, `forkCodexThread`, `rollbackCodexThread`, `unarchiveCodexThread` IPC handlers
- `adeActions/registry.ts` entries for the above
- `preload.ts` exposures
- `AgentChatCodexThread*` types in `chat.ts` (these become unused)
- `emitCodexTurnsPageNotice` (Phase 9 stub that never materialized)

`thread/resume` stays (used internally by auto-resume on session reopen at `agentChatService.ts:16661-16728`).

### A.7 Plan card streaming vs structured updates
**File**: `agentChatService.ts:11295-11305`

When both `item/plan/delta` (streaming text) and `turn/plan/updated` (structured steps) fire, the renderer can't tell them apart in the current event shape. Pass a discriminator: `state: "delta" | "updated"` so the renderer knows whether to append to `streamingText` or replace `steps[]`.

---

## Section B — Renderer extraction + visual rework (desktop)

Every Codex card from Tier A was inlined into `AgentChatPane.tsx` (+458 LOC) and `AgentChatMessageList.tsx` (+125 LOC). Extract them into dedicated files in `apps/desktop/src/renderer/components/chat/codex/`:

```
chat/codex/
  CodexPlanCard.tsx
  CodexGoalBanner.tsx
  CodexTokenFooter.tsx
  CodexImageGenerationCard.tsx
  CodexImageViewLine.tsx
  CodexContextCompactionChip.tsx
  CodexOpenInCliButton.tsx        (new — see §D)
  Dialog.tsx                       (new reusable primitive for any future modals)
```

### B.1 `CodexPlanCard.tsx`
**Replaces inline JSX at `AgentChatMessageList.tsx:2068-2118`.**

Visual:
- Violet `#A78BFA` accent on the card chrome (border-left or top rule).
- Unicode step glyphs `◐` (active) / `○` (pending) / `●` (complete) — match TUI exactly.
- Plain "Plan" header in sans-serif. **No uppercase mono caption.**
- Prose explanation tight above the steps (1.4 line-height).
- "Live thoughts" disclosure **collapsed by default**, shown as a small `▸ live` link in the bottom-right corner — not as a prominent block. The deltas are debug signal only.

```
┌── Plan ────────────────────────────────── ▾ ──┐
│  Refactor the auth middleware to split        │
│  session token storage from request           │
│  validation, per compliance ask.              │
│                                                │
│  ◐ Read existing middleware                   │
│  ○ Extract storage interface                  │
│  ○ Implement file-based + redis backends      │
│  ○ Wire middleware via DI                     │
│  ○ Update tests for both backends             │
│                                  ▸ live       │
└────────────────────────────────────────────────┘
```

Active step gets violet accent on its glyph **and** text. Other steps stay at `text-fg/70`.

### B.2 `CodexGoalBanner.tsx`
**Replaces inline JSX at `AgentChatPane.tsx:6564-6580`.** Also delete the inline duplicate at `AgentChatMessageList.tsx:2294-2307` and add `codex_goal_updated`/`codex_goal_cleared` to `HiddenTranscriptEvent` in `chatTranscriptRows.ts` — the banner is the truth, transcript rows are duplicate noise.

Visual:
- Amber `#F59E0B` accent (not emerald — emerald is overloaded for "completed").
- `◎` glyph (target) for the goal indicator.
- Objective text + truncation with **full-text tooltip** on hover.
- Token-budget progress bar: `ContextMeter`-style, sky base, amber overlay when `tokensUsed > tokenBudget * 0.85`.
- Right side: `tokensUsed / tokenBudget · timeUsedSeconds elapsed · status pill (active/paused/budget-limited/complete)`.
- Inline `✎ edit` / `✕ clear` icon buttons on the right.
- Clicking the objective turns it into an `<input>` for inline edit.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◎  Refactor auth middleware for compliance              ✎  ✕       │
│    ▓▓▓░░░░░░░░  2,341 / 50,000 · 4m 12s · active                   │
└─────────────────────────────────────────────────────────────────────┘
```

No `font-mono uppercase tracking` caption anywhere on this banner.

### B.3 `CodexTokenFooter.tsx`
**Replaces inline JSX at `AgentChatPane.tsx:6603-6619`.** Also delete the inline duplicate at `AgentChatMessageList.tsx:2309-2322`; add `codex_token_usage` to `HiddenTranscriptEvent`.

Visual:
- Render at the **bottom** of the chat column, after sub-panels (currently sandwiched between message list and file-changes — `AgentChatPane.tsx:6603-6650` reorder).
- Real context-window progress bar with cache-portion overlay (`cachedInputTokens / inputTokens`).
- `64%` numeric leads; bar follows.
- Last-turn breakdown: `+2.3k in · 1.1k out · 450 ✶` where `✶` = cached tokens.
- Same line shows `model · effort · sandbox-mode`.
- Sans-serif label (no uppercase mono).

```
┌─────────────────────────────────────────────────────────────────────┐
│  ◇ gpt-5 · medium · workspace-write                                │
│  64% ▓▓▓▓▓▓▓░░░░░  128k / 200k    +2.3k in · 1.1k out · 450 ✶     │
└─────────────────────────────────────────────────────────────────────┘
```

### B.4 `CodexImageGenerationCard.tsx`
**Replaces inline JSX at `AgentChatMessageList.tsx:2257-2292`.** Splits image-generation from image-view (currently merged).

Wire fix: add `savedPath: string | null` field to the `codex_image_generation` AgentChatEvent variant (`chat.ts:484-491`). Today `path` collapses into `result`; surface it separately so the Open button has somewhere to point.

Visual:
- Thumbnail (max 240×240, lazy-loaded) when `result` is `http(s)` / `data:` URL.
- File-path-with-icon when `result` is a local fs path (no `file://` prefix; renderer must handle this).
- "Open" button (`window.ade.shell.openPath(savedPath)`) when `savedPath` is set.
- Revised prompt as collapsed disclosure (default closed; opens with `▸ revised prompt`).
- Card chrome: fuchsia accent (existing — keep), no uppercase mono caption.

### B.5 `CodexImageViewLine.tsx`
**Replaces inline JSX at `AgentChatMessageList.tsx:2257-2292` (the imageView branch).**

Plan §5.5 calls for "inline single-line indented". Current implementation is a full bordered card. Fix: render as `      ↳ Viewing image: <basename>   ↗ open` — single line, indented to signal it's a tool call, with an open action on the right. Click opens via `openPath` for local files or `openExternal` for URLs.

### B.6 `CodexContextCompactionChip.tsx`
**Replaces inline JSX at `AgentChatMessageList.tsx:2505-2534`.**

Current implementation is closer to a hero card with horizontal rules. Plan §5.2 calls for "subtle notice". Pull to a small inline chip:

```
                                  ┌──────────────────┐
                                  │ ⟳ compacted      │
                                  └──────────────────┘
```

Tooltip on hover: `"Context compacted at {time} · trigger: {manual|auto}"`. No horizontal rules, no caption.

### B.7 `Dialog.tsx` primitive
**New file.**

Reusable portal-based modal: backdrop, Esc handler, outside-click close, focus trap. We don't have one today — `LinearIssueBrowser` rolled its own. Build a minimal one now so future modals (MCP browser, hooks list, plugins UI) don't each reinvent it.

API:
```ts
<Dialog open={open} onClose={...} title="..." maxWidth="lg">
  <DialogBody>...</DialogBody>
  <DialogFooter>...</DialogFooter>
</Dialog>
```

Single use this PR: nothing. (HistoryModal got cut.) Building it now is forward-looking; if we want to defer, that's fine — but the audit flagged that we lack the primitive.

### B.8 Web search action list
**File**: `AgentChatMessageList.tsx:2235-2250`

- Remove the `slice(0, 4)` silent truncation. Show all actions; if `> 8`, render a "+N more" disclosure.
- Bump chip readability: drop the `text-[length:calc(var(--chat-font-size)*9/14)]` 9px font and `text-fg/45` 45% opacity. Use 12px at 70% opacity minimum.

### B.9 Composer paste interception
**File**: `AgentChatComposer.tsx:2280-2282`

Today: any pasted text ending in `.png/.jpg/...` gets silently converted to an image-url attachment, swallowing the paste. Fix: only intercept when:
1. The clipboard payload is **exactly** a URL (no other text before/after).
2. Show a small toast / inline notice: "Image URL attached" with an undo affordance.

### B.10 Image-URL attachment thumbnail
**File**: `ChatAttachmentTray.tsx:357-389`

Image-URL chips today are `Globe + hostname` text. For an image URL, render a real `<img>` thumbnail (32×32, lazy-loaded, `onerror` falls back to icon). Truncate URL underneath.

---

## Section C — TUI rework

### C.1 Delete ResumePalette
- Remove `apps/ade-cli/src/tuiClient/components/ResumePalette.tsx` entirely.
- Remove ResumePalette imports, state, render, keybinds (`Ctrl+R`, `Ctrl+G`, `Ctrl+F`, `Ctrl+U`, `Tab`-to-resume) from `app.tsx:2687-3020`.
- Remove `listCodexResumeThreads`, `resumeCodexThread`, `forkCodexThread`, `rollbackCodexThread`, `unarchiveCodexThread` methods from `adeApi.ts:336-391`.
- Remove `/resume` from `BUILTIN_COMMANDS` (`commands.ts`).
- Ctrl+R remains free for future use (reverse-search nice-to-have).

### C.2 Add 15 missing `format.ts` cases
**File**: `apps/ade-cli/src/tuiClient/format.ts:272-427`

The shared union has 32 variants; current formatter handles 17. Add minimal cases for the rest so events stop falling through silently:

- `status` → `[status] {turnStatus}` line, tone by status
- `error` → `[error] {message}` line, `tone: "error"`
- `done` → end-of-turn marker line with usage summary
- `activity` → activity indicator inline pill
- `tokens` → routes to `latestTokenStats` (same as `codex_token_usage`)
- `cloud_artifact` / `cloud_status` → notice lines
- `step_boundary` → horizontal rule with step label
- `todo_update` → checklist diff
- `subagent_started` / `subagent_progress` / `subagent_result` → **minimal one-line** rendering; the real subagent UX lands in the parallel branch. For now: `[agent] {description} ({status})`. Prevents the "subagents are invisible" failure mode.
- `structured_question` → routed to ApprovalPrompt-style overlay
- `tool_use_summary` → notice line
- `completion_report` → `[done] turn summary: {summary}` notice
- `auto_approval_review` → notice line
- `prompt_suggestion` → notice line with copy hint
- `turn_diff_summary` → `[diff] +{add}/-{del} across {files} files`
- `pending_input_resolved` → silent (suppressed)
- `delegation_state` → notice line

Add `system_notice` case `continue;` statement (latent bug noted in TUI audit).

### C.3 `/compact` and `/goal` builtins
**File**: `apps/ade-cli/src/tuiClient/commands.ts`

Add to `BUILTIN_COMMANDS`:
- `/compact` — invokes `thread/compact/start` via existing slash-routing
- `/goal` with subcommand parser:
  - `/goal` (no args) → show current goal
  - `/goal <objective text>` → set objective
  - `/goal clear` → clear
  - `/goal status active|paused` → set status
  - `/goal budget <N>` → set token budget (number)
  - `/goal budget clear` → clear budget (uses double-Option null semantics)

### C.4 Pin goal as amber banner beneath Header
**Files**: `apps/ade-cli/src/tuiClient/components/Header.tsx` (or new `GoalLine.tsx`), `app.tsx`

Today goal is rendered as a transient chat row at `format.ts:376-385` with `tone: "notice"` (gray). Fix:
- Add `latestGoal: CodexThreadGoal | null` to TUI session state (mirror of desktop `session.codexGoal`).
- Render a single amber line beneath Header when goal is set:
  ```
  ◎ Refactor auth middleware...   2.3k/50k · 4m · active
  ```
- Use `theme.color.warning` (amber `#F59E0B`).
- Truncate to terminal width.
- Remove the `format.ts` chat-row case for `codex_goal_updated`/`codex_goal_cleared` — the banner is the truth.

### C.5 Extended ContextMeter (5-field token breakdown + cached)
**File**: `apps/ade-cli/src/tuiClient/components/ModelStatus.tsx:14-26`

Current `ContextMeter` only shows context-window %. Extend to show last-turn input/output + cached marker:

```
◇ Codex · gpt-5 · medium · workspace-write     ▓▓▓▓▓▓▓░░░ 64%  +2.3k/1.1k (450✶)
```

Read `cachedInputTokens` / `cacheReadTokens` from `tokens` and `codex_token_usage` events in `adeApi.ts:347-391` (currently dropped — see TUI audit).

Drop the `codex_token_usage` chat-row case (`format.ts:386-398`) — footer is the truth.

### C.6 Plan card glyphs + active-step accent
**Files**: `apps/ade-cli/src/tuiClient/theme.ts`, `format.ts:338-352`

- Add `glyphFor(status)` helper in `theme.ts` returning `◐ / ○ / ●` for `inProgress / pending / completed`.
- Replace ASCII `> ✓ x -` glyphs.
- Active step uses `theme.color.accent` (`#A78BFA`); other steps `theme.color.notice` (gray).
- Match desktop's `CodexPlanCard` exactly for cross-surface consistency.

### C.7 Web search per-line action list
**File**: `format.ts:354-362`

Today: `actions.slice(0, 3).map(...).join(" · ")` — inline collapse destroys the structural distinction between action types. Fix: render each action on its own indented line per plan §5.6:

```
🔍 web search · "thread/turns/list pagination"
   search        thread/turns/list pagination
   openPage      github.com/openai/codex/.../thread.rs
   findInPage    "items_view" in thread.rs
```

### C.8 `h` key opens images
**File**: `app.tsx`

When the selected/most-recent chat line is `codex_image_generation` or `codex_image_view` (and `path`/`result` is a local file), pressing `h` spawns `open` / `xdg-open` / `start` for the path. Add the binding alongside existing PR-URL-open patterns at `app.tsx:2179`.

### C.9 Chat row budget fix
**File**: `app.tsx:3199-3218`

`chatRowBudget = rows - 12 - statusRows`. With `streaming=true`, budget drops to 11 on `LINES=24`. Resume palette is gone (saves 2 rows), but we should also:
- Move the standalone "streaming" Text row (`app.tsx:3216-3218`) into the prompt-box border as a small `· streaming` annotation. Saves 1 row.
- Drop the constant from 12 to 10 (recount overhead: Header 1 + ModelStatus 1 + FooterControls 1 + prompt-box border 3 + flex padding 2 = 8; mention/slash palettes add their own rows when active).

Target: 14-16 rows of chat scrollback on `LINES=24`.

### C.10 `--image-url <url>` and `--print` flags
**File**: `apps/ade-cli/src/cli.ts:5132-5150`

Add to `ade chat send`:
- `--image-url <url>` — appends an `image-url` attachment to the message
- `--print` — non-interactive mode; triggers Phase 10 opt-out (see §A.5)

---

## Section D — Open in Codex CLI (desktop only)

### D.1 Behavior

A button in the Codex chat header/toolbar. Visible when:
- Provider = Codex
- Session is **not** a mission (mission CODEX_HOME is ephemeral)
- `managed.session.threadId` is set

On click, a small popover with two options:
1. **In ADE terminal** — opens `ChatTerminalDrawer` (already exists per-chat), `cd`s to the lane worktree, runs the resume command in the lane's terminal pane.
2. **In new window** — spawns the user's default terminal app (`open -a Terminal` on macOS, `gnome-terminal` / `xdg-terminal` on Linux, `start cmd` on Windows) with the resume command.

### D.2 Resume command

Default to ADE's **bundled** `codex` binary (`resolveCodexExecutable()` returns the bundled path). Guarantees version match with the app-server that owns the thread.

Need to verify what flag form Codex CLI uses to resume a specific thread:
- `codex resume <threadId>` (likely)
- `codex --thread <threadId>`
- `codex` and rely on interactive `Ctrl+R` picker

**Implementation TODO**: probe `codex --help` at build time; spawn a one-shot subprocess and check stdout for the right flag. If neither flag exists, fall back to launching `codex` interactively and copying the thread ID to clipboard with a toast: "Thread ID copied — paste into Ctrl+R picker".

### D.3 Files

- New: `apps/desktop/src/renderer/components/chat/codex/CodexOpenInCliButton.tsx`
- New: `apps/desktop/src/main/services/chat/codexCliLauncher.ts` — handles cross-platform terminal spawn
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — IPC handler `codex:openInCli` with `{ sessionId, mode: "ade-terminal" | "new-window" }`
- `apps/desktop/src/preload/preload.ts` — expose `window.ade.codex.openInCli`
- `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` — mount the button in the chat header

---

## Section E — Cheap CLI parity verification

Most Codex CLI commands are SDK pass-throughs (`agentChatService.ts:509-562`): ADE lists them in the slash palette, user types them, Codex SDK handles them. This audit step confirms each pass-through actually works end-to-end. The risk: dead-listed commands where ADE shows them in the palette but Codex SDK ignores them (or vice versa).

### E.1 Verify each pass-through

Walk through every command in the registry — `/copy`, `/diff`, `/feedback`, `/init`, `/personality`, `/title`, `/clear`, `/fork`, `/keymap`, `/statusline`, `/vim`, `/experimental`, `/permissions`, `/agents`, `/apps`, `/plugins`, `/hooks`, `/mcp`, `/ide` — and run an integration smoke test (TUI + desktop):
- Type the command, hit enter.
- Capture any response (notification, item, error).
- Confirm the user-visible UX is reasonable (or document where it's not).

### E.2 TUI hotkeys
**File**: `app.tsx`

- `Ctrl+O` — copy latest assistant message to clipboard (uses `clipboardy` or `child_process.exec("pbcopy"...)`).
- `Ctrl+L` — clear viewport (clears the chat scrollback rendering, **does not** start a new thread).

---

## Section F — Cheap Tier B

These add no new UI pages but light up real Codex surfaces.

### F.1 Deprecation / warning notification channels
**File**: `agentChatService.ts` (new handlers in the notification dispatch block 10441-11021)

Codex emits four warning-channel notifications today:
- `deprecationNotice` — feature being removed
- `warning` — general warning
- `guardianWarning` — sandbox guardian flagged something
- `configWarning` — config issue

ADE silently logs these. Surface as `system_notice` rows:
- `deprecationNotice` → tone `warning`, prefix "⚠ deprecated:"
- `warning` → tone `warning`, prefix "⚠"
- `guardianWarning` → tone `error`, prefix "🛡 guardian:"
- `configWarning` → tone `notice`, prefix "⚙ config:"

Renderers already handle `system_notice` — zero new UI.

### F.2 `thread/inject_items` mid-session context
**File**: `agentChatService.ts` (new slash handler)

Adds a `/inject` slash that takes a multiline message and pushes it into thread history as a user item. Useful for "remember this for the rest of the thread" patterns. Renders as a small notice row: `[injected] {first line preview}`.

Composer: optionally add a small `+` menu entry "Inject context" that opens a textarea modal.

### F.3 `completion_report` and `turn_diff_summary` renderers
**File**: `AgentChatMessageList.tsx`

Both event variants exist in the union but have no renderer cases. Add:
- `completion_report` → quiet "turn summary" card at the end of long autonomy runs. Plain prose + report breakdown.
- `turn_diff_summary` → small chip showing `+{additions}/-{deletions} across N files` with click-to-open-diff.

### F.4 `/review` working-tree variant
**File**: `agentChatService.ts:7877`

Today only `review/start { target: { type: "prompt", ... } }` is wired. Extend to support `target: { type: "diff" }` (review the current working-tree diff) and `target: { type: "branch", name }` (review a branch).

Slash: `/review` (working tree) / `/review branch <name>` / `/review prompt <text>`.

---

## Section G — Tests

### G.1 Wire-shape tests
New in `agentChatService.test.ts`:
- `WebSearchAction::Other` catch-all renders without crashing.
- `image-url` attachment → `{ type: "image", url }` UserInput wire shape.
- `imageGeneration` + `imageView` item handlers emit correct events.
- Token-usage normalizer handles snake/camel aliases + 5-field breakdown including `cachedInputTokens` and `reasoningOutputTokens`.
- `thread/compact/start` request shape.
- `thread/goal/updated` and `thread/goal/cleared` notification handling.
- **Double-Option omit semantics**: `/goal pause` does NOT serialize `tokenBudget` field at all (use `expect(Object.keys(params).includes("tokenBudget")).toBe(false)`).
- Server-initiated request stubs return well-formed `-32601` errors.
- `optOutNotificationMethods` populated when `runtimeMode === "print"`.
- `--disable browser_use --disable computer_use` flags NOT present in spawn args (mission + normal).

### G.2 `codexExecutable.test.ts`
- `ADE_DISABLE_BUNDLED_CODEX=1` env disable flag falls through.
- `resourcesPath` walk (packaged Electron app).
- `app.asar.unpacked/node_modules/@openai` walk.

### G.3 TUI tests
**File**: `apps/ade-cli/src/tuiClient/__tests__/format.test.ts`

- New cases for each of the 15 added event variants (assert body substring + tone color).
- `system_notice` `continue;` regression.
- `latestTokenStats` reads `cachedInputTokens` / `cacheReadTokens`.

### G.4 No render-tree snapshot tests
Per `feedback_testing_quality.md`: real-value tests only. Visual changes don't get DOM snapshot tests — they're verified by manual smoke + screenshots.

---

## Sequencing

Phases are largely independent. Recommended order:
1. **A** (wire fixes) — unblocks everything else. ~1 day.
2. **B** + **C** in parallel — renderer extraction can happen alongside TUI rework (no shared files). ~2 days each, parallelizable.
3. **D** (open-in-CLI) — small standalone feature. ~half day.
4. **E** (CLI parity verification) — half day testing, half day fixing whatever's broken.
5. **F** (cheap Tier B) — ~1 day.
6. **G** (tests) — interleaved throughout, finalized at the end.

Estimated total: **4-5 days** focused work. Estimated total with the inevitable surprises: 6-7 days.

---

## Definition of done

- Critical disable-flag bug fixed; `browser_use` / `computer_use` available everywhere.
- Every `Codex*.tsx` component extracted to its own file under `chat/codex/`.
- Goal banner is amber, has edit/clear, persists above message list (not scrolled).
- Token footer has progress bar, last-turn breakdown, cache marker; renders at chat-column bottom.
- Plan card has violet accent, `◐/○/●` glyphs, active-step highlighted.
- Image generation card has Open button + `savedPath`.
- Image view is single-line inline.
- Web search shows all actions on separate lines.
- Composer paste interception is non-silent.
- Image-URL attachment shows a thumbnail.
- TUI: ResumePalette gone; 15 missing format cases added; `/compact` and `/goal` builtins; goal pinned as amber banner; ContextMeter shows 5-field breakdown + cache marker; plan glyphs match desktop; web search per-line; `h` opens images; chat budget ≥ 14 rows at LINES=24; `--image-url` and `--print` flags.
- Open-in-CLI button works for normal Codex sessions (hidden for missions).
- `/side` slash works; `Ctrl+O` / `Ctrl+L` hotkeys.
- Deprecation/warning channels surface as notices.
- `thread/inject_items` + `/inject` slash.
- `completion_report` / `turn_diff_summary` render.
- `/review diff` and `/review branch` variants.
- All §G tests pass under sharded `pnpm test`.
- Manual smoke checklist signed off in dev Electron build + dev TUI build.

---

## Open questions

1. **Codex CLI resume flag form** — does `codex resume <id>` exist? Need to probe at implementation start; fall back to interactive picker + clipboard if not. (§D.2)
2. **Bundled-binary version on user's PATH** — if the user has an older `codex` on PATH and ADE bundles `0.130.0`, the spawned `codex resume` could use the wrong binary. Defaulting to ADE's bundled path avoids this but means we always run our version even when the user explicitly wanted theirs. (§D.2) — leaving as: default to bundled, with a `CODEX_EXECUTABLE` env var escape.
3. **Channel-isolated profiles** (commit `5de5f054`) — does normal-chat `CODEX_HOME` actually shift based on channel (beta vs stable)? If so, "open in CLI" from beta ADE writes to `~/.codex-beta/` and user's stable `codex` doesn't see it. Need to verify and decide how to handle.
