# Onboarding and Settings

Two related but distinct flows:

- **Onboarding** — the fastest path to a usable project. Detects dev
  tools and stack signals, suggests a project config, optionally
  imports existing git branches as lanes, and runs a short wizard for
  AI providers, GitHub, and optional integrations.
- **Settings** — long-lived configuration organized by tab. Persists
  to `.ade/ade.yaml` (shared) and `.ade/local.yaml` (local) through
  `projectConfigService`.

The runtime no longer assumes first-run setup must hydrate every
service. Project open favors a cheap first pass; secondary hydration
(full lane status, provider modes, semantic indexing) happens after
the app is interactive.

## Source file map

Main process:

- `apps/desktop/src/main/services/onboarding/onboardingService.ts` —
  status, stack detection, suggested config, existing lane detection,
  and tour progress tracking. `OnboardingTourProgress` carries the
  legacy flat per-tour map (`tours: Record<string, OnboardingTourEntry>`)
  plus a new variant-aware `tourVariants: Record<string,
  OnboardingTourEntryV2>` keyed by base tour id with a `full` +
  `highlights` pair. A separate `tutorial: OnboardingTutorialState`
  slab tracks the 13-act first-session tutorial
  (`completedAt`/`dismissedAt`/`silenced`/`inProgress`/`lastActIndex`/
  `ctxSnapshot`). Glossary terms seen are tracked in
  `glossaryTermsSeen[]`. Persisted to `kvDb` under
  `onboarding:tourProgress`.
- `apps/desktop/src/main/services/config/projectConfigService.ts` —
  YAML config read/merge/save, AI mode migration, lane env init,
  Linear sync resolver. ~2,870 lines, the largest service.
- `apps/desktop/src/main/services/config/laneOverlayMatcher.ts` —
  matches lanes against `LaneOverlayPolicy[]` to produce the effective
  overlay.

Shared types and IPC:

- `apps/desktop/src/shared/types/config.ts` — central type module for
  the configuration schema (processes, stacks, tests, overlays, lane
  templates, port allocation, proxy, OAuth, integrations, AI).
- `apps/desktop/src/shared/ipc.ts` — channels:
  - `ade.onboarding.*` (status, detectDefaults, detectExistingLanes,
    applySuggestedConfig, complete, setDismissed)
  - `ade.projectConfig.*` (get, validate, save, diffAgainstDisk,
    confirmTrust, export)
  - `ade.project.*` (listRecent, openRepo, switchProjectToPath)
  - `ade.ai.*` and settings-specific channels per integration
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — handler
  registrations.

Preload bridge:

- `apps/desktop/src/preload/preload.ts` — `window.ade.onboarding`,
  `window.ade.projectConfig`, `window.ade.project`, plus the
  integration-specific surfaces (`window.ade.github`, etc.).

Renderer — onboarding:

- `apps/desktop/src/renderer/components/onboarding/ProjectSetupPage.tsx`
  — the project setup wizard used during first-run and on the manual
  "re-run setup" flow. ~610 lines.
- `apps/desktop/src/renderer/components/onboarding/DevToolsSection.tsx`
  — dev tool detection (git, gh).
- `apps/desktop/src/renderer/components/onboarding/EmbeddingsSection.tsx`
  — local embedding model setup.
- `apps/desktop/src/renderer/components/onboarding/OnboardingBootstrap.tsx`
  — top-level orchestrator: mounts the `TourHost`, auto-fires per-tab
  tours on route change, renders `DidYouKnow`, and pops the
  `TutorialPromptCard` when the first-session tutorial is available.
  `DidYouKnow` suppresses itself whenever `activeTourId` is set in the
  onboarding store, so a live tour never competes with a "did you know"
  tooltip. `SmartTooltip` applies the same gate — tooltips silently
  return a null wrapper while a tour is active so the tour's own
  spotlight is the only floating UI.
- `apps/desktop/src/renderer/components/onboarding/TutorialPromptCard.tsx`
  — Start / Not now / Don't show again gate for the 13-act tutorial.
- `apps/desktop/src/renderer/components/onboarding/HelpMenu.tsx`
  — persistent help menu in the top bar: tour replay, glossary, docs
  links, restart tutorial.
