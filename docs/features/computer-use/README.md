# Computer Use

DAEX keeps two jobs apart:

1. **Driving things.** Agents act through DAEX surfaces: the built-in browser
   (`daex browser`), App Control for Electron apps (`daex app-control`), the
   lane's own screen (`daex screen`, see [Mac](../mac-desktop/README.md),
   [Windows](../windows-desktop/README.md) and
   [Linux](../linux-desktop/README.md) Desktop), the Apple device tool
   (`daex apple`), the user's own Chromium browser (`daex browser attach`), and,
   on macOS, Codex's own signed Computer Use client. `ade` still works for every
   command.
2. **Proof.** An agent files a screenshot, video, trace, verification or log on
   purpose. The artifact broker stores it, links it to owners (chat, lane, PR,
   Linear issue, automation run) and the chat renders the set. See
   [artifact-broker.md](artifact-broker.md) and [proof.md](../proof.md).

Capturing is not proof: only an explicit proof call files a record.

## Source file map

### Proof broker and serving (`apps/desktop/src/main/services/computerUse/`)

- `computerUseArtifactBrokerService.ts`: the broker (ingest, list, delete,
  broken/prune/recover, review compatibility, backend status, bounded preview
  and range reads). Details in [artifact-broker.md](artifact-broker.md).
