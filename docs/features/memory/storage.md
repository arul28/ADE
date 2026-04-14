# Memory Storage

Memory lives in SQLite (`kvDb.ts`), with a sidecar folder under
`.ade/memory/` for bootstrap and topic files. This doc captures the
schema, how entries move through it, and the key integrity rules.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/state/kvDb.ts` | Schema: `unified_memories`, `unified_memories_fts`, `unified_memory_embeddings`, `memory_procedure_details`, `memory_procedure_sources`, `memory_procedure_history`, `memory_skill_index`, `memory_capture_ledger`, `memory_sweep_log`, `memory_consolidation_log`, `cto_core_memory_state`, `agent_identities`. Legacy `memories` table remains for migration. |
| `apps/desktop/src/main/services/memory/memoryService.ts` | Read/write API, normalisation, dedup, write gates. |
| `apps/desktop/src/main/services/memory/memoryRepairService.ts` | Detects schema drift and repairs malformed rows. |
| `apps/desktop/src/main/services/memory/memoryFilesService.ts` | Writes `.ade/memory/MEMORY.md` and topic files from promoted memory. |
| `apps/desktop/src/main/services/memory/skillRegistryService.ts` | Tracks the `memory_skill_index` -- mapping skill files to procedure memories. |
| `apps/desktop/src/shared/types/memory.ts` | Shared DTOs and enums. |

## Core table

```sql
create table if not exists unified_memories (
  id text primary key,
  project_id text not null,
  scope text not null,            -- project | agent | mission
  scope_owner_id text,            -- null for project; agent id for agent; run id for mission
  tier integer not null default 2,-- 1 | 2 | 3
  category text not null,         -- MemoryCategory
  content text not null,
  importance text not null default 'medium', -- low | medium | high
  confidence real not null default 1.0,
  observation_count integer not null default 1,
  status text not null default 'promoted',   -- candidate | promoted | archived
  source_type text not null default 'agent', -- agent | system | user | mission_promotion | consolidation
  source_id text,
  source_session_id text,
  source_pack_key text,
  source_run_id text,
  file_scope_pattern text,
  agent_id text,
  pinned integer not null default 0,
  access_score real not null default 0,
  composite_score real not null default 0,
  write_gate_reason text,
  dedupe_key text not null default '',
  created_at text not null,
  updated_at text not null,
  last_accessed_at text not null,
  access_count integer not null default 0,
  promoted_at text,
  foreign key(project_id) references projects(id)
);

create index if not exists idx_unified_memories_project_scope_tier
  on unified_memories(project_id, scope, tier);
create index if not exists idx_unified_memories_scope_owner
  on unified_memories(project_id, scope, scope_owner_id);
create index if not exists idx_unified_memories_project_status
  on unified_memories(project_id, status);
create index if not exists idx_unified_memories_project_pinned
  on unified_memories(project_id, pinned, tier);
create index if not exists idx_unified_memories_project_accessed
  on unified_memories(project_id, last_accessed_at);
create index if not exists idx_unified_memories_project_dedupe
  on unified_memories(project_id, scope, scope_owner_id, dedupe_key);
```

`dedupe_key` is computed at write time and is used by the write gate
for fast exact-dedup lookups before running Jaccard.

## Full-text search

`unified_memories_fts` is an FTS5 virtual table that mirrors the
`content` column. Triggers keep it in sync:

- `unified_memories_fts_ai` -- after insert
- `unified_memories_fts_bd` -- before delete
- `unified_memories_fts_bu` / `unified_memories_fts_au` -- around
  update

Note: schema migrations that reinsert rows must let the triggers do the
work, or manually rebuild the FTS table. Skipping triggers leaves FTS
stale.

## Embeddings

```sql
create table if not exists unified_memory_embeddings (
  id text primary key,
  memory_id text not null,
  project_id text not null,
  embedding_model text not null,      -- "Xenova/all-MiniLM-L6-v2" today
  embedding_blob blob not null,       -- Float32 buffer, 384 dims
  dimensions integer not null,
  norm real,                          -- precomputed L2 norm for cosine
  created_at text not null,
  updated_at text not null,
  foreign key(memory_id) references unified_memories(id),
  foreign key(project_id) references projects(id)
);
```

Embedding rows are optional: search falls back to lexical FTS when
embeddings are missing. See [embeddings.md](embeddings.md) for how they
are produced and consumed.

## Procedures

Procedural learning distills episodes into reusable workflows. Three
tables:

```sql
create table if not exists memory_procedure_details (
  memory_id text primary key,       -- references unified_memories.id
  trigger text not null,
  procedure_markdown text not null,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  last_used_at text,
  exported_skill_path text,
  exported_at text,
  superseded_by_memory_id text,
  created_at text not null,
  updated_at text not null
);

