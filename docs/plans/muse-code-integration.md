# Meta Muse Code as a first-class provider

Status: in progress (branch `ade/b5b67a5c`).

Muse Code is Meta's coding agent (`muse` CLI, default model `muse-spark-1.3`).
ADE ships it both ways it ships Claude and Codex: as an **ADE chat** (driven over
the Muse Session Protocol, MSP) and as a **tracked CLI** in a terminal. Codex is
the reference implementation: MSP is JSON-RPC 2.0 over stdio to a long-lived
`muse serve` host with sessions → turns → items, the same shape as
`codex app-server`.

## Locked decisions

- **Provider id** `muse`. Chat tool type `muse-chat`, CLI tool type `muse`.
- **SDK only, no ACP.** `@muse-code/sdk` (MIT, zero deps, ESM) is pinned exactly
  and force-inlined into the CJS bundles (`noExternal`, like `@opencode/client`).
  ADE uses the SDK for spawn + handshake (`spawnMspConnection`), the
  `Connection` (framing, command ids, retries), the wire types (`msp.d.ts`) and
  errors. ADE does **not** use the `MuseClient`/`Session` facade: the facade owns
  the connection's single notification handler and hides events ADE needs
  (token usage, goals, todos, subagents). ADE folds the raw stream itself, like
  Codex.
- **Pinned binary, fetched not bundled.** The `muse` binary is not on npm. Each
  platform build is 330–470 MB, so ADE pins one exact build and fetches it into
  the shared agent-tools cache (`apps/ade-cli/src/services/tools`) with a sha256
  check, from Meta's versioned manifest
  (`https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=<v>&file=manifest.json`).
  The pin lives in `apps/ade-cli/scripts/muse-release.json` and is written by
  `npm run tools:muse-pin` (network) — the tools manifest generator stays
  offline. ADE never touches a user's own `muse` install and never lets the
  pinned copy self-update. SDK `X.Y.Z` pairs with `muse X.Y.Z-R…`; the pin
  script refuses a mismatch.
- **Starting pin:** SDK `1.4.7`, binary `1.4.7-R6101.1`, MSP schema fingerprint
  `sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9`.
- **Contributor mode is never offered.** Every `muse serve` and every CLI launch
  passes `--contributor-mode off` explicitly (the saved setting is ignored by
  `serve` in 1.4.6+, so omission is not enough).
- **Everything integrated.** Every MSP surface gets an ADE surface. Where Muse
  has a bug, ADE surfaces Muse's error instead of working around it.
- **All platforms**: macOS (arm64, x64), Linux (arm64, x64), Windows (x64; arm64
  build exists, ADE's tools targets cover win32-x64). Muse session messaging is
  unsupported on Windows; ADE hides only that control there.
- **Dependabot** watches `@muse-code/sdk`; the existing "Dependabot PR → its
  branch + agent" automation also runs `tools:muse-pin` for the bumped version.

## Facts (verified against muse 1.4.7-R6101.1)

- `clientInfo.name` must match `^[a-z0-9_]+$` → ADE sends `ade`.
- `initialize` returns `museHome` (`~/.local/share/muse`), `sessionDurability`
  (`durable`), `sandboxAvailability`, `grantedCapabilities`.
- Client capabilities: `userShell`, `sessionMcp`, `sessionListStream`,
  `feedback`, `computerUseSetup`, `computerUseHostSetup`.
- Sessions persist at `<museHome>/sessions/YYYY/MM/DD/<sessionId>/session.jsonl`.
- Auth: `muse login` (browser device code, Meta account) or `muse auth set
  --api-key-stdin`; `META_API_KEY` env always wins. Stored under
  `~/.config/muse/` (`auth.json`, `settings.json`).
- `muse serve` flags: `--provider echo|meta|local`, `--model`,
  `--contributor-mode`, `--no-session-log`, `-c KEY=JSON`, sandbox posture
  (`--disable-sandbox`, `--sandbox-network`, `--disable-write`,
  `--disable-shell`, `--trust-workspace`). Approval mode is per session on the
  wire, not a flag.
- `--provider echo` is a deterministic offline provider: use it for live tests.
- CLI: `muse [PROMPT]` (TUI), `muse resume <uuid|name>`, `muse resume --last`,
  `--model`, `--reasoning-effort none|minimal|low|medium|high|xhigh|max|ultra`,
  `--approval-mode untrusted|on-request|never`, `--yolo`, `--workspace`, `-w`.

## Permission mapping

New field `musePermissionMode` holds Muse's own `ApprovalMode`. Ladder (most
cautious first): `plan` → `denyUnmatched` (plus ADE plan-mode guidance),
`ask` → `promptUnmatched`, `auto-edit` → `onRequest` (Muse's default),
`full-auto` → `allowAll`. CLI flag mapping: `denyUnmatched`/`promptUnmatched` →
`--approval-mode untrusted`, `onRequest` → `on-request`, `allowAll` → `never`.

## MSP → ADE map

| MSP | ADE |
|---|---|
| `turn/start` (`ifBusy: queue`), `turn/steer`, `turn/interrupt`, `turn/cancel`, `turn/unqueue` | send, steer, interrupt, queued-message cancel |
| `item/*` `agentMessage` / `reasoning` / `toolCall` / `userShell` / `webSearch` / `compaction` / `hookRun` | `text`, `reasoning`, `tool_call`+`tool_result`/`command`/`file_change`, `web_search`, `context_compact`, `activity` |
| `item` `subagent` / `workflow` / `reminderChild` / `sideChat` | `subagent_started/progress/result`, workflow card, background reminder activity |
| `approval/requested` → `approval/decide` | `approval_request` card with Muse's server-minted choices |
| `userInput/requested` → `userInput/answer` | `structured_question` |
| `session/tokenUsage`, `session/contextUsage`, `usage/changed` | `tokens`, `context_usage`, provider usage meter |
| `session/todoListChanged` | `todo_update` |
| `session/goalChanged`, `goal/*` | goal banner + `/goal` |
| `session/compact`, `session/fork`, `session/rename`, `session/setModel`, `session/setReasoningEffort`, `session/setApprovalMode` | compact, fork/rewind, rename, model & effort & permission pickers |
| `skill/*`, `plugin/*`, `hook/list`, `task/*`, `recap/*`, `session/sideChat`, `session/userShell`, `subagent/*`, `workflow/*` | slash commands and their panels |
| `view/gap` → `view/page` | gap fill on dropped deliveries |

## Ownership while building

- Runtime (`chat/museSdk*.ts`, `agentChatService.ts` wiring, shared chat types,
  `hostSessionConfig`, `callerMcpServers`, `contextCompaction*`): lead.
- Distribution, auth, Settings provider card, Dependabot: track A.
- CLI mode (terminal launch, tracking, resume, external session discovery and
  import): track B.
- Model catalog and registry, renderer chat/work surfaces, ade-cli TUI, iOS,
  analytics, docs: track C.