- `apps/desktop/src/renderer/components/onboarding/tour/TourHost.tsx`,
  `TourOverlay.tsx`, `TourStep.tsx` — rendered overlay and per-step card.
  `TourHost` intentionally does not gate on the `onboardingEnabled`
  preference: the preference hides passive onboarding surfaces
  (`DidYouKnow`, tour auto-start hooks), but a tour the user explicitly
  starts from the Help menu must still render even when ambient
  onboarding is off — otherwise the menu would silently change routes
  without showing any guidance. `TourOverlay` applies a short
  (350 ms) grace period after a step mounts before
  `exitOnOutsideInteraction` takes effect, so the click that launched
  the current step cannot also dismiss it.
- `apps/desktop/src/renderer/components/onboarding/fx/*` — motion-FX
  primitives (`ActIntro`, `AnimatedField`, `Confetti`, `GhostCursor`,
  `MorphingTree`, `Spotlight`, `StaggeredText`, `TourIllustration`)
  plus a `useReducedMotion` hook. Used by the tutorial and per-tab tours.
- `apps/desktop/src/renderer/onboarding/TourController.ts` — imperative
  driver (advance/skip/complete/dismiss); source of truth for the
  Zustand `onboardingStore`.
- `apps/desktop/src/renderer/onboarding/waitForTarget.ts` — polls for a
  DOM target (ref or `data-onboarding-target`) with a visibility check
  so tour steps anchor reliably to async-mounted elements.
- `apps/desktop/src/renderer/onboarding/docsLinks.ts` — typed registry
  of internal/public doc URLs that tour steps and `HelpMenu` link to.
- `apps/desktop/src/renderer/onboarding/registry.ts` — tour registry.
- `apps/desktop/src/renderer/onboarding/tourGuards.ts` — per-step guard
  predicates (route, selection, and element-presence checks) that decide
  whether a step can advance, skip, or must pause for the user.
- `apps/desktop/src/renderer/onboarding/stepBuilders/*.ts` — factories
  for per-dialog tour steps (`createLaneDialog`, `manageLaneDialog`,
  `prCreateModal`); kept separate from the per-surface tour files so
  dialog-scoped steps can be composed from multiple tours.
- `apps/desktop/src/renderer/onboarding/tours/*.ts` — per-surface tours:
  `lanesTour`, `laneWorkPaneTour`, `workTour`, `filesTour`,
  `runTour`, `missionsTour`, `prsTour`, `graphTour`, `historyTour`,
  `automationsTour`, `ctoTour`, `settingsTour`, plus the first-session
  `firstJourneyTour`. The first-session tour reuses individual steps
  from the per-surface tours via a small `tutorialSection(sectionId,
  steps, requires)` wrapper that namespaces step ids
  (`<sectionId>.<index>`), forces a `requires` gate, derives
  `waitForSelector` from `target`, and — for any step that has a
  `requires` gate without its own `fallbackAfterMs` — injects a
  default 30 s `Skip` fallback so the tutorial can never get
  permanently stuck waiting on state that doesn't appear. The acts
  themselves are intentionally streamlined: act 1 only borrows the
  base-branch / status-chip / lane-work-pane bits (since the user has
  just created a lane interactively); acts 2 + 3 inline ctx-aware
  graph/files steps directly rather than spreading the full sub-tour;
  the per-act "tab handoff" reminder steps were collapsed into the
  single act 12 finale.
- `apps/desktop/src/renderer/components/cto/...` — CTO first-run is a
  separate lightweight wizard covering identity, project context, and
  optional Linear (see `apps/desktop/src/renderer/components/cto/`).

Renderer — settings:

- `apps/desktop/src/renderer/components/app/SettingsPage.tsx` — tab
  container with eight top-level sections.
- `apps/desktop/src/renderer/components/settings/GeneralSection.tsx`
  — theme, AI mode, task routing, terminal preferences, keybindings
  link, and the embedded `AdeCliSection` (compact form) so the most
  common terminal-CLI install/repair affordance lives next to the
  other day-one settings without forcing a tab switch into
  Integrations.
- `apps/desktop/src/renderer/components/settings/AdeCliSection.tsx`
  — surfaces `ade.cli.getStatus` / `ade.cli.install` / `ade.cli.uninstall`.
  In compact form (used by `GeneralSection` and the onboarding
  `DevToolsSection`) it shows the current install path, an
  Install / Repair button, and a "Add to PATH" hint when the install
  target isn't on the user's `$PATH`.