create table if not exists memory_procedure_sources (
  procedure_memory_id text not null,
  episode_memory_id text not null,
  created_at text not null,
  primary key (procedure_memory_id, episode_memory_id)
);

create table if not exists memory_procedure_history (
  id text primary key,
  procedure_memory_id text not null,
  confidence real not null,
  outcome text not null,
  reason text,
  recorded_at text not null
);
```

A procedure is anchored to a `unified_memories` row of category
`procedure`. `memory_procedure_details` carries the structured
payload (trigger text + markdown), success/failure counters, and the
optional skill-file export metadata. `memory_procedure_sources` is the
many-to-many link back to the contributing episodes. `memory_procedure_history`
records each confidence update (success or failure recording).

## Skill index

```sql
create table if not exists memory_skill_index (
  id text primary key,
  path text not null,
  kind text not null,
  source text not null,
  memory_id text,
  content_hash text not null,
  last_modified_at text,
  archived_at text,
  created_at text not null,
  updated_at text not null
);
```

`skillRegistryService.ts` scans `.ade/skills/` and the legacy commands
directory, hashing content to detect changes. Skill files that map to
procedure memories link via `memory_id`; archived files are tombstoned
via `archived_at`.

Memories backing indexed skills are intentionally hidden from the
generic Memory browser to avoid duplication; the Memory tab shows a
summary card linking to the Workspace skill-file surface.

## Capture ledger

```sql
create table if not exists memory_capture_ledger (
  id text primary key,
  project_id text not null,
  source_type text not null,
  source_key text not null,
  memory_id text,
  episode_memory_id text,
  metadata_json text,
  created_at text not null,
  updated_at text not null
);
```

Prevents duplicate captures. `knowledgeCaptureService.ts` checks the
ledger before processing an intervention, error cluster, or PR-feedback
event, keyed by `(source_type, source_key)`.

## Lifecycle logs

```sql
create table if not exists memory_sweep_log (
  id text primary key,
  project_id text not null,
  started_at text not null,
  ended_at text,
  trigger text not null,         -- manual | schedule | startup
  ...
);

