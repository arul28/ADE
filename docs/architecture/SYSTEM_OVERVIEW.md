# System Overview

Last updated: 2026-02-10

## 1. Components

ADE is split into:

- Desktop UI: dashboard, diffs, terminals, processes, packs, conflicts, PRs.
- Local core engine: git/worktrees, PTY, process runner, pack builder (deterministic), job engine, undo timeline.
- Hosted ADE agent: read-only repo mirror + job workers that produce narratives and patch proposals.

## 2. Data Flow (Happy Path)

1. User creates a lane (branch + worktree).
2. User runs agent session in embedded terminal tied to lane.
3. Session ends:
   - local core captures session delta
   - local deterministic packs update immediately
   - sync to hosted mirror runs (coalesced during work; forced on session end)
   - conflicts are predicted against base
4. If conflicts predicted:
   - UI shows conflict badge and files
   - user opens conflicts window to request proposal
5. Hosted agent proposes a patch:
   - user reviews patch in ADE
   - local core applies patch (optional), runs tests, records undo
6. User creates/updates PR and lands changes.

## 3. Key Contracts

- Hosted agent never mutates repo state; it only returns artifacts (markdown packs) and patch proposals (unified diffs).
- Local core is the only component allowed to:
  - edit files
  - run git operations
  - run tests
  - perform undo/rollback

## 4. Swappable Provider Model

All "LLM reasoning" is behind a single internal provider interface:

- Hosted provider (default): calls ADE Cloud.
- BYOK provider: calls model APIs directly.
- CLI provider: runs Codex/Claude Code locally.

The deterministic pack pipeline must function even if LLM provider is disabled.