- `apps/desktop/src/renderer/components/settings/WorkspaceSettingsSection.tsx`
  + `ProjectSection.tsx` — project identity, base ref, paths.
- `apps/desktop/src/renderer/components/settings/AiSettingsSection.tsx`
  / `AiFeaturesSection.tsx` — AI provider preferences.
- `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx`
  — provider CLIs and models.
- `apps/desktop/src/renderer/components/settings/IntegrationsSettingsSection.tsx`
  — GitHub, Linear, and computer-use backend readiness. The old
  dedicated `ComputerUseSection.tsx` was removed; its content folded
  in here.
- `apps/desktop/src/renderer/components/settings/MemoryHealthTab.tsx`
  — memory system overview and browser.
- `apps/desktop/src/renderer/components/settings/LaneTemplatesSection.tsx`
  and `LaneBehaviorSection.tsx` — lane initialization recipes and
  lifecycle policies.
- `apps/desktop/src/renderer/components/settings/OnboardingSection.tsx`
  — surfaces the first-session tutorial and per-tab tour progress,
  plus replay controls.
- `apps/desktop/src/renderer/components/settings/SyncDevicesSection.tsx`
  — multi-device sync management. Surfaces the phone-pairing PIN (set
  / clear / reveal), the QR payload (v2) with its LAN / Tailscale /
  loopback address candidates, the bootstrap token for desktop peers,
  the Tailscale MagicDNS discovery status (`svc:ade-sync` publication
  via `tailscale serve`), and the per-device connection panel used to
  forget paired phones.
- `apps/desktop/src/renderer/components/settings/SettingsUsageSection.tsx`
  and `UsageGuardrailsSection.tsx` — cost and usage.
- `apps/desktop/src/renderer/components/settings/ProxyAndPreviewSection.tsx`
  — proxy/preview configuration UI.
- `apps/desktop/src/renderer/components/settings/DiagnosticsDashboardSection.tsx`
  — runtime diagnostics.

## Detail docs

- [configuration-schema.md](./configuration-schema.md) — shape of
  `.ade/ade.yaml` and `.ade/local.yaml` as consumed by
  `projectConfigService`; types in `shared/types/config.ts`.
- [first-run.md](./first-run.md) — the onboarding wizard, stack
  detection, existing-lane import, and the UX contract that lets
  users skip optional integrations.

## Onboarding responsibilities

Repository onboarding covers five things:

1. detect dev tools (git, gh CLI) and report availability
2. detect stack signals (node, rust, go, python, docker, make)
3. suggest config defaults for processes, tests, stacks
4. optionally import existing git branches as lanes
5. prepare initial deterministic workspace state

Timing: project open runs a cheap first pass and defers heavy work.
Current behavior:

- lanes load without expensive per-lane status first
- keybindings load immediately (they are tiny)
- provider mode and full lane status warm later
- expensive background work is no longer gated on "must finish before
  the app feels usable"

### CTO first-run setup

CTO (the agent identity used in the Chat tab) has its own lightweight
wizard:

1. **Identity** — name, provider/model preference, persona. System
   prompt preview is generated live, debounced.
2. **Project context** — seed from repo-detected defaults or existing
   CTO memory; user can edit summary, conventions, focus areas.
3. **Integrations** — Linear is optional. Primary action finishes
   onboarding with or without Linear. Fastest path is a personal API
   key; OAuth is available but not the default recommendation.

OpenClaw is intentionally excluded from first-run setup.

## Settings responsibilities

Eight top-level tabs, organized to match the kind of thing the user
is changing rather than which service backs it:

| Tab | Section file | What lives here |
|---|---|---|
| General | `GeneralSection.tsx` (embeds `AdeCliSection` in compact form) | Theme, AI mode, task routing, terminal preferences (font size, line height, scrollback), keybindings link, and the `ade` CLI install / status surface |
| Workspace | `WorkspaceSettingsSection.tsx`, `ProjectSection.tsx` | Project identity, paths, skill files |
| AI | `AiSettingsSection.tsx`, `AiFeaturesSection.tsx`, `ProvidersSection.tsx` | Provider CLIs, models, AI feature flags |
| Sync | `SyncDevicesSection.tsx` | Multi-device sync, host-role transfer, peer status, pairing PIN, Tailscale tailnet discovery |
| Integrations | `IntegrationsSettingsSection.tsx`, `GitHubSection.tsx`, `LinearSection.tsx` | GitHub, Linear, and computer-use backend readiness. The GitHub section reads `status.connected` (the backend's single "GitHub is usable" gate) to decide between CONNECTED / LIMITED ACCESS / NOT CONNECTED, surfaces a dedicated repo-probe error when a fine-grained token authenticates as a user but cannot access the active repo, and the REFRESH button calls `getStatus({ forceRefresh: true })` so users who fix permissions on github.com see the change immediately. See [`pull-requests/README.md`](../pull-requests/README.md#github-connectivity-model) for the full status-shape and `connected` derivation. |
| Memory | `MemoryHealthTab.tsx` | Memory health, browser, embedding health |
| Lane Templates | `LaneTemplatesSection.tsx`, `LaneBehaviorSection.tsx` | Lane init recipes and lane lifecycle policy |
| Onboarding | `OnboardingSection.tsx` | First-session tutorial + per-tab tour progress and replay controls |
| Usage | `SettingsUsageSection.tsx`, `UsageGuardrailsSection.tsx` | Cost visibility and guardrails |

The Settings page itself (`SettingsPage.tsx`) has a legacy alias
table (`TAB_ALIASES`) that forwards deep links (`?tab=context`,
`?tab=providers`, `?tab=github`, etc.) to the correct section after
the consolidation that collapsed many top-level tabs into sub-sections.

### Where durable data lives

| What | Location | Notes |
|---|---|---|
| Project config (shared) | `.ade/ade.yaml` | committed to git |
| Project config (local) | `.ade/local.yaml` | gitignored |
| Onboarding status | `AdeDb` via `STATUS_KEY = "onboarding:status"` | `completedAt`, `dismissedAt`, `freshProject` |
| Context doc prefs | `AdeDb` via `context:docs:preferences.v1` | provider, model, reasoning effort, event triggers |
| Terminal preferences | `localStorage` under `ade.terminalPreferences.v1` | font size, line height, scrollback, font family |
| Work view state | `localStorage` under `ade.workViewState.v1` | per-project and per-lane-project slices |
| Memory system | `AdeDb` | see memory feature |
| GitHub/Linear credentials | Keychain via `safeStorage` | tokens encrypted, banner on decryption failure |

## AI mode and provider behavior

`effective.ai.mode` is the source of truth for guest vs subscription
behavior. Current behavior:

- **guest mode** — deterministic features remain usable; AI-backed
  features degrade cleanly (no narrative generation, no summaries).
- **subscription mode** — unlocks chat, narratives, summaries,
  mission orchestration.

Legacy `providers.mode` migration ran during earlier releases and is
no longer part of the contract; `projectConfigService` still contains
the migration path but it is idempotent for current configs.

## UX contract

Onboarding and settings follow a simple rule:

- do not block on optional integrations
- keep setup responsive
- show the fastest path first
- defer advanced or heavy configuration to the feature surface that
  owns it (e.g. memory browser is in the Memory tab, not sprayed
  across multiple places)

## Gotchas

- **Shared vs local.** Shared config is version-controlled and visible
  to the whole team; saving to shared triggers a trust confirmation
  dialog. Local config is per-user and gitignored — use it for ports,
  local-only processes, personal env. Both are merged into `effective`.
- **Trust boundary.** `projectConfigService.getExecutableConfig` gates
  on trust before returning a config that can spawn processes. Callers
  that skip trust (`{ skipTrust: true }`) do so only after trust has
  been confirmed in the same session.
- **Config reload.** On save, dependent services receive reload
  callbacks (the config service iterates listeners). A hot reload is
  best-effort — some changes only take full effect on app restart
  (e.g. proxy port changes).
- **Onboarding status.** `freshProject` is computed at
  `createOnboardingService` construction and does not update at
  runtime. Passing the wrong boolean flips the "first-run" surface on
  a well-used project.
- **Deep links.** Settings tabs accept `?tab=<id>` via
  `useSearchParams`; unknown tab IDs fall back to `general` through
  `TAB_ALIASES`.

## Cross-links

- Run/Project home: [../project-home/README.md](../project-home/README.md)
- Lane templates used during lane creation: Lanes feature
- Terminal preferences applied at runtime:
  [../terminals-and-sessions/ui-surfaces.md](../terminals-and-sessions/ui-surfaces.md)
