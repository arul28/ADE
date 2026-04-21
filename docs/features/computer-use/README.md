# Computer Use

ADE is the control plane for computer-use proof, not the primary executor. External backends (Ghost OS, agent-browser, ADE CLI) perform browser and desktop automation. ADE discovers them, shows their readiness, injects the right guidance into sessions, and ingests the resulting artifacts into a canonical record.

This boundary is intentional: ADE does not compete with browser-automation runtimes. It stays external-first and owns the normalization / ownership / review / publication path.

## Source file map

### Services (apps/desktop/src/main/services/computerUse/)

- `controlPlane.ts` — the control-plane surface. `getComputerUseArtifactKinds`, `collectRequiredComputerUseKindsFromPhases`, `buildComputerUseOwnerSnapshot`, `buildComputerUseSettingsSnapshot`, `buildGhostOsCheck`, `buildCapabilityMatrix`, `selectPreferredBackend`, `summarizePolicy`, activity builder.
- `computerUseArtifactBrokerService.ts` — the broker. Canonical storage for `computer_use_artifacts` + `computer_use_artifact_links`. Ingestion, normalization, review-state management, routing, publication. Exposes `ingestArtifacts`, `listArtifacts`, `reviewArtifact`, `routeArtifact`, `getBackendStatus`.
- `localComputerUse.ts` — fallback-only ADE-local capability detection (`LocalComputerUseCapabilities`, `getGhostDoctorProcessHealth`, `parseGhostDoctorProcessHealth`, `createComputerUseArtifactPath`, `toProjectArtifactUri`).
- `agentBrowserArtifactAdapter.ts` — parses agent-browser payload shapes (screenshots, videos, traces, console logs, verification) into `ComputerUseArtifactInput[]`.
- `proofObserver.ts` — passive observer that watches chat `tool_result` events and auto-ingests screenshot/image/video/trace artifacts so they appear in the proof drawer without the agent explicitly calling `ingest_computer_use_artifacts`. Knows Ghost OS perception tools and recognizes embedded file URIs via regex.
- `syntheticToolResult.ts` — builds synthetic tool-result stubs when a backend's output needs to be re-surfaced as a tool response.

### Renderer

- `apps/desktop/src/renderer/components/settings/ComputerUsePanel.tsx` (or similar) — the Settings > Computer Use surface.
- `apps/desktop/src/renderer/components/missions/ComputerUseMonitor.tsx` — live monitor embedded in mission detail.
- `apps/desktop/src/renderer/components/chat/ComputerUseDrawer.tsx` — chat-side drawer for proof review.

### Related architecture docs

- `docs/architecture/COMPUTER_USE_ARTIFACT_BROKER.md` — the broker boundary and proof model (reference material; this docs set synthesizes it).
- `docs/computer-use.md` — higher-level product description.

## Core model

ADE's role split:

| External tools own | ADE owns |
| --- | --- |
| Browser and desktop interaction | Backend discovery and readiness |
| Click, type, focus, wait, navigate | Policy and fallback messaging |
| Native runtime details | Session and mission guidance |
| | Artifact ingestion and normalization |
| | Canonical storage and ownership links |
| | Monitoring surfaces |
| | Review state and routing actions |
| | Publication into mission, lane, chat, PR, Linear, automation surfaces |

## Proof kinds

Canonical `ComputerUseArtifactKind` values (from `shared/types/computerUseArtifacts.ts`):

- `screenshot`
- `video_recording`
- `browser_trace`
- `browser_verification`
- `console_logs`

`normalizeComputerUseArtifactKind` (in `shared/proofArtifacts.ts`) maps backend-specific labels into these canonical kinds. `inferSupportedKindsFromExternalTool(name, description)` heuristically matches ADE CLI tool metadata to kinds.

## Backends

Three backend styles:

| Backend | Transport | ADE role |
| --- | --- | --- |
| Ghost OS | ADE CLI (stdio, command `ghost ade-cli`) | Discover via ADE CLI, ingest tool results into the broker. Requires `ghost setup` + `ghost doctor` healthy state. |
| agent-browser | External CLI (not ADE CLI) | Detect CLI availability; expect external invocation; ingest its output via `agentBrowserArtifactAdapter`. |
| ADE local | Local compatibility runtime | Fallback-only. Used when no approved external backend satisfies a required proof kind and the scope allows local fallback. |

