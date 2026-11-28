# Feature Path → Doc + Perf-Skill Mapping

Resolve changed file paths (or keyword arguments) to the canonical internal docs
under `docs/` and, where one exists, the performance skill that records measured
patterns for that surface. Load the doc set **and** open the perf skill before
editing that surface.

Internal docs live under `docs/`. The public Mintlify site (`docs.json` +
root-level `*.mdx`) is **out of scope** for context loading.

DAEX works with no computer of your own: every account has DAEX Cloud, one
machine next to the person's own computers. Any work on machines, DAEX Cloud,
the account, or web and iOS with no computer also loads
`docs/ARCHITECTURE.md` section 1.1 and `docs/features/ade-cloud/README.md`.
DAEX Cloud computers run on Agent 37: work that depends on how a cloud
computer sleeps, wakes, restarts or updates also reads that README's "The
provider seam" section, which links Agent 37's own docs.

Folder names keep `ade` (`docs/features/ade-cloud/`, `docs/features/ade-mcp/`,
`apps/ade-cli/`): they are frozen, see `docs/brand/README.md`.

---

## Desktop — main-process services

| Path pattern | Feature docs | Perf skill |
|---|---|---|
| `apps/desktop/src/main/services/projects/` | `docs/features/onboarding-and-settings/README.md` | `ade-perf-boot` |
| `apps/desktop/src/main/services/lanes/` | `docs/features/lanes/README.md` | `ade-perf-lanes` |
| `apps/desktop/src/main/services/prs/` | `docs/features/pull-requests/README.md` | `ade-perf-prs` |
| `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts`, `services/demoVideo/`, `apps/ade-cli/src/services/proof/` (keywords: proof, proof drawer, demo video, `daex proof`) | `docs/features/proof.md` + `docs/features/computer-use/artifact-broker.md` | — |
| `apps/desktop/src/main/services/adeCloud/` (keywords: DAEX Cloud, cloud lane, wake, asleep, server queue, fork-continue, deleting soon, refusal) | `docs/features/ade-cloud/README.md` + `docs/ARCHITECTURE.md` (§1.1) | — |
| `apps/desktop/src/main/services/remoteRuntime/`, `services/localRuntime/`, `services/runtime/` | `docs/features/remote-runtime/README.md` | `ade-perf-boot` |
| `apps/desktop/src/main/services/state/`, `services/startupRecovery/` (keywords: database, recovery, corrupt, durable file) | `docs/features/storage-and-recovery/README.md` | `ade-perf-boot` |
| `apps/desktop/src/main/services/cto/` | `docs/features/cto/README.md` + `docs/features/linear-integration/README.md` | — |
| `apps/desktop/src/main/services/ai/` | `docs/features/chat/README.md` + `docs/features/agents/README.md` | `ade-perf-work` |
| `apps/desktop/src/main/services/chat/` | `docs/features/chat/README.md` | `ade-perf-work` |
| `apps/ade-cli/src/services/personalChats/`, `apps/desktop/src/main/services/chat/personalSession.ts` (keywords: personal chat, project-less chat, Chats page, assistant/embedded profile) | `docs/features/personal-chats/README.md` + `docs/features/chat/README.md` | `ade-perf-work` |
| `apps/desktop/src/main/services/home/` (keywords: home page, widgets, Now Playing, weather, clipboard history) | `docs/plans/ade-dev-home.md` (§4 Widget home page) + `docs/features/music/README.md` for Now Playing | — |
| `apps/desktop/src/main/services/music/` (keywords: Apple Music, Spotify, MusicKit, developer token, music host) | `docs/features/music/README.md` + `docs/plans/ade-dev-home.md` (§3) | — |
| `apps/desktop/src/main/services/search/` (keywords: search, `daex search`, index) | `docs/features/search/README.md` | — |
| `apps/desktop/src/main/services/automations/` | `docs/features/automations/README.md` | — |
| `apps/desktop/src/main/services/computerUse/`, `services/appControl/` | `docs/features/computer-use/README.md` (+ `app-control.md`) | — |
| `apps/desktop/src/main/services/macDesktop/`, `apps/desktop/native/ADEDesktopDriver/` (keywords: mac desktop, virtual display, desktop seat, `daex screen`, `daex mac-desktop`, accessibility driver, window parking, input lease; agent skill `daex-computer-use`) | `docs/features/mac-desktop/README.md` + `docs/features/computer-use/README.md` | — |
| `apps/desktop/src/main/services/windowsDesktop/`, `apps/desktop/native/ADEDesktopDriverWin/` | `docs/features/windows-desktop/README.md` + `docs/features/computer-use/README.md` | — |
| `apps/desktop/src/main/services/linuxDesktop/`, `apps/desktop/native/ADEDesktopDriverLinux/` | `docs/features/linux-desktop/README.md` + `docs/features/computer-use/README.md` | — |
| `apps/desktop/src/main/services/android/`, `apps/desktop/src/renderer/components/android/**` (keywords: Android, emulator, `daex android`) | `docs/features/android-device/README.md` + skill `daex-android` | `ade-perf-work` |
| `apps/desktop/src/main/services/capture/`, `apps/desktop/native/ADECaptureHelper/`, `ADECaptureHelperWin/` (keywords: capture gesture, both ⌘ keys) | `docs/features/capture-gesture/README.md` | — |
| `apps/desktop/src/main/services/deeplinks/` | `docs/features/deeplinks/README.md` | — |
| `apps/desktop/src/main/services/conflicts/` | `docs/features/conflicts/README.md` | — |
| `apps/desktop/src/main/services/files/` | `docs/features/files-and-editor/README.md` | `ade-perf-work` |
| `apps/desktop/src/main/services/history/` | `docs/features/history/README.md` | — |
| `apps/desktop/src/main/services/onboarding/`, `services/config/` | `docs/features/onboarding-and-settings/README.md` | `ade-perf-boot` |
| `apps/desktop/src/main/services/pty/`, `sessions/`, `processes/` | `docs/features/terminals-and-sessions/README.md` | `ade-perf-work` |
| `apps/desktop/src/main/services/sync/` | `docs/features/sync-and-multi-device/README.md` | — |
| `apps/desktop/src/main/services/passwords/` | `docs/features/passwords/README.md` | — |
| `apps/desktop/src/main/services/issueTrackers/`, `services/jira/` | `docs/features/issues/README.md` | — |
| `apps/desktop/src/main/services/git/` | `docs/ARCHITECTURE.md` (§9 Git engine) + `docs/features/lanes/README.md` | `ade-perf-lanes` |
| `apps/desktop/src/main/services/ipc/`, `apps/desktop/src/preload/` | `docs/ARCHITECTURE.md` (§5 IPC contract) | — |
| `apps/desktop/src/main/main.ts`, app bootstrap | `docs/ARCHITECTURE.md` (§2 Apps and processes) | `ade-perf-boot` |

