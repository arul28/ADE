# Rearchitect Context Doc Generation

## Context
Context docs (PRD.ade.md, ARCHITECTURE.ade.md) are compact reference cards loaded into every AI chat session. The current generation pipeline only reads existing documentation files (.md/.txt), builds a text digest, and sends it in a single prompt with no tools. This means:
- Projects with no docs get blank/useless output
- The AI never looks at actual source code
- Every generation starts from scratch (no incremental updates)
- The AI can't explore the codebase — it only sees pre-baked doc excerpts

## Approach
Two changes: (1) give the AI read-only tools so it can explore the codebase, and (2) pre-assemble a lightweight codebase snapshot from actual code (not docs) so the model starts informed and needs fewer tool calls.

---

## Files to Modify

### 1. `apps/desktop/src/main/services/ai/aiIntegrationService.ts`

**`resolveUnifiedToolMode()` (line 203-218):** Currently returns `"none"` for `initial_context` tasks. Change to return `"planning"` so the model gets read-only tools (`readFile`, `glob`, `grep`, `listDir`, `gitStatus`, `gitDiff`, `gitLog`). The executor already caps planning mode at 10 tool-call steps.

```typescript
// Add before line 214:
if (args.taskType === "initial_context") {
  return "planning";
}
```

**`TASK_DEFAULTS.initial_context` (line 168-171):** Increase timeout from `45_000` to `120_000` since the model will now make tool calls.

### 2. `apps/desktop/src/main/services/packs/projectPackBuilder.ts`

#### a) Add `buildCodebaseSnapshot()` — new function

Deterministic (no AI), builds a ~6-8K char snapshot from:
1. **Directory tree** — top-level entries + 2 levels into `src/`, `lib/`, `apps/`, `packages/`. Cap at 150 entries. Use `fs.readdirSync` like existing `buildProjectBootstrap()`.
2. **Package manifest** — first 60 lines of `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml`. Use existing `safeReadDoc()`.
3. **Tech stack signals** — check file existence (same patterns as `onboardingService.detectDefaults()`). Emit bullet list.
4. **Entry point headers** — first 25 lines of up to 4 files matching `main.ts`, `index.ts`, `app.ts`, `server.ts` (or Go/Rust/Python equivalents) in root/`src/`/`cmd/`.
5. **Key doc excerpts** — first 30 lines of `README.md`, `CLAUDE.md`, `AGENTS.md` if they exist. Max 3 files.
6. **Git log** — last 10 commits oneline. Use existing `runGit`. If git fails, skip silently.

#### b) Rewrite `runContextDocGeneration()` (line 433+)

New flow:
1. Build codebase snapshot via `buildCodebaseSnapshot()`
2. Detect mode: **first-gen** (no existing `.ade/context/` docs or docs are tiny) vs **update** (existing docs with real content)
3. For update mode, get changes since last generation:
   - Read `generatedAt` from `CONTEXT_DOC_LAST_RUN_KEY`
   - Run `git log --oneline --stat --since=<timestamp>` via `runGit`
   - **Fallback if git fails**: read current docs, pass snapshot, and tell the AI "here are the current docs and a fresh codebase snapshot — compare and update." No diff needed, the model can figure it out from the snapshot + tools.
4. Build prompt (first-gen or update — see prompts below)
5. Call `generateInitialContext()` with the prompt (model now gets tools automatically from step 1)
6. Parse JSON result, fallback to snapshot-based doc if AI fails
7. Write files + update lastRun — same as current

#### c) Remove/replace `formatDocDigest()`

No longer needed for context doc generation. It only feeds doc file content into the prompt, which is replaced by the codebase snapshot. If used elsewhere, keep it; otherwise delete.

#### d) Update fallback behavior

When AI fails, write the codebase snapshot as a basic reference doc instead of an empty doc digest:
```
# PRD.ade
> Auto-generated from codebase snapshot. Regenerate with AI for richer content.
{snapshot content}
```

---

## Prompts

### First Generation
```
You are producing two compact reference cards that AI coding agents read at the start of every session for quick orientation. Dense and structured — every sentence earns its place.

Here is a snapshot of the codebase:
<snapshot>
{snapshot}
</snapshot>

You have read-only tools: readFile, glob, grep, listDir, gitLog. Use them to inspect key files — entry points, service definitions, types, config. Keep tool calls under 8.

CRITICAL: Each document MUST be under 8000 characters.

Return ONLY: {"prd":"<markdown>","architecture":"<markdown>"}

PRD.ade.md structure:
1. **What this is** — product name, what it does, who uses it (2-3 sentences)
2. **Stack** — languages, frameworks, key deps, repo structure (bullets)
3. **Feature areas** — each major feature, one line each (bullets)
4. **Current state** — what's shipped, what's being built (2-3 sentences)
5. **Working norms** — conventions, testing, deployment (bullets)

ARCHITECTURE.ade.md structure:
1. **System shape** — layers, boundaries, how the app is structured (3-5 sentences)
2. **Core services** — name, responsibility, key interface (bullets)
3. **Data model** — storage, state management (bullets)
4. **Integration points** — external services, APIs, IPC (bullets)
5. **Key patterns** — naming, error handling, extension points (bullets)
```

### Update Generation
```
You are updating existing reference cards that AI agents read at the start of every session.

Current docs:
<prd>{existingPrd}</prd>
<architecture>{existingArch}</architecture>

Changes since last generation ({lastDate}):
<changes>{gitLogOutput OR "Git history unavailable. Compare the snapshot below against the current docs."}</changes>

Current codebase snapshot:
<snapshot>{snapshot}</snapshot>

You have read-only tools. Use them to inspect changed files if needed. Keep tool calls under 5.
Update the docs IN-PLACE — no changelogs, no deltas. Return the full updated documents.
If nothing material changed, return existing content as-is.

CRITICAL: Each document MUST be under 8000 characters.

Return ONLY: {"prd":"<markdown>","architecture":"<markdown>"}
```

---

## What Does NOT Change
- Function signature of `runContextDocGeneration()` — same args, same return type
- `contextDocService.ts` — orchestration layer untouched
- IPC layer, shared types, UI components — all unchanged
- Status tracking keys and kvDb structure — unchanged
- `writeDocWithFallback()` — unchanged

## Verification
1. Delete `.ade/context/PRD.ade.md` and `ARCHITECTURE.ade.md`, run generation — should produce good docs from code exploration
2. Make a code change, run generation again — should do an incremental update, not full regen
3. Test on a repo with zero documentation files — should still produce useful docs
4. Mock AI failure — should write snapshot-based fallback (not empty)
5. `npm --prefix apps/desktop run typecheck` passes
6. Test with git unavailable (non-git directory) — should still work via snapshot-only fallback
