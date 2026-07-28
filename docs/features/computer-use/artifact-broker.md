# Computer-Use Artifact Broker

The broker is the normalization layer after external computer-use execution has happened. External tools perform the actual clicks, keystrokes, and captures. The broker ingests their output, stores it canonically, links it to owners (runs, chats, PRs, Linear issues), reports whether the stored bytes still exist, and owns deletion/recovery.

The broker runs inside the ADE runtime (`ade serve`) that owns the project. Artifacts are written to that runtime machine's `.ade/artifacts/computer-use/` directory; database rows live in that runtime's `.ade/ade.db`. Renderer reads/writes flow through `window.ade.proof.*` → preload → runtime JSON-RPC → broker; the desktop main process is no longer the owner of this state.

## Source file map

- `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` — the service. `createComputerUseArtifactBrokerService(args)` is the entry point. Loaded by both the ADE runtime's project scope and the desktop's local-project services. `readArtifactPreview` serves only files inside the artifact root, caps data-URL responses at 10 MiB, and recognizes common image plus M4V/MOV/MP4/OGV/WebM video extensions.
- `apps/desktop/src/main/services/computerUse/localComputerUse.ts` — storage helpers (`createComputerUseArtifactPath`, `toProjectArtifactUri`).
- `apps/desktop/src/shared/types/computerUseArtifacts.ts` (via `shared/types`) — artifact/link/input/owner records plus availability, delete, broken-record, recovery, and event contracts.
- `apps/desktop/src/shared/proofArtifacts.ts` — `normalizeComputerUseArtifactKind`, `resolveReportArtifactKind`.

The passive `proofObserver.ts` was deleted with the rebuild; nothing watches tool results to auto-ingest captures any more. Captures are intentional: an agent or operator runs `ade proof capture/attach` (or the corresponding RPC tool) and the broker ingests once.

## Canonical record model

### `computer_use_artifacts`

Stored as `StoredArtifactRow`:

- `id` — UUID.
- `artifact_kind` — one of `screenshot`, `video_recording`, `browser_trace`, `browser_verification`, `console_logs`.
- `backend_style` — `external_cli` | `manual` | `local_fallback`.
- `backend_name` — human-readable backend name (e.g. `"Ghost OS"`, `"agent-browser"`, `"ADE local"`).
- `source_tool_name` — the tool or command that produced the artifact (e.g. `"ghost_screenshot"`, `"screenshotPath"`).
- `original_type` — original kind hint from the source (for traceability).
- `title`, `description`.
- `uri` — project-relative artifact URI or `http(s)://` URL. New ingestion never persists unresolved external paths.
- `storage_kind` — `file` | `url`.
- `mime_type` — optional.
- `metadata_json` — backend-specific extras.
- `lane_id` — optional lane binding resolved from an explicit lane owner or an owning chat session; used by lane deletion.
- `created_at` — ISO timestamp.

### `computer_use_artifact_links`

Stored as `StoredLinkRow`:

