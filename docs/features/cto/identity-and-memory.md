# CTO Identity and Memory

How the CTO prompt is assembled, how personality presets are defined, and how persistent state survives context compaction and repo clones.

## Layered prompt model

The CTO system prompt is built from four layers by `ctoStateService.previewSystemPrompt()` / `buildSystemPrompt()`. The layers are merged in order and the preview surface (`CtoPromptPreview.tsx`) renders each one separately so the UI matches the runtime.

### Layer 1: Immutable doctrine

Defined as `IMMUTABLE_CTO_DOCTRINE` in `apps/desktop/src/main/services/cto/ctoStateService.ts`. ADE-owned. Not user-editable. Not compacted away. Covers:

- CTO role scope (project technical and operational lead).
- ADE environment context (local-first Electron desktop, lanes, chats, missions, workers, Linear, PR convergence, conflict resolution).
- Anti-persona drift rule: "Answer identity questions as the project's CTO. Do not reframe yourself as Codex, Claude, or a detached chatbot."
- Precision rules: honor explicit model/lane/configuration requests exactly; never silently fall back.
- Proactive tool use: call the tool first, report facts, do not guess.

### Layer 2: Personality overlay

Selected from `CTO_PERSONALITY_PRESETS` in `apps/desktop/src/shared/ctoPersonalityPresets.ts`. Six presets:

| Preset id | Label | Intent |
| --- | --- | --- |
| `strategic` | Strategic | Long-range, architectural, tradeoff-explicit. |
| `professional` | Executive | Calm, structured, leadership-oriented. |
| `hands_on` | Hands-on | Close to the code, practical, debug-oriented. |
| `casual` | Collaborative | Warm, human, still holds the bar. |
| `minimal` | Concise | Signal-dense, low-noise, next-action-first. |
| `custom` | Custom | Uses the user's `customPersonality` string, still bound to doctrine. |

Each preset exports `systemOverlay` — the actual string spliced into the prompt. The label is what shows up in the UI. When `identity.personality === "custom"`, the runtime uses `identity.customPersonality.trim()` instead of the preset overlay.

The identity record also carries `persona` as a human-readable summary rendered in the sidebar (`"Persistent project CTO with <label> personality."`). `persona` is not used inside the prompt itself.

### Layer 3: Memory operating model

Defined as `CTO_MEMORY_OPERATING_MODEL`. Explains the four-part continuity model and the operating rules:

1. Immutable doctrine is reapplied automatically and never compacted away.
2. Long-term CTO brief at `.ade/cto/MEMORY.md` — summary, conventions, preferences, active focus, standing notes.
3. Current working context at `.ade/cto/CURRENT.md` — recent sessions, worker activity, carry-forward.
4. Durable searchable memory via `memorySearch` / `memoryAdd` (see `apps/desktop/src/main/services/memory/memoryService.ts`).

Operating rules embedded in the prompt:

- Treat memory as mandatory operating infrastructure, not optional notes.
- Re-ground in long-term brief + current context + durable memory before non-trivial work.
- Do not shell-read `.ade/cto/*` from the workspace — ADE already injects the reconstructed state.
- Use `memoryUpdateCore` for the project brief, `memoryAdd` for reusable decisions, patterns, gotchas, preferences.
- Do not store ephemeral turn-by-turn status.

### Layer 4: Environment knowledge and capability manifest

`CTO_ENVIRONMENT_KNOWLEDGE` is a structured block that teaches ADE concepts and intent-to-tool routing. Highlights:

- Lane types (primary / worktree / attached), lane metadata, and lane tools.
- Native ADE chat vs PTY terminal vs subprocess agent distinction, with explicit examples.
- Mission lifecycle, worker lifecycle, convergence, conflict resolution.
- ADE pages and routes (`/work`, `/lanes`, `/files`, `/prs`, `/missions`, `/cto`, `/graph`, `/history`, `/automations`, `/settings`).
- Model registry summary and reasoning-effort tiers.
- Task-routing map (e.g. "Check PR status" -> `getPullRequestStatus`, "Show me the Linear issues" -> `listLinearIssues`).

`CTO_CAPABILITY_MANIFEST` is the full tool surface grouped by domain (lanes, chats, missions, workers, git, PRs, convergence, conflicts, files, context, processes, tests, terminals, Linear, automations, events, project health, computer use, budget, memory). It is the source of truth for "what the CTO can do" and must be kept in sync with `ctoOperatorTools.ts` registrations. The prompt deliberately includes the full manifest rather than a summary so the CTO can pick the right tool without a fallback lookup.

## Core memory

`CtoCoreMemory` is edited via CTO Settings > Memory. Fields:

- `projectSummary` — one-paragraph project brief.
- `criticalConventions` — bullet list.
- `userPreferences` — bullet list.
- `activeFocus` — bullet list.
- `notes` — bullet list.

The service exposes `updateCoreMemory(patch)` which merges a `CoreMemoryPatch` (all fields optional), bumps `version`, and writes `updatedAt`. Core memory is persisted as a `PersistedDoc<CtoCoreMemory>` in the sqlite kv store and mirrored to `.ade/cto/MEMORY.md` for portability and read-through visibility.

Memory browsing across all scopes (project, agent, mission) is consolidated in Settings > Memory. The CTO tab no longer has its own Memory surface — editing of CTO-specific core memory is done in CTO Settings.

## Daily logs

Append-only markdown under `.ade/cto/daily/<YYYY-MM-DD>.md`. API in `ctoStateService.ts`:

- `appendDailyLog(entry, date?)` — timestamped line append.
- `readDailyLog(date?)` — full day file.
- `listDailyLogs(limit?)` — dates, most recent first.

Daily logs are operational history, not part of the immutable doctrine. They are local/ADE-sync only in the current portability pass. Workers and automations can append their own daily log lines via the operator tool surface.

## Subordinate activity

`appendCtoSubordinateActivity({ agentId, agentName, activityType, summary, sessionId?, taskKey?, issueKey? })` writes a row used by the CTO sidebar activity feed. `activityType` is one of `chat_turn` or `worker_run`. Session/task/issue keys thread runs back to their origin.

## Session logs

`appendCtoSessionLog({ sessionId, summary, startedAt, endedAt, provider, modelId, capabilityMode })` writes a compact CTO-session record. `capabilityMode` distinguishes `full_tooling` (ADE CLI/action bridge available) from `fallback` (the provider cannot reach ADE CLI actions). Session logs drive the Settings > Timeline list.

## Reconstruction after context compaction

When a CTO or worker session undergoes context compaction, `refreshReconstructionContext()` re-injects the identity block before the next turn. This prevents the doctrine and personality from being dropped along with older messages. Without it, long sessions drift into generic-chatbot behavior. The service owns this guarantee, not the provider adapter.

## Portability (Phase 6 W3)

- Identity YAML (`identity.yaml` layout) is part of the shared ADE scaffold and intended to survive a clone/pull.
- Core memory schema is git-tracked; the live content in `MEMORY.md` / `CURRENT.md` is local/ADE-sync.
- Daily logs and session logs are operational history — local/ADE-sync only.
- Runtime memory files, openclaw bridge cache, generated docs remain local.

This split is why a fresh clone recovers the CTO identity layer but not recent subordinate activity or session logs.

## Cross-links

- `README.md` — overview and source file map.
- `onboarding.md` — how a new project picks a preset and lands on the CTO page.
- `pipeline-builder.md` — visual plan structure for Linear workflows; identity context appears in workflow target `supervisorIdentityKey`.
- `linear-integration.md` — workflow-level identity mapping (`AgentLinearIdentity`, team panel).
