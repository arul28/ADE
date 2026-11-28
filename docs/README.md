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

The index of the internal docs, written for engineers and agents working on
DAEX itself. **Start with [PRD.md](./PRD.md).** The code is the source of
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

## Start here

1. [PRD.md](./PRD.md): product scope, DAEX with no computer, concepts, the
   feature index.
2. [ARCHITECTURE.md](./ARCHITECTURE.md): DAEX Cloud and the account (section
   1.1), apps, brain and client topology, data plane, IPC, security, build and
   release.
3. [logging.md](./logging.md): local logs, Sentry, PostHog analytics, privacy,
   consent and instrumentation rules.
4. [brand/README.md](./brand/README.md): the DAEX names, the `BRAND` / `Brand`
   constants, and the identifiers that keep the old name.
5. The feature folder for the area you are changing (below). For the machines,
   account and clients picture, start with DAEX Cloud, the web client, remote
   runtime and sync.

Running DAEX from a checkout starts with
[development/local-development.md](./development/local-development.md).
Windows starts with [development/windows-support.md](./development/windows-support.md)
(and the root `WINDOWS_PORT.md`); Linux with
[development/linux-support.md](./development/linux-support.md).

## Features

One folder per feature under [features/](./features/). Each has a `README.md`
(the entry point, starting with a source file map) and detail docs beside it.
The folders `ade-cloud` and `ade-mcp` keep the old name on purpose.

### Machines, account and sync

- [DAEX Cloud](./features/ade-cloud/README.md): one machine per account, a
  computer per cloud lane, plans, the server launcher, sleep and wake.
  [Account test tool](./features/ade-cloud/account-test-tool.md) (act as any
  plan, flip server switches).
- [Remote runtime](./features/remote-runtime/README.md): the brain, remote
  machines, SSH bootstrap.
  [Internal architecture](./features/remote-runtime/internal-architecture.md).
- [Sync and multi-device](./features/sync-and-multi-device/README.md): CRDT
  sync, Activity, the phone, remote commands, handoff.
  [CRDT model](./features/sync-and-multi-device/crdt-model.md) ·
  [Remote commands](./features/sync-and-multi-device/remote-commands.md) ·
  [Devices and machines](./features/sync-and-multi-device/devices-and-machines.md) ·
  [Cross-machine agents](./features/sync-and-multi-device/cross-machine-agents.md) ·
  [Session handoff](./features/sync-and-multi-device/cross-machine-session-handoff.md) ·
  [Activity and push notifications](./features/sync-and-multi-device/push-notifications.md) ·
  [iOS companion](./features/sync-and-multi-device/ios-companion.md).
- [Web client](./features/web-client/README.md): DAEX in a browser, with or
  without a computer.
- [Passwords](./features/passwords/README.md): the account vault (logins,
  codes, passkeys, secrets).
- [Storage and recovery](./features/storage-and-recovery/README.md): disk
  pressure, durable state, repair, `daex triage`.

### Agents and chat

- [Chat](./features/chat/README.md): multi-provider agent chat.
  [Agent routing](./features/chat/agent-routing.md) ·
  [Transcript and turns](./features/chat/transcript-and-turns.md) ·
  [Composer and UI](./features/chat/composer-and-ui.md) ·
  [Tool system](./features/chat/tool-system.md) ·
  [Drafts and scheduled send](./features/chat/drafts-and-scheduled-send.md) ·
  [Quick slots](./features/chat/quick-slots.md) ·
  [ACP providers](./features/chat/acp-providers-spec.md) ·
  [OpenCode](./features/chat/opencode-integration.md) ·
  [Copilot SDK](./features/chat/copilot-sdk-provider.md) ·
  [Antigravity](./features/chat/antigravity-provider.md).
- [Agents](./features/agents/README.md): skill delivery, spawning and
  reporting, the CLI bridge and roles.
  [Tool registration](./features/agents/tool-registration.md).
- [CTO](./features/cto/README.md): the per-project CTO agent, identity and
  personas.
- [Personal chats](./features/personal-chats/README.md): machine-owned chats
  with no project.
