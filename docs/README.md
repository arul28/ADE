# DAEX internal docs

> **The product is DAEX (formerly ADE, renamed 2026-11-28).** Write "DAEX" in
> all copy and docs (all caps; "a DAEX chat"), and "DAEX Cloud", "DAEX MCP" and
> so on for feature names. The CLI is `daex`; `ade` still works as an alias.
> Code identifiers (`AdeFoo`, `window.ade`), `ADE_*` env vars, `.ade/` folders
> and `~/.ade`, file and folder names (`apps/ade-cli`, `docs/features/ade-cloud`),
> bundle IDs and action/IPC names keep the old name on purpose: never rename
> them. For copy in code, use `BRAND` from `apps/desktop/src/shared/brand.ts`
> (Swift: `Brand` in `apps/ios/ADE/Shared/Brand.swift`). Rules and the frozen
> list: [brand/README.md](./brand/README.md).

Navigation map for the internal docs, written for engineers and agents working
on DAEX itself. **Start with [PRD.md](./PRD.md).** The code is the source of
truth; when a doc and the code disagree, the code wins.

The mental model:

- **DAEX works fully with no computer of your own.** Every account always has
  one machine, **DAEX Cloud**, next to the person's own computers on web,
  iPhone and desktop. Each cloud lane has its own computer underneath, which the
  person never sees.
- **Machines** run the work. Each has a **brain**: the always-on DAEX process
  for one channel that owns projects, lanes, chats, work sessions, sync and
  proof.
- **The account** (Cloudflare Workers) holds what a person reads with no
  computer awake: the machine list, DAEX Cloud, saved cloud work, settings and
  the vault. Reading never wakes a computer; doing wakes it.
- **Clients** (the desktop app, the hosted web client, the iPhone app, the
  `daex` CLI) show the account and every connected machine at once.

## Reading order

1. [PRD.md](./PRD.md): product scope, DAEX with no computer, concepts, the
   feature index.
2. [ARCHITECTURE.md](./ARCHITECTURE.md): DAEX Cloud and the account (section
   1.1), apps, brain and client topology, data plane, IPC, security, build and
   release.
3. [logging.md](./logging.md): local logs, Sentry, PostHog analytics, privacy,
   consent and instrumentation rules.
4. [features/](./features/): one folder per feature, each with a `README.md`
   and detail docs. For the machines, account and clients picture start with
   `ade-cloud/`, `web-client/`, `remote-runtime/` and `sync-and-multi-device/`.
5. [playbooks/](./playbooks/): operational workflows agents follow directly.
6. [brand/](./brand/README.md): the DAEX names, the `BRAND` / `Brand`
   constants, and the identifiers that keep the old name.

Running DAEX from a checkout starts with
[development/local-development.md](./development/local-development.md). Windows
starts with [development/windows-support.md](./development/windows-support.md)
(and the root `WINDOWS_PORT.md`); Linux with
[development/linux-support.md](./development/linux-support.md).

## Layout

