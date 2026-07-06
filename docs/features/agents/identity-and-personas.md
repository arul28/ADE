# Identity and Personas

The CTO carries a persistent identity that survives across sessions, context compaction, and model switches. This doc explains how that identity is stored, how it is reconstructed into sessions, how personality/persona overlays shape behavior, and how the smart-memory system keeps the thread grounded.

There is one persistent identity: the CTO. The former worker/hiring agent identities were removed, and `AgentChatIdentityKey` is now just `"cto"`.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | CTO identity CRUD, session logs, system-prompt composition, onboarding state, reconstruction context, and startup reconciliation. |
| `apps/desktop/src/main/services/cto/ctoMemoryService.ts` | The smart-memory file store: `MEMORY.md`, `thread-state.md`, daily logs, search, and injection sections. |
| `apps/desktop/src/main/services/cto/ctoPromptContent.ts` | `buildCtoCapabilityManifest()` — the operator-tool manifest injected into the prompt. |
| `apps/desktop/src/main/services/projects/logIntegrityService.ts` | Hash-chained integrity for CTO session logs. |
| `apps/desktop/src/shared/ctoPersonalityPresets.ts` | Built-in personality overlays plus `custom`. |
| `apps/desktop/src/renderer/components/cto/IdentityEditor.tsx` | UI for editing CTO name, persona, personality, and work style. |
| `apps/desktop/src/shared/types/cto.ts` | CTO identity, onboarding, prompt-preview, memory, and capability types. |

## CTO identity

`CtoIdentity` is versioned and stored per project. It contains name, persona, personality overlay, communication style (work style), constraints, model preferences, onboarding state, and an optional prompt extension.

Storage:

1. SQLite `cto_identity_state`.
2. Filesystem `.ade/cto/identity.yaml`, written atomically.

Startup reconciliation compares timestamps and writes the newer copy back to the stale side. Users should edit through ADE's UI so version ordering stays clear.

## Personality presets

`CTO_PERSONALITY_PRESETS` in `shared/ctoPersonalityPresets.ts` contains:

| Preset id | Label | Description |
|---|---|---|
| `strategic` | Strategic | Long-range, architectural, decisive without losing execution detail. |
| `professional` | Executive | Calm, structured, leadership-oriented for day-to-day technical direction. |
| `hands_on` | Hands-on | Deep in the code, practical in execution, quick to unblock delivery. |
| `casual` | Collaborative | Warm, human, easy to work with while still acting like the technical lead. |
| `minimal` | Concise | Low-noise, direct, focused on decisions, blockers, next actions. |
| `custom` | Custom | User-supplied overlay text via `customPersonality`. |

`getCtoPersonalityPreset(id)` falls back to `strategic` on unknown ids. Do not rename preset ids without a migration.

## Communication style (work style)

```ts
type CtoCommunicationStyle = {
  verbosity: "concise" | "detailed" | "adaptive";
  proactivity: "reactive" | "balanced" | "proactive";
  escalationThreshold: "low" | "medium" | "high";
};
```

These fields drive prompt adjustments for detail level, initiative, and when to escalate. The onboarding card and `IdentityEditor` set them via the `Segmented` work-style rows.

## Immutable doctrine and prompt layers

`ctoStateService.ts` composes the CTO system prompt from layered sections, immutable first:

- `IMMUTABLE_CTO_DOCTRINE` — CTO role, responsibilities, and precision rules.
- Selected personality overlay (+ `customPersonality` for the `custom` preset).
- `CTO_CONTINUITY_OPERATING_MODEL` — how ADE re-grounds the CTO across compaction and resumes.
- `CTO_MEMORY_SYSTEM_GUIDANCE` — teaches the CTO that it has durable, model-agnostic memory and how to use the memory tools.
- Environment knowledge — ADE surfaces, tools, task-routing rules, and the live model registry.
- `CTO_CAPABILITY_MANIFEST` — the available operator tools, injected verbatim.

`previewSystemPrompt()` returns exactly these sections, which the settings and onboarding UI render.

## Smart memory system

The CTO's durable knowledge lives in files under `.ade/cto/`, owned by `ctoMemoryService`:

- `MEMORY.md` — curated durable facts (decisions, preferences, standing context) under a `## Facts` list. Written by the `saveMemory` tool and the `CtoMemoryPanel` editor. Always injected (tail-capped for injection; the disk copy is never truncated, with a 64 KiB hard cap that drops oldest facts).
- `thread-state.md` — a rolling summary of the current goal, recent decisions, and open loops. Rewritten by the continuity flush.
- `daily/<YYYY-MM-DD>.md` — an append-only per-turn journal (`HH:MM — intent → outcome`).