`buildGhostOsCheck` produces `ComputerUseSettingsSnapshot["ghostOsCheck"]` with `setupState` (`not_installed` | `needs_setup` | `ready` | `unknown`), `cliInstalled`, `adeConfigured`, `adeConnected`, `processHealth` (`healthy` | `stale` | `unknown`), a `summary`, and human-readable `details`. It shells out to `ghost status` to determine readiness and runs `ghost doctor` for process-health detection.

`selectPreferredBackend(status)` returns the first available backend. Policy can override via `ComputerUsePolicy.preferredBackend`.

## Artifact record model

`ComputerUseArtifactRecord` shape in `computer_use_artifacts`:

- `id`, `artifact_kind`, `backend_style`, `backend_name`, `source_tool_name`, `original_type`, `title`, `description`, `uri`, `storage_kind`, `mime_type`, `metadata_json`, `created_at`.

`ComputerUseArtifactLink` in `computer_use_artifact_links`:

- `id`, `artifact_id`, `owner_kind`, `owner_id`, `relation`, `metadata_json`, `created_at`.

Owner kinds (`ComputerUseArtifactOwner["kind"]`): `lane`, `mission`, `orchestrator_run`, `orchestrator_step`, `orchestrator_attempt`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`.

A single artifact can link to multiple owners over time — evidence flows from an exploratory chat to a formal mission artifact to a PR comment without losing provenance.

## Ingestion pipeline

`computerUseArtifactBrokerService.ingestArtifacts({ inputs, owners, backend, sourceToolName? })`:

1. Dedupe owners via `dedupeOwners` (unique by `kind:id:relation`).
2. For each input:
   - Normalize the kind via `normalizeInputKind`.
   - Resolve storage: path (validated via `isAllowedExternalArtifactSource` + `resolvePathWithinRoot` against allowed roots), remote URI (http(s)), inline text, inline JSON.
   - Materialize inline content to a file via `materializeInlineContent` (`createComputerUseArtifactPath` + `writeTextAtomic`).
   - For on-disk sources, copy to the project artifacts dir via `secureCopyFromDescriptor` (uses `O_NOFOLLOW` to prevent symlink tricks; atomic rename).
3. Insert the canonical record.
4. Insert links to all owners.
5. Emit a `ComputerUseEventPayload` so renderer surfaces refresh.

Allowed import roots:

```
layout.artifactsDir      // .ade/artifacts
layout.tmpDir            // .ade/tmp
os.tmpdir()              // OS temp
~/.agent-browser         // agent-browser's output dir
```

This list is the trust boundary for external file paths. Other locations are rejected.

## Passive proof observer

`proofObserver.ts` watches chat `tool_result` events and opportunistically ingests artifacts without requiring the agent to call `ingest_computer_use_artifacts` explicitly.

Detection layers:

1. **Known tool names** — `GHOST_ARTIFACT_TOOLS` (set of Ghost OS perception tools: `ghost_screenshot`, `ghost_annotate`, `ghost_ground`, `ghost_parse_screen`, plus ADE CLI-prefixed variants).
2. **Content patterns** — file extensions (`IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`, `TRACE_EXTENSIONS`, `LOG_EXTENSIONS`), field-name heuristics (`ARTIFACT_FIELD_NAMES`, `EMBEDDED_ARTIFACT_CONTEXT_FIELDS`, `TEXTUAL_CONTENT_FIELD_NAMES`), base64 data-URIs, and a regex for embedded `file:///`, `http(s)://`, and absolute-path artifact references.

Detections are normalized into `ComputerUseArtifactInput[]` and handed off to the broker. This keeps the chat-surface artifact drawer populated even when the agent didn't explicitly ingest.

## Policy

`ComputerUsePolicy` (from `shared/types`):

