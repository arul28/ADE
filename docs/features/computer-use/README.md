# Computer Use

ADE has two intentionally separate computer-use responsibilities:

1. **Provider execution wiring.** On macOS, opted-in Codex sessions receive the signed standalone Codex Computer Use client as the canonical `computer_use` MCP server. This works in native Work chats and tracked Codex CLI sessions, including resume/fork paths.
2. **Proof ingestion.** Any agent can intentionally register a screenshot, video, trace, verification output, or console log. ADE stores it, links it to an owner (chat, lane, PR, Linear issue), and renders the collected set in chat.

Execution does not imply proof. ADE never passively promotes every Computer Use tool result into a durable artifact.

On Windows, the macOS Codex Computer Use client and native OS capture/control
remain unavailable and report `blocked_by_capability`. This does not disable
the platform-neutral surfaces: App Control can launch and drive developer-owned
Electron apps through CDP, and proof-file ingestion continues to accept
intentional screenshots, videos, traces, and logs. The renderer hides the
macOS-native Attention Notch and iOS Simulator controls rather than presenting
actions that cannot succeed.

The previous proof control-plane model — policy modes (`off`/`auto`/`enabled`), readiness gates, per-phase evidence requirements, a passive proof observer — is gone. The proof side is now a thin broker backed by canonical artifact and owner-link tables; direct Codex execution is the provider-native MCP path described below.

See [`../proof.md`](../proof.md) for the user-facing CLI surface (`ade proof capture` / `attach` / `list`) and the chat collection UI contract.

## Runtime ownership

The artifact broker is owned by the ADE runtime that owns the project. Ingest, link, list, delete, broken-record audit/prune/recovery, review compatibility updates, backend status, and event emission all happen inside `ade serve` for that project. Artifacts live under that runtime's `.ade/artifacts/computer-use/` directory:

- **Local runtime:** artifacts on the user's machine, under the local project root.
- **Remote runtime:** artifacts on the remote host, under the remote project root. The desktop renderer reads image previews through `computerUse.readArtifactPreview` over the same SSH-tunneled JSON-RPC that backs the rest of the remote project surface. Videos stream instead, from main's loopback media server (see Renderer below): the renderer plays `<base>/remote/<targetId>/<projectId>/<path>`, and main answers each Range request with bounded `computer_use_artifacts.readArtifactRange` reads (at most 2 MiB each, CTO role only) from that machine's broker, which resolves the path inside its own `.ade/artifacts`. A host too old to answer falls back to the 10 MiB data URL. Raw artifact bytes are not synced back to the desktop machine.

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
- `proofFingerprint.ts` — the attach judge the broker calls on each input. It hashes files (SHA-256 plus byte size), finds earlier proof with the same bytes (`ProofDuplicateError`, code `PROOF_DUPLICATE`), and flags a video made before the owning chat's turn. It downgrades an ADE capture to an attach when the bytes no longer match the captured hash.
- `mediaCreationTime.ts` — reads `creation_time` from an MP4 or QuickTime `moov/mvhd` box. It walks box headers only, so it never loads the whole file.
- `artifactMediaServer.ts` — the token-guarded `127.0.0.1` HTTP server that plays proof videos with Range support. See Renderer below.
- `artifactStreamProtocol.ts` — shared by every path that serves proof bytes: the `ade-artifact://` handler, the media server, and the broker's preview and range reads. It holds the MIME table, the Range parse, and the one containment check for local files.
- `artifactByteRange.ts` — one bounded slice of a proof file (at most 2 MiB), for `readArtifactRange`.

Shared modules:

- `apps/desktop/src/shared/proofProvenance.ts` — `proofSource` values, the metadata keys only the broker may write, `PROOF_DUPLICATE_CODE`, and the one-line provenance text each proof surface prints.
- `apps/desktop/src/shared/artifactStreamUrl.ts` — builds and parses the `ade-artifact://project/…` image URLs and the media server's `/project/…` and `/remote/…` video URLs.
- `apps/desktop/src/shared/pathCase.ts` — node-free path case rule (`foldsCase`), shared by the proof URLs and `pathContainment.ts`.
- `apps/ade-cli/src/services/proof/adeCaptureRegistry.ts` — the RPC server's registry of files that its capture actions wrote, by path and hash. An ingest is filed as ADE's capture only when each input matches an entry. Each match is one-shot.

### Direct Codex Computer Use

