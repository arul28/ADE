# Computer Use

ADE does not run computer-use itself. Agents drive computer use through whatever tool they already have — Claude's `computer_use`, Codex shell, a scripted browser, a headless Playwright run. ADE's only job is to **ingest** the resulting artifact (screenshot, video, trace, verification output, console log), link it to an owner (chat, lane, PR, Linear issue), and render it in the review drawer.

The previous control-plane model — policy modes (`off`/`auto`/`enabled`), readiness gates, per-phase evidence requirements, a passive proof observer — is gone. What remains is a thin broker backed by a single table.

See [`../proof.md`](../proof.md) for the user-facing CLI surface (`ade proof capture` / `attach` / `list`) and the drawer UI contract.

## Runtime ownership

The artifact broker is owned by the runtime daemon that owns the project. Ingest, link, list, review, route, backend status, and event emission all happen inside `ade serve` for that project. Artifacts live under that runtime's `.ade/artifacts/computer-use/` directory:

- **Local runtime:** artifacts on the user's machine, under the local project root.
- **Remote runtime:** artifacts on the remote host, under the remote project root. The desktop renderer reads previews through `ade.proof.readArtifactPreview` over the same SSH-tunneled JSON-RPC that backs the rest of the remote project surface; raw artifact bytes are not synced back to the desktop machine.

The desktop renderer is a viewer: it edits review state, navigates owners, and displays previews. It does not own storage. The headless ADE CLI (`ade proof capture` / `attach` / `list`) writes through the same broker via JSON-RPC, so a CLI invocation from a Mac targeting a remote runtime stores artifacts on the remote host.

## Source file map

### Services (apps/desktop/src/main/services/computerUse/)

- `computerUseArtifactBrokerService.ts` — the broker. Canonical storage for `computer_use_artifacts` + `computer_use_artifact_links`. Ingestion (`ingestArtifacts`), listing (`listArtifacts`), review-state management (`reviewArtifact`), routing (`routeArtifact`), backend status (`getBackendStatus`). Uses `secureCopyFromDescriptor` (O_NOFOLLOW + atomic rename) for on-disk ingests and materializes inline text/JSON content via `createComputerUseArtifactPath` + `writeTextAtomic`.
- `controlPlane.ts` — builds `ComputerUseOwnerSnapshot` (recent artifacts + activity) and `ComputerUseSettingsSnapshot` (backend readiness, capabilities). Pure assembly layer over the broker.
- `localComputerUse.ts` — macOS-only capability descriptor (`LocalComputerUseCapabilities`). Reports whether `screencapture`, app launch, and GUI-interaction commands are available. `createComputerUseArtifactPath` + `toProjectArtifactUri` round out the storage helpers.
- `agentBrowserArtifactAdapter.ts` — parses agent-browser payload shapes (screenshots, videos, traces, verification, console logs) into `ComputerUseArtifactInput[]`.
- `syntheticToolResult.ts` — produces tool-result stubs during Claude compaction so a previously-executed tool response can be re-surfaced without re-running the tool.

Computer-use services that used to exist and were deleted on this branch:

- `proofObserver.ts` — the passive observer that auto-ingested screenshots from `tool_result` events. Captures are always intentional now.
- Ghost OS status shelling (`ghost status` / `ghost doctor` probes). The broker no longer shells out to external backend binaries.

### IPC and runtime RPC

Channel constants live under `ade.proof.*` (renamed from the old `ade.computerUse.*`):

- `ade.proof.listArtifacts`
- `ade.proof.getOwnerSnapshot`
- `ade.proof.routeArtifact`
- `ade.proof.updateArtifactReview`
- `ade.proof.readArtifactPreview`
- `ade.proof.event` (push)

Each channel routes renderer → preload → runtime daemon → broker. For local projects the preload bridge talks to the local `ade serve`; for remote projects it tunnels the same JSON-RPC payload over the SSH connection in `apps/desktop/src/main/services/remoteRuntime/runtimeRpcClient.ts`. The broker on the receiving runtime executes the action and emits `ade.proof.event` back along the same channel.

The `ade-cli` headless surface registers the same broker and exposes the equivalent JSON-RPC tools (`screenshot_environment`, `record_environment`, `ingest_computer_use_artifacts`, `list_computer_use_artifacts`) via `apps/ade-cli/src/adeRpcServer.ts`, so a chat agent's `ade proof capture` and the desktop renderer's review drawer go through the same broker instance.

### Renderer

- `apps/desktop/src/renderer/components/chat/ChatComputerUsePanel.tsx` — proof drawer mounted under the chat composer. Shows the `ComputerUseOwnerSnapshot` scoped to the active chat session.
- `apps/desktop/src/renderer/lib/computerUse.ts`, `renderer/lib/proof.ts` — renderer helpers that call `window.ade.proof.*`.

`ComputerUseSection.tsx` (Settings > Computer Use) was removed in this rebuild; its readiness display was folded into `IntegrationsSettingsSection`.

