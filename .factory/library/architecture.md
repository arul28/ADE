# Architecture

Architectural decisions, patterns discovered, and structural notes.

**What belongs here:** Service patterns, dependency injection approach, IPC architecture, data flow, component hierarchy.

---

## Service Pattern
All main-process services use the factory function pattern:
```typescript
export function createXxxService(opts: { db: AdeDb; logger: Logger; /* deps */ }) {
  // private state
  return { publicMethod1, publicMethod2 };
}
```
Services are instantiated in `main.ts` → `initContextForProjectRoot()` with explicit dependency injection. The `AppContext` object holds all service instances.

## IPC Architecture
Four files must be updated for every new IPC channel:
1. `src/shared/ipc.ts` — channel constant string
2. `src/main/services/ipc/registerIpc.ts` — `ipcMain.handle()` handler
3. `src/preload/preload.ts` — `ipcRenderer.invoke()` bridge method
4. `src/preload/global.d.ts` — TypeScript type declaration

Pattern: Renderer → `window.ade.method()` → preload → `ipcRenderer.invoke('channel')` → main → handler → result.

## Database
- sql.js (WASM SQLite, in-process)
- Schema bootstrap in `kvDb.ts` → `migrate()` using `CREATE TABLE IF NOT EXISTS`
- Migrations via `ALTER TABLE ... ADD COLUMN` wrapped in try/catch
- Flush strategy: debounced 500ms + explicit `flushNow()` + on shutdown
- AdeDb interface: `run()`, `get<T>()`, `all<T>()`, `getJson<T>()`, `setJson()`

## Memory System (W6 shipped)
- Canonical backend: `unifiedMemoryService.ts` (~29KB, 1029 lines)
- Tables: `unified_memories` (canonical), `unified_memory_embeddings` (placeholder for vectors)
- Scopes: project, agent, mission
- Tiers: 1 (pinned), 2 (hot/promoted), 3 (cold/archived/candidate)
- Categories: fact, preference, pattern, decision, gotcha, convention, episode, procedure, digest, handoff
- Status lifecycle: candidate → promoted → archived
- Composite scoring: 40% query + 20% recency + 15% importance + 15% confidence + 10% access + tier/pin boosts
- Deduplication via `dedupe_key` (Jaccard similarity >= 0.85)
- Write gating system for quality control

## AI Integration
- `aiIntegrationService.ts` (~29KB) provides executor abstractions
- Model resolution: `resolveModelForTask(taskType, modelIdHint?)` checks config overrides → task routing → defaults
- Feature model overrides stored in `ade.yaml` → `shared.ai.featureModelOverrides`
- Task defaults defined in TASK_DEFAULTS map within aiIntegrationService
- `AiFeatureKey` type in `src/shared/types/config.ts` defines valid feature keys

## Compaction System (existing)
- `compactionEngine.ts` handles conversation transcript compaction
- 70% context window threshold triggers compaction
- Pre-compaction fact extraction already exists in some form
- The compaction flush service (W6½) hooks into this system
