# ADE Internal Docs

Navigation map for the internal docs. **Start with [PRD.md](./PRD.md).**

## Reading order

1. [**PRD.md**](./PRD.md) — product scope, concepts, feature index (links to everything).
2. [**ARCHITECTURE.md**](./ARCHITECTURE.md) — apps, data plane, IPC, services catalog, security, build/test/deploy.
3. [**features/**](./features/) — per-feature subfolders, each with a `README.md` + detail docs.
4. [**playbooks/**](./playbooks/) — operational workflows agents can follow directly.

## Layout

```
new-docs/
├── README.md                              # this file
├── PRD.md                                 # product entry point
├── ARCHITECTURE.md                        # system architecture
├── OPTIMIZATION_OPPORTUNITIES.md          # codebase-wide optimization backlog
├── playbooks/
│   └── ship-lane.md                       # autonomous PR-to-merge driver
└── features/
    ├── agents/                            # agent identity, tools, personas
    ├── automations/                       # rule triggers + actions + guardrails
    ├── chat/                              # multi-provider agent chat
    ├── computer-use/                      # proof control plane, backends, broker
    ├── conflicts/                         # detection + simulation + resolution
    ├── context-packs/                     # context docs + live exports + packs
    ├── cto/                               # CTO agent: identity, pipeline, workers, Linear
    ├── files-and-editor/                  # watcher, editor, Monaco, search
    ├── history/                           # operations timeline, transcripts, export
    ├── lanes/                             # worktree isolation, stacking, runtime, OAuth
    ├── linear-integration/                # dispatch, sync, workflow presets
    ├── memory/                            # storage, compaction, embeddings
    ├── missions/                          # orchestration, validation gates, workers
    ├── onboarding-and-settings/           # first-run, schema, settings tabs
    ├── project-home/                      # welcome + per-lane dashboard
    ├── pull-requests/                     # stacking, queue, conflict simulation
    ├── sync-and-multi-device/             # cr-sqlite CRDT, iOS, remote commands
    ├── terminals-and-sessions/            # PTY, sessions, processes, UI surfaces
    └── workspace-graph/                   # React Flow canvas + data sources
```

## Conventions

- Each `features/<name>/README.md` has a **Source file map** at the top pointing to the primary code paths.
- Detail docs sit next to the README in the same folder; READMEs link down to them.
- No changelogs embedded in docs — use git + `apps/desktop/CHANGELOG.md` for history.
- No "Updated on" notes — treat every doc as a living snapshot.
- Fragile areas are flagged explicitly in the docs that describe them. Read before editing.

## Relationship to the public (Mintlify) docs

`docs.json` at the repo root configures the public-facing Mintlify docs site (`.mdx` files under `./chat/`, `./tools/`, `./missions/`, etc.). That site is user-facing and separate.

**This folder (`new-docs/`) is internal-only** — for engineers and AI agents working on ADE itself.