The CTO reads and writes memory through operator tools: `saveMemory(fact)` (append a durable fact, exact duplicates ignored), `searchMemory(query)` (bounded file search across memory, thread state, and daily logs), and `readMemory()` (durable facts + current thread state).

### Flush and injection lifecycle

The guarantee is a deterministic flush that always runs before anything can be lost; an LLM upgrade of the summary is best-effort on top (both in `agentChatService.ts`, no-op for non-CTO sessions):

1. **Turn-end journal** — after each completed/failed CTO turn, one line is appended to today's daily log. No LLM call.
2. **Pre-compaction flush** — on the runtime's compaction signal, `flushIdentityContinuityDeterministic` writes the tail snapshot to `thread-state.md` synchronously, then a best-effort LLM summary overwrites it when it returns.
3. **Pre-model-switch flush** — the same deterministic flush runs before `teardownRuntime` on a model/provider switch, so nothing in the old window is lost.

Cursor and Droid emit no compaction signal, so for those runtimes the turn-end journal plus the switch-time flush are what make a reset recoverable.

## Reconstruction context

On every CTO session start, and after compaction or a model switch, `ctoStateService.buildReconstructionContext()` produces a bounded block with:

1. The runtime identity and operating doctrine.
2. ADE operational/environment knowledge.
3. Identity metadata (name, persona, preferred model) and recent CTO session summaries.
4. The memory sections from `ctoMemoryService.buildMemoryContextSections()` — durable memory, thread state, and the recent daily log.

`agentChatService` stages this as `pendingReconstructionContext` and re-injects it via `refreshReconstructionContext()` so the identity session does not drift into generic chat behavior.

## Session logs

The CTO maintains an append-only session log with hash chaining. Each entry includes session id, summary, started/ended timestamps, provider, model id, capability mode, created-at timestamp, and an optional `prevHash`. `logIntegrityService` computes and verifies hashes; a broken chain indicates tampering or a partial restore. Logs are reconciled between `sessions.jsonl` and the `cto_session_logs` table on startup.

## Onboarding state

`CtoOnboardingState` tracks completed setup steps. `CTO_REQUIRED_ONBOARDING_STEPS = ["identity"]`; the one-card setup collects personality, work style, and an optional name, then marks the `identity` step complete.

## IPC surface

| Channel | Purpose |
|---|---|
| `ade.cto.getState` | Fetch CTO identity and recent sessions. |
| `ade.cto.previewSystemPrompt` | Render the current layered system prompt for settings/onboarding. |
| `ade.cto.updateIdentity` | Patch identity fields (name, personality, work style, model preferences). |
| `ade.cto.ensureSession` | Get or create the single CTO chat session. |
| `ade.cto.listSessionLogs` | Read the CTO session log. |
| `ade.cto.getMemory` / `ade.cto.updateMemory` / `ade.cto.searchMemory` | Read, rewrite, and search durable memory. |
| `ade.cto.getOnboardingState` / `completeOnboardingStep` / `dismissOnboarding` / `resetOnboarding` | Onboarding lifecycle. |

## Fragile and tricky wiring

- **Personality preset id stability.** Changing an id silently remaps unknown existing identities to `strategic`.
- **Custom personality text size.** `customPersonality` is injected as-is; very long values consume prompt budget.
- **Deterministic flush is the guarantee.** The LLM summary upgrade is best-effort — never make the durable memory write depend on it.
- **Injected memory is authoritative.** The prompt tells the CTO not to claim memory it does not have injected; injection caps/order in `ctoMemoryService`/`ctoStateService` directly change what the CTO "knows."
- **Capability manifest is hand-synced.** `buildCtoCapabilityManifest()` must stay aligned with `ctoOperatorTools.ts` registrations.
- **Daily log permission.** Files under `.ade/cto/daily/` are written with the default umask. Keep `.ade/` out of shared paths.

## Related docs

- [Agents README](README.md) — overview of the CTO and chat agents.
- [CTO](../cto/README.md) — the full CTO thread, memory system, and settings surface.
- [Tool Registration](tool-registration.md) — how identity flows into ADE CLI-exposed tools.
- [Chat Agent Routing](../chat/agent-routing.md) — provider selection and model preferences.