- `proofFingerprint.ts`: the attach judge (SHA-256 + size, `PROOF_DUPLICATE`,
  videos made before the chat's turn, capture-to-attach downgrade).
- `mediaCreationTime.ts`: reads `creation_time` from an MP4/QuickTime `mvhd`
  box without loading the file.
- `controlPlane.ts`: `buildComputerUseOwnerSnapshot` (owner-scoped artifacts,
  latest backend, summary, artifact-derived activity).
- `localComputerUse.ts`: macOS capability descriptor, `createComputerUseArtifactPath`,
  `createComputerUseScratchPath`, `toProjectArtifactUri`.
- `artifactMediaServer.ts`: the token-guarded `127.0.0.1` HTTP server that
  plays proof videos with Range support, local and remote.
- `artifactStreamProtocol.ts`: MIME table, Range parse and the one containment
  check, shared by `ade-artifact://`, the media server and the broker.
- `artifactByteRange.ts`: one bounded slice (≤ 2 MiB) for `readArtifactRange`.
- `artifactDisplayCopy.ts`: JPEG display copies of large pictures for remote
  tiles. `proofPlayableVideo.ts`: playable-video checks.
- Shared: `apps/desktop/src/shared/proofProvenance.ts` (`proofSource`,
  broker-only metadata keys), `artifactStreamUrl.ts` (`ade-artifact://project/…`
  and media-server URLs), `pathCase.ts`, `proofArtifacts.ts`
  (`normalizeComputerUseArtifactKind`).
- `apps/ade-cli/src/services/proof/adeCaptureRegistry.ts`: files DAEX's own
  capture actions wrote (path + hash, one-shot), so only those ingest as DAEX's
  capture.

### The user's own browser

- `apps/desktop/src/main/services/userBrowser/userBrowserDiscovery.ts`: which
  Chromium browsers (Chrome, Edge, Brave, Arc, Helium, Chromium) have remote
  debugging on, from each profile's `DevToolsActivePort` (reads files only);
  `chooseUserBrowserTab`.
- `userBrowserAttachService.ts`: `attach` / `detach` / `status`, one CDP
  connection per chat attachment, App Control's action engine for page commands.
- `apps/desktop/src/main/services/shared/cdpClient.ts`,
  `cdpPageDiagnostics.ts`, `withTimeout.ts`: shared with App Control.
- `apps/desktop/src/shared/userBrowserLabels.ts`: `attached:`, `detached:`,
  `target:` words shared by printer and transcript.
- `apps/ade-cli/src/services/builtInBrowser/userBrowserRouting.ts`: routes the
  runtime's page commands to the attachment.

### Action rows in the transcript

- `apps/desktop/src/shared/computerUseActionSummary.ts`: parses one shell
  command (`daex screen|browser|apple …`, also via `"$ADE_CLI_PATH"`) into
  verb, element, app, surface, effect; null when unsure. Splits unquoted
  redirections off words.
- `computerUseActionOutput.ts`, `computerUseActionPresentation.ts`,
  `readRecord.ts`: output parsing, words and run layout.
- `apps/desktop/src/renderer/components/chat/chatComputerUseRows.ts`,
  `ChatComputerUseActions.tsx`, `ChatViewedImages.tsx`: the rows.
- `apps/desktop/src/main/services/apps/appIcons.ts`: app icons for rows
  (`ade.app.getAppIcon`, macOS only).
- iOS: `apps/ios/ADE/Views/Work/WorkComputerUseSummary.swift`,
  `WorkComputerUsePresentation.swift`, `WorkComputerUseActions.swift`.
- How rows fold: [chat/transcript-and-turns.md](../chat/transcript-and-turns.md).

### Direct Codex Computer Use

- `apps/desktop/src/main/utils/codexComputerUse.ts`: resolves and verifies the
  standalone OpenAI client and returns the MCP launch config.
- `apps/desktop/src/main/services/chat/agentChatService.ts`: merges the
  `computer_use` server into Codex `thread/start` / `thread/resume` and maps
  its tool events and elicitations.
- `apps/desktop/src/shared/cliLaunch.ts` (plus `agentChatCliLaunch.ts`,
  `ptyService.ts`, `externalSessionsService.ts`): the same server as
  `-c mcp_servers.computer_use.*` flags for tracked Codex CLI start, resume,
  imported resume and fork, resolved at each launch.

### Renderer

- `apps/desktop/src/renderer/components/chat/ChatComputerUsePanel.tsx`: proof
  card, lightbox, drawer, availability states, delete.
- `useArtifactPreview.ts`: preview source and failure cause (`offline`,
  `unsent`, `unplayable`).
- `apps/desktop/src/renderer/lib/playableMedia.ts`: relabels `video/quicktime`
  as `video/mp4` for Chromium (stored metadata keeps the true type).
- `AgentChatMessageList.tsx`, `chatCardPrimitives.tsx`, `ChatProofCitation.tsx`:
  per-turn "N proof filed" (`ChatProofCount`) and `ProofActionThumbnail`.
- `apps/desktop/src/renderer/lib/computerUse.ts`: `window.ade.computerUse.*`
  helpers.

### IPC and runtime RPC

`window.ade.computerUse`: `listArtifacts`, `getOwnerSnapshot`,
`deleteArtifacts`, `listBrokenArtifacts`, `pruneBrokenArtifacts`,
`recoverArtifact`, `updateArtifactReview`, `readArtifactPreview`, the push
`event`, and `mediaBaseUrl` (answered by main, never the runtime). The rest
route renderer → preload → the project's runtime → broker, over the SSH
JSON-RPC for remote projects (`remoteRuntime/runtimeRpcClient.ts`). The CLI's
RPC tools (`screenshot_environment`, `record_environment`,
`ingest_computer_use_artifacts`, `list_…`, `delete_…`, `list_broken_…`,
`prune_broken_…`, `recover_computer_use_artifact`) in `adeRpcServer.ts` use the
same broker.

## Gotchas / fragile areas

- **Capture is not proof.** `screenshot_environment` / `record_environment`
  take `proof: false` by default and write to `.ade/cache/tmp/computer-use/`;
  `daex proof capture` / `record` set it. `daex browser record` and
  `daex app-control record` file only with `--caption`. Owner claims are
  resolved only on the proof branch. `daex proof attach <path>` promotes a
  scratch file later.
- **The `computer_use_artifacts` action domain has no `ingest`.** Ingest goes
  only through `ingest_computer_use_artifacts`, which runs
  `validateComputerUseOwnerClaims` and caller-root resolution.
- **Proof must be new bytes.** The broker refuses bytes already filed
  (`PROOF_DUPLICATE`), flags a video recorded before the chat's turn, and
  stamps `metadata.proofSource`. In-process recorders pass `provenance` and skip
  both; a CLI capture counts as DAEX's only if `adeCaptureRegistry` still holds
  it with the same hash.
- **Hidden browser tabs have no compositor surface.** `observe`, `screenshot`,
  `proof` and `record` take a capture hold: the tab is parked attached just past
  every display for the capture (warmed ~120 ms if never shown), then detached.
  With the window minimized or no window open, `observe` and action follow-ups
  answer with the DOM and `screenshotUnavailable`; `screenshot` and `proof`
  (`requireScreenshot: true`) fail.
- **Videos stream from main's loopback server**, not `protocol.handle`, which
  cannot answer the second Range read an end-indexed MP4 needs. URLs carry a
  per-launch token and `?root=<project>`; main serves only projects open on this
  computer, jailed to `.ade/artifacts`, never the focused window's project.
  Refusals log `computer_use.artifact_serve_refused` with a reason.
- **Remote bytes are never synced back.** Remote images use
  `readArtifactPreview` (10 MiB data URL); remote videos are read in ≤ 2 MiB
  `readArtifactRange` slices (CTO role) sized to the measured link; large
  pictures get a cached JPEG display copy (`.ade/cache/artifact-display/`, 400
  max) for tiles only. See
  [Remote runtime](../remote-runtime/README.md#a-slow-or-dropping-link).
- **Codex Computer Use needs explicit opt-in and a verified binary.** Only on
  macOS, only with `[plugins."computer-use@openai-bundled"] enabled = true` or
  a `[mcp_servers.computer_use]` section not set `enabled = false`. The
  resolver checks `$CODEX_HOME/computer-use/` then bundled plugin caches; a
  candidate must pass `codesign --verify --strict` with OpenAI team
  `2DC432GLL2` and bundle id `com.openai.sky.CUAService.cli`. DAEX launches
  the signed helper directly so the OS entitlement is the helper's, not a
  wrapper's. Elicitations become Allow once / Deny cards (Always allow only
  when `_meta.persist` permits); full-auto never approves them silently.
- **Windows has no Codex Computer Use or native capture** and reports
  `blocked_by_capability`; App Control, Windows Desktop and proof ingestion
  still work.
- **Do not re-add** the passive `proofObserver.ts`, `ComputerUsePolicy`
  modes, readiness gates, the Settings > Computer Use panel or Ghost OS probes.
  They were removed on purpose.

## Browser use is visible

Every `daex browser …` command from a chat marks that chat as using the
browser: a globe on its session card and header, a live dot on the Browser
tool, and the same on the phone. The mark expires about 20 s after the last
command (held while recording). See
[An agent is using the browser](../chat/README.md#an-agent-is-using-the-browser).

**Who can use the DAEX browser.** One machine-wide setting, in the browser's ⋯
menu and Settings → Behaviour: **All agents, all lanes** (default), **Agents in
lanes I approve** (asked once per lane) or **Chats I approve** (once per chat).
One answer covers every site. Keys in the dialog's first 0.6 s are ignored.
Grants live in the desktop's global state. Electron main decides for every
caller (local chat, brain bridge, remote runtime). When asked, an agent command
waits up to two minutes; each desktop call returns `approval_pending` after
15 s (keeping the bridge's 30 s liveness) and the CLI re-runs it. A Block fails
with `approval_blocked`. Unanswered prompts close after 10 minutes. Protocol
blocks, site-permission prompts, login handoffs, chat/lane tagging and tab
leases do not change with the setting.

## Attach to the user's own browser

When the user asks for their own browser ("the tab I have open"),
`daex browser attach` connects to it. The request is the consent; the browser
shows its own "Allow remote debugging?" prompt.

- Runs inside the chat's runtime, so it works headless or remote. Output names
  machine and tab: `attached: Google Chrome on <machine>, tab "<title>" (<url>)`.
- Finds `DevToolsActivePort` in each profile dir (newest wins; stale files
  skipped). Only `attach` connects, so `status` never triggers the prompt.
  With none enabled, it names the page to turn it on
  (`chrome://inspect/#remote-debugging`, …). `--browser`, `--user-data-dir`,
  `--tab <text>` narrow it; ambiguous tabs are listed for the agent to ask.
- While attached, `observe`, `click`, `fill`, `clear`, `type`, `key`, `scroll`,
  `hover`, `wait`, `open`, `reload`, `back`, `forward`, `screenshot`, `proof`
  and `trace` act in that tab with the same handles and `hit:`/`effect:` lines;
  every answer starts `target: your <browser> on <machine>`. Only http(s)
  navigation. New tabs, isolated sign-ins, handoff, recording, network logging,
  drag and upload stay DAEX-browser-only.
- Observations go to `.ade/cache/user-browser-observations/` and the capture
  registry, so `daex browser proof` files them as DAEX's capture.
- Ends on `daex browser detach`, tab close, browser quit, 30 idle minutes, or
  chat end. Detach during the pending prompt aborts the handshake
  (`CdpClient.connect` takes an `AbortSignal`), which removes the prompt.
- Only the attaching chat may act in it. The runtime decides once per call and
  the router obeys, so a call never falls through to DAEX's browser unchecked.
  The chat id is a reported label, not a token (same-user processes are
  trusted, as with the built-in browser).

## Lane screens

Mac, Windows and Linux Desktop give each lane its own screen
(`daex screen`, the `mac_desktop` action domain). They change nothing above:
`daex screen proof --caption "…"` is the only call that files a record
(`backendName: "ade-mac-desktop"`, `backendStyle: "manual"`, owners lane,
chat and the lane's primary PR); a bare `screenshot` writes scratch. DAEX ships
its own driver (`ade-desktop-driver`) rather than embedding OpenAI's signed
binary.

## App Control

App Control drives developer-owned Electron apps over CDP, one session per
lane, with the same observe/act loop as the browser, window recording, and
screenshot-backed context chips. Proof: `daex app-control proof --caption`
(backend `ade-app-control`) and captioned recordings (provenance
`ade-recorder`). Full surface: [app-control.md](app-control.md).

## One action answer

Every acting command on the browser, App Control, lane screens and the Apple
device tool answers with two facts first (`--text`):

```
hit: button "Save" (obs-…:e:12)
effect: observed — the URL changed
```

- `hit` names the resolved element and its reusable handle, or where input went
  (`no element; acted on a point`, `… sent to whatever had focus`,
  `no element matched`).
- `effect`: `observed` (something changed; reason names it), `unconfirmed`
  (nothing visible changed; ends "observe again before you continue"),
  `not checked` (no compare; reason says why), `waiting` (browser only,
  `waiting_for_approval` in JSON: a navigation waits on the browser-use prompt).

JSON carries `resolved` and `effect` (`ComputerUseActionEffect` in
`shared/types/agentObservation.ts`). Per surface: browser and App Control
compare the locate-time DOM snapshot with the post-action observation (`wait`
and `--no-observe` answer `not checked`); lane screens compare with the lane's
newest observation; the Apple device is always `not checked` (a second
accessibility snapshot costs more than the tap).
`compareAgentEffectFingerprints` (`shared/agentObservation.ts`) checks URL,
title, windows, scroll, elements, count, focus and a frame hash; element hashes
ignore reordering, sub-4-point jitter, whitespace and busy indicators, and only
the shared prefix of capped lists is compared.

## Cross-links

- [proof.md](../proof.md): `daex proof` and the drawer contract.
- [artifact-broker.md](artifact-broker.md): records, ingestion, deletion.
- [app-control.md](app-control.md): App Control.
- [Mac](../mac-desktop/README.md), [Windows](../windows-desktop/README.md),
  [Linux](../linux-desktop/README.md) Desktop.
- [Automations](../automations/README.md): no automation-level proof policy;
  agents file their own proof.
