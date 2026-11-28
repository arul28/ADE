# Computer-Use Artifact Broker

The broker stores proof. Surfaces and tools do the clicking and capturing; the
broker ingests their output, stores it canonically, links it to owners, reports
whether the bytes still exist, and owns deletion and recovery.

It runs inside the DAEX runtime (`daex serve`) that owns the project. Files go
to that machine's `.ade/artifacts/computer-use/`; rows live in its
`.ade/ade.db`. Renderer calls go `window.ade.computerUse.*` → preload → runtime
JSON-RPC → broker. Desktop main owns none of it, except `mediaBaseUrl` for the
loopback video server. A CLI call against a remote runtime stores on that
remote machine.

## Source file map

- `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts`:
  the service (`createComputerUseArtifactBrokerService`). Loaded by the
  runtime's project scope and the desktop's local-project services.
  `readArtifactPreview` serves files inside the artifact root as data URLs up
  to 10 MiB (BMP/GIF/JPEG/PNG/SVG/WebP images, M4V/MOV/MP4/OGV/WebM video).
  `readArtifactRange` serves ≤ 2 MiB slices under the same jail (paired
  desktops streaming video; the phone's sync file action past `readArtifact`'s
  8 MiB cap).
- `apps/desktop/src/main/services/computerUse/proofFingerprint.ts`: duplicate
  and age checks run on each input.
- `apps/desktop/src/main/services/computerUse/localComputerUse.ts`:
  `createComputerUseArtifactPath`, `toProjectArtifactUri`.
- `apps/desktop/src/main/services/computerUse/controlPlane.ts`:
  `buildComputerUseOwnerSnapshot`.
- `apps/desktop/src/shared/types/computerUseArtifacts.ts`: records, links,
  inputs, owners, availability, delete, broken-record, recovery and event
  contracts.
- `apps/desktop/src/shared/proofArtifacts.ts`: `normalizeComputerUseArtifactKind`.
- `apps/ade-cli/src/services/proof/adeCaptureRegistry.ts`: which files DAEX's
  capture actions wrote.

## Gotchas / fragile areas

- **`secureCopyFromDescriptor` is the only path-based ingest.** Source opened
  `O_RDONLY | O_NOFOLLOW`, 64 KB positional copy into a temp file,
  `fsyncSync`, atomic rename, best-effort cleanup. Never replace it with
  `copyFileSync`: a symlink could escape the import roots.
- **All-or-nothing batches.** Every input is resolved before any row is
  written; one bad input rejects the batch, so a retry cannot duplicate a
  committed prefix.
- **Storage URIs are project-relative or `http(s)`.** Never persist a raw
  external path; resolve `toProjectArtifactUri` values against the project root
  when rendering.
- **Bytes and rows are one lifecycle.** Lane deletion, project local-data
  reset and Settings proof cleanup remove both.
- **Duplicates are refused by content.** `proofFingerprint.ts` hashes each
  file; bytes already filed fail with `PROOF_DUPLICATE` unless the ingest
  carries DAEX `provenance`.
- **Events are best-effort.** A throwing `onEvent` listener is swallowed; read
  back from the broker for state.
- **Inline content:** given both `text` and `json`, the JSON is written.
  `inferArtifactExtension` reads only the path/URI extension (falling back to
  a kind default: `png`, `mp4`, `zip`, `log`, `txt`); set `mimeType` when the
  extension is wrong.

## Records

`computer_use_artifacts` (`StoredArtifactRow`): `id`, `artifact_kind`,
`backend_style` (`external_cli` | `manual` | `local_fallback`), `backend_name`
(for example `ade-mac-desktop`, `ade-app-control`), `source_tool_name`,
`original_type`, `title`, `description`, `uri`, `storage_kind` (`file` |
`url`), `mime_type`, `metadata_json`, optional `lane_id` (from a lane owner or
the owning chat; used by lane deletion), `created_at`.

`computer_use_artifact_links` (`StoredLinkRow`): `id`, `artifact_id`,
`owner_kind` (`lane`, `chat_session`, `automation_run`, `github_pr`,
`linear_issue`), `owner_id`, `relation` (`attached_to` default, `produced_by`,
`published_to`), `metadata_json`, `created_at`. One artifact can have many
owners; owners are set at ingest only (there is no later routing call).