## Canonical record

`ComputerUseArtifactRecord` in `computer_use_artifacts`:

- `id`, `artifact_kind`, `backend_style`, `backend_name`, `source_tool_name`, `original_type`, `title`, `description`, `uri`, `storage_kind`, `mime_type`, `metadata_json`, `created_at`.

`ComputerUseArtifactLink` in `computer_use_artifact_links`:

- `id`, `artifact_id`, `owner_kind`, `owner_id`, `relation`, `metadata_json`, `created_at`.

Owner kinds: `lane`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`.

One artifact can link to multiple owners — evidence flows from an exploratory chat to a PR comment without losing provenance.

## Proof kinds

Canonical `ComputerUseArtifactKind` values:

- `screenshot`
- `video_recording`
- `browser_trace`
- `browser_verification`
- `console_logs`

`normalizeComputerUseArtifactKind` (in `shared/proofArtifacts.ts`) maps backend-specific labels into these canonical kinds.

## Ingestion pipeline

`computerUseArtifactBrokerService.ingestArtifacts({ inputs, owners, backend, sourceToolName? })`:

1. Dedupe owners by `kind:id:relation`.
2. For each input, resolve storage: path (validated against the allowed-roots list), remote URI (http(s)), inline text, inline JSON.
3. Materialize inline content via `createComputerUseArtifactPath` + `writeTextAtomic`.
4. For on-disk sources, copy into the project artifacts dir via `secureCopyFromDescriptor` (O_NOFOLLOW + atomic rename to resist symlink tricks).
5. Insert the canonical record + all owner links.
6. Emit a `ComputerUseEventPayload` on `ade.proof.event`.

Allowed import roots (the trust boundary for external file paths):

```
layout.artifactsDir      // .ade/artifacts
layout.tmpDir            // .ade/tmp
os.tmpdir()              // OS temp
~/.agent-browser         // agent-browser's output dir
```

Other paths are rejected.

## What the rebuild removed

- `proofObserver.ts` and its test.
- `ComputerUsePolicy` (`off`/`auto`/`enabled`, `allowLocalFallback`, `retainProof`, `preferredBackend`) — and the helpers `createDefaultComputerUsePolicy`, `normalizeComputerUsePolicy`, `isComputerUseModeEnabled`, `summarizePolicy`.
- Per-phase `evidenceRequirements` math and preflight coverage/readiness gates.
- Settings > Computer Use panel.
- Ghost OS-specific readiness probes (`ghost status` / `ghost doctor` shelling and regex parsing).
- Separate tool delivery for computer use.

## App Control bridge

Alongside the proof broker, ADE exposes a separate **App Control** capability for driving developer-owned Electron apps from a chat. Unlike the proof broker, App Control actively launches and inspects an app over Chrome DevTools Protocol; it then feeds screenshot + DOM context back into the chat as `AppControlContextItem`s. App Control is intentionally a bridge — Playwright, agent-browser, browser-use, or Claude's `computer_use` may also attach to the same app — but ADE keeps the launch/session state and turns snapshots into chat context.

See [`app-control.md`](./app-control.md) for the full surface (service, IPC, renderer panel, ADE CLI commands).

## macOS VM bridge

ADE also exposes a lane-tied **macOS VM** bridge for isolated macOS GUI work.
The VM is reserved for one fresh lane at a time, mounts that lane into the
guest, and can feed screenshot-backed `MacosVmContextItem` payloads through the
ADE CLI or agent tool surface. The bridge lives outside the proof broker for
lifecycle/control, but screenshot and selection tools still register proof
artifacts through the broker when called from `ade proof`-aware surfaces.

`apps/desktop/src/main/services/macosVm/macosVmService.ts` owns the lifecycle.
It uses Lume as the first provider, keeps VM records under
`.ade/cache/macos-vms`, stores managed VNC credentials under `.ade/secrets`, and
mounts either the lane root directly or a sanitized rsync mirror. The mirror is
used whenever the lane root contains `.ade/`; it excludes secrets, ADE runtime
databases, caches, transcripts, generated local history, nested
worktrees, agent state, and `.git`.

Control flows through `ade.macosVm.*` IPC and the `macos_vm` ADE action domain:
`getStatus`, `provision`, `start`, `stop`, `delete`, `getAgentGuide`,
`getSharePolicy`, `focusWindow`, `captureScreenshot`, `selectPoint`, `click`,
`getDisplaySession`, and `typeText`. The desktop surface is the dedicated
`/vm` tab (`MacVmPage.tsx`), with `/macos-vm` retained as a redirect. The tab
creates VM-reserved lanes, enforces the single-VM lease, embeds a noVNC display
when ADE has managed VNC credentials, and exposes diagnostic frame/click/type
controls. `ade --socket macos-vm ...` gives agents the same
status/start/screenshot/select and click/type controls from the CLI. Headless
screenshot capture uses direct VNC first; ADE waits through transient black
framebuffer updates, wakes the display with a pointer move plus a Shift key
tap, and refuses to attach a persistent black frame as review context.

### Source file map

Main process — `apps/desktop/src/main/services/macosVm/`:

- `macosVmService.ts` — lifecycle owner. Lume `pull`/`create`/`run`/`stop`/`delete`
  drivers, sanitized rsync mirror builder,
  noVNC display proxy with idle/max timeouts, RFB framebuffer wake heuristics,
  and the `ade.macosVm.event` push channel.
- `macosVmStores.ts` — atomic JSON store helpers for VM records
  (`records.json`), the global single-VM lease (`lease.json`), and
  VNC credentials under `.ade/secrets`.
- `rfbDirectClient.ts` — minimal direct-VNC client used for headless capture
  and input. Negotiates RFB, waits through transient black framebuffer updates,
  wakes the display with a pointer move + Shift tap, encodes the framebuffer
  as PNG via `encodeRgbaPng`, and exposes `captureVncScreenshot`, `clickVnc`,
  and `typeTextVnc`.
- `credentialsStore.ts` — macOS Keychain-backed store for guest user
  credentials. Shells out to `/usr/bin/security` (no `keytar` dependency),
  scopes entries by `ade-macos-vm-<vmName>` service + `ade-cli` account, and
  enforces a safe username charset so a stored credential cannot redirect SSH
  to a different host. Renderers receive a summary; the password never crosses
  IPC.
- `runtimeBootstrap.ts` — in-guest ade-runtime installer over SSH+SCP.
  Five-phase progress (`ssh-probe`, `write-script`, `scp-script`,
  `run-script`, `verify-marker`); v1 ships a marker-only bootstrap script so
  the UI flow is exercisable end-to-end while the real runtime download lands
  in a follow-up.
- `macosVmRecovery.ts` — standalone CLI cleanup path. Reads the same records,
  lease, and VNC credential files as `macosVmService.ts` and tears down stale
  state when the desktop surface cannot reach them (e.g. after a crash or
  uninstall). Used by `ade-cli` recovery commands.

Renderer — `apps/desktop/src/renderer/components/vm/`:

- `MacVmPage.tsx` — top-level `/vm` route. Owns the noVNC mount via
  `@novnc/novnc`, the single-VM lane lease UI, host/Lume readiness, runtime
  sign-in status, and diagnostic frame/click/type controls. `/macos-vm` is a
  redirect to this route.
- `FirstBootCard.tsx` — six-step macOS first-boot walkthrough (region,
  transfer, sign-in, agree, account, FDA), with inline shell commands and
  copy buttons. Exports `FIRST_BOOT_STEPS`.
- `PhaseStepper.tsx` — phase progress badge stack driven by
  `MacosVmPhaseNumber` and `PhaseStatus` (`complete | active | pending |
  blocked`); rendered above the page body whenever provisioning, install, or
  runtime sign-in is in flight.
- `VmLifecycleMenu.tsx` — overflow menu for restart / wipe / force-stop on a
  running or failed VM.
- `CredentialsPromptDialog.tsx` — modal for capturing and updating the
  Keychain-backed guest credentials used by `credentialsStore`.
- `CurrentVmLaneRow.tsx` — single-line lane lease summary used on the tab and
  in the lanes surface.
- `MacMiniGlyph.tsx` — Mac mini illustration used in empty/coming-soon states.
- `MacVmComingSoon.tsx` (`ProductionMacVmComingSoon`) — production-build
  fallback when the feature is not yet enabled for shipped builds.

`apps/desktop/src/renderer/components/terminals/MacosVmPanel.tsx` and its
test have been removed; the Work sidebar no longer carries a Mac VM tab. The
dedicated `/vm` page is now the only desktop surface for the VM.

Current audit coverage for the tab lives in
[`../../perf/macos-vm-tab-action-inventory.md`](../../perf/macos-vm-tab-action-inventory.md).

## Cross-links

- [`../proof.md`](../proof.md) — `ade proof` CLI and the drawer UI contract.
- [`../cto/linear-integration.md`](../cto/linear-integration.md) — Linear closeout can attach broker-managed artifacts as proof.
- [`../automations/README.md`](../automations/README.md) — automations that dispatch agent work rely on the agent's own `ade proof` calls; no automation-level proof policy exists.

## Detail docs

- [`app-control.md`](./app-control.md) — current App Control bridge for Electron apps (CDP launch/connect, snapshot, click/type, source matching, ADE CLI `app-control` and `terminal` surfaces).

The three remaining detail docs describe the pre-rebuild control plane (Ghost OS readiness probe, policy matrix, phase-based coverage). They are retained for historical context but do not reflect the current shipping system.

- [`backends.md`](./backends.md) — pre-rebuild backend catalog.
- [`artifact-broker.md`](./artifact-broker.md) — pre-rebuild broker model, including the passive observer.
- [`settings-and-readiness.md`](./settings-and-readiness.md) — pre-rebuild Settings > Computer Use panel.
