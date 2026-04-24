# Computer Use

ADE does not run computer-use itself. Agents drive computer use through whatever tool they already have — Claude's `computer_use`, Codex shell, a scripted browser, a headless Playwright run. ADE's only job is to **ingest** the resulting artifact (screenshot, video, trace, verification output, console log), link it to an owner (chat, mission, lane, PR, Linear issue), and render it in the review drawer.

The previous control-plane model — policy modes (`off`/`auto`/`enabled`), readiness gates, per-phase evidence requirements, a passive proof observer — is gone. What remains is a thin broker backed by a single table.

See [`../proof.md`](../proof.md) for the user-facing CLI surface (`ade proof capture` / `attach` / `list`) and the drawer UI contract.

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

### IPC

Channel constants live under `ade.proof.*` (renamed from the old `ade.computerUse.*`):

- `ade.proof.listArtifacts`
- `ade.proof.getOwnerSnapshot`
- `ade.proof.routeArtifact`
- `ade.proof.updateArtifactReview`
- `ade.proof.readArtifactPreview`
- `ade.proof.event` (push)

### Renderer

- `apps/desktop/src/renderer/components/chat/ChatComputerUsePanel.tsx` — proof drawer mounted under the chat composer. Shows the `ComputerUseOwnerSnapshot` scoped to the active chat session.
- `apps/desktop/src/renderer/components/missions/MissionComputerUsePanel.tsx` and `MissionProofPanel.tsx` — mission-detail Proof tab.
- `apps/desktop/src/renderer/lib/computerUse.ts`, `renderer/lib/proof.ts` — renderer helpers that call `window.ade.proof.*`.

`ComputerUseSection.tsx` (Settings > Computer Use) was removed in this rebuild; its readiness display was folded into `IntegrationsSettingsSection`.

## Canonical record

`ComputerUseArtifactRecord` in `computer_use_artifacts`:

- `id`, `artifact_kind`, `backend_style`, `backend_name`, `source_tool_name`, `original_type`, `title`, `description`, `uri`, `storage_kind`, `mime_type`, `metadata_json`, `created_at`.

`ComputerUseArtifactLink` in `computer_use_artifact_links`:

- `id`, `artifact_id`, `owner_kind`, `owner_id`, `relation`, `metadata_json`, `created_at`.

Owner kinds: `lane`, `mission`, `orchestrator_run`, `orchestrator_step`, `orchestrator_attempt`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`.

One artifact can link to multiple owners — evidence flows from an exploratory chat to a mission artifact to a PR comment without losing provenance.

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
- Per-phase `evidenceRequirements` math and the mission preflight coverage/readiness gate.
- Settings > Computer Use panel.
- Ghost OS-specific readiness probes (`ghost status` / `ghost doctor` shelling and regex parsing).
- MCP tool delivery for computer use.

## Cross-links

- [`../proof.md`](../proof.md) — `ade proof` CLI and the drawer UI contract.
- [`../missions/README.md`](../missions/README.md) — mission detail renders the Proof tab from the same broker.
- [`../cto/linear-integration.md`](../cto/linear-integration.md) — Linear closeout can attach broker-managed artifacts as proof.
- [`../automations/README.md`](../automations/README.md) — automations that dispatch agent work rely on the agent's own `ade proof` calls; no automation-level proof policy exists.

## Detail docs

The three detail docs in this folder describe the pre-rebuild control plane (Ghost OS readiness probe, policy matrix, phase-based coverage). They are retained for historical context but do not reflect the current shipping system.

- [`backends.md`](./backends.md) — pre-rebuild backend catalog.
- [`artifact-broker.md`](./artifact-broker.md) — pre-rebuild broker model, including the passive observer.
- [`settings-and-readiness.md`](./settings-and-readiness.md) — pre-rebuild Settings > Computer Use panel.