create table if not exists memory_consolidation_log (
  id text primary key,
  project_id text not null,
  started_at text not null,
  ended_at text,
  trigger text not null,
  ...
);
```

These drive the Memory tab's "last sweep" and "last consolidation"
panels.

## CTO core memory

```sql
create table if not exists cto_core_memory_state (
  project_id text primary key,
  version integer not null,
  payload_json text not null,
  updated_at text not null
);
```

A small structured document, not a pool of entries. Persisted in two
places:

1. This table.
2. The file `.ade/cto/core-memory.json`.

On startup, `ctoStateService.reconcileCoreMemoryOnStartup()` prefers
the newer version. Writes happen atomically to both: the table is
single-row-per-project, the JSON file is written via
`writeTextAtomic`.

The payload has five fields (`CtoCoreMemory`):

- `projectSummary`
- `criticalConventions`
- `userPreferences`
- `activeFocus`
- `notes`

Plus `version` (monotonic) and `updatedAt`.

## Agent identities

```sql
create table if not exists agent_identities (
  id text primary key,
  project_id text not null,
  name text not null,
  profile_json text not null default '{}',
  persona_json text not null default '{}',
  tool_policy_json text not null default '{}',
  user_preferences_json text not null default '{}',
  heartbeat_json text,
  model_preference text,
  created_at text not null,
  updated_at text not null
);
```

Worker agents (employees) are persisted here. Their core memory lives
in `.ade/agents/<slug>/core-memory.json` and a corresponding
`AgentCoreMemory` document. See
[agents/identity-and-personas](../agents/identity-and-personas.md) for
the full flow.

## Legacy `memories` table

```sql
create table if not exists memories (
  id text primary key,
  project_id text not null,
  scope text not null,
  category text not null,
  content text not null,
  importance text default 'medium',
  source_session_id text,
  source_pack_key text,
  status text default 'promoted',
  agent_id text,
  confidence real default 1.0,
  promoted_at text,
  source_run_id text,
  created_at text not null,
  last_accessed_at text not null,
  access_count integer default 0
);
```

Kept for migration. New code should never read or write this table;
`memoryRepairService.ts` migrates residual rows into `unified_memories`
when it detects them.

## File-system sidecar

`.ade/memory/`

- `MEMORY.md` -- bootstrap summary regenerated from promoted memories
  (top N per category).
- `conventions.md`, `gotchas.md`, `procedures.md` -- topic files.
- `<subtopic>.md` -- additional bounded topic files generated as
  memories accumulate.

These are read by Claude and other agents at startup (project memory
auto-load). Regeneration happens via `memoryFilesService.ts` on sweep
completion and on explicit `memoryRefresh` triggers.

`.ade/cto/`

- `MEMORY.md` -- CTO long-term brief (auto-generated from promoted CTO
  memories).
- `CURRENT.md` -- current working context (recent sessions, worker
  activity).
- `core-memory.json` -- the atomic core memory document.
- `daily/<YYYY-MM-DD>.md` -- append-only daily logs.

## Write gate

`memoryService.writeMemory()` applies the following rules in order:

1. **Scope normalisation.** `"user" -> "agent"`, `"lane" -> "mission"`.
2. **Category allowlist** (`CATEGORY_ALLOWLIST`).
3. **Strict write categories.** When `writeMode: "strict"`, only
   `convention`, `pattern`, `gotcha`, `decision` are accepted; other
   categories silently fall back to `default`.
4. **Exact dedup via `dedupe_key`.** If a non-archived row with the
   same `(project_id, scope, scope_owner_id, dedupe_key)` exists, the
   write merges into it.
5. **Jaccard similarity dedup.** Threshold 0.85 across the same scope.
   Matches merge rather than inserting.
6. **Code-derivable rejection.** Content that matches patterns for raw
   diffs, stack traces, session summaries, git log output, or file path
   dumps is rejected with `writeGateReason = "code_derivable"`.
7. **Insert or update.** On insert, set `status = "candidate"` unless
   the caller passes `"promoted"` or the category is in the promote-on-
   write set.
8. **Enqueue embedding.** Hand off to `embeddingWorkerService` via the
   `onMemoryInserted` callback.
9. **Emit `onMemoryUpserted`.** Callers (agentChatService, lifecycle
   services) subscribe.

Return value: `{ accepted, memory?, reason?, deduped?, mergedIntoId? }`.

## Decay

`memoryLifecycleService.ts` implements decay:

```
newAccessScore = oldAccessScore * 0.5^(daysSinceLastAccess / halfLifeDays)
```

- `halfLifeDays` defaults to 30.
- `EVERGREEN_CATEGORIES = { preference, convention }` skip decay.
- Pinned entries (`pinned = 1`) skip decay.
- Sweeps process up to `UPDATE_CHUNK_SIZE = 250` rows per batch to
  avoid blocking the event loop.

After decay, entries below a threshold demote one tier (Tier 1 -> 2,
Tier 2 -> 3, Tier 3 -> `archived`). Candidates that have gained
confidence and been accessed promote to `promoted`.

Scope limits (`DEFAULT_SCOPE_LIMITS`):

- `project`: 2000
- `agent`: 500
- `mission`: 200

When a scope exceeds its limit, the sweep archives the lowest-scored
non-pinned entries until the count is at the limit.

## Fragile and tricky wiring

- **`dedupe_key` format changes break dedup.** The key is computed
  deterministically from the content. Changing its derivation breaks
  exact-dedup lookups across the entire project.
- **FTS triggers do not fire on raw SQL.** Direct `INSERT INTO
  unified_memories` from migration scripts bypass the FTS triggers if
  triggers were not yet installed. Always run `CREATE TABLE`/trigger
  setup first.
- **Mission-to-project promotion.** `missionMemoryLifecycleService`
  reads mission memories on mission success and promotes qualifying
  entries. Promotion is idempotent via the capture ledger; manually
  touching mission rows can bypass the ledger and cause duplicates.
- **Atomic file writes.** Both `.ade/cto/core-memory.json` and the
  memory bootstrap files go through `writeTextAtomic`. Skipping the
  atomic write on these paths risks half-written files on crash.
- **Access score initialisation.** The schema migration that added
  `access_score` seeds it from `composite_score` and `access_count` via
  a single UPDATE. Running the migration on a large project can take
  seconds; do not run it in a foreground request handler.

## Related docs

- [Memory README](README.md)
- [Compaction](compaction.md)
- [Embeddings](embeddings.md)
- [Agents Identity and Personas](../agents/identity-and-personas.md)
</content>
</invoke>