- `id` — UUID.
- `artifact_id` — FK to the artifact.
- `owner_kind` — one of `lane`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`.
- `owner_id` — the owner's id.
- `relation` — `attached_to` (default), `produced_by`, or `published_to`.
- `metadata_json` — per-link metadata.
- `created_at`.

A single artifact can have multiple links — evidence that starts in a chat can attach to a PR, then to a Linear issue without being duplicated.

## Ingestion pipeline

### Input shape

`ComputerUseArtifactInput`:

- `kind` — explicit kind or null to infer.
- `title`, `description` — optional metadata.
- `path` — local file path.
- `uri` — alternate HTTP(S) URI, or a path-like value handled like `path`.
- `text` — inline text (for console logs, verifications).
- `json` — inline JSON (serialized to file at ingestion).
- `mimeType` — optional.
- `rawType` — backend-specific type hint used by `normalizeComputerUseArtifactKind`.
- `metadata` — arbitrary per-input metadata.

### Ingestion flow (`ingest`)

1. **Dedupe owners** via `dedupeOwners` — unique by `kind:id:relation`.
2. **Resolve every input before inserting any row.** Any invalid member rejects
   the whole batch, so retrying cannot duplicate a prefix that committed before
   a later input failed.
3. For each input:
   - **Normalize kind** via `normalizeInputKind` (reads `kind`, `rawType`, `title`; defaults to `console_logs` when text is present, else `browser_verification`).
   - **Resolve storage URI** via `resolveStoredUri`:
     - `http(s)://` URI -> stored as-is, `storage_kind: "url"`.
     - Relative paths -> try the explicit caller/lane-worktree root, then the project root.
     - Path within `layout.artifactsDir` -> already in the artifacts dir, stored as a project artifact URI.
     - Path outside artifacts dir but within `allowedImportRoots` -> copy via `secureCopyFromDescriptor` to a fresh artifact path (`createComputerUseArtifactPath`), stored as file URI.
     - Missing paths, denied roots, and non-evidence extensions -> throw without creating a record.
     - Path outside all allowed roots -> throw "Artifact path is outside allowed import roots".
     - No path/uri, only `text` or `json` -> materialize inline content via `materializeInlineContent` (writes atomically via `writeTextAtomic`), stored as file URI.
4. **Insert the canonical record** via `insertArtifactRecord`.
5. **Insert links** for each unique owner via `insertLink`.
6. **Emit event** via `onEvent` callback so renderer surfaces refresh.

### Allowed import roots

Fixed set, constructed in the broker factory:

```
layout.artifactsDir      // .ade/artifacts
layout.cacheDir          // .ade/cache
layout.tmpDir            // .ade/tmp
layout.worktreesDir      // managed lane worktrees
projectRoot              // captures written beside project source
os.tmpdir()              // OS temp dir
~/.agent-browser         // agent-browser output dir
```

