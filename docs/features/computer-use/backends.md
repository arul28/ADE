# Computer-Use Backends

The current active provider integration is **Codex Computer Use**: ADE securely resolves OpenAI's standalone signed client and presents it to Codex as an MCP server. Proof capture remains a separate broker workflow.

The later sections describe the historical Ghost OS / agent-browser / local-fallback model. The current shipping broker (`computerUseArtifactBrokerService.getBackendStatus`) reports the same proof-backend names, but the policy + readiness machinery (`buildComputerUseSettingsSnapshot`, `buildGhostOsCheck`, capability matrix) was retired with the proof rebuild and the Settings > Computer Use panel was folded into Integrations. Use those sections for context on proof-backend semantics, not for the current operator UI.

## Source file map

- `apps/desktop/src/main/services/computerUse/controlPlane.ts` — pre-rebuild `buildComputerUseOwnerSnapshot` + capability/Ghost-OS helpers. The current build keeps the snapshot assembly path; the policy/Ghost-OS readiness helpers are vestigial.
- `apps/desktop/src/main/services/computerUse/localComputerUse.ts` — `getLocalComputerUseCapabilities`, `createComputerUseArtifactPath`, `toProjectArtifactUri`. Capability detection (`screencapture`, `open`, `swift`, `osascript`) reflects the runtime host's environment.
- `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` — `getBackendStatus` (emits `ComputerUseBackendStatus`), `secureCopyFromDescriptor` (symlink-safe path-based ingest), backend enumeration.
- `apps/desktop/src/main/utils/codexComputerUse.ts` — current direct Codex client resolver and signature/opt-in boundary.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — injects the MCP config into app-server threads and maps Computer Use MCP calls/elicitations into chat events.
- `apps/desktop/src/shared/cliLaunch.ts` — injects the same MCP server into tracked Codex CLI start/resume argv.

## Codex Computer Use (current)

**Transport:** provider-native MCP server named `computer_use`, exposed to the model as `mcp__computer_use`.

ADE enables this path only on macOS and only when the user's Codex config has one of these explicit opt-ins:

- `[plugins."computer-use@openai-bundled"]` with `enabled = true`; or
- `[mcp_servers.computer_use]` unless that section explicitly sets `enabled = false`.

`resolveCodexComputerUseMcpConfig()` searches the stable install under
`$CODEX_HOME/computer-use/` first, then version-sorted bundled plugin-cache
directories. A candidate must be executable and pass both
`codesign --verify --strict` and identity checks for OpenAI team `2DC432GLL2` and client bundle
identifier `com.openai.sky.CUAService.cli`. ADE never executes an arbitrary
same-named cache binary.

The standalone helper is important: starting Computer Use through a generic
`node_repl`/host wrapper makes the operating-system entitlement depend on the
host process. ADE instead launches the OpenAI-signed helper directly, preserving
the Computer Use entitlement when Codex runs inside ADE.

Native Work chats merge the config into the app-server `thread/start` and
`thread/resume` config alongside the selected reasoning effort. Existing user
MCP servers remain configured; ADE supplies only the canonical `computer_use`
entry. Tracked Codex CLI sessions receive the equivalent `-c` overrides on
initial launch, resume, imported-session resume, and fork. The resolver runs at
those boundaries rather than persisting an executable path in chat state.

Computer Use follows normal MCP consent. `mcpServer/elicitation/request` becomes
an ADE pending-input card with Allow once / Deny and, only when the server's
`_meta.persist` permits it, Always allow. URL-mode requests can open the
authorization link in ADE's built-in browser. Full-auto chat permissions do not
silently approve a per-app elicitation.

## Historical proof backends

The remaining sections document the retired readiness/policy model.

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

**Tool scope:** Ghost OS exposes a large perception + interaction tool set. The pre-rebuild `proofObserver` auto-ingested a curated `GHOST_ARTIFACT_TOOLS` subset on tool-result events; the observer has been deleted, so today an agent capturing Ghost OS evidence must call `ade proof capture/attach` (or the broker's `ingest_computer_use_artifacts` RPC tool) to file it.

**Shell-out constraints:**

- `ghost status` times out at 5 seconds.
- `ghost doctor` times out at 10 seconds.
- Both run via `spawnSync` with `encoding: "utf8"`.
- Fails close: any timeout or error leaves `setupState` as `"unknown"` rather than flipping to `"ready"`.

**Proof kinds produced:** primarily `screenshot` (via `ghost_screenshot`, `ghost_annotate`, `ghost_ground`, `ghost_parse_screen`). Inferred via `inferSupportedKindsFromExternalTool` based on tool names and descriptions.

## agent-browser

**Transport:** external CLI. It runs outside ADE and produces output files;
ADE ingests only the explicit paths the caller supplies through
`ade proof attach` or `ingest_computer_use_artifacts.inputs`.

The retired manifest adapter and its backend-specific field aliases were
deleted. ADE no longer interprets an arbitrary agent-browser JSON payload or
accepts `manifestPath`; the caller names each proof input using the canonical
`ComputerUseArtifactInput` shape.

**Kind inference fallback:**

- `normalizeInputKind` reads the explicit `kind`, then `rawType`, then `title`.
- If nothing matches, `input.text` present implies `console_logs`; otherwise defaults to `browser_verification`.

**Allowed-source enforcement:** When ingesting agent-browser artifacts by path,
the path must resolve within a broker-approved root (including
`~/.agent-browser`, project/lane/cache/temp roots, or a narrowly injected
browser-observation root), must not resolve under `.ade/secrets`, and must have
an allow-listed evidence extension. The broker securely copies it into the
artifact store before persisting the row.

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
4. (Pre-rebuild only.) The historical `proofObserver` auto-ingested specific tool names; since the observer was deleted, new backends ingest exclusively through explicit `ade proof attach` / `ingest_computer_use_artifacts` calls.
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
