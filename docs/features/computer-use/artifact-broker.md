# Computer-Use Artifact Broker

The broker is the normalization layer after external computer-use execution has happened. External tools perform the actual clicks, keystrokes, and captures. The broker ingests their output, stores it canonically, links it to owners (missions, chats, PRs, Linear issues), and tracks review and publication state.

## Source file map

- `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` — the service. `createComputerUseArtifactBrokerService(args)` is the entry point. ~2000 LOC.
- `apps/desktop/src/main/services/computerUse/proofObserver.ts` — passive observer that auto-ingests artifacts from chat tool results.
- `apps/desktop/src/main/services/computerUse/agentBrowserArtifactAdapter.ts` — payload parser for agent-browser output.
- `apps/desktop/src/main/services/computerUse/localComputerUse.ts` — storage helpers (`createComputerUseArtifactPath`, `toProjectArtifactUri`).
- `apps/desktop/src/shared/types/computerUseArtifacts.ts` (via `shared/types`) — `ComputerUseArtifactRecord`, `ComputerUseArtifactLink`, `ComputerUseArtifactInput`, `ComputerUseArtifactOwner`, `ComputerUseArtifactReviewState`, `ComputerUseArtifactWorkflowState`, `ComputerUseEventPayload`.
- `apps/desktop/src/shared/proofArtifacts.ts` — `normalizeComputerUseArtifactKind`, `resolveReportArtifactKind`.
- `docs/architecture/COMPUTER_USE_ARTIFACT_BROKER.md` — the architectural boundary document.

## Canonical record model

### `computer_use_artifacts`

Stored as `StoredArtifactRow`:

- `id` — UUID.
- `artifact_kind` — one of `screenshot`, `video_recording`, `browser_trace`, `browser_verification`, `console_logs`.
- `backend_style` — `ade-cli` | `cli` | `local`.
- `backend_name` — human-readable backend name (e.g. `"Ghost OS"`, `"agent-browser"`, `"ADE local"`).
- `source_tool_name` — the tool or command that produced the artifact (e.g. `"ghost_screenshot"`, `"screenshotPath"`).
- `original_type` — original kind hint from the source (for traceability).
- `title`, `description`.
- `uri` — storage URI: project-relative artifact path, `http(s)://` URL for remote artifacts, or raw external path for unresolved files.
- `storage_kind` — `file` | `url`.
- `mime_type` — optional.
- `metadata_json` — backend-specific extras.
- `created_at` — ISO timestamp.

### `computer_use_artifact_links`

Stored as `StoredLinkRow`:

- `id` — UUID.
- `artifact_id` — FK to the artifact.
- `owner_kind` — one of `lane`, `mission`, `orchestrator_run`, `orchestrator_step`, `orchestrator_attempt`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`.
- `owner_id` — the owner's id.
- `relation` — default `attached_to`; can also be `produced_by`, `referenced_by`, `published_to`, etc.
- `metadata_json` — per-link metadata.
- `created_at`.

A single artifact can have multiple links — evidence that starts in a chat can attach to a mission, then to a PR, then to a Linear issue without being duplicated.

## Ingestion pipeline

### Input shape

`ComputerUseArtifactInput`:

- `kind` — explicit kind or null to infer.
- `title`, `description` — optional metadata.
- `path` — local file path.
- `uri` — alternate URI (http/https, file:// ok).
- `text` — inline text (for console logs, verifications).
- `json` — inline JSON (serialized to file at ingestion).
- `mimeType` — optional.
- `rawType` — backend-specific type hint used by `normalizeComputerUseArtifactKind`.
- `metadata` — arbitrary per-input metadata.

### Ingestion flow (`ingestArtifacts`)

1. **Dedupe owners** via `dedupeOwners` — unique by `kind:id:relation`.
2. For each input:
   - **Normalize kind** via `normalizeInputKind` (reads `kind`, `rawType`, `title`; defaults to `console_logs` when text is present, else `browser_verification`).
   - **Resolve storage URI** via `resolveStoredUri`:
     - `http(s)://` URI -> stored as-is, `storage_kind: "url"`.
     - Path within `layout.artifactsDir` -> already in the artifacts dir, stored as a project artifact URI.
     - Path outside artifacts dir but within `allowedImportRoots` -> copy via `secureCopyFromDescriptor` to a fresh artifact path (`createComputerUseArtifactPath`), stored as file URI.
     - Path outside all allowed roots -> throw "Artifact path is outside allowed import roots".
     - No path/uri, only `text` or `json` -> materialize inline content via `materializeInlineContent` (writes atomically via `writeTextAtomic`), stored as file URI.