Runtime callers may add an explicit trusted import root (for example the
machine-local browser observation root). `.ade/secrets` is always denied.
Allow- and deny-root checks compare real paths, and the file itself must have an
allow-listed image/video/trace/log extension; this prevents a project-local
`.env`, database, key, or certificate from being promoted into proof merely
because the project root is allowed.

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
  kind: "lane" | "chat_session" | "automation_run" | "github_pr" | "linear_issue",
  id: string,
  relation?: "attached_to" | "produced_by" | "published_to",
  metadata?: Record<string, unknown>
}
```

Owner precedence for snapshots (`usageEventMatchesOwner`):

- `chat_session` — matches usage events with `chatSessionId` or `callerId` matching the id.

## Review state

`ComputerUseArtifactReviewState` values: `pending`, `accepted`, `needs_more`, `dismissed`. Newly ingested proof defaults to `accepted`; the field remains for compatibility with operator tooling rather than a chat approval step.

`updateArtifactReview(args)` updates state and records the decision. Review decisions are persisted alongside the artifact for compatibility.

These fields remain in the broker contract for compatibility with downstream
automation and publishing integrations. The chat transcript, proof drawer, and
iOS artifact surfaces do not render review/workflow controls; to users, proof is
only the collected artifact set.

`ComputerUseArtifactWorkflowState` values: `evidence_only`, `promoted`, `published`, `dismissed`. Default is `evidence_only`.

## Routing and promotion

**Removed.** `routeArtifact` shipped with full IPC + preload + action-domain plumbing and never had a production caller. Re-linking an artifact to a second owner is done by ingesting with the owners you want.

An ingest request can still supply multiple owners up front. There is no later
route/promotion mutation in the shipping product.

## Availability, recovery, and deletion

`listArtifacts()` projects each record to a view with:

- `available` — bytes are readable (or the record is URL-backed).
- `missing_file` — the canonical artifact-store URI exists but the file is gone.
- `unimported` — a historic record points outside the artifact store.

Older hosts can omit availability; clients attempt the preview.
`listBrokenArtifacts()` returns both broken classes and a `recoverablePath` when
the original source survives. `recoverArtifact()` runs that source through the
same realpath, extension, and secure-copy gates as normal ingestion.
`pruneBrokenArtifacts()` deletes broken records that cannot usefully render.

`deleteArtifacts()` is idempotent and removes database rows plus only those
files that resolve inside the artifact-store jail. It reports deleted, missing,
and failed ids plus bytes freed. `deleteArtifactsForLane()` removes captures
owned by a deleted lane but preserves an artifact linked to a chat in another
lane. Lane archive is non-destructive. `deleteAllArtifacts()` supports project
local-data reset, while `purgeArtifactRecordsUnder()` keeps Settings storage
cleanup from deleting bytes without their records.

## Event emission

`onEvent(payload: ComputerUseEventPayload)` fires after successful ingestion,
linking, review, and deletion. Renderer surfaces subscribe to this stream to
refresh the proof drawer without polling. A deletion with no surviving owner
still carries the last known owner when one existed, so owner-scoped subscribers
can invalidate.

## Snapshots

`buildComputerUseOwnerSnapshot(args)` in `controlPlane.ts`:

- Calls `broker.listArtifacts({ owner, limit })`.
- Keeps the newest five as `recentArtifacts`.
- Selects the active backend from the latest artifact, then the first currently
  available backend.
- Builds the owner summary from retained proof or current availability.
- Emits up to eight artifact-derived activity rows using each artifact's real
  timestamp. It does not fabricate "just now" readiness/history entries;
  missing/unimported artifacts become warning activity rows.

## Publishing

Artifacts flow into downstream workflow surfaces:

- **Lane history** — linked lane surfaces the artifact in the lane timeline.
- **Chat history** — linked chat sessions bucket proof by capture time and
  expose a collapsed filmstrip from the producing turn; the drawer keeps the
  complete set.
- **Lane cleanup** — lane-linked or lane-attributed records are removed with a
  destructive lane delete, unless another lane's chat still owns the artifact.

There is no publication path in the shipping product; `updateArtifactReview` exists only for the CTO operator tool.

## Invariants

- **One canonical artifact per captured moment.** Re-ingesting an identical source path should not create a duplicate record — the caller is expected to dedupe via content hashing before calling the broker. The broker does not hash-dedupe automatically.
- **Links are additive during ingest.** The removed routing API cannot append
  owners later; destructive artifact deletion removes the record and its links.
- **`secureCopyFromDescriptor` is the only path-based ingestion path.** Adding a new path-based ingestor requires using this helper.
- **Storage URIs point into the project or are `http(s)` URLs.** Never persist raw external absolute paths as a storage URI — the broker resolves them to project-relative paths at ingestion time.
- **Bytes and rows are one lifecycle.** Lane deletion, project-local-data reset,
  and Settings proof cleanup must remove both.

## Gotchas

- **Missing/invalid path inputs fail loudly.** They do not create dead records,
  and a multi-input request does not partially commit.
- **`materializeInlineContent` respects JSON vs text.** Passing both `text` and `json` writes the JSON (text is ignored). Don't rely on the ordering for mixed payloads; pick one.
- **`toProjectArtifactUri` produces project-relative URIs.** When rendering artifacts in a UI component, resolve these against the current project root — hard-coding a prefix will break with different projects.
- **`inferArtifactExtension` reads only the file path/URI extension.** MIME-type-based inference is not attempted; set `mimeType` explicitly if the extension is wrong.
- **Event emission is best-effort.** `onEvent` callbacks that throw are swallowed. Do not rely on the event bus for ACID transitions — read back from the broker instead.

## Cross-links

- `README.md` — control-plane role, proof kinds, backend overview.
- `backends.md` — Ghost OS, agent-browser, ADE local detection and capabilities.
- `settings-and-readiness.md` — Settings > Computer Use surface.
- `../linear-integration/README.md` — the Linear write surface used when publishing an artifact to a linked issue.
