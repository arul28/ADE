# ADE Internal Docs

Navigation map for the internal docs. **Start with [PRD.md](./PRD.md).**

The mental model up front:

- **ADE works fully with no computer of your own.** Every account always has one machine, **ADE Cloud**, next to the person's own computers on web, iPhone and desktop. Each cloud lane has its own computer underneath, which the person never sees.
- **Machines** run the work. Each has a **brain**: the always-on ADE process for one channel that owns projects, lanes, chats, work sessions, sync and proof.
- **The account** (Cloudflare Workers) holds what a person reads with no computer awake: the machine list, ADE Cloud, saved cloud work, settings and the vault. Reading never wakes a computer; doing wakes it.
- **Clients** (the desktop app, the hosted web client, the iOS app, the `ade` CLI) show the account and every connected machine at once.

## Reading order

1. [**PRD.md**](./PRD.md) — product scope, ADE with no computer, concepts, feature index.
2. [**ARCHITECTURE.md**](./ARCHITECTURE.md) — ADE Cloud and the account (§1.1), apps, brain/client topology, data plane, IPC, services catalog, security, build/test/deploy.
3. [**logging.md**](./logging.md) — ground truth for local logging, PostHog product analytics, privacy, consent, event budgets, dashboards, and instrumentation rules.
4. [**features/**](./features/) — per-feature subfolders, each with a `README.md` + detail docs. Start with `ade-cloud/`, `web-client/`, `remote-runtime/` and `sync-and-multi-device/` for the machines, account and clients picture.
5. [**playbooks/**](./playbooks/) — operational workflows agents can follow directly.

Running ADE from a checkout starts with
[`development/local-development.md`](./development/local-development.md) for the
glossary, the dev command matrix, lane worktrees, and local Alpha packaging.

Windows release engineering starts with
[`development/windows-release-proof.md`](./development/windows-release-proof.md)
for the exact-SHA evidence contract and
[`development/windows-support.md`](./development/windows-support.md) for the
installed-host supervisor and troubleshooting boundary.

## Layout

```
docs/
├── README.md                              # this file
├── PRD.md                                 # product entry point
├── ARCHITECTURE.md                        # system architecture
├── logging.md                             # logging + PostHog ground truth
├── OPTIMIZATION_OPPORTUNITIES.md          # open optimization backlog
├── analytics/
│   ├── README.md                          # PostHog setup, dashboards, tracking plan guide
│   └── tracking-plan.json                 # the event catalog
├── design/
│   ├── ask-question-redesign.md (+ .html, renders/)  # ask-question surface spec
│   ├── keyboard.md                        # keyboard and focus rules
│   ├── notices.md                         # banners, toasts, dialogs, Z_LAYERS + ade-ui lint ratchet
│   ├── theming.md                         # theme format, engine, token seam
│   └── visual-language.md                 # surface kit, scenes, layout, colour rules
├── development/
│   ├── local-development.md                # run, test, and package ADE locally
│   ├── linux-support.md                    # Linux evidence and support guide
│   ├── windows-support.md                  # installed Windows support guide
│   ├── windows-port-lane.md                # Windows port lane rules
│   ├── windows-update-timeline.md          # Windows auto-update install timeline
│   ├── windows-release-proof.md            # exact-SHA evidence schema + validator
│   ├── windows-full-system-scenarios.json  # external Windows acceptance inventory
│   └── windows-source-provenance.json      # source/rebase/stack mapping for the proof
├── perf/
│   ├── macos-baseline.md                  # measured numbers and ceilings (the perf gate)
│   ├── windows-baseline.md                # the same for Windows
│   ├── cloudflare-costs.md                # Worker and Durable Object cost notes
│   └── *-action-inventory.md              # Work, PRs and iOS perf audit matrices
├── plans/                                 # only plans with open work, or contracts code names
│   ├── ade-cloud-plans-and-disk.md        # plan, disk and cost rules (code comments point here)
│   ├── ade-dev-home.md                    # home widgets, Browser tab, Music design
│   ├── android-emulator.md                # open Android items
│   ├── apple-device-env.md                # Apple agent contracts (auto-record)
│   ├── apple-device-env-contracts.md      # Apple error codes and settings keys
│   ├── beta-track.md                      # Beta track contracts
│   ├── ios-beta-app.md                    # the ADE Beta iPhone app
│   ├── lane-sharing-real-ui.md            # open lane sharing work
│   └── cloud-6/                           # server launcher and cloud automations specs
├── playbooks/
│   ├── ship-lane.md                       # autonomous PR-to-merge driver
│   └── windows-signed-release.md          # signed Windows publication
├── triage/
│   └── PLAYBOOK.md                        # the playbook `ade triage` reads
└── features/
    ├── ade-cloud/                         # ADE Cloud: one machine per account, cloud lane computers, server routes
    ├── ade-mcp/                           # ADE MCP: AI apps run `ade` on a computer through ADE Relay
    ├── agents/                            # agent identity, tools, personas
    ├── android-device/                    # Android Development tool + scrcpy stream
    ├── apple-device/                      # Apple Development tool + helper stream + ADEInspector
    ├── automations/                       # rule triggers + actions + guardrails
    ├── capture-gesture/                   # global screenshot chord (both ⌘ / both Ctrl) → CTO
    ├── chat/                              # multi-provider agent chat
    ├── computer-use/                      # proof control plane, backends, broker
    ├── conflicts/                         # detection + simulation + resolution
    ├── cto/                               # CTO agent: single thread, smart memory, model switching, Linear
    ├── deeplinks/                         # ade:// and https://ade-app.dev/open links
    ├── files-and-editor/                  # watcher, editor, Monaco, search
    ├── history/                           # operations timeline, transcripts, export
    ├── issues/                            # open an issue where you are: Issues tool tab, issue sheet
    ├── lanes/                             # worktree isolation, stacking, runtime, OAuth, lane sharing
    ├── linear-integration/                # issue reads, lane/PR flow, live-status round-trip
    ├── linux-desktop/                     # the per-lane Linux screen
    ├── mac-desktop/                       # per-lane macOS virtual display driven by `ade screen` / `ade mac-desktop`
    ├── music/                             # Apple Music and Spotify, players, MusicKit host, Now Playing source
    ├── onboarding-and-settings/           # first-run, schema, settings tabs
    ├── passwords/                         # the account vault: logins, codes, passkeys, secrets
    ├── personal-chats/                    # machine-owned projectless AI conversations
    ├── pull-requests/                     # stacking, queue, conflict simulation
    ├── remote-runtime/                    # local runtime + SSH remote machines
    ├── sdk/                               # embeddable @ade-dev/sdk + @ade-dev/chat-ui sidecar
    ├── search/                            # universal FTS5 index + ⌘K/CLI search
    ├── storage-and-recovery/              # disk pressure, durable state, diagnosis, repair
    ├── sync-and-multi-device/             # CRDT sync, account Activity, iOS, remote commands, session handoff
    ├── terminals-and-sessions/            # PTY, sessions, and UI surfaces
    ├── web-client/                        # the full ADE in a browser, with or without a computer
    └── windows-desktop/                   # per-lane Windows screen (private child session or the main desktop by consent), `ade screen`
```

## Conventions

- Each `features/<name>/README.md` has a **Source file map** at the top pointing to the primary code paths.
- Detail docs sit next to the README in the same folder; READMEs link down to them.
- No changelogs embedded in docs — use git + `apps/desktop/CHANGELOG.md` for history.
- No "Updated on" notes — treat every doc as a living snapshot.
- Fragile areas are flagged explicitly in the docs that describe them. Read before editing.

## Relationship to the public (Mintlify) docs

`docs.json` at the repo root configures the public-facing Mintlify docs site (`.mdx` files under `./chat/`, `./tools/`, `./concepts/`, `./sdk/`, etc.). That site is user-facing and separate. The **SDK** tab (`sdk/*.mdx`) is the public embedder docs for `@ade-dev/sdk` and `@ade-dev/chat-ui`; keep it in lockstep with `docs/features/sdk/` and the package READMEs when the contract changes.

The public site is organized **task-first**: “I want to…” groups, then a Concepts layer (machines, lanes, work sessions, agents, tools, subagents), then Reference. It is deliberately not one page per feature. When adding a user-visible feature, prefer extending an existing area page over adding a new one.

`docs-areas.json` at the repo root is the source-to-page ownership map. Every public page belongs to an area or to `shared`, and every area names the source trees that can make it wrong. `node scripts/docs-areas.mjs --changed --base <ref>` prints the pages a change can affect; the release skill runs it as its docs-drift gate. `node scripts/validate-docs.mjs` fails if a page has no owner or an area points at a missing page.

**This folder (`docs/`) is internal-only** — for engineers and AI agents working on ADE itself.
