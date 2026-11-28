# Proof

Proof in DAEX is **intentional**, never auto-captured. An agent does computer
use however it wants; DAEX does not wrap or observe external tools. When a
moment deserves evidence, the agent (or user) runs a `daex proof …` command or
a surface's own `proof` / `record` command (`daex browser proof`, `daex apple
proof`, `daex screen proof`, `daex app-control proof`). A proof set is a
handful of captioned screenshots and short demo videos a reviewer can skim.

Commands use `daex`; `ade` still works.

## Source file map

| Path | Owns |
|---|---|
| `apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` | The only ingest path: owner checks, list, delete, broken-record audit/prune/recover, lane/project cleanup, bounded preview reads. |
| `apps/desktop/src/main/services/computerUse/controlPlane.ts`, `localComputerUse.ts` | Owner snapshots for the drawer; local capture capabilities and artifact path helpers. |
| `apps/desktop/src/main/services/computerUse/proofFingerprint.ts`, `mediaCreationTime.ts` | Duplicate-bytes refusal (`PROOF_DUPLICATE`); the older-video flag from `mvhd`. |
| `apps/desktop/src/main/services/computerUse/proofPlayableVideo.ts` | H.264 MP4 copies of other video formats. |
| `apps/desktop/src/main/services/computerUse/artifactMediaServer.ts`, `artifactStreamProtocol.ts`, `artifactByteRange.ts`, `apps/desktop/src/shared/artifactStreamUrl.ts` | Loopback video server and Range reads. |
| `apps/desktop/src/shared/proofProvenance.ts`, `proofCitation.ts`, `proofDrawerModel.ts` | `proofSource` values; citation forms; drawer grouping. |
| `apps/desktop/src/shared/types/computerUseArtifacts.ts` | Artifact, owner and event contracts. |
| `apps/desktop/src/main/services/state/kvDb.ts` | `computer_use_artifacts` / `computer_use_artifact_links` schema. |
| `apps/ade-cli/src/cli.ts`, `adeRpcServer.ts`, `proofPublish.ts` | `daex proof …` commands, RPC tools, PR publish. |
| `apps/ade-cli/src/services/proof/adeCaptureRegistry.ts` | Files DAEX's own capture actions wrote, by path and hash. |
| `apps/desktop/src/shared/demoVideo/` (`demoContract.ts`, `demoPlanner.ts`, `demoCameraPlanner.ts`, `demoProofText.ts`) | Demo contract, pure planner and camera, proof text. |
| `apps/desktop/src/main/services/demoVideo/` | Track registry, render service, recording guard, engines (`swiftDemoEngine.ts`, `chromiumDemoEngine.ts`, `ffmpegDemoEngine.ts`), `demoMp4Source.ts`, `demoChildStop.ts`, `proofReview.ts` + `sheetFrames.ts` (`daex proof review`). |
| `apps/desktop/native/ADEMedia/` | `ade-media`, the macOS demo engine. |
| `apps/desktop/src/main/services/cto/ctoProofShare.ts` | Proof in the CTO's answer. |
| `apps/desktop/src/renderer/components/chat/ChatComputerUsePanel.tsx`, `ChatProofCitation.tsx`, `components/terminals/CliAgentPane.tsx` | Proof drawer, inline citations, the CLI actions pane's drawer. |
| `apps/ios/ADE/Views/Work/WorkProofSheet.swift` | The phone's proof sheet. |

## Gotchas

- **Only a proof-named call files proof.** Capture tools are scratch by default; never make one file on an agent's behalf.
- **The broker is the only ingest path**; every caller goes through its owner checks (`validateComputerUseOwnerClaims`).
- **Bytes do not replicate.** Records sync through cr-sqlite; previews stream from the machine that holds the files and are unavailable while it is unreachable.
- **Proof lives on the runtime's machine** (`.ade/artifacts/computer-use/`), so a remote session's proof is on the remote host.
- **`metadata.proofSource`, `turnId` and duplicate fingerprints are broker-written**; caller metadata cannot set them.

## The explicit-only rule

Capturing pixels and filing evidence are different acts: an agent looks at the
screen constantly, and a drawer of every look is a dump.

- `screenshot_environment` / `record_environment` RPC tools file a record only with `proof: true`, which `daex proof capture` and `daex proof record` set.
- The `computer_use_artifacts` action domain does not expose `ingest`.
- There is no `captureScreenshot` chat tool.

Scratch bytes stay on disk in roots the broker accepts, so
`daex proof attach <path> --caption "…"` promotes any of them later.

## Runtime ownership

The broker and storage belong to the runtime (`daex serve`) that owns the
project: files under that machine's `.ade/artifacts/computer-use/`, rows in its
`.ade/ade.db`. Desktop and the CLI reach it over JSON-RPC. Remote proof is
viewable only while that runtime is reachable.

## CLI reference

`daex help proof` has the full flag list. Commands print JSON, or one
confirmation line with `--text`.

### `daex proof capture`

```
daex proof capture [--caption "<text>"] [--real-screen] [--owner-kind chat|lane] [--owner-id <id>]
```

DAEX does not capture the real screen by default. The runtime finds the
caller's lane (the chat's lane, then the lane containing the caller's root,
then a named lane):

- **The lane has a Mac Desktop display:** the screenshot is taken there and filed like `daex screen proof` (owned by lane and chat, linked to the lane's PR).
- **No display:** refused, nothing captured; the error names the surface commands to use instead.
- **`--real-screen`:** `screencapture -x` on the runtime host (macOS only).

Exit codes: `0` filed; `1` refused, failed, or not readable back; `2` usage.

### `daex proof attach`

```
daex proof attach <path> [--caption "<text>"] [--title "<text>"] [--owner-kind …] [--owner-id …]
```

Kind from extension: images → `screenshot`; `.mov`/`.mp4`/`.m4v`/`.webm` →
`video_recording`; `.zip`/`.har` → `browser_trace`; other allowed types →
`browser_verification`. The file is copied in; the original stays.

- **Import roots:** project root, lane worktree, `.ade/artifacts`, `.ade/cache`, `.ade/tmp`, the OS temp dir and `/tmp` (with `/private/tmp` on macOS), and `~/.agent-browser`. The evidence-extension allow-list and the `.ade/secrets` deny-list decide what may be copied; `.env`, databases, keys and certificates are refused. Symlinks resolve before both checks and the source opens with `O_NOFOLLOW`.
- **Which directory the call claims:** `callerRoot` is `ADE_WORKSPACE_ROOT` if set, else omitted when only `ADE_LANE_ID` is set (the runtime uses the authorized worktree), else `process.cwd()`. A failure names the path, its source and the authorized root.
- **Confirmation:** `attach`, `capture`, `ingest` and `record` re-read the record through the drawer's list path; exit `0` only when it exists. Anything else prints one line containing `failed`. `--no-verify` skips the re-read.
- **Duplicates:** bytes matching earlier proof in the project (by size, then SHA-256) are refused with `PROOF_DUPLICATE`, including Apple recordings on disk that never reached the drawer. DAEX's own captures (matched one-shot in `adeCaptureRegistry.ts` by path and hash) skip the check for stills, never for videos.
- **Older videos:** an MP4/MOV whose `mvhd` creation time is more than 60 s before the owning chat's turn started still lands, with `metadata.recordedBeforeRequest: true` and an amber "recorded before this request" line.
- `metadata.proofSource` is `ade-recorder`, `ade-capture` or `attached`.

### `daex proof publish`

```
daex proof publish --pr <number|url> <artifact-id>… [--heading "<text>"] [--note "<text>"] [--replace]
daex proof publish --pr <number|url> --in-body
```

- Posts one PR comment with `gh pr comment --attach` on the machine holding the files. Only the caller's own proof can be posted. `--replace` deletes the account's earlier DAEX proof comments after the new one posts.
- `--in-body` uploads the proof the PR text cites (`![caption](ade-proof://<id>)`, `proof-compare` fences) with `gh pr edit --attach` and rewrites the citations (`shared/prBodyProof.ts`); `daex prs create` / `daex prs body` do the same. See [PRs › Proof in the PR text](./pull-requests/README.md#proof-in-the-pr-text).
- Needs `gh` 2.99.0+ and a `gh` login, not the DAEX GitHub App token (GitHub's upload endpoint refuses App tokens). On a DAEX Cloud computer it uses the account's copy of a `gh` login from DAEX's token endpoint (`use=upload`); with none, it refuses before uploading.
- Limits: 10 MB per picture; 10 MB per video on GitHub Free, 100 MB on paid plans. Skipped items are listed with the reason.
- Posted items get a `github_pr` owner link, shown as a "PR #N" chip.

### Other commands

- `daex proof list [--owner-kind …] [--owner-id …] [--limit n]`: the inferred owner's proof; `--text` leads with the scope the runtime authorized.
- `daex proof record --seconds <n>` (1–120): records the lane's Mac Desktop display and files a demo; refused with no display unless `--real-screen`.
- `daex proof step "<text>" [--focus x,y,w,h]`: a caption (≤ 60 chars) and optional camera focus for every recording running on the caller's lane.
- `daex proof review <id>`: see [below](#checking-a-demo-daex-proof-review).
- `daex proof rm`, `broken`, `prune [--broken]`, `recover <id>`: deletion and broken-record maintenance.
- `daex proof status`, `launch`, `interact`, `environment`, `ingest --input-json`: lower-level helpers.

`environment`, `launch`, `interact` and `--real-screen` captures prefer
headless mode unless `--socket` is passed; plain `capture` and `record` need
the running runtime, because the lane display lives there.

## Demo videos

Every recording DAEX files is a demo: a short, readable video of what the
agent did, on every surface (Apple device, the lane's Mac Desktop, App Control,
the built-in browser). `record start --plain` skips everything but the size fit,
only when the user asks for the raw recording.

### What a demo does

| Step | Rule |
|---|---|
| Still time | A still stretch over 2 s keeps 0.75 s. |
| Waits | A load or small change while the agent waits plays at 2×–16× (about 2.5 s) with a speed badge; past 16× the middle is cut. Agent thinking counts as still. |
| Actions | 0.3 s before to 1.2 s after each action plays at normal speed. |
| Camera | Focused steps (`--focus`) drive the camera when present. Otherwise a computer recording rests on the region where anything happened, and each scene zooms once (≤ 2×). A phone recording zooms only with `--zoom`. |
| Pointer and keys | A drawn pointer glides to each action and rings clicks (tap rings on the Apple device). Named keys and modifier chords show as badges; bare characters never do, so typed text (a password) never appears. Typing is paced while recording. |
| Captions | Each `daex proof step` shows until the next (≤ 5 s). No steps, no captions. |
| Size | Every file ends under 10 MB (GitHub Free's PR video limit), stepping 1080p30 → 540p10 as needed. |

### How it works

1. `record start` writes a raw recording beside the final path: MP4 from the Swift recorders and the Windows driver, or `.aderaw` (JPEG or H.264 units) from Chromium-side recorders.
2. The owning process logs a track (`demoTrackRegistry.ts`): actions, loads, steps, and the chat's thinking/tool state from its own events.
3. At stop, `produceDemoVideo` (`demoRenderService.ts`) has an engine measure the raw file, plans (`demoPlanner.ts`, pure), renders, refits when over 10 MB, and deletes the raw file.
4. The proof carries `metadata.demo` (lengths, cuts, steps); players list the steps as chapters on desktop and iOS.

Three engines run the same plan, tried in order until one reads the file:
`ade-media` (macOS), the Chromium engine in the desktop app (WebCodecs; reads
`.aderaw` and H.264 MP4 via `demoMp4Source.ts`, reached from the brain over the
desktop bridge), and `ffmpeg` (the machine's, or DAEX's pinned static build on
Linux and Windows, downloaded when a recording starts). ffmpeg text goes
through `textfile=`, never `text=`.

- When no engine can read it, an MP4 is filed as recorded with `fallbackReason` (and `demoNote` when the desktop app was not connected). An empty MP4 or an `.aderaw` is not filed.
- A media process that does not exit 10 s after SIGKILL is stuck on a dead drive (`demoChildStop.ts`, `isStuckMediaProcessError`): nothing touches that drive again, no fallback runs, and the raw file stays.

### Checking a demo: `daex proof review`

`daex proof review <id> --text` (`proofReview.ts`) writes a contact sheet of a
video's key moments to `.ade/cache/proof-review/` (newest 20 kept) using the
first engine with `contactSheet`. `pickSheetFrames` chooses 4–16 frames: ends,
each step's outcome, the biggest changes, then even fill. Findings flag
recordings under 3 s or over 90 s, no captions, plain or fallback recordings,
older videos, and small pictures. It reads the caller's own proof only. Every
filing command prints a `next:` line naming the review command.

### Limits every recording shares

| Limit | Value | Stop reason |
|---|---|---|
| Length | 5 minutes (`--max-seconds` sets less) | `cap` |
| No action | 2 minutes with nothing on the track | `idle` |
| Raw file | 2 GB | `disk` |
| Free disk | under 5 GB on the raw file's volume | `disk` |

A limit-stopped chat recording is still filed. Stop answers after the demo is
filed; desktop gives `stopRecording` / `recordStop` four minutes.

## Owner inference

The CLI infers the owner from `ADE_CHAT_SESSION_ID` (chat, wins) or
`ADE_LANE_ID` (lane). A tracked agent CLI carries its own id as
`ADE_CHAT_SESSION_ID`, so its proof files to that CLI. With no owner,
`daex proof capture` fails: un-owned proof has no home in the UI.

RPC tools (`screenshot_environment`, `record_environment`,
`ingest_computer_use_artifacts`, `list_computer_use_artifacts`, …) accept
explicit `ownerKind` + `ownerId`, added to the inferred identity.
`resolveComputerUseOwners` (`adeRpcServer.ts`) normalizes kinds `lane`,
`chat_session`, `automation_run`, `github_pr`, `linear_issue` (aliases `chat`,
`pr`). A synthetic caller id like `ade-cli:5504` (`shared/syntheticCallerId.ts`)
identifies a process and never becomes a chat owner.

## Storage

- Files: `<project>/.ade/artifacts/computer-use/<uuid>.<ext>` on the runtime host. Rows in `computer_use_artifacts`, owners in `computer_use_artifact_links`; `lane_id` comes from a lane owner or the owning chat.
- No age-based retention. Proof goes when the user deletes it or its lane, clears project artifacts, or removes the proof storage category; rows go with the bytes. Archiving a lane keeps it.
- Ingest resolves every item before inserting any row; one bad item fails the batch.
- Views carry `availability`: `available`, `missing_file`, `unimported`.
- Browser observations (`daex browser observe`, traces, sessions) are scratch under `.ade/cache/browser-observations/` (or the personal root) and pruned; promote checkpoints with `daex browser proof`.

## Chat UI

- **Transcript:** proof is bucketed into the turn that filed it; the turn shows "N proof filed", which opens the drawer narrowed to those records. "Filed proof" action rows open a small thumbnail in place.
- **Proof drawer** (`ChatComputerUsePanel.tsx`, `shared/proofDrawerModel.ts`): grouped by turn, newest first; "In the answer" items before "Also filed"; `proof-compare` pairs shown together; search, Pictures/Videos, "In answers" and PR filters.
- **iOS** (`WorkProofSheet.swift`): the same grouping and tabs, and a full-screen viewer with one page per artifact. See [iOS companion › The Proof sheet and viewer](./sync-and-multi-device/ios-companion.md#the-proof-sheet-and-viewer).
- A video flagged as older keeps its amber line; no other provenance line is drawn.

Media resolves through the owning runtime. Desktop shows local images through
`ade-artifact://project/`; videos and paired-machine images play from main's
token-guarded loopback server with Range reads (paired files pulled in 1 MiB
slices; paired pictures cached in memory, 64 MiB). Older machines and the web
fall back to `computerUse.readArtifactPreview` (≤ 10 MiB). A retryable failure
offers **Retry**; a missing file does not. See
[computer use › Renderer](./computer-use/README.md#renderer).

## Proof in the answer

The agent cites proof under the claim it proves
(`apps/desktop/src/shared/proofCitation.ts`):

- `![caption](ade-proof://<artifactId>)` shows a picture or plays a video inline.
- A fenced `proof-compare` block (`before: <id> <label>`, `after: <id> <label>`, optional `caption:`) shows two items side by side.

Every proof command prints a ready `cite:` line and returns
`artifacts[].citation`. Each chat-owned artifact stores `metadata.turnId`
(broker-stamped). Desktop and web render through `ChatProofCitation.tsx` (by
id through the chat's runtime if not in the list); iOS through
`WorkProofCitationView`. The web client pulls files over 8 MiB in
`readArtifactRange` slices into a blob URL (≤ 256 MiB); its CSP allows
`media-src 'self' data: blob:`.

### Proof in the CTO's answer

Clients resolve the CTO's citations through the CTO chat on its home machine,
so the proof must be there, owned by the CTO chat (`cto/ctoProofShare.ts`):

- **A child on the same machine:** when it reports back, its turn's proof is linked to the CTO chat (`broker.linkArtifactsToChat`, no copy) and the wake carries the cite lines (waiting ≤ 45 s for conversions).
- **A child on another machine or a DAEX Cloud lane:** the CTO calls `getChatProof({ sessionId, machine })`; the home brain pulls each file in `readArtifactRange` slices (≤ 512 MiB) and files a copy with `metadata.importedFrom`. Repeat calls reuse copies; an asleep machine returns earlier copies with a note.
- **A file the CTO made:** `showMedia({ path, caption })` checks import roots and the secrets folder first, then files it.
- Non-MP4 video (and HEVC/VP9 in MP4) gets an H.264 copy (`proofPlayableVideo.ts`; ffmpeg, or `avconvert` on a Mac without it).
- Raw proof bytes are secret-bearing: a remote brain may read them only via `readArtifactRange` at the CTO role (`isCtoBrainCopyableAdeAction` in `actionPolicy.ts`), and only DAEX's code copies them, never the model.

## For agents

When the host can capture or give the lane its own screen, the system prompt
adds a computer-use directive (`buildComputerUseDirective` in
`agentChatService.ts`): read the **daex-computer-use** skill first, never act
on the user's own screen unless asked, and file proof with each surface's
`proof` or `record` command (`adeCliGuidance.ts`). A good set is three to eight
captures with captions that name the exact state proven.

## Not supported

- Annotated overlays (an agent can compose its own picture and attach it).
- Offline byte replication.
- Auto-capture of any kind ([The explicit-only rule](#the-explicit-only-rule)).
