# Computer-Use Backends

Three supported backend styles. ADE's job is to discover them, report their readiness, and ingest their output. ADE does not wrap or replace the backends themselves.

## Source file map

- `apps/desktop/src/main/services/computerUse/controlPlane.ts` — `buildGhostOsCheck`, `buildCapabilityMatrix`, `selectPreferredBackend`, `buildComputerUseSettingsSnapshot`. Ghost OS detection via `ghost status` / `ghost doctor`.
- `apps/desktop/src/main/services/computerUse/localComputerUse.ts` — `getLocalComputerUseCapabilities`, `getGhostDoctorProcessHealth`, `parseGhostDoctorProcessHealth`. CLI detection (`screencapture`, `open`, `swift`, `osascript`).
- `apps/desktop/src/main/services/computerUse/agentBrowserArtifactAdapter.ts` — `parseAgentBrowserArtifactPayload`, `loadAgentBrowserArtifactPayloadFromFile`. Parses agent-browser output manifests.
- `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` — `getBackendStatus` (emits `ComputerUseBackendStatus`), backend registration, `inferSupportedKindsFromExternalTool`.
## Ghost OS

**Transport:** external CLI. ADE detects `ghost` on `PATH` and reads `ghost status` / `ghost doctor` for readiness.

**Installation flow:**

1. Install the Ghost OS CLI on the Mac (`brew install ghostwright/ghost-os/ghost` or equivalent).
2. Run `ghost setup` — grants accessibility permissions, installs local dependencies.
3. Open ADE Settings > Computer Use.
4. Verify that Ghost OS is ready and capable.

**Readiness detection** (`buildGhostOsCheck`):

- `cliInstalled` — `commandExists("ghost")`.
- `setupState` — derived from `ghost status` output:
  - `"ready"` when `status: ready` matches.
  - `"needs_setup"` when output mentions `ghost setup`, `"run `ghost setup` first"`, `not granted`, or `not configured`.
  - `"unknown"` otherwise.
- `adeConfigured` — true when an ADE CLI entry has `command === "ghost"` and args includes `"ade-cli"`.
- `adeConnected` — true when at least one matching snapshot has `state === "connected"`.
- `processHealth` — from `ghost doctor` output:
  - `"healthy"` when `[ok] Processes:` matches or when 1 or fewer processes reported.
  - `"stale"` when more than one process is reported (stale instances remaining) or `[FAIL] Processes:` matches.
  - `"unknown"` when the pattern isn't matchable.

**Tool scope:** Ghost OS exposes a large perception + interaction tool set (see `proofObserver.ts` `GHOST_ARTIFACT_TOOLS` for the perception subset ADE auto-ingests). All tools run over ADE CLI — ADE calls them via the ADE CLI service.

**Shell-out constraints:**

- `ghost status` times out at 5 seconds.
- `ghost doctor` times out at 10 seconds.
- Both run via `spawnSync` with `encoding: "utf8"`.
- Fails close: any timeout or error leaves `setupState` as `"unknown"` rather than flipping to `"ready"`.

**Proof kinds produced:** primarily `screenshot` (via `ghost_screenshot`, `ghost_annotate`, `ghost_ground`, `ghost_parse_screen`). Inferred via `inferSupportedKindsFromExternalTool` based on tool names and descriptions.

## agent-browser

**Transport:** CLI-native. Not an ADE CLI. Runs externally, produces a manifest or output files, ADE ingests after the fact.

**Installation flow:**

1. Install the `agent-browser` CLI locally.
2. Confirm in Settings > Computer Use that the CLI is detected (`commandExists("agent-browser")`).
3. Run agent-browser externally.
4. Ingest its manifests or output files into ADE via the broker.

**Payload parser** (`agentBrowserArtifactAdapter.ts`):

`parseAgentBrowserArtifactPayload(payload)` accepts either an array of entries or an object with recognized fields:

- `artifacts: []` — explicit array of entries (`{ kind, title, description, path, uri, text, json, mimeType, rawType, metadata }`).
- Direct mappings:
  - `screenshotPath` / `imagePath` -> `screenshot`.
  - `videoPath` -> `video_recording`.
  - `tracePath` -> `browser_trace`.
  - `consoleLogsPath` / `consoleLogPath` -> `console_logs`.
  - `verificationPath` -> `browser_verification`.
- Direct text mappings:
  - `consoleLogs` / `consoleLog` -> `console_logs` (inline text).
  - `verificationText` -> `browser_verification` (inline text).

`loadAgentBrowserArtifactPayloadFromFile(filePath)` is the convenience wrapper — reads JSON and parses.

**Kind inference fallback:**

- `normalizeInputKind` reads the explicit `kind`, then `rawType`, then `title`.
- If nothing matches, `input.text` present implies `console_logs`; otherwise defaults to `browser_verification`.