```
docs/
├── README.md                     # this file
├── PRD.md                        # product entry point
├── ARCHITECTURE.md               # system architecture
├── logging.md                    # logs, Sentry and PostHog ground truth
├── analytics/
│   ├── README.md                 # PostHog setup, dashboards, how to add an event
│   └── tracking-plan.json        # the event catalog (checked in CI)
├── brand/
│   ├── README.md                 # DAEX names, BRAND constants, frozen identifiers
│   ├── desktop-packaging.md      # showing DAEX without moving installs, per platform
│   └── rebrand-checklist.md      # audit of places a person can still see "ADE"
├── design/
│   ├── ask-question-redesign.md (+ .html, renders/)  # ask-question surface spec
│   ├── keyboard.md               # keyboard and focus rules
│   ├── notices.md                # banners, toasts, dialogs, Z_LAYERS, ade-ui lint
│   ├── theming.md                # theme format, engine, tokens
│   └── visual-language.md        # surface kit, scenes, layout, colour rules
├── development/
│   ├── local-development.md      # run, test and package DAEX locally
│   ├── linux-support.md          # Linux evidence and support
│   ├── windows-support.md        # Windows capabilities and troubleshooting
│   ├── windows-port-lane.md      # Windows integration lane rules
│   ├── windows-update-timeline.md        # Windows auto-update timeline
│   ├── windows-release-proof.md          # exact-SHA evidence schema
│   ├── windows-full-system-scenarios.json  # Windows acceptance inventory
│   └── windows-source-provenance.json      # source mapping for the proof
├── perf/
│   ├── macos-baseline.md         # measured numbers and ceilings (the perf gate)
│   ├── windows-baseline.md       # the same for Windows
│   ├── cloudflare-costs.md       # Worker and Durable Object cost notes
│   └── work-tab-action-inventory.md  # Work tab perf audit matrix
├── plans/                        # only plans with open work, or contracts code names
│   ├── ade-dev-home.md           # home widgets, Browser tab, Music
│   ├── android-emulator.md       # open Android items
│   ├── apple-device-env.md       # Apple agent contracts
│   ├── apple-device-env-contracts.md  # Apple error codes and settings keys
│   ├── beta-track.md             # Beta track contracts
│   └── lane-sharing-real-ui.md   # open lane sharing work
├── playbooks/
│   ├── ship-lane.md              # autonomous PR-to-merge driver
│   ├── update-gate.md            # the account server's minimum client version
│   └── windows-signed-release.md # signed Windows publication
├── triage/
│   └── PLAYBOOK.md               # the playbook `daex triage` reads
└── features/
    ├── proof.md                  # how proof is filed and cited
    ├── ade-cloud/                # DAEX Cloud: one machine per account, cloud lane computers, server routes
    ├── ade-mcp/                  # DAEX MCP: AI apps run `daex` on a computer through DAEX Relay
    ├── agents/                   # agent identity, tools, personas
    ├── android-device/           # Android emulator + scrcpy stream
    ├── apple-device/             # Apple simulator + helper stream
    ├── automations/              # rule triggers, actions, guardrails
    ├── capture-gesture/          # global screenshot chord (both ⌘ / both Ctrl) → CTO
    ├── chat/                     # multi-provider agent chat
    ├── computer-use/             # proof control plane, backends, broker
    ├── conflicts/                # detection, simulation, resolution
    ├── cto/                      # the CTO agent
    ├── deeplinks/                # daex:// (and ade://) links, https open links
    ├── files-and-editor/         # watcher, editor, Monaco, search
    ├── history/                  # operations timeline, transcripts, export
    ├── issues/                   # Linear, GitHub and Jira issues where you are
    ├── lanes/                    # worktree isolation, runtime, OAuth, lane sharing
    ├── linear-integration/       # issue reads, lane/PR flow, live status
    ├── linux-desktop/            # the per-lane Linux screen
    ├── mac-desktop/              # per-lane macOS virtual display (`daex screen`)
    ├── music/                    # Apple Music and Spotify players
    ├── onboarding-and-settings/  # first run, schema, settings tabs
    ├── passwords/                # the account vault: logins, codes, passkeys, secrets
    ├── personal-chats/           # machine-owned projectless chats
    ├── pull-requests/            # PRs, stacks, checks, merging
    ├── remote-runtime/           # the brain, remote machines, SSH bootstrap
    ├── sdk/                      # embeddable @daex-dev/sdk + @daex-dev/chat-ui
    ├── search/                   # universal FTS5 index, ⌘K and `daex search`
    ├── storage-and-recovery/     # disk pressure, durable state, repair
    ├── sync-and-multi-device/    # CRDT sync, Activity, iOS, remote commands, handoff
    ├── terminals-and-sessions/   # PTY, sessions, Work surfaces
    ├── web-client/               # DAEX in a browser, with or without a computer
    └── windows-desktop/          # per-lane Windows screen (`daex screen`)
```

Folder names under `features/` (`ade-cloud`, `ade-mcp`) keep the old name on
purpose; links and skills point at them.

## Conventions

- Each `features/<name>/README.md` starts with a **Source file map** of the
  primary code paths.
- Detail docs sit next to their README, which links down to them.
- Docs describe the present. No changelogs, "updated on" notes or "previously"
  stories; history is in git and `CHANGELOG.md`.
- Fragile areas are flagged in the docs that describe them. Read before editing.
- Future work goes to Linear, not into committed TODO files.

## The public docs site

`docs.json` at the repo root configures the public Mintlify site (`.mdx` files
in root folders such as `chat/`, `tools/`, `concepts/`, `sdk/`). It is
user-facing and separate from this folder. The SDK tab (`sdk/*.mdx`) is the
public embedder docs for `@daex-dev/sdk` and `@daex-dev/chat-ui`; keep it in
step with `features/sdk/` and the package READMEs.

The public site is organized task-first ("I want to…"), then Concepts, then
Reference; it is not one page per feature. `docs-areas.json` maps source trees
to the pages they can make wrong: `node scripts/docs-areas.mjs --changed --base <ref>`
lists the pages a change can affect, and `node scripts/validate-docs.mjs` fails
on an unowned page, a missing page or a broken internal link.

**This folder (`docs/`) is internal only.**
