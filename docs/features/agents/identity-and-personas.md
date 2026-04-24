# Identity and Personas

CTO and worker agents carry persistent identity documents that survive
across sessions. This doc explains how identity is stored, how it is
reconstructed into each session, and how the personality/persona
overlays shape agent behavior.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/cto/ctoStateService.ts` | CTO identity CRUD, core memory CRUD, session logs, subordinate activity feed, system prompt composition, daily logs, onboarding state, startup reconciliation. |
| `apps/desktop/src/main/services/cto/workerAgentService.ts` | Worker identity CRUD, core memory CRUD, adapter config validation, slug generation, secret policy enforcement. |
| `apps/desktop/src/main/services/projects/logIntegrityService.ts` | Hash-chained integrity for CTO and worker session logs. |
| `apps/desktop/src/shared/ctoPersonalityPresets.ts` | `CTO_PERSONALITY_PRESETS`: five built-in overlays plus `custom`. |
| `apps/desktop/src/renderer/components/cto/identityPresets.ts` | Renderer re-export of the personality presets. |
| `apps/desktop/src/renderer/components/cto/IdentityEditor.tsx` | UI for editing CTO identity, persona, personality, communication style. |
| `apps/desktop/src/shared/types/cto.ts` | `CtoIdentity`, `CtoCoreMemory`, `CtoCapabilityMode`, `CtoPersonalityPreset`. |
| `apps/desktop/src/shared/types/agents.ts` | `AgentIdentity`, `AgentCoreMemory`, `AgentRole`, `AdapterType`. |

## CTO identity

### Documents

Two separate documents, versioned independently:

- **`CtoIdentity`** -- persona, personality overlay, communication
  style, constraints, model preferences, memory policy, onboarding
  state. Stable per-project unless the user edits it.
- **`CtoCoreMemory`** -- projectSummary, criticalConventions,
  userPreferences, activeFocus, notes. Mutates frequently as the CTO
  learns about the project.

Both documents carry `version: number` and `updatedAt: string`. The
version is strictly monotonic; every write increments it.

### Storage

Dual-persisted for resilience:

1. **SQLite** -- `cto_identity_state` and `cto_core_memory_state`
   tables. Single row per project. The payload is a JSON blob.
2. **Filesystem** -- `.ade/cto/identity.json` and
   `.ade/cto/core-memory.json`. Written atomically via
   `writeTextAtomic`.

Writes happen to both places. Reads prefer SQLite during normal
operation.

### Reconciliation on startup

`ctoStateService.reconcileCoreMemoryOnStartup()` and its identity
twin run at app startup:

1. Read both copies.
2. Compare versions.
3. If equal, no-op.
4. If unequal, prefer the higher version. Write it back to the lower
   side so both are in sync.

The rationale: the user may edit the JSON file externally while the
app is off, or the app may crash before syncing to disk. Version-based
reconciliation handles both cases. The losing side's changes are
silently discarded -- always edit through the UI when possible.

### Personality presets

`CTO_PERSONALITY_PRESETS` in `shared/ctoPersonalityPresets.ts`:

| Preset id | Label | Description |
|---|---|---|
| `strategic` | Strategic | Long-range, architectural, decisive without losing execution detail. |
| `professional` | Executive | Calm, structured, leadership-oriented for day-to-day technical direction. |
| `hands_on` | Hands-on | Deep in the code, practical in execution, quick to unblock delivery. |
| `casual` | Collaborative | Warm, human, easy to work with while still acting like the technical lead. |
| `minimal` | Concise | Low-noise, direct, focused on decisions, blockers, next actions. |
| `custom` | Custom | User-supplied overlay text via `customPersonality`. |

Each preset ships a `systemOverlay` string that injects into the CTO
system prompt after the doctrine. Selecting `custom` switches to the
`customPersonality` field as the overlay.

`getCtoPersonalityPreset(id)` is the lookup helper; it falls back to
`strategic` (the first preset) on unknown input. This fallback means
removing or renaming a preset id silently remaps existing CTO
identities. Keep ids stable.

### Communication style

Orthogonal to personality preset:

```ts
type CtoCommunicationStyle = {
  verbosity: "concise" | "detailed" | "adaptive";
  proactivity: "reactive" | "balanced" | "proactive";
  escalationThreshold: "low" | "medium" | "high";
};
```

These drive fine-grained prompt adjustments (how much detail to
provide, when to volunteer information, when to escalate).

### Immutable doctrine

`ctoStateService.ts` defines three multi-line constants that are
always present in every CTO session's system prompt, independent of
the selected personality or persona:

- `IMMUTABLE_CTO_DOCTRINE` -- who the CTO is, responsibilities, and
  precision rules.
- `CTO_MEMORY_OPERATING_MODEL` -- the four-layer memory model
  (doctrine, long-term brief, current context, durable memory).
- `CTO_ENVIRONMENT_KNOWLEDGE` -- an extensive description of ADE
  surfaces, tools, and task-routing rules.
- `CTO_CAPABILITY_MANIFEST` -- the full list of tool names the CTO
  can call, with brief descriptions.

These blocks are concatenated, then the personality overlay, persona,
core memory, and `systemPromptExtension` are appended. The resulting
system prompt is the first message in every CTO session.

### Core memory fields

```ts
type CtoCoreMemory = {
  version: number;
  updatedAt: string;
  projectSummary: string;       // concise project description
  criticalConventions: string[];// rules and patterns the team follows
  userPreferences: string[];    // user-stated preferences
  activeFocus: string[];        // current priorities
  notes: string[];              // freeform observations
};
```

Populated by:

- The CTO via `memoryUpdateCore` tool calls (one call per patch).
- The user via the CTO Settings panel.
- Startup reconciliation (merges from filesystem).

### Reconstruction context

On every CTO session start (and after context compaction),
`buildReconstructionContext()` produces a structured block injected as
the first user message:

1. Core memory: projectSummary, conventions, preferences, focus, notes.
2. Memory briefings: top-N pinned and high-importance memories across
   project scope.
3. Recent session logs: last few `CtoSessionLogEntry` rows (summaries).
4. Recent subordinate activity: last few `CtoSubordinateActivityEntry`
   rows.
5. Daily log contents (if any for today).

The block is bounded; long lists truncate with a "+N more" marker so
the context window is not consumed by identity alone.

### Refresh after compaction

When chat context compaction fires for a CTO session, `agentChatService`
calls `refreshReconstructionContext()` which re-runs
`buildReconstructionContext()` and injects the block again. Without
this, the CTO loses persona + identity mid-session and starts
answering as a generic assistant.

## Worker identity

Structured identically to CTO (five-field core memory), but with more
configuration surface:

- **Role** (`AgentRole`) -- `engineer`, `qa`, `designer`, `devops`,
  `researcher`, `general`. Used for prompt context, Linear routing,
  and UI grouping. `cto` is reserved.
- **Adapter** -- one of `claude-local`, `codex-local`,
  `openclaw-webhook`, `process`. Determines how the worker is
  activated.
- **Runtime config** -- heartbeat policy, max concurrent runs.
- **Budget** -- monthly cents cap + current spend.
- **Linear identity** -- optional mapping to Linear user ids,
  display names, and aliases so issues assigned to the worker can
  route correctly.
- **ADE CLI access** -- per-worker policy for ADE CLI
  servers.

### Slug generation

`slugify(input)` lowercases, replaces non-alphanumerics with `-`, and
strips leading/trailing hyphens. Empty results fall back to `"worker"`.
Collisions are resolved by appending `-2`, `-3`, etc.

The slug is used in:

- SQLite `agent_identities.slug` column.
- Filesystem path `.ade/agents/<slug>/`.
- ADE CLI action routing.

Renaming a worker leaves the slug fixed unless the user explicitly
updates it; the filesystem directory does not move.

### Secret policy

`assertEnvRefSecretPolicy` walks adapter config values looking for
raw secrets. It uses `looksSensitiveKey` (keys like `apiKey`, `token`,
`password`) and `looksSensitiveValue` (values with suspicious
prefixes/shapes). Values that match must be `${env:VAR_NAME}`
references; raw secrets throw at write time.

Bypassing this check (direct SQL writes) allows secrets into the
adapter config, from which they leak into logs, system prompts, and
transcripts. Always write through `workerAgentService.upsert`.

### Core memory

Same five fields as CTO:

```ts
type AgentCoreMemory = {
  version: number;
  updatedAt: string;
  projectSummary: string;
  criticalConventions: string[];
  userPreferences: string[];
  activeFocus: string[];
  notes: string[];
};
```

Defaults (from `normalizeWorkerCoreMemory`):

- Empty arrays for list fields.
- `projectSummary` defaults to `"Worker context is being built
  through direct sessions and CTO delegation."` when missing.