**Allowed-source enforcement:** When ingesting agent-browser artifacts by path, the path must resolve within one of the allowed roots (`.ade/artifacts`, `.ade/tmp`, `os.tmpdir()`, `~/.agent-browser`). Paths outside these roots are rejected.

## ADE local (fallback-only)

**Purpose:** Compatibility support when no approved external backend satisfies the required proof kind and the scope allows local fallback.

**Platform:** macOS only. On non-macOS, `getLocalComputerUseCapabilities` returns `overallState: "blocked_by_capability"` and all capability entries are blocked with `DARWIN_BLOCKED_DETAIL`.

**Capability detection** (`localComputerUse.ts`):

| Capability | Command | Purpose |
| --- | --- | --- |
| screenshot | `screencapture` | macOS built-in, required for screenshots. |
| videoRecording | `screencapture -v` | macOS built-in, records screen video. |
| appLaunch | `open` | macOS built-in, launches and focuses apps. |
| guiInteraction | `swift` (preferred) or `osascript` | Native click automation (Swift) or AppleScript fallback. |
| environmentInfo | `osascript` | AppleScript inspection of frontmost app. |

`getLocalComputerUseCapabilities()` returns a `LocalComputerUseCapabilities` snapshot with per-kind `proofRequirements`:

- `screenshot` -> screenshot capability.
- `browser_verification` -> screenshot + guiInteraction.
- `browser_trace` -> screenshot-backed evidence.
- `video_recording` -> videoRecording capability.
- `console_logs` -> environmentInfo (AppleScript).

`overallState` is derived: `present` if all capabilities are present; `blocked_by_capability` if any are blocked; else `missing`.

**Fallback policy:** ADE local is used only when `policy.allowLocalFallback === true` and no approved external backend is available for the required kind. Policy evaluation happens at dispatch time, not at capability detection time.

## Backend status surface

`ComputerUseBackendStatus` (emitted by the broker's `getBackendStatus`):

- `backends: ComputerUseExternalBackendStatus[]` — one per registered external backend. Fields: `name`, `style`, `available`, `state` (`"connected"` | `"disconnected"` | `"reconnecting"` | `"failed"` | `"installed"`), `detail`, `supportedKinds`, `policyTouchpoints`.
- `localFallback: { supportedKinds: ComputerUseArtifactKind[], state: LocalComputerUseCapabilityState, detail: string }`.

`buildCapabilityMatrix(status)` produces the matrix the Settings UI renders — one row per proof kind, with which external backends can satisfy it and whether local fallback is available.

## Preferred backend selection

`selectPreferredBackend(status)` returns the first available backend. Can be overridden by `ComputerUsePolicy.preferredBackend`.

Selection precedence during a run (`buildComputerUseOwnerSnapshot`):

1. If an artifact has been ingested for the scope, the latest artifact's backend wins (source: `"artifact"`).
2. Else if the policy pins a preferred backend, use it (source: `"policy"`).
3. Else the first available backend (source: `"available"`).
4. Else `null` (no active backend; fallback or block depending on policy).

## Adding a new backend

To register a new external backend:

1. Add it to the ADE CLI list (if ADE CLI) or define a CLI-detection check.
2. Extend `buildComputerUseSettingsSnapshot` or the broker's backend enumeration to include it.
3. Register supported proof kinds — via explicit declaration or by letting `inferSupportedKindsFromExternalTool` match from the tool descriptions.
4. Update `proofObserver.ts` if the backend's tool names should be auto-observed.
5. Add the backend's output root to the broker's `allowedImportRoots` if it writes files outside existing trusted locations.
6. Document the setup flow in Settings > Computer Use guidance.

## Gotchas

- **Ghost OS CLI timeouts matter.** A hung `ghost` binary will throttle readiness detection. Keep the 5s / 10s timeouts tight.
- **`ghost doctor` output format is not stable API.** The `GHOST_DOCTOR_PROCESS_REGEX` parses human-readable output. Ghost OS updates can change this.
- **agent-browser is not ADE CLI.** Don't treat its tool invocations as ADE CLI calls; the only integration path is payload ingestion.
- **Local fallback is macOS-only.** Other platforms return `blocked_by_capability` across the board. Don't add placeholder Linux/Windows branches — the control plane treats them as blocked.
- **`swift` vs `osascript`.** The guiInteraction capability prefers Swift if available. AppleScript is the fallback. Both are optional — if neither is present the capability is missing.
- **Allowed-roots enforcement applies to all path-based ingestion.** Paths from agent-browser must live under `~/.agent-browser` (or the other trusted roots); otherwise `isAllowedExternalArtifactSource` rejects them.

## Cross-links

- `README.md` — control-plane role and proof kinds.
- `artifact-broker.md` — how ingested artifacts are stored and routed.
- `settings-and-readiness.md` — the Settings surface.
