# PRD: ADE (Agentic Developer Environment)

Last updated: 2026-02-10

## 1. Summary

ADE is a desktop "development operations cockpit" for agentic coding. It helps developers run parallel work safely across multiple lanes (git worktrees + branches), keep context coherent, keep processes/tests consistent, detect conflicts early, and land changes with minimal Git overhead.

ADE is not a full IDE. Most editing happens in external editors or agent tools; ADE is the control plane that keeps work organized and merge-safe.

## 2. Goals

- Cross-platform desktop app (macOS, Windows, Linux).
- Worktree-first lanes that make parallelism real and understandable.
- Embedded terminals and lane-scoped agent sessions.
- Deterministic "packs" that stay in sync:
  - Project Pack (global)
  - Lane Pack (per lane)
  - Conflict Pack (per integration attempt/prediction)
- Proactive integration:
  - drift and conflict prediction across lanes
  - guided sync flows with undo
- Hosted ADE agent (read-only repo mirror) that:
  - generates narratives/summaries from deterministic packs
  - proposes conflict resolution patches
  - never applies patches, never runs tests
- Local safety contract:
  - all writes happen locally
  - tests run locally
  - every operation has an audit trail and undo

## 3. Non-Goals (MVP)

- Full IDE replacement (debugger, LSP, full editor).
- Multi-user collaboration (later).
- Running tests in the cloud (no).
- Silent repo modifications by default (e.g., auto-writing `.gitignore`).

## 4. Target Users

- Power developers orchestrating 3-10 agent workstreams.
- Builders who want Git safety/guardrails without deep Git knowledge.
- Solo builders operating a monorepo with multiple parallel tasks.

## 5. Principles

- Tool-agnostic: work with Codex CLI, Claude Code, and other CLIs.
- Worktree-first: lanes are real directories, not virtual illusions.
- Propose-first automation: AI suggests; user approves; tests gate.
- Reversible operations: undo timeline is core, not optional.
- Context portability: project should remain healthier even if ADE disappears.

## 6. Core Concepts

- Lane: branch + worktree + terminals + status + lane pack + optional PR linkage.
- Project Pack: a global, deterministic summary of repo structure and how to run/test it; incrementally updated.
- Lane Pack: deterministic lane state (intent, deltas, touched areas, how to test, recent results).
- Conflict Pack: deterministic integration incident bundle (predicted/active conflicts, relevant deltas, hunks, options).
- Stack: parent/child lanes; restack propagates parent changes to children.
- Hosted agent: reads a synced mirror of the repo (with excludes), produces narratives and patch proposals.

## 7. Product Surface (What Users See)

- Lanes dashboard: list + stack graph + readiness indicators.
- Per-lane workspace: file tree + diffs + quick edits.
- Terminal grid and per-lane terminals.
- Process runner + logs + test suite buttons.
- Packs viewer: project/lane/conflict packs and status timestamps.
- Conflicts window: predicted conflicts, active conflicts, proposal runs, patch review/apply.
- PR window (GitHub): create/link, status, checks, description draft.

## 8. Scope (MVP vs V1 vs V2)

MVP:

- Lanes: create/rename/archive; worktrees; stack visualization (basic).
- Embedded terminals + sessions; launch agent commands.
- Process runner + tests + logs.
- Deterministic packs updated on session end / commit.
- Conflict prediction and guided sync (merge-first default; rebase supported).
- Hosted agent integration (read-only) for:
  - narrative pack augmentation
  - conflict resolution proposals (manual trigger from conflicts window)
- AWS backend (serverless) for hosted agent:
  - Cognito Hosted UI login via GitHub OAuth
  - S3 mirrors + artifacts
  - SQS jobs + Lambda workers
  - DynamoDB metadata
- GitHub PR: create/link/push + show status + draft description.

V1:

- Restack flow; "land stack" guided merge order.
- Batch assess conflicts across lanes; batch sync.
- Rich operation timeline and undo for more operations.
- Automation scheduling and "actions" system (more triggers, better UX).

V2:

- Multi-repo workspaces.
- Team collaboration.
- Advanced conflict resolution (rerere integration, higher confidence auto-apply modes).
- Optional semantic retrieval (vector index) if it materially improves outcomes.

## 9. Success Metrics

- Time-to-first-lane; time-to-first-agent-session.
- Weekly multi-lane usage and retention.
- Reduced conflict resolution time; increased merge throughput.
- % of predicted conflicts surfaced before merge time.
- % of hosted agent proposals accepted; rollback frequency.

## 10. Key Risks

- Hosted mirror security and trust.
- Token/cost blowups if agent reads too much code.
- Cross-platform PTY edge cases.
- Git correctness across odd repos.

Mitigations:

- Strict exclude lists + per-job budgets + caching.
- Keep all mutations local; make proposals reviewable.
- Make PTY + streaming a Milestone 0 gate.
- Shell out to `git` CLI initially; add repo fixtures for integration tests.

## 11. Document Map

- Feature specs: `features/INDEX.md`
- Architecture specs: `architecture/INDEX.md`
- Implementation plan: `IMPLEMENTATION_PLAN.md`