Kinds (`ComputerUseArtifactKind`): `screenshot`, `video_recording`,
`browser_trace`, `browser_verification`, `console_logs`.

Review state (`pending`, `accepted`, `needs_more`, `dismissed`; new proof is
`accepted`) and workflow state (`evidence_only` default, `promoted`,
`published`, `dismissed`) stay in the contract for compatibility. No chat,
drawer or iOS surface shows review controls.

## Ingestion (`ingest({ inputs, owners, backend, callerRoot? })`)

Input (`ComputerUseArtifactInput`): `kind` (or null to infer), `title`,
`description`, `path`, `uri`, `text`, `json`, `mimeType`, `rawType`,
`metadata`.

1. Dedupe owners by `kind:id:relation`.
2. For each input, normalize the kind (`kind`, `rawType`, `title`; default
   `console_logs` with text, else `browser_verification`) and resolve storage:
   - `http(s)://` → stored as a URL.
   - Relative path → the caller's lane-worktree root, then the project root.
   - Inside `.ade/artifacts` → stored as a project artifact URI.
   - Inside an allowed import root → fingerprinted and secure-copied to a new
     artifact path.
   - Missing, denied root, non-evidence extension, or outside every root →
     throws, no record.
   - Only `text`/`json` → written atomically (`writeTextAtomic`).
3. Insert the record and its links.
4. Emit `artifact-ingested` / `artifact-linked` on `ade.computerUse.event`.

Allowed import roots:

```
layout.artifactsDir      // .ade/artifacts
layout.cacheDir          // .ade/cache
layout.tmpDir            // .ade/tmp
layout.worktreesDir      // managed lane worktrees
projectRoot              // captures beside project source
os.tmpdir()              // OS temp
/tmp + realpath(/tmp)    // POSIX only (/private/tmp on macOS)
~/.agent-browser         // agent-browser output
```

`resolveTempImportRoots()` builds the temp entries (Windows: `os.tmpdir()`
only). Both `/tmp` and its realpath are listed because the check compares real
paths. Runtime callers may add trusted roots (for example the user-browser
observation root). `.ade/secrets` is always denied, and the extension
allow-list keeps a project's `.env`, database, key or certificate out of proof
even though the project root is allowed.

## Availability, recovery and deletion

`listArtifacts()` gives each view an `availability`: `available` (readable, or
URL-backed), `missing_file` (store URI exists, file gone) or `unimported` (an
old record outside the store). Older hosts omit it; clients try the preview.

- `listBrokenArtifacts()` returns both broken classes with a `recoverablePath`
  when the source survives; `recoverArtifact()` re-runs it through the same
  gates; `pruneBrokenArtifacts()` drops records that cannot render.
- `deleteArtifacts()` is idempotent, removes rows and only files inside the
  artifact jail, and reports deleted, missing, failed and bytes freed.
- `deleteArtifactsForLane()` removes a deleted lane's captures but keeps one
  linked to a chat in another lane. Archive deletes nothing.
- `deleteAllArtifacts()` backs project local-data reset;
  `purgeArtifactRecordsUnder()` keeps Settings storage cleanup from deleting
  bytes without their rows.
- `onEvent` fires after ingest, link, review and delete. A delete with no
  surviving owner still carries the last known owner so owner-scoped
  subscribers refresh.

## Owner snapshots

`buildComputerUseOwnerSnapshot` lists the owner's artifacts, keeps the newest
five, picks the active backend from the latest artifact (else the first
available backend), builds the summary, and emits up to eight activity rows
with real timestamps (missing or unimported artifacts become warnings).

Chats bucket proof by capture time into the turn that produced it ("N proof
filed" opens the drawer narrowed to it).

## Cross-links

- [README.md](README.md): surfaces, capture-vs-proof, serving and the action answer.
- [proof.md](../proof.md): the `daex proof` CLI and drawer.
- [Linear integration](../linear-integration/README.md).