- `mode` — `off` | `auto` | `enabled`.
- `allowLocalFallback: boolean` — whether ADE-local fallback is permitted for this scope.
- `retainProof: boolean` — whether to retain proof artifacts after the run.
- `preferredBackend: string | null` — optional pinned backend.

Policy applies per scope: mission-wide, chat-session-wide, or lane-wide. `summarizePolicy(policy)` produces the human-readable policy statement surfaced in the chat header and mission preflight.

`createDefaultComputerUsePolicy(partial)` is the factory — missing fields default to `auto` mode with local fallback allowed and proof retention on.

## Mission flow

### Launch + preflight

Mission preflight surfaces computer-use readiness:

- Required proof kinds for the selected phase profile (from `collectRequiredComputerUseKindsFromPhases`, which reads `phase.validationGate.evidenceRequirements`).
- Current `ComputerUsePolicy`.
- Approved external backends currently available.
- Whether ADE can satisfy the proof contract externally, only through fallback, or not at all (hard block).

If proof is required but not satisfiable, preflight blocks launch.

### Run monitoring

Mission run detail includes a Computer Use section rendering a `ComputerUseOwnerSnapshot` via `buildComputerUseOwnerSnapshot`. It shows:

- Active or inferred backend (from latest artifact, policy preference, or first available).
- External-first vs fallback mode.
- Recent activity (backend state, tool usage, artifact ingestion, missing proof kinds).
- Recent retained artifacts.
- Proof coverage summary (present kinds vs required kinds).

### Artifact review + closeout

Artifact review UI:

- Inspect screenshots, traces, logs, videos, verification outputs.
- See backend provenance and linked owners.
- Mark review state: `accepted`, `needs_more`, `dismissed`, `published`.
- Route to related owners: lane, GitHub PR, Linear issue, automation run.

Mission closeout can use broker-managed artifacts regardless of whether they came from Ghost OS, agent-browser, or fallback.

## Chat flow

Computer use is first-class in normal chat too:

- Session policy toggle in the chat header (`CU Off`, `CU Auto`, `CU On`, `Fallback`, `Proof`).
- Inline monitor in the thread with current proof summary, active backend, fallback mode, recent activity.
- Artifact review surface with the same accept / dismiss / more-proof / publish actions.
- Promotion path: attach a chat-session artifact to a mission, lane, PR, or Linear issue without losing provenance.

## Gotchas

- **ADE local is fallback-only.** Do not expand it into a general-purpose automation engine. If an approved external backend covers the required kind, prefer the external backend.
- **Allowed import roots are a hard trust boundary.** Adding a new root (e.g. a new backend's cache dir) requires a code change in `computerUseArtifactBrokerService.ts`.
- **`secureCopyFromDescriptor` uses `O_NOFOLLOW`.** Don't relax this — symlink-based attacks escape the allowed-roots check otherwise.
- **Ghost OS status is shelled out via `spawnSync("ghost", ["status"])`.** Timeout is 5 seconds. A hung `ghost` binary throttles the readiness check — make sure the CLI responds quickly.
- **`ghost doctor` process health detection parses human-readable output.** The regex `GHOST_DOCTOR_PROCESS_REGEX` is the parsing boundary; changes to Ghost OS output format require updating both the regex and the tests.
- **agent-browser is not an ADE CLI.** Don't treat its artifacts as coming from an ADE CLI transport — they come through the `agentBrowserArtifactAdapter` payload parser.
- **`inferSupportedKindsFromExternalTool` is heuristic.** It reads the tool name + description. Backends with ambiguous names may be misclassified — prefer explicit declarations via the broker backend registration.

## Cross-links

- `backends.md` — Ghost OS, agent-browser, ADE local fallback in detail.
- `artifact-broker.md` — the broker's ingestion, ownership, review, and publication model.
- `settings-and-readiness.md` — the Settings > Computer Use surface and readiness checks.
- `../missions/README.md` — mission preflight and run monitoring read from the broker.
- `../cto/linear-integration.md` — Linear closeout can attach broker-managed artifacts as proof.
- `../automations/README.md` — automations request computer-use proof via the mission surface.