3. **Insert the canonical record** via `insertArtifactRecord`.
4. **Insert links** for each unique owner via `insertLink`.
5. **Emit event** via `onEvent` callback so renderer surfaces refresh.

### Allowed import roots

Fixed set, constructed in the broker factory:

```
layout.artifactsDir      // .ade/artifacts
layout.tmpDir            // .ade/tmp
os.tmpdir()              // OS temp dir
~/.agent-browser         // agent-browser output dir
```

This list is the trust boundary for external ingestion. Adding a new root requires a code change. `isAllowedExternalArtifactSource(absolutePath, roots)` enforces this using `resolvePathWithinRoot` per root.

### Secure copy

`secureCopyFromDescriptor(sourcePath, targetPath)` uses:

- `O_RDONLY | O_NOFOLLOW` on the source to prevent symlink tricks.
- `O_WRONLY | O_CREAT | O_TRUNC` on a temp file with `sourceStat.mode & 0o777` permissions.
- 64KB chunked copy loop with explicit positional reads.
- `fsyncSync` before closing.
- Atomic `renameSync` from temp to target.
- Best-effort cleanup of the temp file on failure.

This is the symlink-safe copy path. Do not replace with plain `copyFileSync` — symlinks outside `allowedImportRoots` could otherwise escape the trust boundary.

### Inline materialization

`materializeInlineContent(input, kind, title)` writes `input.text` or `JSON.stringify(input.json)` to a fresh file:

- Path from `createComputerUseArtifactPath(projectRoot, title, extension)`.
- Extension from `inferArtifactExtension` (reads path/URI extension, or falls back to kind-default: `png` for screenshot, `mp4` for video, `zip` for trace, `log` for console_logs, `txt` default).
- Atomic write via `writeTextAtomic`.

## Owners

`ComputerUseArtifactOwner`:

```
{
  kind: "lane" | "mission" | "orchestrator_run" | "orchestrator_step" | "orchestrator_attempt" | "chat_session" | "automation_run" | "github_pr" | "linear_issue",
  id: string,
  relation?: "attached_to" | "produced_by" | "referenced_by" | "published_to" | ...,
  metadata?: Record<string, unknown>
}
```

Owner precedence for snapshots (`usageEventMatchesOwner`):

- `chat_session` — matches usage events with `chatSessionId` or `callerId` matching the id.
- `mission` — matches events with `missionId`.
- `orchestrator_run` — matches events with `runId`.
- `orchestrator_step` — matches events with `stepId`.
- `orchestrator_attempt` — matches events with `attemptId`.

## Review state

`ComputerUseArtifactReviewState` values: `pending`, `accepted`, `needs_more`, `dismissed`, `published`. Default is `pending`.

`reviewArtifact(args)` updates state and records the decision. Review decisions are persisted alongside the artifact for audit.

`ComputerUseArtifactWorkflowState` values: `evidence_only`, `awaiting_publication`, `published`, `retained`, `purged`. Default is `evidence_only`. Used to track publication lifecycle separately from review.

## Routing and promotion

`routeArtifact(args)` adds a new link to a different owner — this is the "promote from chat to mission" path. The original link is preserved (to maintain provenance) and a new link is added with an appropriate `relation`.

Example promotion flow:

```
chat_session:abc (relation: attached_to)
  -> mission:xyz (relation: produced_by)
  -> github_pr:123 (relation: published_to)
  -> linear_issue:LIN-456 (relation: published_to)
```

