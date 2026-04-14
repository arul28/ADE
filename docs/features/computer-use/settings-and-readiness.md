# Settings and Readiness

The `Settings > Computer Use` panel is the operator's entry point for configuring and monitoring the computer-use control plane. It shows backend readiness, policy, and a capability matrix mapping proof kinds to backends. Readiness detection runs on demand and is cached in the broker's backend status.

## Source file map

- `apps/desktop/src/main/services/computerUse/controlPlane.ts` — `buildComputerUseSettingsSnapshot`, `buildGhostOsCheck`, `buildCapabilityMatrix`, `selectPreferredBackend`, `summarizePolicy`, `buildComputerUseOwnerSnapshot`.
- `apps/desktop/src/main/services/computerUse/localComputerUse.ts` — `getLocalComputerUseCapabilities`, `getGhostDoctorProcessHealth`, `parseGhostDoctorProcessHealth`.
- `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` — `getBackendStatus`.
- `apps/desktop/src/main/services/externalMcp/externalMcpService.ts` — tracks registered external MCP servers.
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — IPC surface for `computerUse:*` channels.
- Renderer Settings surface — `apps/desktop/src/renderer/components/settings/` (look for `ComputerUsePanel.tsx` or similar).

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
- `adeConfigured: boolean` — whether an external MCP entry with `command === "ghost"` + `args` including `"mcp"` exists.
- `adeConnected: boolean` — whether any matching MCP snapshot has `state === "connected"`.
- `summary: string` — one-line human summary.
- `details: string[]` — multi-line actionable details.
- `processHealth: GhostDoctorProcessHealth` — from `getGhostDoctorProcessHealth`:
  - `state`: `"healthy"` | `"stale"` | `"unknown"`.
  - `processCount: number | null`.
  - `detail: string`.

Process health detection shells out to `ghost doctor` (10s timeout) and parses output via `parseGhostDoctorProcessHealth`. Patterns:

- `GHOST_DOCTOR_PROCESS_REGEX` — `/(\d+)\s+ghost MCP process(?:es)?\s+found/i` for explicit counts.
- `[FAIL] Processes:` -> stale (failure signaled).
- `[ok] Processes:` -> healthy (no explicit count but success signaled).
- Otherwise -> unknown.

Stale processes indicate leftover `ghost mcp` instances from earlier sessions — operators should stop them and rerun `ghost doctor` before using Ghost OS.

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
2. **Per-scope override** — mission settings (for mission scope), chat header (for chat session scope), lane metadata (for lane scope).

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

1. `broker.getBackendStatus()` — synthesizes current external backend states from the external MCP registry + capability detection for CLI backends + local fallback capabilities.
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

## Mission preflight readiness

Mission preflight computes:

- Required proof kinds from `collectRequiredComputerUseKindsFromPhases(phases)` (reads `phase.validationGate.evidenceRequirements` for kinds in `COMPUTER_USE_KINDS`).
- Current `ComputerUsePolicy` (mission metadata > project default).
- Available external backends.
- Gap analysis: which required kinds have no available backend?

Gaps become preflight warnings. If the gap is not satisfiable externally and local fallback is disallowed for the scope, launch is blocked.

## Setup flows

### Ghost OS (from Settings > Computer Use)

1. UI shows `setupState` — `not_installed`, `needs_setup`, `ready`, or `unknown`.
2. If not installed: link to the Ghost OS repo + CLI install instructions.
3. If needs setup: instruction to run `ghost setup` in a terminal.
4. If ready but not configured in ADE: instruction to add the Ghost OS server in External MCP (`command: "ghost"`, `args: ["mcp"]`).
5. If ready + configured + not connected: "Reconnect the Ghost OS MCP entry in ADE".
6. If ready + connected: green state.
7. If process health is stale: "Stop the stale `ghost mcp` processes, then rerun `ghost doctor`".

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
- Open the external MCP settings to add / configure / reconnect Ghost OS.
- Open the broker's artifact review surface.

## Gotchas

- **Readiness detection is synchronous via spawnSync.** A hung external binary throttles the settings load. Timeouts are 5s for `ghost status`, 10s for `ghost doctor`.
- **Ghost OS detection needs both CLI presence and MCP configuration.** Installing the CLI without configuring MCP leaves ADE showing `"ready"` without `adeConnected`. The details list surfaces the right next step.
- **`GHOST_DOCTOR_PROCESS_REGEX` is format-sensitive.** Ghost OS CLI updates that change output wording break detection silently — add tests when updating the regex.
- **Platform fallback is binary.** macOS fallback is fully supported; non-macOS fallback is fully blocked. There is no "partial" state for Linux/Windows.
- **Preferred backend is not enforced as a hard constraint.** If the preferred backend becomes unavailable, snapshots fall through to the first available backend. This is by design — proof still gets captured — but the UI should always show the current active backend so operators see the drift.
- **Policy mode `"off"` does not delete existing artifacts.** Switching to off stops new capture but retained proof stays. Use `retainProof: false` + explicit purge to drop evidence.

## Cross-links

- `README.md` — control-plane overview.
- `backends.md` — detection internals for Ghost OS, agent-browser, ADE local.
- `artifact-broker.md` — ingestion, storage, review, publication.
- `../missions/README.md` — preflight readiness checks consume this surface.
- `../cto/README.md` — CTO operator tool surface includes computer-use artifact actions.