- [Automations](./features/automations/README.md): rules that run agents.
  [Triggers and actions](./features/automations/triggers-and-actions.md) ·
  [Guardrails](./features/automations/guardrails.md) ·
  [UI](./features/automations/ui-design.md) ·
  [Known gaps](./features/automations/known-gaps.md).
- [DAEX MCP](./features/ade-mcp/README.md): AI apps run `daex` on a computer
  through DAEX Relay.
- [SDK](./features/sdk/README.md): the embeddable `@daex-dev/sdk` and
  `@daex-dev/chat-ui`.

### Lanes, Git and issues

- [Lanes](./features/lanes/README.md): lanes and the main checkout.
  [Worktree isolation](./features/lanes/worktree-isolation.md) ·
  [Lane runtime](./features/lanes/runtime.md) ·
  [OAuth redirect](./features/lanes/oauth-redirect.md) ·
  [Lane sharing](./features/lanes/lane-sharing.md).
- [Conflicts](./features/conflicts/README.md): prediction, merge simulation,
  AI resolution.
  [Detection](./features/conflicts/detection.md) ·
  [Simulation and resolution](./features/conflicts/simulation.md).
- [Pull requests](./features/pull-requests/README.md): PRs, checks, merging.
  [GitHub stacked PRs](./features/pull-requests/github-stacked-prs.md).
- [Issues](./features/issues/README.md): Linear, GitHub and Jira issues where
  you are.
- [Linear integration](./features/linear-integration/README.md): issue reads,
  lane/PR flow, live status.
- [History](./features/history/README.md): the commits graph, the operations
  timeline and export.

### Work surfaces

- [Terminals and sessions](./features/terminals-and-sessions/README.md): PTY,
  sessions, the Work tab.
  [PTY and sessions](./features/terminals-and-sessions/pty-and-sessions.md) ·
  [UI surfaces](./features/terminals-and-sessions/ui-surfaces.md) ·
  [Runtime isolation](./features/terminals-and-sessions/runtime-isolation.md) ·
  [Settle](./features/terminals-and-sessions/settle-teardown-design.md) ·
  [External session import](./features/terminals-and-sessions/external-session-import.md).
- [Files and editor](./features/files-and-editor/README.md): watcher, editor,
  Monaco.
  [Editor surfaces](./features/files-and-editor/editor-surfaces.md) ·
  [File watcher and trust](./features/files-and-editor/file-watcher-and-trust.md).
- [Search](./features/search/README.md): the FTS5 index, ⌘K and `daex search`.
- [Deeplinks](./features/deeplinks/README.md): `daex://` (and `ade://`) links
  and https open links.
- [Music](./features/music/README.md): Apple Music and Spotify players.

### Devices, computer use and proof

- [Computer use](./features/computer-use/README.md): driving apps and screens,
  and keeping proof.
  [App Control](./features/computer-use/app-control.md) ·
  [Artifact broker](./features/computer-use/artifact-broker.md).
- [Proof](./features/proof.md): how proof is filed and cited.
- [Apple device](./features/apple-device/README.md): simulator and helper
  stream.
  [DAEX Cloud iPhone](./features/apple-device/ade-cloud-iphone.md) ·
  [Inspector](./features/apple-device/inspector.md).
- [Android device](./features/android-device/README.md): emulator and scrcpy
  stream.
- Per-lane screens (`daex screen`): [macOS](./features/mac-desktop/README.md) ·
  [Windows](./features/windows-desktop/README.md) ·
  [Linux](./features/linux-desktop/README.md).
- [Capture gesture](./features/capture-gesture/README.md): the global
  screenshot chord (both ⌘ / both Ctrl) to the CTO.

### Setup and settings