- `apps/desktop/src/main/utils/codexComputerUse.ts` — resolves the standalone `SkyComputerUseClient`, requires explicit user opt-in, verifies its strict macOS code signature plus OpenAI team/bundle identifiers, and returns the MCP launch config.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — merges the resolved `computer_use` server into every Codex `thread/start` and `thread/resume` config and handles MCP tool/source events plus elicitation requests.
- `apps/desktop/src/shared/cliLaunch.ts` — emits the equivalent `-c mcp_servers.computer_use.*` flags for tracked Codex CLI start/resume commands. `agentChatCliLaunch.ts`, `ptyService.ts`, and `externalSessionsService.ts` resolve the config at each launch/resume so a newly installed or disabled plugin is respected.

Computer-use services that used to exist and are deliberately gone (do not re-add):

- `proofObserver.ts` — the passive observer that auto-ingested screenshots from `tool_result` events. Captures are always intentional: a bare `screenshot_environment` writes to the project's cache/tmp scratch root (`createComputerUseScratchPath` in `localComputerUse.ts`), which the broker already allows as an import root, and only a proof-named call creates a drawer record.
- Ghost OS status shelling (`ghost status` / `ghost doctor` probes). The broker no longer shells out to external backend binaries.

### IPC and runtime RPC

Channel constants live under `ade.computerUse.*` in `shared/ipc.ts`. The preload namespace is `window.ade.computerUse`:

- `ade.computerUse.listArtifacts`
- `ade.computerUse.getOwnerSnapshot`
- `ade.computerUse.deleteArtifacts`
- `ade.computerUse.listBrokenArtifacts`
- `ade.computerUse.pruneBrokenArtifacts`
- `ade.computerUse.recoverArtifact`
- `ade.computerUse.updateArtifactReview`
- `ade.computerUse.readArtifactPreview`
- `ade.computerUse.mediaBaseUrl` — main only. It returns the loopback media server's base URL, or null. It does not go to the runtime.
- `ade.computerUse.event` (push)

Each channel except `mediaBaseUrl` routes renderer → preload → ADE runtime → broker. For local projects the preload bridge talks to the local `ade serve`; for remote projects it tunnels the same JSON-RPC payload over the SSH connection in `apps/desktop/src/main/services/remoteRuntime/runtimeRpcClient.ts`. The broker on the receiving runtime executes the action and emits `ade.computerUse.event` back along the same channel.

The `ade-cli` headless surface registers the same broker and exposes the equivalent JSON-RPC tools (`screenshot_environment`, `record_environment`, `ingest_computer_use_artifacts`, `list_computer_use_artifacts`, `delete_computer_use_artifacts`, `list_broken_computer_use_artifacts`, `prune_broken_computer_use_artifacts`, `recover_computer_use_artifact`) via `apps/ade-cli/src/adeRpcServer.ts`, so a chat agent's `ade proof capture` and the desktop renderer's transcript/drawer collections go through the same broker instance.

### Capture is not proof

Computer use and proof are separate acts. Capturing the screen is something an
agent does to see; filing a proof-drawer record is something it does on purpose,
for a reviewer. Only an explicit proof call writes a record:

- **`captureScreenshot`** (formerly in
  `apps/desktop/src/main/services/ai/tools/workflowTools.ts`) is not a callable
  tool and never was: that module exported names, not implementations, and no
  tool registry ever received one. It never touched the broker, and the module
  itself has now been deleted. Agents use `ade proof capture --caption "…"` for
  reviewer-facing proof.
- **`screenshot_environment` / `record_environment`** take a `proof` flag. It is
  false by default, and `ade proof capture` / `ade proof record` are what set it
  true. A bare call — an agent looking at the screen, or an automation run using
  the `browser` tool family allow-list in
  `apps/desktop/src/main/services/automations/automationService.ts` — writes the
  capture to `.ade/cache/tmp/computer-use/` and returns its path. Explicit
  `ownerKind`/`ownerId` are resolved only on the `proof: true` branch, because a
  scratch capture has no ownership to authorize.
- **`ade browser record start|stop`** follows the same explicit-proof rule. The
  built-in browser records the tab itself (hidden ADE page + `getDisplayMedia` +
  `MediaRecorder`, MP4 where available, WebM otherwise) and always returns the
  scratch file path. It reaches the proof drawer as a `video_recording` artifact
  **only** when `record start` was given a `--caption`, mirroring
  `ade browser proof`; without one, nothing is ingested.
