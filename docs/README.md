# ADE Internal Docs

Navigation map for the internal docs. **Start with [PRD.md](./PRD.md).**

The mental model up front: ADE is a **per-machine runtime daemon** (`apps/ade-cli/`, run as `ade serve`) that owns projects, lanes, chats, processes, sync, and proof. The desktop app, the terminal `ade code` client, the iOS app, and SSH-attached desktop windows are all peer **clients** of that runtime. Read the entry-point docs in that order:

## Reading order

1. [**PRD.md**](./PRD.md) — product scope, runtime + clients model, concepts, feature index.
2. [**ARCHITECTURE.md**](./ARCHITECTURE.md) — apps, runtime/client topology, data plane, IPC, services catalog, security, build/test/deploy.
3. [**features/**](./features/) — per-feature subfolders, each with a `README.md` + detail docs. Start with `remote-runtime/`, `ade-code/`, and `sync-and-multi-device/` for the runtime+clients picture.
4. [**playbooks/**](./playbooks/) — operational workflows agents can follow directly.

## Layout

```
docs/
├── README.md                              # this file
├── PRD.md                                 # product entry point
├── ARCHITECTURE.md                        # system architecture
├── OPTIMIZATION_OPPORTUNITIES.md          # codebase-wide optimization backlog
├── playbooks/
│   └── ship-lane.md                       # autonomous PR-to-merge driver
└── features/
    ├── agents/                            # agent identity, tools, personas
    ├── ade-code/                          # terminal Work chat docs; source lives in apps/ade-cli/src/tuiClient
    ├── automations/                       # rule triggers + actions + guardrails
    ├── chat/                              # multi-provider agent chat
    ├── computer-use/                      # proof control plane, backends, broker
    ├── conflicts/                         # detection + simulation + resolution
    ├── cto/                               # CTO agent: identity, pipeline, workers, Linear
    ├── files-and-editor/                  # watcher, editor, Monaco, search
    ├── history/                           # operations timeline, transcripts, export
    ├── ios-simulator/                     # chat-side iOS Simulator drawer + ADEInspector
    ├── lanes/                             # worktree isolation, stacking, runtime, OAuth
    ├── linear-integration/                # dispatch, sync, workflow presets
    ├── missions/                          # orchestration, validation gates, workers
    ├── onboarding-and-settings/           # first-run, schema, settings tabs
    ├── project-home/                      # welcome + per-lane dashboard
    ├── pull-requests/                     # stacking, queue, conflict simulation
    ├── remote-runtime/                    # local daemon + SSH remote machines
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

**This folder (`docs/`) is internal-only** — for engineers and AI agents working on ADE itself.