- [Onboarding and settings](./features/onboarding-and-settings/README.md):
  first run, settings tabs.
  [First run](./features/onboarding-and-settings/first-run.md) ·
  [Configuration schema](./features/onboarding-and-settings/configuration-schema.md) ·
  [Harness presets](./features/onboarding-and-settings/harness-presets.md) ·
  [Agent tools cache](./features/onboarding-and-settings/agent-tools-cache.md) ·
  [MCP servers](./features/onboarding-and-settings/mcp-servers.md) ·
  [Usage tracking](./features/onboarding-and-settings/usage-tracking.md) ·
  [Project health](./features/onboarding-and-settings/project-health.md) ·
  [Project move](./features/onboarding-and-settings/project-move.md) ·
  [Desktop auto-update](./features/onboarding-and-settings/desktop-auto-update.md).

## Engineering

### Development

- [local-development.md](./development/local-development.md): run, test and
  package DAEX locally.
- [linux-support.md](./development/linux-support.md): Linux evidence and
  support.
- [windows-support.md](./development/windows-support.md): Windows capabilities
  and troubleshooting.
- [windows-port-lane.md](./development/windows-port-lane.md): Windows
  implementation map and smoke checklist.
- [windows-update-timeline.md](./development/windows-update-timeline.md):
  where the time goes in a Windows update.
- [windows-release-proof.md](./development/windows-release-proof.md): the
  exact-SHA evidence schema, with `windows-full-system-scenarios.json`
  (acceptance inventory) and `windows-source-provenance.json` (source mapping).

### Performance

- [macos-baseline.md](./perf/macos-baseline.md): measured numbers and ceilings
  (the perf gate).
- [windows-baseline.md](./perf/windows-baseline.md): the same for Windows.
- [cloudflare-costs.md](./perf/cloudflare-costs.md): Worker and Durable Object
  cost notes.
- [work-tab-action-inventory.md](./perf/work-tab-action-inventory.md): the
  Work tab perf audit matrix.

### Design

- [visual-language.md](./design/visual-language.md): surface kit, scenes,
  layout, colour rules.
- [notices.md](./design/notices.md): banners, toasts, dialogs, `Z_LAYERS`, the
  ade-ui lint.
- [keyboard.md](./design/keyboard.md): keyboard and focus rules.
- [theming.md](./design/theming.md): theme format, engine, tokens.
- [ask-question-redesign.md](./design/ask-question-redesign.md): the
  ask-question surface contract (with its `.html` mock and `renders/`).

### Brand and analytics

- [brand/README.md](./brand/README.md): DAEX names, `BRAND` constants, frozen
  identifiers.
- [brand/desktop-packaging.md](./brand/desktop-packaging.md): showing DAEX
  without moving installs, per platform.
- [brand/rebrand-checklist.md](./brand/rebrand-checklist.md): places a person
  can still see "ADE".
- [analytics/README.md](./analytics/README.md): PostHog setup, dashboards, how
  to add an event. The event catalog is `analytics/tracking-plan.json`
  (checked in CI).

### Playbooks and triage

- [playbooks/ship-lane.md](./playbooks/ship-lane.md): the autonomous
  PR-to-merge driver.
- [playbooks/update-gate.md](./playbooks/update-gate.md): the account server's
  minimum client version.
- [playbooks/windows-signed-release.md](./playbooks/windows-signed-release.md):
  signed Windows publication.
- [triage/PLAYBOOK.md](./triage/PLAYBOOK.md): the playbook `daex triage` reads.

### Plans

Only plans with open work, or contracts that code names, stay here.

- [ade-dev-home.md](./plans/ade-dev-home.md): the widget home page, Browser and
  Music tabs.
- [android-emulator.md](./plans/android-emulator.md): open Android items.
- [apple-device-env.md](./plans/apple-device-env.md): Apple agent contracts.
- [apple-device-env-contracts.md](./plans/apple-device-env-contracts.md): Apple
  error codes and settings keys.
- [beta-track.md](./plans/beta-track.md): Beta track decisions and contracts.
- [lane-sharing-real-ui.md](./plans/lane-sharing-real-ui.md): open lane sharing
  work.

## Conventions

- Each `features/<name>/README.md` starts with a **Source file map** of the
  primary code paths.
- Detail docs sit next to their README, which links down to them. Add a new
  doc to this index too.
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