## Desktop — renderer

| Path pattern | Feature docs | Perf skill |
|---|---|---|
| `apps/desktop/src/renderer/components/lanes/**` | `docs/features/lanes/README.md` | `ade-perf-lanes` |
| `apps/desktop/src/renderer/components/prs/**` | `docs/features/pull-requests/README.md` | `ade-perf-prs` |
| `apps/desktop/src/renderer/components/chat/**`, Work tab panes (Tools, Git, Files, iOS, App Control, Browser) | `docs/features/chat/README.md` + relevant feature | `ade-perf-work` |
| `apps/desktop/src/renderer/components/issues/**`, `apps/desktop/src/renderer/lib/issueNavigation.ts`, `apps/desktop/src/shared/issueRefs.ts` (keywords: issue viewer, Issues tool, issue sheet, Linear link, GitHub issue) | `docs/features/issues/README.md` + `docs/features/linear-integration/README.md` | `ade-perf-work` |
| `apps/desktop/src/renderer/components/personalChats/**` | `docs/features/personal-chats/README.md` + `docs/features/chat/README.md` | `ade-perf-work` |
| `apps/desktop/src/renderer/components/home/**` | `docs/plans/ade-dev-home.md` (§4 Widget home page) + `docs/features/music/README.md` for the Now Playing widget | — |
| `apps/desktop/src/renderer/components/music/**` | `docs/features/music/README.md` | — |
| `apps/desktop/src/renderer/components/browser/**` (the Browser top tab) | `docs/features/chat/README.md` ("The Browser top tab") + `docs/plans/ade-dev-home.md` (§2) | `ade-perf-work` |
| `apps/desktop/src/renderer/components/app/**` (App shell) | `docs/ARCHITECTURE.md` (§7 UI framework) | `ade-perf-boot` |
| `apps/desktop/src/renderer/components/cloudLane/**`, `apps/desktop/src/renderer/components/adeCloud/**`, `apps/desktop/src/renderer/state/adeCloud*.ts`, `cloudRestingRows.ts`, `cloudSaved*.ts`, `ownComputers.ts`, `crossMachineLanes.ts` (keywords: DAEX Cloud tab, resting lane, saved chat, queued message, offline hidden) | `docs/features/ade-cloud/README.md` + `docs/features/web-client/README.md` + `docs/ARCHITECTURE.md` (§1.1) | `ade-perf-work` |
| `apps/desktop/src/renderer/components/<area>/**` | `docs/features/<same-area>/README.md` | match by area above |
| `apps/desktop/src/renderer/state/` (incl. `appStore.ts`) | `docs/ARCHITECTURE.md` (§7 UI framework) | `ade-perf-lanes` |
| `apps/desktop/src/shared/**` | `docs/ARCHITECTURE.md` + the touching feature's doc | — |
| Any renderer UI (`apps/desktop/src/renderer/**/*.tsx`), esp. `components/ui/notice/**`, `components/ui/dialog/**`, `components/app/toast/**`, `components/app/HeaderSheet.tsx`, `components/ui/zLayers.ts`, `apps/desktop/eslint-rules/**` | `docs/design/notices.md` and `docs/design/visual-language.md` (in addition to the area's docs) | — |

## DAEX CLI and brain (`apps/ade-cli`)

| Path pattern | Feature docs | Perf skill |
|---|---|---|
| `apps/ade-cli/**` | `docs/ARCHITECTURE.md` (§2.1 brain and runtime, §14 Build, test, deploy) + `docs/features/agents/README.md` | — |
| `apps/ade-cli/src/services/cloudChats/**`, `services/power/cloudPrepareStop.ts`, `services/github/cloudGitIdentity.ts`, `services/account/accountLaneIndexPublisher.ts` (keywords: save at rest, queue drain, restore, git identity, lane index) | `docs/features/ade-cloud/README.md` + `docs/features/remote-runtime/README.md` | — |
| `apps/ade-cli/src/services/passwords/**`, `apps/password-key-service/**` | `docs/features/passwords/README.md` | — |

## iOS, web, SDK, CI

| Path pattern | Feature docs | Perf skill |
|---|---|---|
| `apps/ios/**` | `docs/features/sync-and-multi-device/ios-companion.md` + `docs/features/apple-device/README.md` + `docs/features/ade-cloud/README.md` for DAEX Cloud screens | — |
| `apps/desktop/src/main/services/ios/**`, `apps/desktop/src/renderer/components/apple/**`, `apps/desktop/native/ADESimHelper/**` | `docs/features/apple-device/README.md` + skill `daex-apple` | `ade-perf-work` |
| `apps/web/**` | `apps/web/README.md` + `docs/ARCHITECTURE.md` (§2.5 Web app) | — |
| `apps/desktop/src/renderer/webclient/**` | `docs/features/web-client/README.md` + `docs/ARCHITECTURE.md` (§1.1, §2.4) | `ade-perf-boot` |
| `apps/account-directory/**` | `docs/features/ade-cloud/README.md` + `apps/account-directory/README.md` | — |
| `apps/push-relay/**` (keywords: vault, Passwords, browser allowlist, Activity) | `docs/features/passwords/README.md` + `apps/push-relay/README.md` + `docs/features/sync-and-multi-device/push-notifications.md` | — |
| `apps/webhook-relay/**` (keywords: webhook, event wake) | `apps/webhook-relay/README.md` + `docs/features/automations/README.md` | — |
| `apps/ade-cli/src/services/remoteMcp/**`, `apps/ade-cli/src/cliRemoteMcp.ts`, `apps/tunnel-relay/**`, `apps/desktop/src/renderer/components/settings/AdeMcpPage.tsx` (keywords: remote MCP, MCP server, DAEX MCP, `daex mcp`, connector) | `docs/features/ade-mcp/README.md` + `apps/tunnel-relay/README.md` | — |
| `packages/sdk/**`, `packages/chat-ui/**` (keywords: SDK, `@daex-dev/sdk`, sidecar) | `docs/features/sdk/README.md` + `packages/sdk/README.md` | — |
| `.github/workflows/**` | `docs/ARCHITECTURE.md` (§14 Build, test, deploy) | — |

---

## Windows parity (load when the lane touches a Windows-sensitive surface)

Windows parity is a default requirement for all new code, so a lane hitting any
of these paths starts Windows-aware rather than discovering it in `/quality`.

| Path pattern | Windows docs |
|---|---|
| Anything matching `**/*[Ww]indows*`, `**/win32*`, `apps/ade-cli/src/serviceManager/**`, `apps/ade-cli/src/lib/trustedWindowsTools.ts` | `WINDOWS_PORT.md` + `docs/development/windows-support.md` |
| `**/services/shared/processExecution.ts`, `services/shared/utils.ts`, `services/pty/**`, `services/processes/**`, `services/sessions/**` (process launch, kill, ConPTY) | `docs/development/windows-support.md` |
| `**/pathCompare.ts`, `apps/desktop/src/renderer/lib/pathUtils.ts`, `apps/ade-cli/src/services/projects/machineLayout.ts`, any new path construction or comparison | `docs/development/windows-support.md` |
| `services/runtime/**`, `apps/ade-cli/src/services/runtime/localIpcListenOptions.ts`, local IPC / socket / named-pipe endpoints | `docs/development/windows-support.md` |
| `services/credentials/**`, `safeStorage`/DPAPI/Keychain callers | `docs/development/windows-support.md` |
| `services/computerUse/**`, `services/appControl/**`, `services/macDesktop/**`, `services/windowsDesktop/**`, `apps/desktop/src/renderer/lib/platform.ts`, any platform capability gate | `docs/development/windows-support.md` + `docs/features/windows-desktop/README.md` |
| `.github/workflows/**` (Windows jobs), `scripts/package-channel.mjs`, packaging/native artifacts | `docs/development/windows-release-proof.md` |
| Release, signing, installer, updater feed (`latest.yml`) | `docs/playbooks/windows-signed-release.md` + `docs/development/windows-release-proof.md` |
| Running a dev app, profiling, or benchmarking on a Windows host (keywords: dev app, perf pass, benchmark, profile the brain) | `docs/development/local-development.md` (**On Windows**) |
| `apps/desktop/src/main/services/updates/**`, `apps/desktop/build/installer.nsh`, `apps/desktop/scripts/windows-install-setup.ps1`, the NSIS `build.nsis` block, auto-update install/relaunch | `docs/development/windows-update-timeline.md` + `docs/development/windows-support.md` |

Companion reference for the failure classes themselves (read alongside the docs,
not instead of them): `.agents/skills/quality/references/windows-quirks.md`.

---

**Cross-cutting:** any change to `apps/desktop/src/preload/`,
`apps/desktop/src/shared/ipc.ts`, or `apps/desktop/src/main/services/ipc/registerIpc.ts`
also loads `docs/ARCHITECTURE.md` (§5 IPC contract, §3 Data plane). Keep IPC
contracts, preload types, shared types, and renderer usage in sync — see the
`runtime-backed null services` rule in the `/quality` skill's
`references/ade-review-rules.md` for the bug class this guards against.

## Linux desktop parity

For packaging, release, native dependencies, credentials, process and socket
lifecycle, display, sync/discovery, platform gates, or a Linux dev run, load
`docs/development/linux-support.md` and
`.agents/skills/quality/references/linux-quirks.md`. Use the normal focused tests
and CI; the support doc identifies which scenarios require a real Linux host.
