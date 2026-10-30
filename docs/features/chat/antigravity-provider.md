# Antigravity provider

ADE runs Google's official Antigravity ACP agent, `agy_acp_server` (ACP
registry id `antigravity-acp`), as a chat provider on the shared ACP host
([acp-providers-spec.md](acp-providers-spec.md)). It is ACP-only: Google ships
no terminal CLI for it, so there is no Antigravity terminal, CLI session, or
terminal login.

## Where things live

| Piece | File |
|---|---|
| Dialect (spawn plan, capabilities, mode mapping) | `apps/desktop/src/main/services/chat/acpHost/acpDialects/antigravity.ts` |
| Captured `initialize` (1.4.1) | `apps/desktop/src/main/services/chat/acpHost/fixtures/antigravity.initialize.json` |
| Per-launch temp directories | `apps/desktop/src/main/services/chat/acpHost/acpScratchDirs.ts` |
| Signed-in check, credential environment, ADE's own settings | `apps/desktop/src/main/services/ai/antigravityAuth.ts` |
| Sign-in runner (`authenticate`, URL capture, return-URL forwarding) | `apps/desktop/src/main/services/ai/antigravitySignIn.ts` |
| Settings sign-in panel | `apps/desktop/src/renderer/components/settings/providers/bodies/AntigravitySignIn.tsx` |
| Pin (tool `antigravity`) | `apps/ade-cli/scripts/pins/antigravity.json`, tools manifest |

## The pinned copy

The tools cache entry `antigravity` is a flat zip from `dl.google.com`:
`agy_acp_server.par` and `localharness_external` (`.exe` for both on Windows),
which must stay siblings. ADE computes and commits the SHA-256 of each target's
zip. Resolution is the same as every ACP provider (env override
`ANTIGRAVITY_ACP_EXECUTABLE` for development, then the current pin, then the
previous pin); a miss starts the download and shows "Downloading Antigravity
for this machine…". A machine with no Google build (for example Intel macOS if
Google drops it) shows "not available on this machine". The status row and
Download/Retry come from the generic pinned-tool actions
(`ai.pinnedToolStatus` / `ai.pinnedToolDownload`).

## Spawn

- Command: the pin's `agy_acp_server`, plus `--uid=` on Linux (the ACP
  registry's launch line; without it a root launch switches to `nobody`).
- `ANTIGRAVITY_HARNESS_PATH` = the pin's `files.harness`.
- `TMPDIR` (`TEMP` and `TMP` on Windows) = `<os temp>/ade-agent-tmp/<ADE pid>-antigravity-<random>`.
  The server unpacks itself there on every launch. The ACP connection creates
  the directory before the spawn and deletes it when the process exits. A
  force-killed ADE leaves it behind, so the desktop app sweeps directories
  whose owning ADE process is gone a minute after start, and every process
  sweeps once before its first launch.
- `GEMINI_HOME` is left alone: the default `~/.gemini` (or the user's own
  `GEMINI_HOME`) is the login every client of this agent shares. ADE never
  writes there.
- `BROWSER` = a command that exits 0 and opens nothing (`/usr/bin/true`;
  `cmd.exe /d /c exit 0` on Windows). Python's `webbrowser` falls through to
  the OS browser when a `BROWSER` entry fails, so a failing command would still
  open a browser on a headless machine. ADE reads the sign-in URL from stderr.
- Google credential variables (`GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`/`LOCATION`, …) are
  removed, and only the method the agent recorded in its own `settings.json`
  gets its variables back (`antigravityCredentialEnv`). An ambient key cannot
  decide which account a chat bills.

## Capabilities (verified 2026-10-18, 1.4.1, macOS arm64, signed out)

- ACP v1. `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`,
  `agent-platform`, all agent-driven (no terminal method).
- `loadSession` and `sessionCapabilities.resume` and `list`; no `close`, so
  each chat owns its own process (`oneProcessPerSession`, `kill_process`), and
  rejoin is resume-preferred.
- Image prompts, MCP http and sse. `auth.logout` is advertised; ADE hides the
  agent's `/logout` from the slash picker because it signs out every client on
  the machine.
- Unauthenticated `session/new` is `-32000 Authentication required`.
- From the 1.4.1 sources (needs a login to exercise): models are the `model`
  config option (plus `thinking_level`, which ADE uses for reasoning effort);
  modes are `default`, `auto_edit`, `yolo`.

ADE's gates follow from this:

