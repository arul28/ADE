# W7c: Skills + Learning Pipeline
> Source: [Factory.ai missions](https://factory.ai/news/missions) — skill extraction pattern (missions extract skills, skill library compounds over time). [LangMem procedural memory](https://langchain-ai.github.io/langmem/concepts/) — episodic → semantic → procedural extraction pipeline. [Vercel/Anthropic skills format](https://docs.anthropic.com/en/docs/claude-code/skills) — universal `SKILL.md` markdown convention. [Paperclip runtime skill injection](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) — SKILLS.md injected into agent context at runtime. [CrewAI long-term memory](https://docs.crewai.com/concepts/memory) — confidence evolution and automatic archival.

Dependencies: **W7a** (embeddings — needed for cosine similarity in episode clustering and procedure dedup) + **W7b** (episodic summaries — needed as input to the extraction pipeline).

##### Required Reading for Implementation

| Reference | What to Read | What ADE Adopts |
|-----------|-------------|-----------------|
| [Factory.ai Missions Blog](https://factory.ai/news/missions) | Full post — how missions extract skills that compound over time | Core concept: agent work produces reusable skills. Skill library grows with each mission. |
| [LangMem Concepts — Memory Types](https://langchain-ai.github.io/langmem/concepts/) | Episodic, Semantic, and Procedural memory sections | Three-stage pipeline: episodes (what happened) → semantic facts (what we know) → procedures (what to do). Extraction triggers and consolidation. |
| [LangMem Source — `knowledge/`](https://github.com/langchain-ai/langmem/tree/main/langmem/knowledge) | Extraction logic, clustering, and procedural generation | Pattern detection from episode clusters, LLM-driven procedure extraction. |
| [Claude Code Skills Docs](https://docs.anthropic.com/en/docs/claude-code/skills) | Skills format, directory convention, how skills are loaded | `SKILL.md` format — universal markdown, any agent can consume. ADE materializes project-local skills under `.ade/skills/<name>/SKILL.md`. |
| [Paperclip SKILLS.md Injection](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) | §7 Runtime Context, SKILLS.md section | Skills injected into agent system prompt at activation time. Goal hierarchy provides skill selection context. |
| [CrewAI Memory — Long-Term](https://docs.crewai.com/concepts/memory) | Long-term memory and learning sections | Confidence evolution: success/failure tracking, automatic archival of low-confidence procedures. |

W7c builds the extraction and materialization layer on top of W7a's embeddings and W7b's episodic summaries. A 2026-03-12 closure pass confirmed that the extraction/materialization loop is fully shipped in product surfaces: procedural learning, confidence/history tracking, skill export, skill ingestion, advanced-source knowledge capture, and operator-facing review UX now all exist in both Settings and the CTO Memory tab.

##### Audit Snapshot (2026-03-12)

- Implemented in code today: `proceduralLearningService.ts`, `skillRegistryService.ts`, the Procedures/Skills views in `MemoryHealthTab.tsx`, and the corresponding W7c review surfaces in `CtoMemoryBrowser.tsx`.
- Episode clustering, procedure creation/update, confidence history, export to `.ade/skills/`, and filesystem re-indexing are all present.
- `knowledgeCaptureService.ts` now captures resolved interventions, recurring error clusters, and PR feedback, and is wired into current runtime flows.
- End-to-end validation now covers the advanced capture sources called out by the workstream: resolved interventions, recurring failure clusters, and PR feedback.
- Review/inspection UX is now available in both Settings > Memory and CTO > Memory, including procedure detail, confidence history, indexed skills, knowledge sync, and raw-memory provenance.

##### Procedural Memory Extraction

> Reference: [LangMem — procedural memory](https://langchain-ai.github.io/langmem/concepts/) — extraction from episodic clusters. [Factory.ai — missions](https://factory.ai/news/missions) — skills compound over time from agent work.

When the same pattern appears across 3+ episodic summaries (from different missions or sessions), the system extracts it as a procedural memory:

```typescript
interface ProceduralMemory {
  id: string;
  trigger: string;       // When to apply: "changing auth module", "updating API endpoints"
  procedure: string;     // What to do: "1. Run migration 2. Update CORS 3. Regenerate types"
  confidence: number;    // 0-1, increases with successful applications
  successCount: number;
  failureCount: number;
  sourceEpisodeIds: string[];  // episodic memories this was derived from
  lastUsed: string;
  createdAt: string;
}
```

**Extraction trigger**: After each episodic summary is saved to project memory (by W7b's `episodicSummaryService`), the system scans for recurring patterns. This follows [LangMem's episodic → procedural extraction pipeline](https://langchain-ai.github.io/langmem/concepts/):
1. Embed the new episode (W7a), search project memory for similar episodes (`vec_distance_cosine() < 0.25`, i.e., cosine similarity > 0.75).
2. If 3+ similar episodes found with overlapping `patternsDiscovered` or `decisionsMade`: check if a procedure already exists for this pattern (cosine similarity > 0.85 against existing `category: "procedure"` entries). If so, boost its `confidence` and increment `observationCount` instead of creating a new one.
3. If no existing procedure matches, invoke LLM with the cluster of episodes. LLM extracts: trigger condition + step-by-step procedure + confidence estimate. Prompt template:
   ```
   You are analyzing a cluster of similar mission outcomes. Extract a reusable procedure.

   Episodes:
   {{episodeCluster}}

   Extract:
   - trigger: When should this procedure be applied? (one sentence)
   - procedure: Step-by-step instructions (numbered list)
   - confidence: How confident are you this is a reliable pattern? (0.0-1.0)
   ```
4. Saved as project memory entry: `category: "procedure"`, Tier 2, `status: "candidate"`, `sourceType: "system"`. The `content` field contains the JSON-serialized `ProceduralMemory` struct. Source episode IDs stored for traceability.
5. On subsequent missions, procedures with matching triggers are discovered via `memorySearch` during the L1 briefing assembly (W7b) and injected into worker context.

**Extraction is async and non-blocking**: The episode-to-procedure pipeline runs after the episodic summary is saved. It does not block mission completion or session teardown. If the LLM extraction call fails, log a warning — the episodes are still stored and can be re-processed later.

##### Confidence Evolution

Follows a Bayesian-style belief update — success increases confidence with diminishing returns (asymptotic to 1.0), failure decreases it more sharply. See [CrewAI's long-term memory confidence tracking](https://docs.crewai.com/concepts/memory) for a similar pattern.

```typescript
function updateConfidence(current: number, success: boolean): number {
  if (success) {
    // Diminishing returns: large jumps early, asymptotic to 1.0
    return current + (1.0 - current) * 0.15;
  } else {
    // Sharp decrease: failures are taken seriously
    return current * 0.7;
  }
}
```

- **Tracking**: Each procedure tracks `successCount`, `failureCount`, and `lastUsed`. On mission completion, if a procedure was injected into worker context and the mission succeeded, count as success. If the mission failed on a step where the procedure was relevant, count as failure.
- **Auto-archive**: `confidence < 0.3` after `successCount + failureCount >= 5` → set `status: "archived"`, demote to Tier 3. The procedure was tried enough times and is unreliable.
- **Auto-promote**: `confidence >= 0.8` after `successCount >= 3` → promote to Tier 1 (pinned). The procedure is proven and should always be in context when its trigger matches.
- **Manual override**: Users can pin, archive, or adjust confidence for any procedure from the Memory inspector. User actions always override automatic confidence evolution.

##### Knowledge Source Capture

Automatic capture from agent interactions into project memory. These entries feed the episodic → procedural pipeline above. All captures go through the W6 write gate (dedup + consolidation), so duplicates are automatically merged.

- **Mission failures and resolutions**: Hook into the orchestrator's step failure → retry/resolution path. When a step fails and is subsequently resolved (by retry or user intervention), capture the failure pattern and resolution as a `category: "gotcha"` or `category: "pattern"` entry with `fileScopePattern` inferred from the changed files in that step. Enters as `status: "candidate"` with `importance: "medium"`, `confidence: 0.5` — needs confirmation from repeated observation.

- **User interventions**: When a user sends a steering message during a mission (intervention resolution, manual fix instruction, correction), `knowledgeCaptureService` analyzes the message for implicit rules. Example: user says "don't use default exports" → candidate convention with `category: "convention"`, `confidence: 0.4`. Promoted to `confidence >= 0.7` after 2+ observations of the same pattern (dedupe via lexical similarity in write gate, boosted via `observationCount`).

- **Repeated errors**: On session/mission end, check error patterns against existing `category: "gotcha"` entries via embedding search (cosine similarity > 0.85, W7a). If the same error appears in 3+ sessions (2 existing entries with `observationCount >= 1` each + current occurrence), escalate the existing entry's `importance` to `"high"` and boost `confidence` by 0.15. This surfaces persistent issues without manual tagging.

- **PR review feedback**: If PR review comments are available (via Linear sync outbound comments or GitHub PR review data from W8), analyze recurring reviewer feedback patterns. Example: reviewer consistently asks for test coverage on API changes → recorded as `category: "preference"`, `fileScopePattern: "src/api/**"`.

##### Skill Materialization

Confirmed procedural memories can be exported as universal skill files, following the [Claude Code skills convention](https://docs.anthropic.com/en/docs/claude-code/skills):

- User reviews procedural memories in Settings > Memory > Procedures tab or CTO > Memory > Procedures.
- User clicks "Export as Skill" on a procedure → system materializes it as `.ade/skills/<name>/SKILL.md`.
- `.ade/skills/` is the canonical project-local skill export path. Legacy `.claude/skills/` content is still read and indexed when present.
- **Skill file format**: Plain markdown with trigger description, step-by-step instructions, and context notes. Follows the Vercel/Anthropic skills convention — any agent that reads markdown can consume it:
  ```markdown
  # Auth Migration

  ## When to use
  When changing the auth module or updating authentication flows.

  ## Steps
  1. Run the database migration: `npm run db:migrate`
  2. Update CORS configuration in `src/middleware/cors.ts`
  3. Regenerate TypeScript types: `npm run codegen`
  4. Run the auth test suite: `npm test -- --grep auth`
  5. Verify the Stripe webhook handler still works (it depends on auth headers)

  ## Context
  - Extracted from 5 successful missions (confidence: 0.92)
  - The CORS step is critical — missing it causes silent 403 errors in production
  - Source episodes: mission-abc, mission-def, mission-ghi
  ```
- **Naming**: Skill directory name derived from the procedure trigger via slugification (`"changing auth module"` → `auth-module`). Collision avoidance: append numeric suffix if slug exists.
- Skills are indexed back into project memory (see Skill Ingestion below) so ADE's own agents discover them via `memorySearch`.

```
.ade/
  skills/
    auth-migration/
      SKILL.md          # "When changing auth module: 1. Run migration..."
    api-versioning/
      SKILL.md          # "When updating API endpoints: 1. Update routes..."
```

##### Skill Ingestion

Read existing skill and command files into project memory so that ADE agents can discover and use them:

- **Scan triggers**: On app startup and on filesystem change.
- **Scan targets**: `.ade/skills/**/*.md`, legacy `.claude/skills/**/*.md`, `.claude/commands/**/*.md`, `CLAUDE.md`, `agents.md`.
- **Parse and index**: Each file is parsed and indexed into project memory as a Tier 2 entry with `category: "procedure"`, `sourceType: "user"`, `status: "promoted"`. User-authored skills start at `confidence: 1.0` (user is the authority).
- **Dedup with existing entries**: Before inserting, check for existing entries via embedding similarity (cosine > 0.85, W7a). If a near-duplicate exists:
  - If existing entry is `sourceType: "user"` → update content in place (user edited the file).
  - If existing entry is `sourceType: "system"` (machine-extracted) → mark the system entry as superseded, keep the user entry as canonical.
- **Deletion tracking**: If a previously-indexed skill file is deleted, mark the corresponding memory entry as `status: "archived"`. Do not hard-delete — the knowledge may still be useful for pattern matching.
- **Runtime injection**: At worker activation time (W7b briefing assembly), `memorySearch` returns matching procedures. The Paperclip pattern of injecting a `SKILLS.md` section into the system prompt is achieved naturally — matching procedures appear in L1 search results because they have high composite scores (user-authored → `confidence: 1.0`, `importance: "high"`).

##### Renderer

- **Settings > Memory > Procedures tab**: Table of extracted procedures showing:
  | Column | Description |
  |--------|-------------|
  | Trigger | When the procedure applies |
  | Confidence | Current confidence score with visual bar |
  | Applications | `successCount / (successCount + failureCount)` success rate |
  | Source | Number of source episodes, link to episode entries |
  | Status | candidate / promoted / archived / pinned / exported |
  | Actions | Pin, Archive, Export as Skill, Edit, View Source Episodes |

  Procedures sorted by confidence (descending) by default. Filter by status, category, file scope.

- **Settings > Memory > Skills tab**: Table of indexed skill files showing:
  | Column | Description |
  |--------|-------------|
  | Name | Skill directory name |
  | File | Path to `SKILL.md` |
  | Indexed | Whether the skill is indexed in project memory (checkmark/dash) |
  | Source | "User" (manually written) or "Exported" (materialized from procedure) |
  | Last Modified | File modification time |
  | Actions | Open in editor, Re-index, Delete |

- **Procedure confidence chart**: Small sparkline or line chart per procedure showing confidence evolution over time (data from `observationCount` + confidence at each update). Available in the procedure detail view (click a row to expand).

- **Export flow**: "Export as Skill" button opens a confirmation dialog showing the generated `SKILL.md` content with an editable name field. User confirms → file written → skill tab updated → memory entry linked.

**Implementation status (2026-03-12):** Complete.

**Tests:**
- Procedural extraction: 3+ similar episodes trigger extraction, LLM extraction call produces valid `ProceduralMemory`, confidence initialized from LLM estimate, source episode IDs recorded.
- Episode similarity search: cosine > 0.75 threshold finds related episodes, cosine <= 0.75 does not trigger extraction, embedding unavailable gracefully skips extraction.
- Existing procedure boost: cosine > 0.85 match against existing procedure boosts confidence and `observationCount` instead of creating duplicate.
- Confidence evolution: success increments with diminishing returns (0.5 → 0.575 → 0.64...), failure decrements sharply (0.8 → 0.56), auto-archive at confidence < 0.3 after 5+ applications, auto-promote at confidence >= 0.8 after 3+ successes.
- Knowledge capture — failures: step failure + resolution recorded as gotcha with file scope, enters as candidate with medium confidence.
- Knowledge capture — interventions: user steering message analyzed, implicit rule saved as candidate convention, promoted after 2+ observations via write gate dedupe boost.
- Knowledge capture — repeated errors: 3+ matching error gotchas escalate importance to high, embedding search (cosine > 0.85) identifies matches.
- Skill materialization: procedure exported as `.ade/skills/<name>/SKILL.md`, correct markdown format with trigger/steps/context sections, slug naming with collision avoidance.
- Skill ingestion: `.ade/skills/` plus legacy `.claude/skills/` scanned on startup, parsed and indexed as Tier 2 procedure entries, deduped with existing entries via embeddings, file deletion marks entry archived.
- Skill ingestion — user vs system: user-authored skill supersedes machine-extracted procedure, updated file content refreshes existing entry in place.
- Runtime injection: matching procedure appears in L1 briefing assembly search results, high-confidence procedures rank above low-confidence ones.
- End-to-end: mission run → episodic summary (W7b) → pattern detected across 3+ episodes → procedure extracted → user confirms → skill file created → future mission worker receives skill in briefing.