Persisted at `.ade/agents/<slug>/core-memory.json` and in-SQLite
similarly to the CTO (though via a different storage path).

### Reconstruction

When a worker session starts, a worker-specific reconstruction
context is built analogously to the CTO flow:

1. Worker's core memory.
2. Worker's persona, personality, constraints, `systemPromptExtension`.
3. Memory briefing (project + agent + mission scopes).
4. Recent worker session logs.

The worker does not see the CTO's doctrine or environment knowledge
blocks; workers are scoped to their role.

## Session logs

Both CTO and workers maintain append-only session logs with hash
chaining.

### Schema

```sql
create table if not exists cto_session_logs (
  id text primary key,
  project_id text not null,
  session_id text not null,
  summary text not null,
  started_at text not null,
  ended_at text,
  provider text not null,
  model_id text,
  capability_mode text not null,
  created_at text not null
);
```

(Workers use `worker_agent_runs` for runtime rows and a filesystem log
for session entries.)

### Entry shape

```ts
type CtoSessionLogEntry = {
  id: string;
  prevHash?: string | null;    // hash of the previous entry
  sessionId: string;
  summary: string;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  modelId: string | null;
  capabilityMode: "full_tooling" | "fallback";
  createdAt: string;
};
```

`prevHash` links each entry to the previous one. `logIntegrityService`
computes and verifies these hashes; a broken chain indicates tampering
or partial restore.

