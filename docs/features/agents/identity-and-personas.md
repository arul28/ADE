# Identity and Personas

CTO and worker agents carry persistent identity documents that survive
across sessions. This doc explains how identity is stored, how it is
reconstructed into sessions, and how personality/persona overlays shape
behavior.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | CTO identity CRUD, session logs, subordinate activity feed, system prompt composition, daily logs, onboarding state, and startup reconciliation. |
| `apps/desktop/src/main/services/cto/workerAgentService.ts` | Worker identity CRUD, adapter config validation, slug generation, secret policy enforcement, and session context assembly. |
| `apps/desktop/src/main/services/projects/logIntegrityService.ts` | Hash-chained integrity for CTO and worker session logs. |
| `apps/desktop/src/shared/ctoPersonalityPresets.ts` | Built-in personality overlays plus `custom`. |
| `apps/desktop/src/renderer/components/cto/IdentityEditor.tsx` | UI for editing CTO identity, persona, personality, and communication style. |
| `apps/desktop/src/shared/types/cto.ts` | CTO identity, onboarding, prompt preview, and capability types. |
| `apps/desktop/src/shared/types/agents.ts` | Worker identity, role, adapter, runtime, and budget types. |

## CTO identity

`CtoIdentity` is versioned and stored per project. It contains persona,
personality overlay, communication style, constraints, model
preferences, onboarding state, and optional prompt extension.

Storage:

1. SQLite `cto_identity_state`.
2. Filesystem `.ade/cto/identity.json`, written atomically.

Startup reconciliation compares versions and writes the newer copy back
to the stale side. Users should edit through ADE's UI so version
ordering stays clear.

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

`getCtoPersonalityPreset(id)` falls back to `strategic` on unknown ids.
Do not rename preset ids without a migration.

## Communication style

```ts
type CtoCommunicationStyle = {
  verbosity: "concise" | "detailed" | "adaptive";
  proactivity: "reactive" | "balanced" | "proactive";
  escalationThreshold: "low" | "medium" | "high";
};
```

These fields drive prompt adjustments for detail level, initiative, and
when to escalate.

## Immutable doctrine

`ctoStateService.ts` defines prompt blocks that are always present in
CTO sessions:

- `IMMUTABLE_CTO_DOCTRINE` -- CTO role, responsibilities, and precision
  rules.
- `CTO_ENVIRONMENT_KNOWLEDGE` -- ADE surfaces, tools, and task-routing
  rules.
- `CTO_CAPABILITY_MANIFEST` -- available operator tools.

The doctrine, personality overlay, persona, recent context, and prompt
extension are assembled into the first prompt for each CTO session.

## Reconstruction context

On every CTO session start, and after chat context compaction,
`buildReconstructionContext()` produces a bounded block with:

1. Recent CTO session summaries.
2. Recent subordinate activity.
3. Daily log contents for the current day when present.
4. Identity/persona metadata needed to keep the session grounded.

`agentChatService` calls `refreshReconstructionContext()` after
compaction so identity sessions do not drift into generic chat behavior.

## Worker identity

Workers use `AgentIdentity` with role, adapter, runtime config, budget,
Linear identity, persona fields, constraints, and system-prompt
extension.

### Slug generation

`slugify(input)` lowercases, replaces non-alphanumerics with `-`, and
strips leading/trailing hyphens. Empty results fall back to `"worker"`.
Collisions append `-2`, `-3`, etc. The slug is used for the SQLite row,
filesystem directory, and ADE CLI action routing.

Renaming a worker leaves the slug fixed unless the user explicitly
updates it; the filesystem directory does not move.

### Secret policy

`assertEnvRefSecretPolicy` walks adapter config values for raw secrets.
Sensitive values must be `${env:VAR_NAME}` references; raw secrets throw
at write time. Bypassing this check can leak secrets into prompts,
logs, and transcripts.

### Reconstruction

Worker sessions receive a worker-specific context block:

1. Worker identity, role, persona, constraints, and prompt extension.
2. Recent worker session logs.
3. Current lane/project context relevant to the activation.

Workers do not receive the CTO doctrine or full environment knowledge
block.

## Session logs

CTO and workers maintain append-only session logs with hash chaining.
Each entry includes session id, summary, started/ended timestamps,
provider, model id, capability mode, created-at timestamp, and optional
`prevHash`.

`logIntegrityService` computes and verifies hashes; a broken chain
indicates tampering or partial restore.

## Subordinate activity feed

The CTO feed records worker chat turns and worker runs:

```ts
type CtoSubordinateActivityEntry = {
  id: string;
  agentId: string;
  agentName: string;
  activityType: "chat_turn" | "worker_run";
  summary: string;
  sessionId?: string | null;
  taskKey?: string | null;
  issueKey?: string | null;
  createdAt: string;
};
```

The feed is capped and included in the CTO's session context.

## Daily logs

Append-only markdown files:

- CTO: `.ade/cto/daily/<YYYY-MM-DD>.md`
- Workers: `.ade/agents/<slug>/daily/<YYYY-MM-DD>.md`

Each entry is a session summary or ad-hoc note. The current day's log is
read into reconstruction context for within-day continuity.

## Onboarding state

`CtoOnboardingState` tracks completed setup steps.
`CTO_REQUIRED_ONBOARDING_STEPS = ["identity"]`; the wizard walks through
identity setup before enabling the full CTO experience.

## IPC surface

| Channel | Purpose |
|---|---|
| `ade.cto.getState` | Fetch CTO identity, recent sessions, and subordinate activity. |
| `ade.cto.getSystemPromptPreview` | Render the current system prompt for settings/onboarding. |
| `ade.cto.updateIdentity` | Patch identity fields. |
| `ade.cto.ensureSession` | Get or create the CTO chat session. |
| `ade.cto.appendSessionLog` / `ade.cto.listSessionLogs` | Session log CRUD. |
| `ade.cto.appendSubordinateActivity` / `ade.cto.listSubordinateActivity` | Feed CRUD. |
| `ade.workers.list` / `ade.workers.upsert` / `ade.workers.remove` | Worker CRUD. |
| `ade.workers.getIdentity` | Single worker fetch. |

## Fragile and tricky wiring

- **Personality preset id stability.** Changing an id silently remaps
  unknown existing identities to `strategic`.
- **Custom personality text size.** `customPersonality` is injected
  as-is. Very long values consume prompt budget.
- **Worker slug drift.** Renaming a worker does not move its filesystem
  directory.
- **Daily log permission.** Files under `.ade/cto/daily/` are written
  with the default umask. Keep `.ade/` out of shared paths.
- **Post-compaction identity block size.** Reconstruction is bounded but
  can still be several thousand tokens on busy projects.
- **Capability mode is historical.** Logs record the mode in effect at
  session start; they do not update when ADE CLI becomes available later.
- **Subordinate activity ordering.** Writes prepend to a capped list;
  sort by `createdAt` for strict chronology.

## Related docs

- [Agents README](README.md) -- overview of CTO, workers, and chat.
- [Tool Registration](tool-registration.md) -- how identity flows into
  ADE CLI-exposed tools.
- [Chat Agent Routing](../chat/agent-routing.md) -- provider selection
  and model preferences.