- **Plan mode is unavailable.** The agent has no read-only mode; its own
  `/plan` command plans. The permission picker offers Ask, Accept edits and
  Full access; a Plan request runs at Ask with a one-time note.
- **No rewind or edit of earlier turns.** Continue with a follow-up or start a
  new chat.
- **Subagents** show as tool activity (no subagent capability row).
- **One-shot tasks** (naming, summaries) have no Antigravity runner yet; a
  task configured with an Antigravity model falls through to OpenCode, like
  Devin's (open follow-up).
- **No usage limits.** ADE does not call Google's private quota APIs.

## Sign-in

Sign-in is an explicit action in Settings > Providers > Antigravity and runs on
the machine the Settings page shows. The runtime actions `ai.antigravitySignInStatus`,
`ai.antigravitySignInStart`, `ai.antigravitySignInComplete` and
`ai.antigravitySignInCancel` are reachable remotely (action domain `ai`,
`actionPolicy` remote list, `adeActionAccess` tiers); preload methods take
`pin` and go through `callPinnedOrBoundRuntimeActionOr`; the panel passes
`useSettingsMachineScope().pin` and keys its read on `pin?.key`. Start, status
reads, the pasted address and cancel all go to that one machine.

The runner spawns the pinned agent with the chosen method's credentials,
sends `authenticate({ methodId })`, and proves the login with one
`session/new`. The agent saves the method in its own `settings.json`, so later
chats need no `authenticate`. A flow times out after five minutes; Cancel ends
it and the agent.

| Method | What ADE does |
|---|---|
| Google account (`oauth-personal`, default) | The agent prints `Open the following link to authenticate the ACP server: <url>` and waits for Google's redirect to its `127.0.0.1` listener. On this computer ADE opens the URL; the browser lands on the listener by itself. |
| Gemini Enterprise (`oauth-business`) | Same browser sign-in, then the agent's own license page (served on that machine's loopback; it opens only in a browser there). The agent records the project and location itself. |
| Gemini API key (`gemini-api-key`) | `GEMINI_API_KEY` from ADE's key store (the key sheet on the Antigravity page, slot `antigravity-gemini`), passed only for this method. |
| Agent Platform (`agent-platform`) | `GOOGLE_API_KEY` from ADE's key store (slot `antigravity-agent-platform`), or the machine's ADC variables plus a project and location ADE keeps in `<ADE home>/providers/antigravity.json`. |

**Another machine.** When the Settings page shows a remote machine (or the web
client), Google's last page will not load in the user's browser, because the
listener is on the machine that runs the agent. The panel shows the URL to open
anywhere and a "paste the full return address" field. ADE accepts the pasted
address only when it is `http`, the same `127.0.0.1` host, port and path as the
agent's `redirect_uri`, carries the same single `state`, and one Google
response (`code` or `error`); it then forwards exactly that request to the
listener on that machine. The URL, `state`, `code` and tokens are never logged:
the ACP connection redacts OAuth query values from stderr lines and error
tails.

## Signed-in status without a spawn

`inspectAntigravityCredentials` reads the agent's `settings.json` (`auth.type`,
mtime-cached) and then:

- Google account / Gemini Enterprise: `antigravity-acp/acp_token.json` or
  `acp_business_token.json`; on macOS, when that file is absent, whether the
  login keychain has the agent's item (service `gemini`, account
  `antigravity-acp` or `antigravity-acp-business`). `security
  find-generic-password` without `-w` reads attributes only: no secret, no
  prompt. Cached for 30 seconds.
- Gemini API key: a key in ADE's store or the environment.
- Agent Platform: a key, or a project and location from any source.

On macOS the agent keeps its token in the keychain whenever a default keychain
works (file elsewhere). ADE does not set `AGY_ACP_FORCE_FILE_STORAGE`: forcing
the file would split ADE's login from the one other clients of this agent read
on a Mac and would move the token out of the keychain into a plaintext file. A
user who sets it keeps it.

The ACP auth probe runs only when the pin is on disk. It checks `session/new`
and never sends `authenticate` (every method would open a browser sign-in).
The `agy` CLI's and the Antigravity app's logins are separate and not reused.

## Surfaces

Settings descriptor and logo (LobeHub's Antigravity mark, the one the editor
menu uses), model picker rail, `ade chat models --provider antigravity`, the
web client (through the same actions), and iOS (`WorkModelCatalog.swift` group and label,
provider label/color; a CLI launch with an Antigravity model is refused).
