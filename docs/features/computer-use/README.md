# Computer Use

ADE has two intentionally separate computer-use responsibilities:

1. **Provider execution wiring.** On macOS, opted-in Codex sessions receive the signed standalone Codex Computer Use client as the canonical `computer_use` MCP server. This works in native Work chats and tracked Codex CLI sessions, including resume/fork paths.
2. **Proof ingestion.** Any agent can intentionally register a screenshot, video, trace, verification output, or console log. ADE stores it, links it to an owner (chat, lane, PR, Linear issue), and renders the collected set in chat.

Execution does not imply proof. ADE never passively promotes every Computer Use tool result into a durable artifact.

The previous proof control-plane model — policy modes (`off`/`auto`/`enabled`), readiness gates, per-phase evidence requirements, a passive proof observer — is gone. The proof side is now a thin broker backed by canonical artifact and owner-link tables; direct Codex execution is the provider-native MCP path described below.

See [`../proof.md`](../proof.md) for the user-facing CLI surface (`ade proof capture` / `attach` / `list`) and the chat collection UI contract.

## Runtime ownership

The artifact broker is owned by the ADE runtime that owns the project. Ingest, link, list, delete, broken-record audit/prune/recovery, review compatibility updates, backend status, and event emission all happen inside `ade serve` for that project. Artifacts live under that runtime's `.ade/artifacts/computer-use/` directory:

- **Local runtime:** artifacts on the user's machine, under the local project root.
- **Remote runtime:** artifacts on the remote host, under the remote project root. The desktop renderer reads previews through `ade.proof.readArtifactPreview` over the same SSH-tunneled JSON-RPC that backs the rest of the remote project surface; raw artifact bytes are not synced back to the desktop machine.

The desktop renderer is a viewer: it lists collected proof and displays
runtime-fetched previews inline in the chat and in the drawer. It does not own
storage or expose artifact review-state controls. The headless ADE CLI (`ade
proof capture` / `attach` / `list`) writes through the same broker via JSON-RPC,
so a CLI invocation from a Mac targeting a remote runtime stores artifacts on
the remote host.

## Source file map

### Services (apps/desktop/src/main/services/computerUse/)

- `computerUseArtifactBrokerService.ts` — the broker. Canonical storage for `computer_use_artifacts` + `computer_use_artifact_links`. Ingestion (`ingest`), listing (`listArtifacts`), deletion (`deleteArtifacts`, `deleteArtifactsForLane`, `pruneBrokenArtifacts`, `purgeArtifactRecordsUnder`), recovery (`recoverArtifact`), broken-record reporting (`listBrokenArtifacts`), compatibility review-state management (`updateArtifactReview`), backend status (`getBackendStatus`), and bounded preview reads (`readArtifactPreview`, 10 MiB maximum). Image previews cover BMP/GIF/JPEG/PNG/SVG/WebP; video previews cover M4V/MOV/MP4/OGV/WebM. Uses `secureCopyFromDescriptor` (O_NOFOLLOW + atomic rename) for on-disk ingests and materializes inline text/JSON content via `createComputerUseArtifactPath` + `writeTextAtomic`.
- `controlPlane.ts` — builds `ComputerUseOwnerSnapshot` (owner-scoped artifacts, latest active backend, summary, and artifact-derived activity) over the broker. It does not synthesize timestamped readiness activity.
- `localComputerUse.ts` — macOS-only capability descriptor (`LocalComputerUseCapabilities`). Reports whether `screencapture`, app launch, and GUI-interaction commands are available. `createComputerUseArtifactPath` + `toProjectArtifactUri` round out the storage helpers.

### Direct Codex Computer Use

- `apps/desktop/src/main/utils/codexComputerUse.ts` — resolves the standalone `SkyComputerUseClient`, requires explicit user opt-in, verifies its strict macOS code signature plus OpenAI team/bundle identifiers, and returns the MCP launch config.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — merges the resolved `computer_use` server into every Codex `thread/start` and `thread/resume` config and handles MCP tool/source events plus elicitation requests.
- `apps/desktop/src/shared/cliLaunch.ts` — emits the equivalent `-c mcp_servers.computer_use.*` flags for tracked Codex CLI start/resume commands. `agentChatCliLaunch.ts`, `ptyService.ts`, and `externalSessionsService.ts` resolve the config at each launch/resume so a newly installed or disabled plugin is respected.

Computer-use services that used to exist and were deleted on this branch:

- `proofObserver.ts` — the passive observer that auto-ingested screenshots from `tool_result` events. Captures are always intentional now.
- Ghost OS status shelling (`ghost status` / `ghost doctor` probes). The broker no longer shells out to external backend binaries.

### IPC and runtime RPC

Channel constants live under `ade.proof.*` (renamed from the old `ade.computerUse.*`):

- `ade.proof.listArtifacts`
- `ade.proof.getOwnerSnapshot`
- `ade.proof.deleteArtifacts`
- `ade.proof.listBrokenArtifacts`
- `ade.proof.pruneBrokenArtifacts`
- `ade.proof.recoverArtifact`
- `ade.proof.updateArtifactReview`
- `ade.proof.readArtifactPreview`
- `ade.proof.event` (push)

Each channel routes renderer → preload → ADE runtime → broker. For local projects the preload bridge talks to the local `ade serve`; for remote projects it tunnels the same JSON-RPC payload over the SSH connection in `apps/desktop/src/main/services/remoteRuntime/runtimeRpcClient.ts`. The broker on the receiving runtime executes the action and emits `ade.proof.event` back along the same channel.