- **Proof must be new bytes.** The broker hashes every stored proof file and
  refuses an attach whose bytes are already proof (`PROOF_DUPLICATE`), reads an
  attached MP4/MOV's `mvhd` creation time to flag a video recorded before the
  chat's turn, and stamps `metadata.proofSource` on every record. ADE's
  in-process recorders and captures pass `provenance` on the ingest request and
  skip both checks. A CLI capture counts as ADE's only when the RPC server's
  capture registry still holds the file with the same hash. See [Already-filed bytes and older videos](../proof.md#already-filed-bytes-and-older-videos).
- **Browser use is visible to the human, automatically.** Every
  capability-validated `ade browser …` command marks the calling chat as using
  the browser, so a globe appears on its session card and chat header, the
  Browser tool's tab gets a live dot, and the phone and TUI say the same thing.
  Nothing is asked of the agent — there is no "announce it" instruction to
  follow or forget — and the mark expires about twenty seconds after the last
  command (held while a tab is recording, cleared when the tab closes or a login
  handoff passes it to a person). See
  [An agent is using the browser](../chat/README.md#an-agent-is-using-the-browser).
- **The `computer_use_artifacts` action domain** exposes reads and record
  lifecycle (list, delete, broken/prune/recover, review, preview, owner
  snapshot, backend status) but **not** `ingest`. It used to be a spread of the
  whole broker, which let `ade actions call computer_use_artifacts.ingest` reach
  ingestion without `validateComputerUseOwnerClaims` or the authorized
  caller-root resolution that guard the `ingest_computer_use_artifacts` tool.

Scratch captures are recoverable: `.ade/cache/tmp` and the OS temp root are both
allowed broker import roots, so `ade proof attach <path> --caption "…"` promotes
any of them later.

### Renderer

- `apps/desktop/src/renderer/components/chat/ChatComputerUsePanel.tsx` — shared
  proof card, in-app lightbox, full drawer, availability/error states, and
  irreversible delete action for the active chat session. Local images,
  including project-relative and in-project absolute uris, use the
  `ade-artifact://project/` protocol. Every video, local or remote, plays from
  main's loopback media server
  (`apps/desktop/src/main/services/computerUse/artifactMediaServer.ts`):
  Electron's `protocol.handle` cannot answer the second Range read a `<video>`
  makes when an MP4 keeps its index at the end, so a long recording cannot
  load through it. The server listens on `127.0.0.1` on an OS-picked port, starts
  on the first `computerUse.mediaBaseUrl` call, and every path begins with a
  random per-launch token: `http://127.0.0.1:<port>/<token>/project/<path>` for
  this computer and `…/<token>/remote/<targetId>/<projectId>/<path>` for a
  paired one (`shared/artifactStreamUrl.ts` builds and parses both). An
  absolute uri maps only when it sits under the project root; a drive-letter
  or UNC root compares without case, a POSIX root exactly. A local
  path must resolve inside the project's `.ade/artifacts`, the same check the
  `ade-artifact://` handler makes; a remote one is read chunk by chunk from
  that machine's broker, which applies the check on its side. Remote images
  use `computerUse.readArtifactPreview`.
  A failed preview names its cause when known (the machine is offline, it sent
  nothing, or the bytes did not play). Neither path falls back to Finder.
- `apps/desktop/src/renderer/components/chat/useArtifactPreview.ts` — resolves
  one artifact's preview source (protocol URL, media server URL, or bounded
  runtime read) and the failure cause (`offline`, `unsent`, `unplayable`).
- `apps/desktop/src/renderer/lib/playableMedia.ts` — relabels a
  `video/quicktime` source as `video/mp4` where a video plays, because Chromium
  refuses the QuickTime type for the same bytes. Stored metadata keeps the true
  type.
- `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`,
  `chatCardPrimitives.tsx` — bucket artifacts by capture time into the completed
  turn that produced them and render the collapsed inline filmstrip.
- `apps/desktop/src/renderer/lib/computerUse.ts` — renderer helpers that call `window.ade.computerUse.*`.

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
7. Emit `artifact-ingested` / `artifact-linked` payloads on `ade.computerUse.event`.

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

App Control also carries the same agent action model as the built-in browser: `ade app-control observe` returns a screenshot plus a bounded element list with stable `obs-…:e:N` handles, and `click` / `hover` / `fill` / `clear` / `type` / `press` / `scroll` / `wait` act on those handles and answer with a post-action observation and a per-session action trace. `ade app-control proof` registers an observation as a proof artifact under the `ade-app-control` backend. Sessions carry a `driver` (`cdp` today; `computer_use` is typed and capability-gated but not implemented).

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
