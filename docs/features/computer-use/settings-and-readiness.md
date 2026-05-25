# Settings and Readiness

This doc describes the pre-rebuild `Settings > Computer Use` panel and its policy/readiness model. That panel was removed with the proof rebuild; readiness now appears inside the broader `IntegrationsSettingsSection`, and `ComputerUsePolicy` (with its `off`/`auto`/`enabled` modes, `allowLocalFallback`, etc.) is gone. Use this doc for historical context on what the matrix used to express.

The active broker still runs inside the runtime daemon that owns the project (`computerUseArtifactBrokerService.getBackendStatus` reflects backends installed on the runtime host's `PATH`).

## Source file map

- `apps/desktop/src/main/services/computerUse/controlPlane.ts` — pre-rebuild `buildComputerUseSettingsSnapshot`, `buildGhostOsCheck`, `buildCapabilityMatrix`, `selectPreferredBackend`, `summarizePolicy`. Only `buildComputerUseOwnerSnapshot` is still wired into the live UI.
- `apps/desktop/src/main/services/computerUse/localComputerUse.ts` — `getLocalComputerUseCapabilities`, `createComputerUseArtifactPath`.
- `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` — `getBackendStatus`.
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — IPC surface; channels live under `ade.proof.*` today (the `computerUse:*` namespace was renamed during the rebuild).
- Renderer Settings surface — `apps/desktop/src/renderer/components/settings/IntegrationsSettingsSection.tsx` (the dedicated `ComputerUsePanel.tsx` was deleted).

## Settings snapshot

`ComputerUseSettingsSnapshot` returned by `buildComputerUseSettingsSnapshot({ status, snapshots })`:

- `backendStatus` — full `ComputerUseBackendStatus` with backends and local fallback.
- `preferredBackend` — result of `selectPreferredBackend(status)`.
- `capabilityMatrix` — one row per proof kind with `externalBackends: string[]` and `localFallbackAvailable: boolean`.
- `ghostOsCheck` — `buildGhostOsCheck` result (see below).
- `guidance` — static strings:
  - `overview`
  - `ghostOs`
  - `agentBrowser`
  - `fallback`

The guidance strings are the single-source-of-truth explainer text. They live in the service, not the renderer, so both desktop and headless surfaces render identical guidance.

## Ghost OS check

`buildGhostOsCheck({ status, snapshots })` returns `GhostOsCheck` with:

- `repoUrl` — `https://github.com/ghostwright/ghost-os` (hardcoded).
- `cliInstalled: boolean` — `commandExists("ghost")`.
- `setupState`:
  - `"not_installed"` — no `ghost` binary.
  - `"needs_setup"` — `ghost status` output indicates setup isn't complete.
  - `"ready"` — `status: ready` matches.
  - `"unknown"` — CLI exists but status output is ambiguous.
- `adeConfigured: boolean` — whether an ADE CLI entry with `command === "ghost"` + `args` including `"ade-cli"` exists.
- `adeConnected: boolean` — whether any matching ADE CLI snapshot has `state === "connected"`.
- `summary: string` — one-line human summary.
- `details: string[]` — multi-line actionable details.
- `processHealth: GhostDoctorProcessHealth` — from `getGhostDoctorProcessHealth`:
  - `state`: `"healthy"` | `"stale"` | `"unknown"`.
  - `processCount: number | null`.
  - `detail: string`.

Process health detection shells out to `ghost doctor` (10s timeout) and parses output via `parseGhostDoctorProcessHealth`. Patterns:

- `GHOST_DOCTOR_PROCESS_REGEX` — `/(\d+)\s+ghost ADE CLI process(?:es)?\s+found/i` for explicit counts.
- `[FAIL] Processes:` -> stale (failure signaled).
- `[ok] Processes:` -> healthy (no explicit count but success signaled).
- Otherwise -> unknown.

Stale processes indicate leftover `ghost ade-cli` instances from earlier sessions — operators should stop them and rerun `ghost doctor` before using Ghost OS.

## Capability matrix

`buildCapabilityMatrix(status)` returns one row per proof kind:

```
[
  { kind: "screenshot", externalBackends: ["Ghost OS"], localFallbackAvailable: true },
  { kind: "video_recording", externalBackends: [], localFallbackAvailable: true },
  { kind: "browser_trace", externalBackends: ["agent-browser"], localFallbackAvailable: true },
  { kind: "browser_verification", externalBackends: ["Ghost OS"], localFallbackAvailable: true },
  { kind: "console_logs", externalBackends: ["agent-browser"], localFallbackAvailable: true },
]
```

Each row lists which registered external backends declared support (via `supportedKinds`) and whether local fallback is available for that kind. The UI renders this as a matrix so operators can see at a glance which backends satisfy which proof kinds.

## Policy surface

`ComputerUsePolicy` is edited in two places:

1. **Global default** — Settings > Computer Use. Controls the project-wide default policy.
2. **Per-scope override** — chat header (for chat session scope), lane metadata (for lane scope).

Fields:

- `mode: "off" | "auto" | "enabled"`.
- `allowLocalFallback: boolean`.
- `retainProof: boolean`.
- `preferredBackend: string | null`.

`summarizePolicy(policy)` generates the human-readable statement displayed in the UI. The renderer should always render this summary, not re-derive it — keeping the text in the service centralizes policy wording.

`createDefaultComputerUsePolicy(partial)` fills in missing fields:

- `mode: "auto"` default.
- `allowLocalFallback: true` default.
- `retainProof: true` default.
- `preferredBackend: null` default.

## Readiness check flow

The Settings renderer calls `window.ade.computerUse.getSettings()` which runs:

1. `broker.getBackendStatus()` — synthesizes current external backend states from the ADE CLI registry + capability detection for CLI backends + local fallback capabilities.
2. `buildComputerUseSettingsSnapshot({ status, snapshots })` — wraps the status with guidance and the Ghost OS check.
3. Returns the snapshot over IPC.

Ghost OS detection shells out to `ghost status` (5s timeout) and `ghost doctor` (10s timeout) — the UI shows a loading state while this runs. A cold detection pass can take a few seconds on a fresh Mac; subsequent passes are fast.

## Chat session readiness

In a chat session, the header shows the policy toggle and summary:

- `CU Off` — `mode === "off"`.
- `CU Auto` — `mode === "auto"`.
- `CU On` — `mode === "enabled"`.
- `Fallback` — `allowLocalFallback === true`.
- `Proof` — `retainProof === true`.

The inline monitor renders `buildComputerUseOwnerSnapshot({ broker, owner: { kind: "chat_session", id }, policy })` for live backend / activity / artifact status.

## Setup flows

### Ghost OS (from Settings > Computer Use)

1. UI shows `setupState` — `not_installed`, `needs_setup`, `ready`, or `unknown`.
2. If not installed: link to the Ghost OS repo + CLI install instructions.
3. If needs setup: instruction to run `ghost setup` in a terminal.
4. If ready but not configured in ADE: instruction to add the Ghost OS server in ADE CLI (`command: "ghost"`, `args: ["ade-cli"]`).
5. If ready + configured + not connected: "Reconnect the Ghost OS ADE CLI entry in ADE".
6. If ready + connected: green state.
7. If process health is stale: "Stop the stale `ghost ade-cli` processes, then rerun `ghost doctor`".

### agent-browser (from Settings > Computer Use)

1. UI reports `commandExists("agent-browser")`.
2. If missing: link to install instructions.
3. If present: green state. Reminder that agent-browser runs externally and ADE ingests its output via the broker.

### ADE local fallback

1. `getLocalComputerUseCapabilities()` runs CLI detection for `screencapture`, `open`, `swift`, `osascript`.
2. UI shows per-capability state and per-proof-kind availability.
3. On non-macOS: the panel shows `"blocked_by_capability"` and explains the macOS-only limitation.

## Operator actions

From Settings:

- Toggle global computer-use policy.
- Pin a preferred backend.
- Allow or disallow local fallback.
- Enable or disable proof retention.
- Open the ADE CLI settings to add / configure / reconnect Ghost OS.
- Open the broker's artifact review surface.

## Gotchas

- **Readiness detection is synchronous via spawnSync.** A hung external binary throttles the settings load. Timeouts are 5s for `ghost status`, 10s for `ghost doctor`.
- **Ghost OS detection needs both CLI presence and ADE CLI configuration.** Installing the CLI without configuring ADE CLI leaves ADE showing `"ready"` without `adeConnected`. The details list surfaces the right next step.
- **`GHOST_DOCTOR_PROCESS_REGEX` is format-sensitive.** Ghost OS CLI updates that change output wording break detection silently — add tests when updating the regex.
- **Platform fallback is binary.** macOS fallback is fully supported; non-macOS fallback is fully blocked. There is no "partial" state for Linux/Windows.
- **Preferred backend is not enforced as a hard constraint.** If the preferred backend becomes unavailable, snapshots fall through to the first available backend. This is by design — proof still gets captured — but the UI should always show the current active backend so operators see the drift.
- **Policy mode `"off"` does not delete existing artifacts.** Switching to off stops new capture but retained proof stays. Use `retainProof: false` + explicit purge to drop evidence.

## Cross-links

- `README.md` — control-plane overview.
- `backends.md` — detection internals for Ghost OS, agent-browser, ADE local.
- `artifact-broker.md` — ingestion, storage, review, publication.
- `../cto/README.md` — CTO operator tool surface includes computer-use artifact actions.