All links remain in `computer_use_artifact_links`; the artifact record itself is unchanged.

## Projection into legacy artifact plumbing

The broker projects broker-managed artifacts into older mission/orchestrator artifact plumbing where compatibility still matters (mission artifact lists, orchestrator artifact queries). `missionService` and `orchestratorService` read from the broker and expose broker artifacts under the normal artifact surface so UI that hasn't migrated yet still sees proof evidence.

## Event emission

`onEvent(payload: ComputerUseEventPayload)` fires after every successful ingestion, review, or routing change. Renderer surfaces subscribe to this stream to refresh the proof drawer, mission run view, or Settings readiness snapshot without polling.

## Snapshots

`buildComputerUseOwnerSnapshot(args)` in `controlPlane.ts`:

- Calls `broker.listArtifacts({ owner, limit })`.
- Computes `presentKinds` (kinds actually ingested for this scope).
- Computes `missingKinds` (required kinds not yet present).
- Finds the active backend via latest artifact -> policy pref -> first available.
- Emits a list of `ComputerUseActivityItem` entries for the UI via `buildActivity`:
  - Usage events (`backend_tool_used`).
  - Backend state events (`backend_connected`, `backend_unavailable`, `backend_available`).
  - Artifact ingestion events (`artifact_ingested`).
  - Missing proof events (`proof_missing`).
- Sorted newest first, limited to 8.

## Publishing

Artifacts flow into downstream workflow surfaces:

- **Mission closeout** — broker artifacts attach to the result lane closeout record.
- **Lane history** — linked lane surfaces the artifact in the lane timeline.
- **Chat history** — linked chat session surfaces the artifact in the thread.
- **GitHub PR workflows** — linked PR gets a comment with the artifact reference (when published).
- **Linear closeout** — linked Linear issue gets a comment + optional state transition.
- **Automations history** — linked automation run shows the artifact in the run log.

Publication paths call `routeArtifact` or `reviewArtifact` depending on the transition — publication always preserves the original link for provenance.

## Invariants

- **One canonical artifact per captured moment.** Re-ingesting an identical source path should not create a duplicate record — the caller is expected to dedupe via content hashing before calling the broker. The broker does not hash-dedupe automatically.
- **Links are additive.** Owners are appended, not replaced. Revoking an ownership is a soft-delete via metadata, not a row removal.
- **`secureCopyFromDescriptor` is the only path-based ingestion path.** Adding a new path-based ingestor requires using this helper.
- **Storage URIs point into the project or are `http(s)` URLs.** Never persist raw external absolute paths as a storage URI — the broker resolves them to project-relative paths at ingestion time.

## Gotchas

- **Empty inputs are silently skipped.** `pushInput` in `agentBrowserArtifactAdapter` rejects inputs with no path/uri/text/json — this means a malformed payload produces zero artifacts with no error. Validate upstream.
- **`materializeInlineContent` respects JSON vs text.** Passing both `text` and `json` writes the JSON (text is ignored). Don't rely on the ordering for mixed payloads; pick one.
- **`toProjectArtifactUri` produces project-relative URIs.** When rendering artifacts in a UI component, resolve these against the current project root — hard-coding a prefix will break with different projects.
- **`inferArtifactExtension` reads only the file path/URI extension.** MIME-type-based inference is not attempted; set `mimeType` explicitly if the extension is wrong.
- **Reviewer decisions can change the workflow state.** A `published` review state usually implies `workflowState: "published"`, but the broker does not enforce the correlation — check both fields when deciding whether to re-publish.
- **Event emission is best-effort.** `onEvent` callbacks that throw are swallowed. Do not rely on the event bus for ACID transitions — read back from the broker instead.

## Cross-links

- `README.md` — control-plane role, proof kinds, backend overview.
- `backends.md` — Ghost OS, agent-browser, ADE local detection and capabilities.
- `settings-and-readiness.md` — Settings > Computer Use surface.
- `../missions/README.md` — mission preflight and run monitoring consume broker snapshots.
- `../cto/linear-integration.md` — Linear closeout attaches broker artifacts via routing.