The `ade-cli` headless surface registers the same broker and exposes the equivalent JSON-RPC tools (`screenshot_environment`, `record_environment`, `ingest_computer_use_artifacts`, `list_computer_use_artifacts`, `delete_computer_use_artifacts`, `list_broken_computer_use_artifacts`, `prune_broken_computer_use_artifacts`, `recover_computer_use_artifact`) via `apps/ade-cli/src/adeRpcServer.ts`, so a chat agent's `ade proof capture` and the desktop renderer's transcript/drawer collections go through the same broker instance.

### Renderer

- `apps/desktop/src/renderer/components/chat/ChatComputerUsePanel.tsx` — shared
  proof card, in-app lightbox, full drawer, availability/error states, and
  irreversible delete action for the active chat session. Local files use ADE's
  range-capable artifact protocol; remote files use
  `ade.proof.readArtifactPreview`. Neither path falls back to Finder.
- `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`,
  `chatCardPrimitives.tsx` — bucket artifacts by capture time into the completed
  turn that produced them and render the collapsed inline filmstrip.
- `apps/desktop/src/renderer/lib/computerUse.ts`, `renderer/lib/proof.ts` — renderer helpers that call `window.ade.proof.*`.

`ComputerUseSection.tsx` (Settings > Computer Use) was removed in this rebuild; its readiness display was folded into `IntegrationsSettingsSection`.

## Canonical record

`ComputerUseArtifactRecord` in `computer_use_artifacts`:

- `id`, `artifact_kind`, `backend_style`, `backend_name`, `source_tool_name`, `original_type`, `title`, `description`, `uri`, `storage_kind`, `mime_type`, `metadata_json`, optional `lane_id`, `created_at`.

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

`computerUseArtifactBrokerService.ingest({ inputs, owners, backend, callerRoot? })`:

1. Dedupe owners by `kind:id:relation`.
2. Resolve every input before writing any row. Relative paths try the caller's
   lane-worktree root before the project root; a missing or invalid member
   rejects the whole batch.
3. Materialize inline content via `createComputerUseArtifactPath` + `writeTextAtomic`.
4. For on-disk sources, realpath-check the allow/deny roots, enforce the
   evidence-extension allow-list, and copy into the project artifacts dir via
   `secureCopyFromDescriptor` (`O_NOFOLLOW` + atomic rename).
5. Resolve optional `lane_id` from a lane owner or owning chat.
6. Insert the canonical record + all owner links.
7. Emit `artifact-ingested` / `artifact-linked` payloads on `ade.proof.event`.

Allowed import roots (the trust boundary for external file paths):

```
layout.artifactsDir      // .ade/artifacts
layout.cacheDir          // .ade/cache
layout.tmpDir            // .ade/tmp
layout.worktreesDir      // managed lane worktrees
projectRoot              // captures written beside project source
os.tmpdir()              // OS temp
~/.agent-browser         // agent-browser's output dir
```

Runtime-owned callers can add explicit trusted roots; `.ade/secrets` is always
denied. Project-local `.env`, database, key, and certificate files remain
rejected by the extension gate even though `projectRoot` is allowed.

`ComputerUseArtifactView.availability` is `available`, `missing_file`, or
`unimported` (optional for older hosts). Broken records can be listed, pruned,
or recovered through the typed CLI/action surface. Deletion removes records and
only files that resolve inside the artifact jail. Destructive lane deletion
removes lane-attributed proof unless another lane's chat owns it; archive does
not. Settings proof cleanup and project-local-data reset remove matching rows
with the bytes.

## What the rebuild removed

- `proofObserver.ts` and its test.
- `ComputerUsePolicy` (`off`/`auto`/`enabled`, `allowLocalFallback`, `retainProof`, `preferredBackend`) — and the helpers `createDefaultComputerUsePolicy`, `normalizeComputerUsePolicy`, `isComputerUseModeEnabled`, `summarizePolicy`.
- Per-phase `evidenceRequirements` math and preflight coverage/readiness gates.
- Settings > Computer Use panel.
- Ghost OS-specific readiness probes (`ghost status` / `ghost doctor` shelling and regex parsing).
- The old ADE-defined universal computer-use tool delivery. Codex now uses its provider-native MCP client instead.

## App Control bridge

Alongside the proof broker, ADE exposes a separate **App Control** capability for driving developer-owned Electron apps from a chat. Unlike the proof broker, App Control actively launches and inspects an app over Chrome DevTools Protocol; it then feeds screenshot + DOM context back into the chat as `AppControlContextItem`s. App Control is intentionally a bridge — Playwright, agent-browser, browser-use, or Claude's `computer_use` may also attach to the same app — but ADE keeps the launch/session state and turns snapshots into chat context.

See [`app-control.md`](./app-control.md) for the full surface (service, IPC, renderer panel, ADE CLI commands).

## Cross-links

- [`../proof.md`](../proof.md) — `ade proof` CLI and the drawer UI contract.
- [`../automations/README.md`](../automations/README.md) — automations that dispatch agent work rely on the agent's own `ade proof` calls; no automation-level proof policy exists.

## Detail docs

- [`app-control.md`](./app-control.md) — current App Control bridge for Electron apps (CDP launch/connect, snapshot, click/type, source matching, ADE CLI `app-control` and `terminal` surfaces).

The backend doc begins with the current direct Codex integration, then retains the pre-rebuild Ghost OS / local-fallback catalog for historical context. The settings/readiness doc is historical.

- [`backends.md`](./backends.md) — direct Codex Computer Use execution plus the historical proof-backend catalog.
- [`artifact-broker.md`](./artifact-broker.md) — current broker, storage, and ownership model, with the retired passive observer called out for context.
- [`settings-and-readiness.md`](./settings-and-readiness.md) — pre-rebuild Settings > Computer Use panel.
