# External Session Import

Coding CLIs run outside DAEX keep their own sessions. Import lets the user
browse them from Work and continue one inside DAEX. Twelve providers: Claude
Code, Codex, Cursor `cursor-agent`, Factory Droid, OpenCode, Pi, Muse Code,
and the CLI stores of Qwen Code, Kimi Code, Grok, GitHub Copilot CLI and
Antigravity's `agy`. (Devin has no import.)

Every import picks a **surface** (DAEX chat or tracked CLI terminal) and a
**mode**: Continue uses the original provider session (do not keep it open
elsewhere); Copy starts a new session from the history and leaves the original.
One policy table decides which actions a session gets and in which lanes. Every
provider can open as a DAEX chat copy.

Sessions DAEX creates or imports stay resumable from the provider CLI, because
DAEX records (and for fresh Claude, Qwen, Grok and Copilot launches, chooses)
the provider ids ([Session tracking](#session-tracking)).

## Source file map

Main process (`apps/desktop/src/main/services/externalSessions/`):

| File | Owns |
|---|---|
| `externalSessionsService.ts` | `list`, `importExternalSession`, `getDetail`: discovery, capability stamping, `home` lane, import marking, the policy guard, CLI resume/fork commands, chat import delegation. |
| `discoverers.ts` | The one provider → discoverer table. |
| `discoverClaude.ts`, `discoverCodex.ts`, `discoverCursor.ts`, `discoverDroid.ts`, `discoverOpenCode.ts` + `openCodeStore.ts`, `discoverPi.ts`, `discoverMuse.ts` | Per-provider discovery. |
| `discoverQwen.ts`, `discoverKimi.ts`, `discoverGrok.ts`, `discoverCopilot.ts`, `discoverAntigravity.ts`, `discoverAcpShared.ts` | CLI-store discovery for the ACP-family providers. |
| `sessionIds.ts` | Id validation (strict UUID for Claude/Codex, a bounded token for others; ids are joined into paths). |
| `sessionHome.ts` | Maps a session cwd to its lane (`ExternalSessionHome`); deepest lane root wins. |
| `adeConfigHomes.ts` | DAEX-owned config homes under `<ADE_HOME>/provider-homes/` that hold CLI sessions. |
| `events/` | Provider store → DAEX chat events, with byte-window paging, for preview and import. |
| `externalSessionDetail.ts` | Preview detail and the local file watch. |
| `importedSessionStore.ts` | Durable import log, `<ADE_HOME>/external-sessions/imported.json`. |
| `liveChatProviderRefs.ts` | Every provider pointer a DAEX chat holds, so a session DAEX runs never lists as importable. |
| `providerSessionHandles.ts`, `claudeLiveSessions.ts` | Which live process holds a session file; Claude's live-session registry. |
| `claudeSessionTransplant.ts` | Non-destructive Claude transcript copy into another cwd. |

Shared and other:

| File | Owns |
|---|---|
| `apps/desktop/src/shared/externalSessionPolicy.ts` | `PROVIDER_IMPORT_RULES`, `effectiveImportRules`, `planImport`, `importRejectionReason`, `importProviderLabel`. iOS port: `WorkExternalSessionAffordances.swift`. |
| `apps/desktop/src/shared/types/externalSessions.ts`, `externalSessionDetail.ts` | DTOs, provider list and labels, base capabilities. |
| `apps/desktop/src/shared/importedTurnBoundaries.ts` | Adds a `done` after each imported turn that did tool work. |
| `apps/desktop/src/shared/cliLaunch.ts` | Resume/fork builders and pre-assigned id helpers. |
| `apps/desktop/src/main/services/chat/externalChatHistoryImport.ts`, `agentChatService.ts` (`importExternalChatSession`) | Chat import. |
| `apps/desktop/src/renderer/components/terminals/importSessions/` | The desktop dialog (`ImportSessionBrowser.tsx`, top bar, list, preview, `ImportActionBar.tsx`, `importBrowserModel.ts`, `useExternalSessionDetail.ts`). |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` | `work.listExternalSessions`, `work.getExternalSessionDetail`, `work.importExternalSession`. |
| `apps/ios/ADE/Views/Work/WorkImportSession*.swift`, `WorkImportActionBar.swift`, `apps/ios/ADE/Models/RemoteModels.swift` | iOS flow and models. |

## Discovery

`list` runs one discoverer per provider (each failure caught), filters to the
project unless `scope: "all"`, and returns rows newest first. Reads are
bounded (byte and line limits; counts only under a size cap). A session a live
tracked DAEX PTY owns is not listed.

- `title` is a provider-persisted title or `null`, never the first message. `preview` is the opening prompt after DAEX guidance and transport wrappers are removed. `messages` is an optional sample (≤ 8, ≤ 320 chars each).
- **Keep `messages` optional and nullable.** iOS drops a whole summary on a failed decode. Add optional keys; never re-type one.
- The markup-density gate applies to previews only, never to `cleanExternalSessionUserText` (which feeds imports) or counts.
- The service stamps `alreadyImported` / `importedSessionRef`, `possiblyActive` (Claude's live registry with a live pid, else a file changed in the last two minutes), `home` and `sizeBytes`.

### Codex thread store

Codex threads come from `CODEX_HOME/state_5.sqlite` (read-only), not the
rollout tree, because only the database knows spawn edges. Non-archived,
non-child threads are listed; line 1 of the rollout gives `originator` (DAEX's
own sessions excluded) and `forked_from_id`. A parent with no activity after a
fork hides behind it. Classification fails open (unknown `source` strings are
listed and logged). An unusable database falls back to the rollout scan.

### Where Claude sessions live

DAEX does not run CLIs on the provider default: an account gets
`CLAUDE_CONFIG_DIR=<ADE_HOME>/provider-homes/claude/<instance>`, and presets,
keys and `--via` routes get their own homes. Discovery scans every home and a
record keeps its `configHome`; import resumes under that home and records the
account in `resumeMetadata.launch`. With several Claude or Codex accounts, the
action bar offers an account picker; another account copies the session into
that home first (source kept). A removed account id is refused.

### Where the other CLIs' sessions live

Presets and routes can also move four CLIs into a DAEX home
(`adeHarnessConfigHomes`):

| Provider | Variable DAEX sets | Sessions inside |
|---|---|---|
| Droid | `FACTORY_HOME_OVERRIDE` (a HOME; Droid adds `.factory`) | `<home>/.factory/sessions/<escaped cwd>/` |
| Grok | `GROK_HOME` | `<home>/sessions/<percent-encoded cwd>/<id>/` |
| Kimi | `KIMI_CODE_HOME` | `<home>/sessions/wd_<slug>_<hash>/<id>/` |
| Pi | `PI_CODING_AGENT_DIR` | per Pi's rules (`piSessionRootForEnvironment`) |

Homes: `preset/<id>`, `route/r<hash>` (listed only when the CLI's own files are
there), `credential/droid/<id>`. DAEX never scans `<provider>/default` or walks
`provider-homes` whole. Import puts the home's variable and the preset env in
the terminal; a gone preset or route logs a warning and still resumes in the
home. These homes offer CLI continue and chat copy, not chat continue
(`importToChat: false`).

### Lane attribution

`home.kind` is `lane` (a live lane's worktree or inside it; `atLaneRoot` when
exactly the root), `removed-lane` (under `.ade/worktrees/` with no live lane),
or `outside`. The primary lane contains every lane, so the deepest root wins.

### Import marking

Four sources feed one `provider:id` → ref map (chat refs outrank CLI refs):
the durable import log (machine-local JSON with a short lock, because desktop
and the brain can share one DAEX home), `terminal_sessions` resume metadata,
Claude session pointers, and the chat refs provider (built the same way on
both hosts). Only the log survives deleting the DAEX session and knows a
fork's new provider id.

| State | Fields | Dialog |
|---|---|---|
| In DAEX now | `alreadyImported: true` | "Open in DAEX" replaces the plan. |
| Imported before | `importedBefore: true` | Importable, with a hint. |
| Never imported | both false | Importable. |

A copy leaves the original importable. Collapsing discoverers set
`lineageIds`, and marking matches `id ∪ lineageIds`. Rows whose ids are all
recorded fork targets are dropped.

## Import policy

`apps/desktop/src/shared/externalSessionPolicy.ts` is the one source of truth;
the renderer, the host guard and the iOS port all use it.

| Rule | Where the action can run |
|---|---|
| `any` | Any lane. |
| `home` | Only the session's home lane (a session with no live home lane can go anywhere and runs in its original folder). |
| `root` | Only the home lane, and only when the session folder is its worktree root. |
| `none` | Not offered. |

`PROVIDER_IMPORT_RULES`:

| Provider | Chat continue | Chat copy | CLI continue | CLI copy |
|---|---|---|---|---|
| Claude | `root` | `any` | `home` | `any` |
| Codex | `any` | `any` | `any` | `any` |
| Cursor | `none` | `any` | `home` | `none` |
| Droid | `root` | `any` | `home` | `any` |
| OpenCode | `root` | `any` | `home` | `home` |
| Pi | `root` | `any` | `home` | `home` |
| Muse | `root` | `any` | `home` | `none` |
| Qwen | `none` | `any` | `home` | `home` |
| Kimi | `none` | `any` | `home` | `none` |
| Grok | `none` | `any` | `home` | `home` |
| Copilot | `root` | `any` | `home` | `none` |
| Antigravity | `none` | `any` | `home` | `none` |

- **Chat continue**: Claude binds the session, Codex the thread; Droid, OpenCode, Pi, Muse and Copilot seed the provider pointer. It is `none` for Cursor and the ACP CLIs because no live run has proven that the chat path can open a CLI-created session. To enable one, add it to `NATIVE_CHAT_CONTINUE_PROVIDERS` (`agentChatService.ts`), seed its pointer, and change both policy tables.
- **Chat copy**: a native fork for Claude and Codex with a same-family model, else a full replay into the chosen model.
- **CLI copy**: Claude `--fork-session` or a transplant, Codex `fork`, Droid/OpenCode/Pi `--fork`, Qwen and Grok `--fork-session`.

### Capabilities only narrow the table

The host sends `ExternalSessionCapabilities` per row (`resumeInPlace`,
`resumeInDifferentCwd`, `fork`, `forkIntoDifferentCwd`, `importToChat`).
`effectiveImportRules` narrows, never widens. Chat copy is never narrowed. A
missing source folder disables everything except Claude's copy and Droid's
fork; Droid's fork waits for a `droid --help` probe.

### The plan and the guard

`planImport(summary, { surface, targetLaneId, … })` returns the `ImportPlan`
every client renders as is: `surfaces`, `surface`, `targetLaneId`,
`laneLocked` / `lockReason`, `primary` / `secondary` (with `mode`, `label`,
`needsModel`, `confirmBeforeRun` for a continue on a possibly-active session),
and one `note`. Clients never re-derive `confirmBeforeRun`.

`importExternalSession` finds the summary again and calls
`importRejectionReason`; an import the plan would not offer fails with the
dialog's words.

## CLI target

1. Validate the id; resolve the target lane cwd and caller lane scope; find the summary; run the guard.
2. Codex resumes in the lane folder; every other provider in the session's own folder. ACP selectors: `qwen --resume <id>`, `kimi -S <id>`, `grok -r <id>`, `copilot --resume=<id>`, `agy --conversation <id>`. A session from a DAEX home resumes with that home.
3. With no override, the resume keeps provider state (no injected plan mode, models or agents).
4. Spawn through `ptyService.create` with `tracked: true`, `resumeMetadata.importedFrom`, and `allowExternalCwd` when the run cwd is not the lane cwd. A future pre-assigned import id must also set `allowNewSessionId: true`.

The import returns the persisted summary; clients install it before
navigating so the first render does not race sync.

## Chat target

`agentChatService.importExternalChatSession` creates a lane chat, stamps
`importedFrom` (`continue` or `fork`), appends history, and binds future turns:

| Path | When | What |
|---|---|---|
| Claude native | Claude, Claude-family model | Continue binds the session; Copy transplants the JSONL under a new id. |
| Codex native | Codex, Codex-family model | Continue binds the thread; Copy calls `thread/fork` (archived again if the import fails). |
| Native continue | Droid, OpenCode, Pi, Muse, Copilot, `mode: "resume"` | Seeds the provider pointer; refused unless the folder is the lane root and the model is same-family. OpenCode continues only sessions in DAEX's managed store. |
| Replay copy | Everything else | Writes the history and stages a replay for the chosen model's first turn. |

History: Claude and Codex through `externalChatHistoryImport.ts` (last 32 MB,
newest 2,000 events, provenance notices); others through
`loadExternalSessionEvents` (`purpose: "import"`).

**Keep the Claude transplant import in `agentChatService.ts` static.** A
dynamic `import()` is not bundled into the brain's `cli.cjs`, and the packaged
brain then fails with a missing module.

## Conversation events

`events/index.ts` turns a provider store into DAEX chat events, so the
preview shows exactly what an import writes. Preview pages are 200 events
(phone 120) from a growing 2–16 MB window; import is one read of up to 32 MB
and 2,000 events. Paging cursors name absolute byte windows, so appends never
shift older pages.

| Provider | Source |
|---|---|
| Claude, Droid | The session JSONL (shared converter). |
| Codex | The rollout JSONL (current, legacy and bare layouts). |
| Cursor | `agent-transcripts/<id>/<id>.jsonl`, else `store.db` (`loadCursorStorePage`). |
| OpenCode | The owning SQLite store, read-only (v1 and v2 schemas). |
| Pi | The session JSONL. |
| Muse | `sessions/YYYY/MM/DD/<id>/session.jsonl`. |
| Qwen | `chats/<id>.jsonl` (tool shapes unverified). |
| Grok | `chat_history.jsonl`. |
| Copilot | `events.jsonl` (subagent and autopilot rows dropped). |
| Antigravity | `conversations/<id>.db` (`loadAntigravityStorePage`). |
| Kimi | `agents/main/wire.jsonl` (unverified). |

Every caller reads detail through `externalSessionsService.getDetail`. An
ill-formed id returns an empty detail. `watchDetail` is local IPC only, so live
preview updates work only for sessions on this computer.

## Desktop dialog and routing

`ImportSessionBrowser.tsx` is a split view: list left, preview and action bar
right. The target lane is the session's home lane when this computer has it,
else the dialog's lane, captured once at open; a Work lane change does not
move it. The action bar renders the plan and nothing else; a `confirmBeforeRun`
action needs a second click ("Continue anyway").

`window.ade.externalSessions.list/import/getDetail` go to the bound runtime's
`external-sessions` action domain; desktop IPC is only the unbound fallback.
Both hosts (`main.ts`, `apps/ade-cli/src/bootstrap.ts`) build the service.
Non-CTO `run_ade_action` callers are lane-scoped.

Mobile uses the three `work.*` sync commands (`viewerAllowed`; import is
`queueable`). The phone never reads provider files; it sends no model or
permission override.

## Provider gotchas

### Claude

- Every Claude path must respect `CLAUDE_CONFIG_DIR`. Resume is cwd-scoped.
- Only `<projectSlug>/<uuid>.jsonl` is a session; `subagents/**` and `agent-*.jsonl` are not.
- SDK-origin transcripts (DAEX chats) are excluded by the entrypoint the session starts with, never by any single `sdk` row.
- Discovery collapses pure continuation chains (one file a prefix of another) to the leaf. The chain key is the first record uuid, never message text (DAEX injects the same preamble everywhere). Diverging files are real forks and both stay.

### Codex

- Only interactive CLI rollouts import. Previews prefer `event_msg` `user_message` rows.
- File-change items use tagged shapes; keep `externalChatHistoryImport.ts` aligned with the current app-server contract.

### Cursor

- One conversation can have up to four artifacts (`chats/<md5(cwd)>/<id>/store.db`, a second bucket after a resume from another cwd, `agent-transcripts`, an `empty-window` copy). Discovery groups by id and keeps the fullest; size, not recency, decides.
- `store.db` is content-addressed; order comes from the root blob (`openCursorStoreConversation`).
- `agent-<uuid>` (SDK runs) and the all-zero uuid are never sessions. No fork; resume always names the chat id, never `--continue`.
- Edit mode must not map to `--mode ask` (read-only).

### Droid

- `<factoryConfigHome>/sessions/<escaped-cwd>/*.jsonl`; the first row must be `session_start`. One id can appear under several cwds; the fullest copy wins.
- A `--via` route cannot run Droid (Factory rejects the route key), so a route-home Droid session lists but its resume fails.

### OpenCode

- `openCodeStore.ts` reads stores read-only; never `opencode session list` (stdout is cut at 64 KiB) and never a 2.0 server on the user's store (it migrates v1 in place).
- DAEX's own background-task titles are dropped. A user-store session is offered only as a chat copy.

### Pi

- Discovery drops sessions owned by a DAEX chat (`.ade-owner` owner `sdk`) or opening with the `## DAEX` (older: `## ADE`) guidance block. The tracked-terminal lookup uses `defaultHomeOnly`.

### Muse

- `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl` (UUIDv7 ids); `subagent/` children are not sessions. DAEX's MSP chats mark `client_info_name: "ade"`. Only a captured id resumes, never `muse resume --last`.

### CLI stores (Qwen, Kimi, Grok, Copilot, Antigravity)

Each discoverer reads the CLI's store directly and leaves out DAEX-launched,
subagent and prompt-less sessions. Reads are defensive (a bad shape gives a
thinner row, never a throw) and stop once enough rows survive.

| Provider | Store | DAEX-launched test |
|---|---|---|
| Qwen | `<QWEN_RUNTIME_DIR or QWEN_HOME or ~/.qwen>/projects/<cwd>/chats/<id>.jsonl` | No `attribution_snapshot` row and an `## DAEX` (older: `## ADE`) first prompt |
| Kimi | `KIMI_CODE_HOME` (`~/.kimi-code`) `sessions/wd_<slug>_<hash12>/<id>/` | `## DAEX` (older: `## ADE`) first prompt; archived, deleted and child sessions dropped |
| Grok | `$GROK_HOME/sessions/<encoded cwd>/<id>/` | `session_kind` `subagent` or `headless`, or an `## DAEX` (older: `## ADE`) first prompt |
| Copilot | `$COPILOT_HOME/session-state/<uuid>/` | `client_name` starting with `ade` (older SDK chats: DAEX's prompt in the first system message) |
| Antigravity | `~/.gemini/antigravity-cli/conversations/<id>.db` | ACP system prompt opening with `## DAEX` (older: `## ADE`); subagent conversations dropped |

Copilot discovery reads files, not the SDK's `listSessions()` (which needs a
running runtime and lacks the fields).

## Session tracking

**Pre-assigned ids.** A fresh tracked launch gets a new UUID
(`preassignedSessionIdArgs`): Claude `--session-id`, Qwen `--session-id`, Grok
`-s`, Copilot `--session-id=`. Never on a launch that continues a session,
except a Claude fork (`--fork-session` allows it). The resume parser
(`terminalSessionSignals.ts`) prefers a pre-assigned id over a resume selector.

**Kimi** has no such flag: `ptyService` adopts the session born in the launch
window under `wd_<slug>_<sha256(cwd)[:12]>` whose recorded `workDir` matches
and that no other terminal adopted. If ownership cannot be proved, nothing is
captured: a wrong resume is worse than none.

**Cursor, Pi and Muse** resume only by a captured id; "most recent" can be
another terminal's.

**Handle ownership.** `inspectLiveProviderSessions` finds which process holds
each session file. The holder is usually a PTY descendant, so handles carry
`trackedRootPid` and `handleIsOwnedByTrackedPty` decides; never compare
`handle.pid` with PTY pids. ACP store layouts use fixed file names, so the id
is a path segment (`sessionIdFromLayout`); OpenCode ids are `ses_<id>`
segments.

## Known limits

- No feature flag gates import.
- Keep the DTOs, `externalSessionPolicy.ts`, its Swift port, iOS models and sync payloads in lockstep; a one-sided change hides buttons or offers actions the guard refuses.
- Without `work.getExternalSessionDetail` on the host, the phone preview falls back to sampled messages.
- The Kimi PTY watcher is unverified against a real session.
- `external-sessions.list` can block the brain's event loop for 2–5 s on a large machine (mostly Claude and Pi discovery).