## Subordinate activity feed

CTO-specific. The feed records what workers (subordinates) have been
doing, so the CTO can check proactively.

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

Appended by:

- `agentChatService` on worker chat turn completion.
- `workerAgentService` / `workerAgentRuns` on worker run completion.

The feed is capped at N entries (prepend-and-truncate). The CTO's
Daily Context protocol includes "check subordinate activity".

## Daily logs

Append-only markdown files:

- CTO: `.ade/cto/daily/<YYYY-MM-DD>.md`
- Workers: `.ade/agents/<slug>/daily/<YYYY-MM-DD>.md`

Each entry is a single session summary or an ad-hoc note. The current
day's log file is read and included in the reconstruction context for
within-day session continuity.

Daily logs are **not** persisted to SQLite; they are file-only. This
keeps SQLite small and makes the logs human-readable/editable.

## Long-term memory brief

`.ade/cto/MEMORY.md` and `.ade/agents/<slug>/MEMORY.md` are
auto-generated from promoted memories. These files are NOT the core
memory document; they are narrative summaries rendered from the
unified memory store, intended for Claude/agent auto-load at session
start.

## Onboarding state

`CtoOnboardingState` (in `cto.ts`) tracks which onboarding steps the
user has completed. `CTO_REQUIRED_ONBOARDING_STEPS = ["identity"]`
is the minimum set; the onboarding wizard walks through identity
setup before enabling the full CTO experience.

## IPC surface

| Channel | Purpose |
|---|---|
| `ade.cto.getState` | Fetch full `CtoSnapshot` (identity + core memory + recent sessions + subordinate activity). |
| `ade.cto.getSystemPromptPreview` | Render the current system prompt without running a session (for the settings preview). |
| `ade.cto.updateIdentity` | Patch identity fields. Increments version. |
| `ade.cto.updateCoreMemory` | Patch core memory fields. Increments version. |
| `ade.cto.ensureSession` | Get-or-create the CTO's chat session. |
| `ade.cto.appendSessionLog` / `ade.cto.listSessionLogs` | Session log CRUD. |
| `ade.cto.appendSubordinateActivity` / `ade.cto.listSubordinateActivity` | Feed CRUD. |
| `ade.cto.listDailyLogs` / `ade.cto.readDailyLog` | Daily log access. |
| `ade.workers.list` / `ade.workers.upsert` / `ade.workers.remove` | Worker CRUD. |
| `ade.workers.getCoreMemory` / `ade.workers.updateCoreMemory` | Worker core memory CRUD. |
| `ade.workers.getIdentity` | Single worker fetch. |

## Fragile and tricky wiring

- **Version race on concurrent edits.** If the user edits
  `core-memory.json` while ADE is running, the SQLite copy may be
  stale. The reconciler on next startup picks the higher version, but
  mid-run writes from the app can overwrite the external edit. Tell
  users to close ADE or use the UI.
- **Personality preset id stability.** Changing a preset id (e.g.
  renaming `professional` to `executive`) silently remaps to
  `strategic` for all existing CTO identities. Always add a new id
  and migrate data explicitly.
- **Custom personality text truncation.** `customPersonality` is
  injected as-is. Very long values consume system-prompt budget.
- **Worker slug drift.** Renaming a worker via `upsert` does not
  move its filesystem directory. Manual directory moves are
  required when the user wants to rename across both.
- **Daily log permission.** Files under `.ade/cto/daily/` are
  written with default umask. On multi-user systems this can leak
  session content. Ensure `.ade/` is excluded from shared paths.
- **Post-compaction identity block size.** `buildReconstructionContext`
  bounds its output but can still be several thousand tokens on
  large projects. Claude compaction watermarks may re-fire if the
  reconstruction block alone exceeds the post-compaction budget.
- **`capabilityMode` is retroactive.** Session logs record the mode
  in effect when the session *started*. If ADE CLI becomes available
  mid-session, the log still says `fallback`. This is by design but
  can confuse debuggers.
- **Subordinate activity ordering.** Writes prepend to a capped list;
  races between concurrent worker completions can briefly reorder.
  Sort by `createdAt` for guaranteed chronology.
- **Log integrity verification is not automatic.** `logIntegrityService.verify`
  must be explicitly invoked; routine reads do not verify. Corrupt
  entries remain functional unless the user triggers verification.

## Related docs

- [Agents README](README.md) -- overview of CTO, workers, and chat.
- [Tool Registration](tool-registration.md) -- how identity flows
  into ADE CLI-exposed tools.
- [Memory README](../memory/README.md) -- core memory and memory
  briefings.
- [Chat Agent Routing](../chat/agent-routing.md) -- provider
  selection and model preferences.
</content>
</invoke>