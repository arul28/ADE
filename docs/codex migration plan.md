# Codex `app-server` Migration Plan

Linear: [ADE-32](https://linear.app/ade-linear/issue/ADE-32) · GitHub: [#278](https://github.com/arul28/ADE/issues/278)
Status: spec (proposed)
Date: 2026-05-11
Target Codex release: `rust-v0.130.0` (latest stable; alpha track ignored)

This document is the wire-level + UI-level migration spec for bringing ADE's bundled Codex `app-server` and its work-tab + TUI chat surfaces to feature parity with Codex CLI / Codex Desktop on the **chat UX layer** (Tier A in the planning conversation). Capability-layer additions (plugins UI, MCP-in-app, hooks UI, realtime voice, fs/process/command-exec RPCs, environments, dynamic tools, multi-agent UI, memory mode) are explicitly out of scope here — they are tracked separately and called out at the bottom.

The spec assumes the prior plan at [`plans/ade-32-codex-v130-chat-parity.md`](../plans/ade-32-codex-v130-chat-parity.md) is approved. This document replaces and supersedes that plan with structural detail.

---

## 1. Reference snapshot

All Codex source citations are pinned to `openai/codex` `main` branch as of 2026-05-11. Every URL below resolves to a single immutable Rust file or markdown doc; we should re-verify these before starting implementation in case `main` has moved.

### 1.1 Codex repo (`openai/codex/codex-rs/`)

| Topic | URL |
|---|---|
| Wire registry (every method + notification name) | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/common.rs |
| JSON-RPC envelope | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/jsonrpc_lite.rs |
| Item enum (`ThreadItem`) and item-streaming notifications | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs |
| Thread lifecycle, goals, compaction, token usage | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs |
| Turn lifecycle, `TurnPlanStep`, `UserInput` | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs |
| Top-level notifications (`error`, `warning`, `deprecationNotice`) | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/src/protocol/v2/notification.rs |
| App-server README — initialize, capabilities, subscription lifecycle | https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md |
| v1 → v2 migration doc | https://raw.githubusercontent.com/openai/codex/main/codex-rs/docs/protocol_v1.md |
| v0.130.0 release notes | https://github.com/openai/codex/releases/tag/rust-v0.130.0 |
| Slash command inventory | https://developers.openai.com/codex/cli/slash-commands |

### 1.2 ADE codebase (current state, file:line refs)

| Surface | File | Line range |
|---|---|---|
| Codex runtime (spawn, JSON-RPC, notification dispatch) | `apps/desktop/src/main/services/chat/agentChatService.ts` | spawn 11023-11068; readline transport 11070-11146; notification dispatch 10441-11021; `turn/start` 7770-7807 |
| Executable resolver | `apps/desktop/src/main/services/ai/codexExecutable.ts` | 1-50 (whole file) |
| Normalized event union (used by both surfaces) | `apps/desktop/src/shared/types/chat.ts` | `AgentChatEvent` 150-446; `Session` 551-553 |
| Desktop chat root | `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | 1763-5919 |
| Desktop message list (event switch) | `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` | switch 2024-2915; `CollapsibleCard` 963-1021; `InlineDisclosureRow` 699-748 |
| Desktop plan card (existing for Claude) | `apps/desktop/src/renderer/components/chat/ChatProposedPlanCard.tsx` | whole file |
| Desktop composer | `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` | 1-800+ |
| Desktop slash/file palette | `apps/desktop/src/renderer/components/chat/ChatCommandMenu.tsx` | 76-160 |
| TUI ChatView formatter | `apps/ade-cli/src/tuiClient/format.ts` | switch 258-352 |
| TUI command registry | `apps/ade-cli/src/tuiClient/commands.ts` | 12-113 |
| TUI palettes | `apps/ade-cli/src/tuiClient/components/SlashPalette.tsx` 8-46; `MentionPalette.tsx` 13-34 | |
| TUI model status bar | `apps/ade-cli/src/tuiClient/components/ModelStatus.tsx` | 28-76 |
| TUI theme | `apps/ade-cli/src/tuiClient/theme.ts` | 55-78 |
| Release matrix | `.github/workflows/release-core.yml` | runtime matrix 215-332; mac signing 87-130; runtime sign+notarize 313-318 |
| Extra resources packaging | `apps/desktop/package.json` | 175-214 |
| Version stamping | `apps/desktop/scripts/set-release-version.mjs` | 13-34 |

---

## 2. Scope, goals, non-goals

### 2.1 Goals (Tier A)

Each item below is a fully-defined deliverable, with both a desktop and a TUI implementation, that ships as part of this milestone:

1. Bundle and pin `codex` `rust-v0.130.0` in the desktop installer and the `apps/ade-cli` npm package (replacing the current `PATH`-based resolution).
2. Cleanup of the existing handshake (remove triple-name `effort` shim; drop `--disable plugins --disable apps` flags; keep `--disable browser_use --disable computer_use`).
3. Structured plan-mode card (`/plan`): renders `turn/plan/updated` + `Plan` items + `plan/delta`.
4. Manual `/compact` slash command: calls `thread/compact/start`; renders the `ContextCompaction` item.
5. Goals (`/goal set | get | clear`): calls `thread/goal/{set,get,clear}`; renders `thread/goal/updated`/`thread/goal/cleared` as a pinned banner.
6. Image input parity: support `{ type: "image", url }` for clipboard / drag-dropped URLs (we already support `localImage`).
7. `imageGeneration` item rendering (thumbnail + revised prompt + path).
8. `imageView` tool-call item rendering.
9. Rich `webSearch` item: render every `WebSearchAction` variant (`search`, `openPage`, `findInPage`, plus an `other` catch-all).
10. Token-usage HUD: surface `thread/tokenUsage/updated` (both `total` cumulative and `last` per-turn) in the model status bar.
11. Thread history UX: `/resume` palette with filter+search; fork, unarchive, rollback actions.
12. Long-thread pagination: `thread/turns/list` with `itemsView: "summary"` on resume, lazy-load `"full"` on scroll.
13. `optOutNotificationMethods` plumbing for non-streaming consumers (TUI `--print`).

### 2.2 Explicit non-goals (deferred to follow-ups)

These will become separate Linear tickets after Tier A ships:

- Plugin browser UI, marketplace add/remove/upgrade UI (the runtime is enabled by dropping `--disable plugins`; users configure plugins via the Codex CLI / `~/.codex/`).
- Apps / connectors UI (same: runtime enabled by dropping `--disable apps`).
- MCP-in-app UI (OAuth, server status, tool catalog).
- Hooks system (`hooks/list`, `hook/started`, `hook/completed`, `hookPrompt` item).
- Realtime voice (`thread/realtime/*`).
- `command/exec`, `process/spawn`, `fs/*` RPCs.
- Environments (`environment/add`, environment-routed `view_image`).
- Dynamic client tools (`item/tool/call` server-initiated, `dynamicToolCall` item).
- Multi-agent collaboration UI (`collabAgentToolCall` item, collaboration mode picker).
- Memory mode (`thread/memoryMode/set`, `memory/reset`).
- Attestation (`attestation/generate` server-initiated request).
- External agent import (`externalAgentConfig/{detect,import}`).
- Vim composer, `/keymap`, `/title`, `/statusline`, `/ide`, `Ctrl+R` reverse history search (TUI-only nice-to-haves).

### 2.3 Architectural principle

ADE's TUI does **not** speak Codex protocol. It consumes the normalized `AgentChatEvent` envelope (`apps/desktop/src/shared/types/chat.ts:150-446`) published by `agentChatService.ts` via the ADE RPC server. Every feature in this spec therefore threads through **three layers** in order:

```
   [ codex app-server JSON-RPC ]
              ↓ ↑
   [ agentChatService.ts ]  ←—— receive Codex notification / send Codex request
              ↓
   [ AgentChatEvent union (shared/types/chat.ts) ]  ←—— add new variant
              ↓
   ┌──────────────────────┬──────────────────────────┐
   │ desktop renderer     │ TUI ChatView formatter   │
   │ (AgentChatMessageList│  (format.ts)             │
   │   .tsx switch)       │                          │
   └──────────────────────┴──────────────────────────┘
```

The shared union is the contract. **Every phase below ships a desktop AND a TUI renderer for any new variant** (per the user's "parity in one pass" choice).

---

## 3. Architecture decisions and their sources

This section captures the load-bearing architectural calls with citations. If a future engineer reverses one, they should at least know what they're reversing.

### 3.1 Pin to `rust-v0.130.0` stable, not the alpha track

- **Decision:** bundle `rust-v0.130.0`. Skip `rust-v0.131.0-alpha.*`.
- **Source:** v0.130.0 is the latest stable per [github.com/openai/codex/releases/tag/rust-v0.130.0](https://github.com/openai/codex/releases/tag/rust-v0.130.0). 0.131 alphas are work-in-progress; nothing in Tier A requires them.
- **Reversibility:** trivial. We can re-pin in a single env var (`CODEX_VERSION`) plus a checksum update.

### 3.2 Bundle the binary; do not rely on user's `codex` on PATH

- **Decision:** ship the binary inside both the Electron installer (`extraResources` → `resources/codex-bin/{target}/codex`) and the `apps/ade-cli` npm package.
- **Source:** current `resolveCodexExecutable` (`apps/desktop/src/main/services/ai/codexExecutable.ts:18-42`) falls through to literal `"codex"` if nothing else resolves, which means users without `codex` on PATH get a confusing crash. The release matrix already does this for ADE's own runtime binaries (`.github/workflows/release-core.yml:215-332`); we extend the same pattern.
- **Reversibility:** keep `CODEX_EXECUTABLE` / `CODEX_EXECUTABLE_PATH` env overrides for dev. Bundled binary is just a higher-priority resolution step.

### 3.3 Speak Codex v2 only (we already do)

- **Decision:** continue to send v2 wire names (`thread/start`, `turn/start`, `item/*`) and ignore the deprecated v1 `codex/event` / `newConversation` / `sendUserMessage` surface.
- **Source:** verified ADE already speaks v2 at `agentChatService.ts:11349, 7793, 10441-11021`. v1 docs at [codex-rs/docs/protocol_v1.md](https://raw.githubusercontent.com/openai/codex/main/codex-rs/docs/protocol_v1.md) explicitly mark v1 as legacy.
- **Reversibility:** none; v1 is being removed upstream.

### 3.4 Drop `--disable plugins --disable apps`; keep `--disable browser_use --disable computer_use`

- **Decision:** at `agentChatService.ts:11059`, the launch line currently disables all four. Plugins and apps are configured via the Codex CLI / `~/.codex/` and benefit ADE for free; browser-use and computer-use conflict with ADE's own ai-tools layer and stay disabled.
- **Source:** plugin install flow is the `plugin/install` JSON-RPC method (`codex-rs/app-server-protocol/src/protocol/v2/plugin.rs`), invoked by users via `codex plugin install <name>@<marketplace>`. ADE doesn't need a UI for this in Tier A — it just needs to stop disabling the runtime path.
- **Reversibility:** trivial.

### 3.5 Normalize through `AgentChatEvent`, do not pass Codex types to renderers

- **Decision:** every new Codex item gets its own `AgentChatEvent` variant; renderers never import Codex protocol types directly.
- **Source:** the shared union at `apps/desktop/src/shared/types/chat.ts:150-446` is already the single source of truth for both renderers (47 variants today). The TUI runs out of process and only receives JSON via ADE's RPC server — Codex types can't cross that boundary.
- **Reversibility:** none. This is structural to ADE.

### 3.6 Use `experimentalApi: true` in `initialize`

- **Decision:** opt in.
- **Source:** README, [codex-rs/app-server/README.md L1850](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md): *"This setting is negotiated once at initialization time for the process lifetime."* Several Tier A surfaces are experimental-gated: `thread/turns/list`, `thread/goal/*`, `thread/start.permissions`, `turn/start.permissions`. Skipping the flag means those return `requires experimentalApi capability` errors.
- **Reversibility:** flip the boolean.

### 3.7 Do not implement `requestAttestation` or any `chatgptAuthTokens` capability

- **Decision:** do not set `capabilities.requestAttestation`; do not attempt to handle `attestation/generate` server-initiated requests or `account/chatgptAuthTokens/refresh`.
- **Source:** Codex desktop is the host that owns ChatGPT tokens in-memory for the VS Code / desktop extension flow. ADE uses the standard ChatGPT OAuth via the `codex` CLI's existing auth files in `~/.codex/`. No `requestChatgptAuthTokens` capability exists in the README on `main` (verified). Per the protocol research agent's gotcha #12: *"If the migration spec mentions this, the spec is wrong."*
- **Reversibility:** add later when ADE wants in-app ChatGPT OAuth.

### 3.8 Render `WebSearchAction::Other` as a generic fallback

- **Decision:** the Rust enum has `#[serde(other)]` `Other` — meaning any new action variant added upstream deserializes as `{ type: "other" }`. Our renderer must handle this, not crash on it.
- **Source:** `WebSearchAction` definition in `codex-rs/app-server-protocol/src/protocol/v2/item.rs`.
- **Reversibility:** none — this is forward-compat scaffolding.

### 3.9 Pagination defaults to `itemsView: "summary"` on resume

- **Decision:** when resuming a thread, fetch a summary view first, then lazily upgrade to `"full"` on user scroll.
- **Source:** README L405: *"omitted `itemsView` defaults to `"summary"`."* Resume + summary is the fastest path; fetching `"full"` upfront on multi-hundred-turn threads will block the UI.
- **Reversibility:** trivial.

### 3.10 ADE never sends a `"jsonrpc": "2.0"` field

- **Decision:** match Codex's non-strict envelope.
- **Source:** verbatim from `jsonrpc_lite.rs`: *"We do not do true JSON-RPC 2.0, as we neither send nor expect the `jsonrpc: 2.0` field."*
- **Reversibility:** none.

---

## 4. Wire spec — exact shapes we'll handle

The protocol research agent extracted the Rust struct definitions verbatim. Below are the TypeScript types we'll add to `apps/desktop/src/shared/types/chat.ts` (or a new sibling `apps/desktop/src/shared/types/codex.ts` — see §5.2). Every type maps one-to-one to a Rust struct in `codex-rs/app-server-protocol/src/protocol/v2/`.

### 4.1 Items (subset we render)

```ts
// codex-rs/app-server-protocol/src/protocol/v2/item.rs

export type CodexPlanItem = {
  type: "plan";
  id: string;
  text: string;
};

export type CodexContextCompactionItem = {
  type: "contextCompaction";
  id: string;
};

export type CodexWebSearchItem = {
  type: "webSearch";
  id: string;
  query: string;
  action: CodexWebSearchAction | null;
};

export type CodexWebSearchAction =
  | { type: "search"; query: string | null; queries: string[] | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };

export type CodexImageGenerationItem = {
  type: "imageGeneration";
  id: string;
  status: string;             // free-form per upstream
  revisedPrompt: string | null;
  result: string;             // URL or base64 ref
  savedPath?: string;
};

export type CodexImageViewItem = {
  type: "imageView";
  id: string;
  path: string;
};
```

### 4.2 Goal types

```ts
// codex-rs/app-server-protocol/src/protocol/v2/thread.rs

export type CodexThreadGoal = {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type CodexThreadGoalSetParams = {
  threadId: string;
  objective?: string | null;
  status?: CodexThreadGoal["status"] | null;
  // Double-Option: omit ⇒ unchanged; null ⇒ clear; number ⇒ set.
  tokenBudget?: number | null;
};

export type CodexThreadGoalUpdatedNotification = {
  threadId: string;
  turnId: string | null;
  goal: CodexThreadGoal;
};

export type CodexThreadGoalClearedNotification = {
  threadId: string;
};
```

### 4.3 Token usage

```ts
// codex-rs/app-server-protocol/src/protocol/v2/thread.rs

export type CodexTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type CodexTokenUsage = {
  total: CodexTokenUsageBreakdown;       // cumulative across thread
  last: CodexTokenUsageBreakdown;        // last turn only
  modelContextWindow: number | null;
};

export type CodexThreadTokenUsageUpdatedNotification = {
  threadId: string;
  turnId: string;
  tokenUsage: CodexTokenUsage;
};
```

### 4.4 Plan steps (turn-scoped, structured)

```ts
// codex-rs/app-server-protocol/src/protocol/v2/turn.rs

export type CodexTurnPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export type CodexTurnPlanUpdatedNotification = {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: CodexTurnPlanStep[];
};

export type CodexPlanDeltaNotification = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};
```

### 4.5 Thread list / read / fork / unarchive / rollback

```ts
// codex-rs/app-server-protocol/src/protocol/v2/thread.rs

export type CodexThreadListParams = {
  cursor?: string;
  limit?: number;
  sortKey?: "created_at" | "updated_at";   // SNAKE_CASE on wire (see §3 gotcha 5)
  sortDirection?: "asc" | "desc";          // SNAKE_CASE on wire
  modelProviders?: string[];
  sourceKinds?: CodexThreadSourceKind[];
  archived?: boolean;
  cwd?: string | string[];                 // untagged union (see §3 gotcha 6)
  searchTerm?: string;
};

export type CodexThreadSourceKind =
  | "cli" | "vscode" | "exec" | "appServer"
  | "subAgent" | "subAgentReview" | "subAgentCompact"
  | "subAgentThreadSpawn" | "subAgentOther" | "unknown";

export type CodexThreadListResponse = {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};

export type CodexThreadForkParams = {
  threadId: string;
  ephemeral?: boolean;
  // ... plus optional model/sandbox/permission overrides (see thread.rs)
};

export type CodexThreadRollbackParams = {
  threadId: string;
  numTurns: number;   // must be >= 1
};

export type CodexThreadTurnsListParams = {
  threadId: string;
  cursor?: string;
  limit?: number;
  sortDirection?: "asc" | "desc";
  itemsView?: "notLoaded" | "summary" | "full";  // defaults to "summary"
};
```

### 4.6 User input (sent on `turn/start`)

```ts
// codex-rs/app-server-protocol/src/protocol/v2/turn.rs

export type CodexUserInput =
  | { type: "text"; text: string; text_elements?: CodexTextElement[] }
  | { type: "image"; url: string }                          // ← NEW for Phase 5
  | { type: "localImage"; path: string }                    // already implemented
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };        // already implemented

export type CodexTextElement = {
  byteRange: { start: number; end: number };
  placeholder?: string | null;
};
```

### 4.7 Initialize capabilities

```ts
// codex-rs/app-server/README.md (verbatim shape)

export type CodexInitializeParams = {
  clientInfo: { name: string; title?: string; version: string };
  capabilities?: {
    experimentalApi?: boolean;          // we set true
    optOutNotificationMethods?: string[]; // exact method names
    // NOTE: do NOT set `requestAttestation` (see §3.7)
  };
};
```

### 4.8 Gotchas captured from the protocol research

These are subtle wire facts that will cost us hours if forgotten. Each maps to a specific check we have to enforce:

1. **No `"jsonrpc": "2.0"` field** — neither sent nor expected (`jsonrpc_lite.rs`).
2. **`WebSearchAction.Other`** is a `#[serde(other)]` catch-all; our union must include `{ type: "other" }`.
3. **Token usage carries 5 fields** per breakdown, including `cachedInputTokens` and `reasoningOutputTokens` — not the 3-field shape from older protocols.
4. **Double-Option serialization** in goals, service tier, git info: distinguish "omit (unchanged)" from "null (cleared)". On our side that means `undefined` in TS request bodies must be elided, not serialized as `null`.
5. **`ThreadSortKey` and `SortDirection` use snake_case** (`"created_at"`, `"updated_at"`, `"asc"`, `"desc"`) — unlike every other enum. Don't camelCase these.
6. **`ThreadListParams.cwd` is `#[serde(untagged)]`** — accepts a string OR a string array.
7. **`UserInput::Image.url` not `imageUrl`** — v2 wire renames it.
8. **`developerInstructions` is thread-scoped only**, not on `TurnStartParams`. Don't try to override per-turn.
9. **`dynamicTools` is thread-scoped only** (same as `developerInstructions`).
10. **`thread/turns/items/list` returns unsupported-method** on `main`. Use `thread/turns/list` with `itemsView: "full"`.
11. **`ContextCompactedNotification` is deprecated**; use the `ContextCompaction` item.
12. **30-min idle eviction** of subscribed threads only after last subscriber leaves AND zero activity. New `thread/start`/`thread/fork` auto-subscribes.

---

## 5. Migration phases

Each phase is a self-contained deliverable. Phases are ordered by risk + dependency, not user value. Phase 0 must land first; phases 1-9 can be parallelized across people but the desktop and TUI legs of any single phase must land together (per the user's "parity in one pass" call).

### Phase 0 — Bundle binary + handshake cleanup

#### 0.1 Bundle `codex` v0.130.0

**What changes:**

1. New env var `CODEX_VERSION=0.130.0` (canonical version source, mirrors `ADE_STATIC_NODE_VERSION`).
2. New script `apps/desktop/scripts/download-codex-binary.mjs` that:
   - Reads `CODEX_VERSION` and target triple from CI matrix.
   - Downloads from `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${target}.tar.gz`.
   - Verifies SHA256 against a checked-in manifest `apps/desktop/resources/codex-bin/checksums.json`.
   - Extracts the `codex` binary to `apps/desktop/resources/codex-bin/${target}/codex`.
3. New release-workflow job `download-codex-binaries` in `.github/workflows/release-core.yml`, parallel to `build-runtime-binaries`, fanned across the same matrix (lines 219-228: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`; Windows added at workflow level).
4. macOS notarization: codex binary inherits the app-bundle code signature when `notarize:mac:dmg` runs because it lives under `extraResources` (already-signed `hardenedRuntime` entitlements at `apps/desktop/build/entitlements.mac.plist` apply). If notarization rejects it, fall back to signing the binary independently with `apps/desktop/scripts/notarize-mac-dmg.mjs` extended to walk `resources/codex-bin/`.
5. `extraResources` entry added to `apps/desktop/package.json:175-214`:
   ```json
   { "from": "resources/codex-bin", "to": "codex-bin", "filter": ["**/*"] }
   ```
6. `apps/ade-cli/package.json`: add an optional dependency per platform (npm's standard binary-shipping pattern) — `@ade/codex-bin-darwin-arm64`, etc. Each is a thin npm package containing the binary. Alternative: a `postinstall` script that downloads the binary on user install. Per the release pipeline research (§3), ADE CLI is pure JS today; postinstall is the cleaner first step.

**Sources for this approach:**
- ADE already does this fanned-matrix pattern for its own runtime binaries: `release-core.yml:215-332`. Sign+notarize step at L313-318 is the model for darwin codex binaries.
- `extraResources` shape: existing entries at `apps/desktop/package.json:175-214`.

#### 0.2 Extend `resolveCodexExecutable`

Current (`apps/desktop/src/main/services/ai/codexExecutable.ts:18-42`) resolves in this order: auth → env → known-dir → fallback `"codex"`. Insert a new step at priority 2 (after env vars, before known-dir search):

```ts
// Pseudocode
const bundledPath = resolveBundledCodexPath();   // checks app.getAppPath()/Contents/Resources/codex-bin/{target}/codex on macOS
if (bundledPath && fs.existsSync(bundledPath)) {
  return { path: bundledPath, source: "bundled" };
}
```

Add `"bundled"` to the `CodexExecutableResolution.source` enum.

#### 0.3 Drop `--disable plugins --disable apps`

At `agentChatService.ts:11059`, change:

```ts
appServerArgs.push("--disable", "plugins", "--disable", "apps", "--disable", "browser_use", "--disable", "computer_use");
```

to:

```ts
appServerArgs.push("--disable", "browser_use", "--disable", "computer_use");
```

#### 0.4 Initialize handshake

At `agentChatService.ts:11259` (where `initialize` is sent), set:

```ts
{
  clientInfo: { name: "ade_desktop", title: "ADE Desktop", version: ADE_VERSION },
  capabilities: {
    experimentalApi: true,
    optOutNotificationMethods: [],   // populated in Phase 9
    // requestAttestation intentionally omitted (§3.7)
  },
}
```

For the TUI runtime path (also through `agentChatService.ts`, since the TUI calls into the same service via ADE RPC), use `name: "ade_tui"` to differentiate. If the TUI runs `--print` (non-interactive), pass `optOutNotificationMethods` from §5.10.

#### 0.5 Reasoning effort triple-name cleanup

At `agentChatService.ts:7800-7802`, the current shim sends three keys for compat with older app-server builds:

```ts
...(managed.session.reasoningEffort
  ? {
      effort: managed.session.reasoningEffort,
      reasoningEffort: managed.session.reasoningEffort,
      reasoning_effort: managed.session.reasoningEffort,
    }
  : {}),
```

v0.130 canonical key is `effort`. Replace with `{ effort: managed.session.reasoningEffort }` only.

#### 0.6 Stub server-initiated requests we don't answer

Codex may send these server→client requests; today we'd return JSON-RPC method-not-found. Wire them as explicit "capability not granted" responses so the server can degrade cleanly:

- `attestation/generate` → `{ error: { code: -32601, message: "capability not granted" } }`
- `account/chatgptAuthTokens/refresh` → same
- `item/tool/call` (dynamic tools) → same

**Files touched in Phase 0:**

| File | Change |
|---|---|
| `apps/desktop/src/main/services/ai/codexExecutable.ts` | Add bundled-path resolution step |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | L11059 disable list, L11259 initialize, L7800-7802 effort cleanup, new server→client request handlers |
| `apps/desktop/package.json` | Add `extraResources` entry for `codex-bin` |
| `apps/desktop/scripts/download-codex-binary.mjs` | New script |
| `apps/desktop/resources/codex-bin/checksums.json` | New manifest |
| `.github/workflows/release-core.yml` | New `download-codex-binaries` matrix job |
| `apps/ade-cli/package.json` | Postinstall + per-platform optional deps OR binary shipping mechanism |

---

### Phase 1 — Structured plan-mode card

**Wire surface:** `Plan` item (text only) + `plan/delta` (streaming text) + `turn/plan/updated` (structured `TurnPlanStep[]`). The streaming text is informational; the structured step array is authoritative.

**Current state in ADE:** `agentChatService.ts:10952` handles `item/plan/delta` and accumulates into a text buffer; `10787` handles `turn/plan/updated` (logged only). No structured step rendering. There's an existing `ChatProposedPlanCard.tsx` (Claude-flavored) we'll generalize.

**New `AgentChatEvent` variants:**

```ts
| {
    type: "codex_plan";
    turnId: string;
    sessionId: string;
    explanation: string | null;
    steps: { step: string; status: "pending" | "inProgress" | "completed" }[];
    streamingText: string;        // accumulated plan/delta tail (informational)
    state: "active" | "complete";
  }
```

**`agentChatService.ts` changes:**

1. On `item/started` where `item.type === "plan"`: emit `codex_plan` with empty `steps`, empty `streamingText`, `state: "active"`.
2. On `item/plan/delta`: append `delta` to `streamingText`.
3. On `turn/plan/updated`: replace `steps` and `explanation`.
4. On `item/completed` where `item.type === "plan"`: set `state: "complete"`.

**Desktop UI design:**

Insert a new case in the `AgentChatMessageList.tsx:2024-2915` switch, around line 2068 (replacing the current `plan` `InlineDisclosureRow`). The card uses the existing `CollapsibleCard` primitive (file:line 963-1021). Color: violet accent (matches the `#A78BFA` token in TUI theme), since plans are an assistant-generated artifact.

ASCII mock (desktop card, ~600px wide):

```
┌─ Plan ────────────────────────────────────────────────── ▾ ─┐
│  Refactor the auth middleware to split session token         │
│  storage from request validation, per the legal/compliance   │
│  ask.                                                        │
│                                                              │
│  ◐ 1. Read the existing middleware and identify the         │
│       coupling point                          (in progress)  │
│  ○ 2. Extract session-storage interface                      │
│  ○ 3. Implement file-based and Redis-based storage backs    │
│  ○ 4. Wire the middleware to take a storage backend via DI  │
│  ○ 5. Update tests for both backends                        │
│                                                              │
│  ▸ Live thoughts (click to expand)                          │
└──────────────────────────────────────────────────────────────┘
```

Step glyphs match TUI for visual consistency. The "Live thoughts" disclosure reveals the streamed `plan/delta` text — only useful for debugging.

**TUI UI design:**

ChatView formatter at `format.ts:258-352` gets a new case. Render the structured plan inline (no border — ApprovalPrompt already uses borders, plans should feel calmer):

```
plan · 14:23
  Refactor the auth middleware to split session token storage from request validation.

  ◐ Read existing middleware and identify coupling point  (in progress)
  ○ Extract session-storage interface
  ○ Implement file-based and Redis-based storage backends
  ○ Wire the middleware to take a storage backend via DI
  ○ Update tests for both backends
```

Use `theme.ts:TONE_COLORS.notice` (gray) for non-active steps, `TONE_COLORS.user` (`#A78BFA`) for the active step. Step glyphs in `theme.ts` need three new entries (`pending = ○`, `inProgress = ◐`, `completed = ●`).

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | Add `codex_plan` variant to `AgentChatEvent` |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Replace text-only plan handling at L10787, L10952; emit structured event |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` | New switch case at L2068, replace `InlineDisclosureRow` with `CodexPlanCard` |
| `apps/desktop/src/renderer/components/chat/CodexPlanCard.tsx` | New component (modeled on `ChatProposedPlanCard.tsx`) |
| `apps/ade-cli/src/tuiClient/format.ts` | New case in switch at L258-352 |
| `apps/ade-cli/src/tuiClient/theme.ts` | Add `glyphFor(status)` helper |

---

### Phase 2 — `/compact` slash command + `ContextCompaction` item

**Wire surface:** client sends `thread/compact/start { threadId }`; server streams a `contextCompaction` item via standard `item/started` → `item/completed`. The legacy `thread/compacted` notification is deprecated.

**Current state in ADE:** no compaction wire at all today. The Codex CLI's `/compact` is a slash command that calls `thread/compact/start`.

**New `AgentChatEvent` variant:**

```ts
| {
    type: "codex_context_compaction";
    turnId: string;
    sessionId: string;
    state: "started" | "completed";
  }
```

**Slash-command wiring:**

The slash registry is server-driven for desktop (filtered in `ChatCommandMenu.tsx:85-89`) and a mix of `BUILTIN_COMMANDS` + server commands for TUI (`commands.ts:12-113`). Since `/compact` is provider-specific, we:

1. Add `/compact` to the Codex provider's slash list emitted from `agentChatService.ts` (the same place `skills/list` results are exposed).
2. On dispatch (desktop: `AgentChatComposer.tsx` slash dispatch; TUI: `commands.ts` `parseCommand`), route to a new IPC method `window.ade.codex.compact({ sessionId })` that calls `thread/compact/start`.

**Desktop UI design:**

Compaction is mid-stream — not a hero card. Inline subtle notice:

```
                                                            ┌──────────────┐
                                                            │ ⟳ compacted  │
                                                            └──────────────┘
```

The chip sits between the last message and the next. On hover, tooltip: "Context compacted at 14:31 — N tokens reclaimed" (we don't have the token count yet from this notification, but Phase 6's token HUD updates simultaneously).

**TUI UI design:**

```
[notice] context compacted
```

Single dimmed line, `tone: "notice"`, no border.

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | New variant |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | New handler for `item/started`/`item/completed` where `item.type === "contextCompaction"`; new public method `compact(sessionId)` |
| `apps/desktop/src/main/ipc/codexHandlers.ts` (new file or extend existing chat IPC) | Expose `compact` |
| `apps/desktop/src/preload/...` | Wire `window.ade.codex.compact` |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` | New switch case for chip |
| `apps/ade-cli/src/tuiClient/format.ts` | New case → `tone: "notice"` |
| `apps/ade-cli/src/tuiClient/commands.ts` | Add `/compact` to `BUILTIN_COMMANDS` for codex provider |

---

### Phase 3 — Goals (`/goal set | get | clear`)

**Wire surface:** `thread/goal/set`, `thread/goal/get`, `thread/goal/clear` + `thread/goal/updated`, `thread/goal/cleared` notifications. Goal type at §4.2.

**New `AgentChatEvent` variants:**

```ts
| {
    type: "codex_goal_updated";
    sessionId: string;
    goal: CodexThreadGoal;
  }
| {
    type: "codex_goal_cleared";
    sessionId: string;
  }
```

We also need to persist the active goal in `ChatSession` (`apps/desktop/src/shared/types/chat.ts:551-553` adds a `codexGoal: CodexThreadGoal | null` field).

**Slash-command wiring:**

- `/goal` (no args) — show current goal.
- `/goal <objective text>` — `thread/goal/set { objective }`.
- `/goal clear` — `thread/goal/clear`.
- `/goal status active|paused` — `thread/goal/set { status }`.
- `/goal budget <N>` — `thread/goal/set { tokenBudget: N }`.
- `/goal budget clear` — `thread/goal/set { tokenBudget: null }` (double-Option `null` ⇒ clear).

**Desktop UI design:**

A persistent slim banner above the message list when a goal is set. Click to edit (opens a small inline form).

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ◎ Goal:  Refactor auth middleware for legal/compliance ask        ✎ ✕    │
│   ─────────────────────────────────────────────                            │
│   2,341 / 50,000 tokens · 4m 12s elapsed · status: active                  │
└───────────────────────────────────────────────────────────────────────────┘
[message list scrolls below this banner]
```

`◎` glyph (target). Color: amber-on-dim — important but not alarming. Token-budget progress bar uses the same `ContextMeter` style as the TUI footer.

**TUI UI design:**

Below the header, above the chat scrollback (uses the existing Drawer/RightPane layout primitives at `app.tsx`):

```
◎ Goal: Refactor auth middleware...   2.3k/50k · 4m · active
```

Single line, truncated to terminal width. Color: amber (`#F59E0B` already in theme as `warning` / `approval`).

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | New variants + `codexGoal` field on Session |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | New handlers, new public methods `goalSet/Get/Clear` |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | Render `GoalBanner` above message list when `session.codexGoal != null` |
| `apps/desktop/src/renderer/components/chat/CodexGoalBanner.tsx` | New component |
| `apps/ade-cli/src/tuiClient/components/Header.tsx` | New goal line beneath title (or replace one of the existing lines) |
| `apps/ade-cli/src/tuiClient/commands.ts` | Add `/goal` builtin with subcommands |

---

### Phase 4 — Image input parity (URL form)

**Wire surface:** `UserInput::Image { url: string }` (§4.6). We already send `localImage` for clipboard-pasted / drag-dropped files; we need to also send `image` when the source is a URL (e.g. user pastes an image URL in the prompt, or drags an image from a browser tab — Chromium can give us a URL instead of bytes).

**Current state:** `agentChatService.ts:7781-7789` only handles `localImage` and `mention`. The composer at `AgentChatComposer.tsx` has attachment plumbing but no URL form.

**Changes:**

- Composer paste handler: if clipboard contains a `text/uri-list` or a single image URL, append it as an attachment of new type `image-url` (in our `AgentChatFileRef` discriminator).
- `agentChatService.ts:7781-7789`: extend the for-loop to handle `attachment.type === "image-url"` → push `{ type: "image", url: attachment.url }`.

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | Extend `AgentChatFileRef` with `image-url` variant |
| `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` | Paste/drop handler emits `image-url` ref |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | L7781-7789 handle new ref type → `image` UserInput |
| `apps/ade-cli/src/tuiClient/commands.ts` | Add `--image-url <url>` flag to send command |

---

### Phase 5 — `imageGeneration` and `imageView` items

**Wire surface:**

```ts
type CodexImageGenerationItem = {
  type: "imageGeneration"; id: string; status: string;
  revisedPrompt: string | null; result: string; savedPath?: string;
};
type CodexImageViewItem = { type: "imageView"; id: string; path: string };
```

**New `AgentChatEvent` variants:**

```ts
| {
    type: "codex_image_generation";
    turnId: string;
    sessionId: string;
    status: string;
    revisedPrompt: string | null;
    result: string;
    savedPath: string | null;
  }
| {
    type: "codex_image_view";
    turnId: string;
    sessionId: string;
    path: string;
  }
```

**Desktop UI design:**

Image generation card:

```
┌─ Image generated ──────────────────────────────────────────┐
│  [200x200 thumbnail of the generated image]                │
│                                                             │
│  ▸ Revised prompt: "A serene mountain landscape with..."   │
│  Saved to: ~/Projects/.../assets/mountain.png       ↗ open │
└─────────────────────────────────────────────────────────────┘
```

Image view (tool call):

```
   ↳ Viewing image: assets/screenshot.png   ↗ open
```

Inline single-line, indented to indicate it's a tool call.

**TUI UI design:**

```
[tool] image generated → ~/Projects/.../mountain.png   (h to open)
       revised: A serene mountain landscape with...

[tool] viewing image → assets/screenshot.png   (h to open)
```

`h` key opens via system handler (`open <path>` on macOS, `xdg-open` on Linux, `start ""` on Windows). Wire through existing TUI key handling in `app.tsx`.

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | Two new variants |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Handle `item.type === "imageGeneration" / "imageView"` in `item/started` + `item/completed` |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` | Two new switch cases |
| `apps/desktop/src/renderer/components/chat/CodexImageGenerationCard.tsx` | New |
| `apps/desktop/src/renderer/components/chat/CodexImageViewLine.tsx` | New (or inline) |
| `apps/ade-cli/src/tuiClient/format.ts` | Two new cases |
| `apps/ade-cli/src/tuiClient/app.tsx` | Wire `h` key to `open` system call for images |

---

### Phase 6 — Rich `webSearch` item rendering

**Wire surface:** `WebSearchAction` union with `search`, `openPage`, `findInPage`, `other` variants (§4.1).

**Current state:** `agentChatService.ts:10878` logs `codex/event/web_search_begin` only. There's also a `web_search` variant in `AgentChatEvent` already at `AgentChatMessageList.tsx:2166-2227` for other providers' web search — we can reuse the visual treatment.

**Change to existing `AgentChatEvent` web_search variant** (extend, don't replace, so other providers keep working):

```ts
| {
    type: "web_search";
    turnId: string;
    sessionId: string;
    query: string;
    state: "running" | "completed" | "failed";
    actions?: CodexWebSearchAction[];   // ← NEW, only populated for Codex
  }
```

Note: a single `webSearch` item carries one `action`. We accumulate them across `item/started` (initial action) and `item/completed` (final action) into `actions[]` for richer rendering. If multiple `webSearch` items fire in a turn, each gets its own event.

**Desktop UI design:**

```
┌─ Web search ───────────────────────────────────────────── ▸ ─┐
│  🔍 "Codex app-server thread/turns/list pagination"           │
│                                                                │
│     • search:        thread/turns/list pagination             │
│     • openPage:      github.com/openai/codex/.../thread.rs    │
│     • findInPage:    "items_view"  in  thread.rs              │
└────────────────────────────────────────────────────────────────┘
```

Use the existing Motion card from `AgentChatMessageList.tsx:2166-2227`; just extend its body to render the action list when `actions[]` is present.

**TUI UI design:**

```
🔍 web search · "Codex app-server thread/turns/list pagination"
   search        thread/turns/list pagination
   openPage      github.com/openai/codex/.../thread.rs
   findInPage    "items_view" in thread.rs
```

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | Extend `web_search` variant with `actions[]` |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Replace L10878 stub with structured handling of `webSearch` items via `item/started` + `item/completed` |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` | Extend existing case at L2166-2227 to render actions list when present |
| `apps/ade-cli/src/tuiClient/format.ts` | Extend `web_search` case to render actions |

---

### Phase 7 — Token-usage HUD

**Wire surface:** `thread/tokenUsage/updated` (§4.3) — carries both `total` (cumulative) and `last` (latest turn) breakdowns plus `modelContextWindow`.

**New `AgentChatEvent` variant:**

```ts
| {
    type: "codex_token_usage";
    sessionId: string;
    total: CodexTokenUsageBreakdown;
    last: CodexTokenUsageBreakdown;
    modelContextWindow: number | null;
  }
```

We don't render this in the message stream — it updates the persistent footer/status bar. So `agentChatService.ts` stashes it in `ChatSession.codexTokenUsage` and emits a `session_updated` event for renderers to re-read.

**Desktop UI design:**

Extend the model status area (currently rendered inline in `status` events at `AgentChatMessageList.tsx:2915-2978`). Add a persistent footer:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ◇ Codex · gpt-5 · medium effort · workspace-write                         │
│  ▓▓▓▓▓▓▓░░░░░  64% (128k / 200k)   last turn: +2.3k in · 1.1k out (450 ✶)  │
└────────────────────────────────────────────────────────────────────────────┘
```

`✶` denotes cached input tokens. Bar is `modelContextWindow`-relative.

**TUI UI design:**

Extend `ModelStatus.tsx:28-76` (right-side `ContextMeter`). Replace the existing `tokenSummary` string with a richer one:

```
◇ Codex · gpt-5 · medium · workspace-write          ▓▓▓▓▓▓▓░░░ 64%  +2.3k/1.1k (450✶)
```

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | `CodexTokenUsage*` types; `codexTokenUsage` on Session; `codex_token_usage` event |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | New handler |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | New footer component below message list when `session.codexTokenUsage != null` |
| `apps/desktop/src/renderer/components/chat/CodexTokenFooter.tsx` | New |
| `apps/ade-cli/src/tuiClient/components/ModelStatus.tsx` | Extend `ContextMeter` summary string |

---

### Phase 8 — Thread history: list + read + fork + unarchive + rollback

This is the biggest UX piece. Codex CLI's `/resume` flow is the target.

**Wire surface:** `thread/list`, `thread/read`, `thread/fork`, `thread/unarchive`, `thread/rollback`. Shapes at §4.5.

**Currently in ADE:** `thread/resume` and `thread/archive` are called; nothing else.

**New IPC layer:** add a `CodexHistoryService` in main process that owns these requests. Two design choices, picking option A:

- **Option A (picked):** reuse the active managed session's runtime if there is one open (cheaper, one process).
- **Option B:** spawn a transient `codex app-server` for history queries, shut down after. (Heavier, but useful for closed-app scenarios — defer to a follow-up.)

Expose to renderer via `window.ade.codex.history.{list, read, fork, unarchive, rollback}`.

**Desktop UI design — `/resume` modal:**

```
┌─ Codex history ─────────────────────────────────────────────────────────┐
│                                                                          │
│  [search threads...]                                                     │
│                                                                          │
│  [Active] [Archived] [Forks]    cwd: [all  ▾]    provider: [codex  ▾]   │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────  │
│  thr_a1b2c3d4   "Refactor auth middleware"                              │
│                 2026-05-11 14:23 · 12 turns · ~/Projects/auth-svc       │
│                 [resume] [fork] [archive] [rollback ▾]                  │
│  ─────────────────────────────────────────────────────────────────────  │
│  thr_e5f6g7h8   "Add SSO with Okta"                                     │
│                 2026-05-09 09:11 · 47 turns · ~/Projects/auth-svc       │
│                 [resume] [fork] [archive] [rollback ▾]                  │
│  ─────────────────────────────────────────────────────────────────────  │
│  ...                                                                     │
│                                                                          │
│  Load more  (next cursor: xyz...)                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

`[rollback ▾]` opens a small inline picker: "Rollback last 1 / 2 / 5 / 10 turns…".

Modal pattern follows the existing `LinearIssueBrowser` modal precedent (`AgentChatPane.tsx:42`). No `Dialog` primitive exists; we use `createPortal` + a backdrop div.

**TUI UI design — `ChatHistoryPalette`:**

A new palette component modeled on `MentionPalette.tsx:13-34` / `SlashPalette.tsx:29-45`. Opened by `Ctrl+R` or `/resume`:

```
┌─ resume codex thread ────────────────────────────────────┐
│ [search threads...]                                      │
│                                                          │
│ › thr_a1b2c3d4  Refactor auth middleware           12t   │
│   thr_e5f6g7h8  Add SSO with Okta                  47t   │
│   thr_i9j0k1l2  Pipeline builder refactor          8t    │
│   ...                                                    │
│                                                          │
│ ↵ resume  f fork  a archive  r rollback  ⎋ close        │
└──────────────────────────────────────────────────────────┘
```

`r` opens an inline number prompt for "rollback N turns".

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/shared/types/chat.ts` | `CodexThread*` types |
| `apps/desktop/src/main/services/chat/codexHistoryService.ts` | New file — wraps the 5 RPCs against the active runtime |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Expose `getRuntime(sessionId)` helper for the history service |
| `apps/desktop/src/main/ipc/codexHandlers.ts` | New IPC channels |
| `apps/desktop/src/preload/...` | `window.ade.codex.history.*` |
| `apps/desktop/src/renderer/components/chat/CodexHistoryModal.tsx` | New modal |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | Mount modal; wire `/resume` slash to open it |
| `apps/ade-cli/src/tuiClient/components/ChatHistoryPalette.tsx` | New TUI palette |
| `apps/ade-cli/src/tuiClient/app.tsx` | Wire `Ctrl+R` keybind and `/resume` to open palette |
| `apps/ade-cli/src/tuiClient/commands.ts` | Add `/resume` builtin |

---

### Phase 9 — Long-thread pagination

**Wire surface:** `thread/turns/list { threadId, itemsView, cursor, limit, sortDirection }`. Defaults `itemsView: "summary"`.

**Migration plan:**

1. When `thread/resume` returns, ADE currently expects the full history in the response. Instead:
   - Issue `thread/resume` (still required to subscribe to live events).
   - Immediately issue `thread/turns/list { threadId, itemsView: "summary", limit: 50 }`.
   - Render summary cards as turn boundaries with a "Load full turn" disclosure.
2. On scroll-up past the top of currently-loaded turns:
   - Issue `thread/turns/list { threadId, cursor: nextCursor, itemsView: "summary", limit: 50 }`.
3. On user expanding a specific turn's full content:
   - Issue `thread/turns/list { threadId, cursor: <turn-anchor>, itemsView: "full", limit: 1 }` and replace the summary view for that single turn.

**Subtlety:** Codex `Turn` carries an `itemsView` field that tells us what's already there. README says the default for `thread/turns/list` is `"summary"`. We must not assume `"full"` is always populated.

**Desktop UI design:** the existing message list already scrolls; we add:

- A "Load older turns" button at the top of the scrollback when `nextCursor != null`.
- A `[ Show full turn ▾ ]` button at the top of each summary-rendered turn.

**TUI UI design:** when scrolling up past the loaded window, the bottom-status bar shows `[older turns: press Ctrl+G to load]`. Pressing Ctrl+G fetches the next 50.

**Files touched:**

| File | Change |
|---|---|
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Issue `thread/turns/list` after `thread/resume`; expose `loadOlderTurns(sessionId, cursor)` |
| `apps/desktop/src/shared/types/chat.ts` | Add `loadCursor: string \| null` and `itemsViewByTurnId: Record<string, "summary" \| "full">` to Session |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | "Load older" UI; "Show full turn" button |
| `apps/ade-cli/src/tuiClient/app.tsx` | Ctrl+G keybind |

---

### Phase 10 — `optOutNotificationMethods` for perf

For renderers that don't need streaming (TUI non-interactive `ade chat send --print`), opt out of high-volume deltas:

```ts
optOutNotificationMethods: [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
]
```

Desktop chat keeps all deltas. The TUI interactive mode also keeps all deltas. Only the `--print` path opts out.

**File:** `agentChatService.ts:11259` — pass `optOutNotificationMethods` conditionally based on `ChatSession.runtimeMode`.

---

## 6. Migration sequencing & dependencies

```
Phase 0 (binary + handshake)
  ├─→ Phase 1 (plan card)
  ├─→ Phase 2 (compact)
  ├─→ Phase 3 (goal)
  ├─→ Phase 4 (image input URL)
  ├─→ Phase 5 (image gen + view)
  ├─→ Phase 6 (web search)
  ├─→ Phase 7 (token HUD)
  └─→ Phase 8 (thread history)
        └─→ Phase 9 (pagination)
              └─→ Phase 10 (opt-out)
```

Phases 1-7 are independent of each other after Phase 0 lands. Phase 9 depends on Phase 8 (it relies on the history service infrastructure). Phase 10 depends on Phase 9 because that's when we start having streams large enough to want to opt out of.

**Suggested cadence:** Phase 0 first (1 PR). Phases 1, 2, 3, 7 next as a "chat affordances" batch (one PR each, parallelizable). Phases 4, 5, 6 next as an "image + search" batch. Phase 8 as a standalone PR (largest). Phases 9 + 10 as a single follow-up PR.

---

## 7. Where to use parallel agents

This is the user's explicit ask: where do parallel subagents accelerate this? The boundaries below are the natural seams.

### 7.1 Code-generation parallelism

The phases factor cleanly across the three layers — wire handler, shared type, renderer — and within each phase the desktop and TUI renderers don't touch each other's files. Recommended pattern per phase:

**For each Phase 1-7 (small phases), spawn 2 agents in parallel:**

- **Agent A** ("wire + types"): adds the `AgentChatEvent` variant in `apps/desktop/src/shared/types/chat.ts`, wires the new request/notification in `agentChatService.ts`, and emits the new event. Touches main-process code only.
- **Agent B** ("renderers"): once Agent A has merged the type variant, branches off to add the new switch case in `AgentChatMessageList.tsx` AND the new case in TUI `format.ts`. Touches renderer code only.

Reason this works: the union type is the API contract between them. Agent A finishing the type definition unblocks Agent B even before A's IPC is fully wired (B can stub the event with a dev-tools button).

**For Phase 8 (thread history), spawn 3 agents in parallel after the IPC layer is sketched:**

- **Agent A:** `codexHistoryService.ts` + IPC handlers + preload bindings.
- **Agent B:** `CodexHistoryModal.tsx` + `AgentChatPane` mount + `/resume` slash routing on desktop.
- **Agent C:** `ChatHistoryPalette.tsx` + `app.tsx` keybind wiring + `commands.ts` builtin on TUI.

### 7.2 Research parallelism (during ongoing implementation)

Once we're in execution, certain research tasks block specific phases. Spawn these as research agents the first time the phase begins:

- **Phase 0 binary bundling:** an agent to verify SHA256 manifest building works against `github.com/openai/codex/releases/download/rust-v0.130.0/*` for each target triple. The agent fetches each tarball, computes sha256, writes the manifest.
- **Phase 8 history modal:** an agent to UX-prototype the modal layout in a sandbox (the user has a strong preference against generic AI aesthetics — see `feedback_design.md` memory — so we want an explicit design pass before locking in the look).
- **Phase 7 token HUD:** an agent to validate that `thread/tokenUsage/updated` actually fires on every turn boundary (vs. only at completion) by running a fake stream against a real `codex app-server` v0.130 — this affects whether the HUD updates feel real-time or laggy.

### 7.3 Test-generation parallelism

After each phase's implementation lands, spawn a single agent per phase to add tests in parallel with the next phase's implementation. The test agent's prompt should be: *"For [phase] in [PR #], add unit tests in `agentChatService.test.ts` that exercise the new wire handler against a fake app-server (use the existing fixture harness). Do NOT add brittle render-tree tests."* This obeys the existing memory `feedback_testing_quality.md`.

### 7.4 Cross-phase agents

Once 3+ phases have landed, spawn an **audit agent** with the prompt: *"Walk every new `AgentChatEvent` variant added since [start commit]; confirm desktop and TUI both have a renderer case; confirm there is a corresponding `agentChatService.ts` handler; confirm tests exist."* This catches drift between the three layers without a human re-checking each phase.

---

## 8. Testing strategy

Per the project's testing memory (`feedback_testing_quality.md`, `feedback_test_scoping.md`, `feedback_test_sharding.md`):

1. **Real-value tests only.** No brittle DOM snapshot tests, no fragile render assertions.
2. **Scope to changed files.** Run `pnpm test apps/desktop/src/main/services/chat/agentChatService.test.ts` and the codex-specific TUI fixture only — never the full suite per change.
3. **Always shard.** Use the existing shard configuration.

### 8.1 Per-phase test deliverables

- **Phase 0:** integration test that spawns the bundled binary, completes an `initialize` handshake, sends one trivial `turn/start`, asserts a `turn/completed` notification. This proves the bundled binary works end-to-end.
- **Phase 1:** fake-app-server fixture that emits a `turn/plan/updated` + `Plan` item + `plan/delta` sequence; assert the emitted `AgentChatEvent` matches snapshot.
- **Phase 2:** fixture that runs `thread/compact/start`, fake server emits `contextCompaction` item; assert event.
- **Phase 3:** `/goal set Foo` → assert `thread/goal/set` request body shape matches §4.2 (esp. double-Option semantics for `tokenBudget`).
- **Phase 4-5:** assert URL-form image goes through as `{ type: "image", url }`; assert imageGeneration/imageView items become the right events.
- **Phase 6:** fixture emits one `webSearch` item with each `WebSearchAction` variant including `{ type: "other" }`; assert no crash and a renderable event.
- **Phase 7:** fixture emits `thread/tokenUsage/updated` with the 5-field breakdown; assert footer model gets all 5 fields.
- **Phase 8:** `thread/list` returns paginated data with `nextCursor`; assert the modal renders and `[Load more]` issues another request with that cursor. Test snake_case wire encoding of `sortKey` (gotcha 5).
- **Phase 9:** fixture returns a thread with 100 turns; assert only 50 summary items load on resume, full only on expand.
- **Phase 10:** `--print` mode skips emitting delta events.

### 8.2 Manual smoke checklist

For each phase, end with a manual smoke pass against the dev Electron build:

- Open the work tab, start a chat, exercise the new feature, capture screenshot.
- Open `ade` TUI in another terminal, attach to the same lane, exercise the same feature.
- Compare event ordering against `git log` of `agentChatService.ts` debug output.

---

## 9. Rollout & migration plan

1. **Pre-merge:** all phase PRs target a feature branch `feature/codex-v130`, not `main`.
2. **First release with new binary:** ship in a beta channel build. The channel-isolated profile work already landed (commit `5de5f054 — Isolate desktop profiles by channel`) means beta users get a clean profile so a broken Codex session can't poison prod profiles.
3. **Rollback plan:** keep the `CODEX_EXECUTABLE` env override functional. If v0.130 has a regression, users can drop to a known-good local install with `export CODEX_EXECUTABLE=/usr/local/bin/codex` and restart.
4. **Telemetry to add:** on every Codex JSON-RPC method call, log method + duration + error code. Surface in the existing ADE telemetry pipeline. Especially important: `thread/turns/list` p95 (Phase 9 hinges on it staying < 500ms).

---

## 10. Open questions / risks

1. **Binary signing on Windows.** Codex binaries are unsigned upstream. macOS notarization will pick up the binary via the app bundle's hardened-runtime entitlements (verified — there's a `disable-library-validation` entitlement at `apps/desktop/build/entitlements.mac.plist:4-9`). Windows is different — `ADE_REQUIRE_WIN_SIGNING` (env var at `apps/desktop/scripts/validate-win-artifacts.mjs:34`) currently fails the build if shipped binaries are unsigned. We may need to re-sign the codex binary with our cert or disable the check for the codex bin specifically. Confirm with whoever owns the Windows release.
2. **Bundle size.** Codex binary is ~50MB per platform. Universal mac DMG = arm64 + x64 = 100MB extra. Windows installer = 50MB extra. We already ship runtime binaries the same way, so this is a known cost.
3. **Plugin/app misconfig noise.** Once `--disable plugins --disable apps` is dropped, users with broken plugin configs in `~/.codex/` will hit `configWarning` notifications. We should surface these as a subtle dimmed line in the chat (one-line addition; out of scope for Phase 0).
4. **Double-Option for token budget.** TS doesn't distinguish `undefined` from `null` natively in `JSON.stringify` if you set the field. We need explicit serialization helpers; consider a small `omitUndefined()` wrapper before sending `thread/goal/set` requests, and prefer `null` only when the user means "clear".
5. **`developerInstructions` is thread-scoped only.** If we ever want per-turn override (e.g. "for this prompt only, be terse"), we'll need a `thread/fork` + `thread/start` pattern instead. Document this in the slash command help.
6. **`thread/turns/items/list` returns unsupported-method.** We rely on `thread/turns/list` with `itemsView: "full"` instead. If a future Codex version implements per-item pagination, we can swap.
7. **Goal banner real estate in TUI.** The TUI already has a Header + ModelStatus + FooterControls stack. One more line is fine, but check it doesn't push the chat scrollback into a too-small region on 24-line terminals. Test with `COLUMNS=80 LINES=24`.

---

## 11. Definition of done

- `codex` v0.130.0 binary ships in macOS arm64, macOS x64, Windows x64, Linux x64, Linux arm64 builds — verified by running the smoke handshake test in CI.
- `--disable plugins --disable apps` is gone from the spawn line; `--disable browser_use --disable computer_use` remains.
- `/plan`, `/compact`, `/goal`, `/resume` are wired in both desktop slash registry and TUI `commands.ts`.
- Plan, compaction, goal banner, image-gen card, image-view line, webSearch card all have dedicated visual treatment (no `text` fallback).
- Token usage shows the 5-field breakdown in the desktop footer and the TUI `ModelStatus` line; `modelContextWindow`-relative progress bar is visible in both surfaces.
- Resume picker opens via `/resume` (and `Ctrl+R` in TUI); search, fork, unarchive, rollback all work.
- Resuming a 100-turn thread loads in < 1s thanks to `itemsView: "summary"`; "Show full turn" expands a single turn lazily.
- No regression in approval flow, command execution rendering, file diff rendering, reasoning streaming, /review slash command.
- All new tests pass under sharded `pnpm test`; manual smoke checklist signed off.
