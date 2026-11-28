# DAEX MCP

Lets AI apps the person picks (claude.ai, ChatGPT, Cursor, VS Code, Claude Code,
Grok, scripts) run the DAEX CLI on any of their computers. The account has one
MCP server, reached through DAEX Relay (`apps/tunnel-relay`): any included
computer that is online answers its URL, and a call for another computer is sent
on to it ([Account server](#account-server)). Off until the person turns it on.

The main tool is **`daex`**: the words after `daex`, run as the real CLI on that
computer (a call to the old name `ade` still runs, but only `daex` is listed).
Every CLI command is available with no per-command MCP work. Beside it,
[typed tools](#typed-tools) take named inputs, and tools with a view return an
[MCP App](#mcp-apps).

Settings › You › DAEX MCP shows the account's state; its **Computers** card shows
which computers answer (with **Check again**).

## Source file map

All under `apps/ade-cli/src/services/remoteMcp/` unless noted.

| Path | Role |
|---|---|
| `remoteMcpService.ts` | The server: HTTP router (stateless Streamable HTTP, JSON answers), token checks (`authenticate`), OAuth endpoints, Settings actions. |
| `remoteMcpProtocol.ts` | MCP JSON-RPC: tools, the `daex://commands` resource, prompts, run limits. |
| `remoteMcpOAuth.ts`, `remoteMcpOAuthRoutes.ts`, `remoteMcpKnownApps.ts` | Stateless registration, redirect rules, PKCE, pending sign-ins and codes, the pages; which app a sign-in is. |
| `remoteMcpTools.ts` | Typed tools: inputs, argv, JSON trimming, `next` hints, result shapes, `printsAgentOutput`. |
| `remoteMcpCommandPolicy.ts` | Which commands each access level runs; argv splitting; log redaction. |
| `remoteMcpRunner.ts` | Runs the CLI as a child of the brain: no shell, role by access, timeout, output cap, tree kill. |
| `remoteMcpStore.ts`, `remoteMcpAccount.ts`, `remoteMcpShared.ts` | Connections in the account vault (hashes only) and the legacy-file migration; the account secret and settings keys; the machine's one service instance. |
| `remoteMcpForward.ts`, `remoteMcpHttp.ts`, `remoteMcpChatRouting.ts`, `remoteMcpProjects.ts` | The account's computers and forwarding; brain→relay requests, retry rules and the replay guard; chat-id routing; project resolution. |
| `remoteMcpEventHub.ts`, `remoteMcpEvents.ts`, `remoteMcpEventCatalog.ts`, `remoteMcpEventWebhooks.ts` | MCP Events: the in-memory hub, `events/*` and `events_poll`, types and cursor, webhooks. |
| `remoteMcpActivityLog.ts` | `<ade home>/remote-mcp/activity.jsonl` (512 KB, one rolled file). |
| `remoteMcpApps.ts`, `remoteMcpApp/` | The MCP App HTML (`npm run mcp-app:build` writes `app.generated.ts`; `mcp-app:check` fails when stale). |
| `remoteMcpContextBudget.test.ts`, `.json` | The context-size ratchet. |
| `apps/ade-cli/src/cliRemoteMcp.ts`, `cliChatInbox.ts` | `daex mcp` commands; `daex chat inbox`. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | `remoteMcp.call` behind `daex mcp` (operator only). |
| `apps/ade-cli/src/services/sync/syncTunnelClientService.ts`, `machineRelayTunnel.ts` | Control-socket `http` / `http_res` and `mcp_state`; attaching to the relay tunnel. |
| `apps/tunnel-relay/src/relay.ts`, `tunnelDo.ts`, `mcpAccountObject.ts`, `mcpMachineForwarding.ts`, `relayShared.ts` | Relay routes, account and endpoint objects, per-machine limits, replay-safe body check. |
| `apps/desktop/src/main/services/net/publicHttpsPost.ts` | Public-https-only POST (DNS pinned, no redirects) for chat and Events webhooks. |
| `apps/desktop/src/main/services/adeActions/actionPolicy.ts`, `apps/desktop/src/shared/adeActionAccess.ts` | `remote_mcp` is CTO-only, writes user-only, `createToken` secret-bearing. |
| `apps/desktop/src/shared/types/remoteMcp.ts` | Shared wire types. |
| `apps/desktop/src/renderer/components/settings/AdeMcpPage.tsx` | The Settings page (calls this desktop's brain with no pin; only Activity is per-computer). |
| `apps/desktop/resources/agent-skills/daex-mcp-client/SKILL.md` | The outside-bot walkthrough, served as an MCP prompt. |
| `evals/ade-mcp/` | Eval of how models use the tools; run it when tool text changes. |

## Gotchas / fragile areas

- **Never run `wrangler dev` on port 8787** on a machine with DAEX: the brain's
  sync listener uses it, and the phone loses relay.
- Cloudflare's bot check answers `error code: 1010` to some default user agents
  (Python `urllib`); test scripts must send one.
- **Deploy order:** push relay (accepts vault kind `ade_mcp`), then the tunnel
  relay, then DAEX. The vault uploads `ade_mcp` rows in their own batch
  (`NEWER_VAULT_KINDS`) so an older push relay holds back only those.
- Pending sign-ins and codes are in memory on one computer; an account-URL
  sign-in relies on the relay keeping the same front computer.
- Forwarding assumes all computers use the same relay URL; one on a custom
  `ADE_TUNNEL_RELAY_URL` answers only its own calls.
- The relay must pass `x-ade-mcp-call-id` through, or the target cannot tell a
  retry from a new call.
- Connections imported from a per-computer DAEX MCP, or made on a per-machine
  URL, reach only that computer (`onlyMachine`).
- The `ade_mcp` vault kind and `ade_mcp.*` settings are written only by the
  service in process; the `account_vault` / `account_settings` actions refuse
  them for every caller.
- **New CLI commands are off until classified.** A top-level command in neither
  `FULL_ACCESS_COMMANDS` nor `BLOCKED_COMMANDS` is refused;
  `remoteMcpCommandPolicy.test.ts` fails for an unclassified command.

## Account server

The person turns it on once (Settings, or `daex mcp on`) and gives an app
`https://<relay>/a/<accountKey>/mcp`. State lives in the account stores, never
the relay:

| Where | Key | What |
|---|---|---|
| Vault (`ade_mcp`) | `account-secret` | 32 random bytes. See [The account secret](#the-account-secret). |
| Vault | `connection:<id>` | `{id, kind, label, scope, tokenHash, tokenHint, createdAt, redirectHost, app, clientKey?}`; never the token. |
| Settings | `ade_mcp.enabled` | On/off for the account. |
| Settings | `ade_mcp.machine.<machineKey>` | `{name, endpointKey, included, version, serving, notServingReason, reportedAt, …}`, written by each computer for itself (any computer may set `included`). |
| Settings | `ade_mcp.lastUsed.<id>` | Last use, written at most every 10 minutes. |

`accountKey = hex(HMAC-SHA256(secret, "ade-mcp-account")).slice(0, 40)`
(`deriveRemoteMcpAccountKey`). The brain sends the secret in `mcp_state` and the
relay derives the key, so a brain joins only an account whose secret it holds.

A computer **serves** when it is signed in, DAEX MCP is on, it is included, it
has the secret, and it has a relay identity (`servingBlocker`). Otherwise it tells
the relay it is off. It reports why it does not serve
(`RemoteMcpNotServingReason`: `off_for_account`, `left_out`, `signed_out`,
`relay_disconnected` after 45 s, `account_vault_unreachable`,
`waiting_for_account_secret`) into its own entry when the state changes (at most
once a minute; starting to serve goes out at once). Other computers show that
report, overridden by rules that hold now (`older_ade`, `offline`). An entry that
never reported is "serving unknown" and calls are still tried.

### The account secret

The account URL is derived from the secret, so it must never change under an app.

- Only `setEnabled(true)` and the legacy migration may mint one, and they pull
  first and adopt an existing secret.
- `setEnabled(true)` succeeds only once the secret has uploaded; otherwise it
  fails with a sentence and leaves `ade_mcp.enabled` alone.
- `maintain()` on other computers never mints; it pulls (every minute while
  waiting) and reports `waiting_for_account_secret`. (Minting there once let two
  secrets race and killed a URL already handed out.)

**Tokens across computers.** Each computer checks a bearer against its own vault
copy. A miss forces a shared pull (at most one per 15 s; only for `ade_mcp_`
bearers). A hit on a copy older than 60 s starts a background pull. Revocation is
immediate where it happened and within about a minute elsewhere. Signing out
purges the copy.

**Migration.** A legacy `<secrets>/remote-mcp.json` is copied into the vault (same
ids and hashes) once signed in, then emptied. Old per-machine URLs keep working.

### Another computer

Every tool takes an optional `machine` (name or key from `machines_list`; unique
match only). On the account URL every result starts `[machine: <name>]`. A call
for another computer is resent to `https://<relay>/m/<endpointKey>/mcp` with the
app's own bearer and `x-ade-mcp-via`; the target checks the token and runs the
call under its own policy. No new trust between brains.

- One hop: a request with `x-ade-mcp-via` never forwards again.
- A computer that does not serve is refused with the sentence for its reason
  (`notServingSentence`); 401, 404 `ade_mcp_off`, 429 and 503 each have a
  sentence.
- **Retries** (once, inside the same deadline): always when nothing was sent
  (`ECONNREFUSED`, `ENOTFOUND`, …); after a reset only for read-only typed tools;
  never after a timeout. Every try carries `x-ade-mcp-call-id`, and the receiver
  answers a repeated (connection, call id) once for two minutes.
- Budget: the tool's timeout + 30 s, at most 10 minutes.
- `machine: "all"` on `projects_list`, `chat_list`, `inbox`, `usage_limits`,
  `lanes_list` runs on every included computer (six at a time, 60 s each) and
  returns one row per computer.
- Online state comes from the account directory (cached 15 s).

## Typed tools

Reads: `projects_list`, `lanes_list`, `lanes_show`, `files_tree`, `files_read`,
`files_search`, `diff_changes`, `diff_patch`, `git_status`, `prs_list`,
`prs_show`, `prs_checks`, `chat_list`, `chat_read`, `chat_status`, `chat_wait`,
`chat_events`, `proof_review`, `usage_limits`, `machines_list`, `inbox`,
`events_poll`. Writes (full access only): `chat_respond`, `chat_send`,
`chat_start`, `chat_update`, `chat_interrupt`, `lanes_create`, `files_write`,
`projects_clone`.

- **One command each.** A typed tool builds the argv of one CLI command and runs
  it through the same policy and runner as `daex`, so it can never exceed the
  connection's scope (`inbox` is `daex chat inbox`, `chat_start` is
  `daex chat launch --wait`). Free text goes as one `--flag=<text>` word.
- **Results** are `structuredContent` `{ project, result, next? }`, trimmed;
  chat results carry a `link` naming this computer and project. `next` is the
  next step, written where the model decides it. A `chat_wait` that times out is
  an answer, not an error.
- **Naming where things go.** `chat_start` requires `model` (full name; DAEX never
  picks one for an outside app) and, like `lanes_create`, `project` (and
  `machine` on the account URL). `chat_start` sends `full-auto` unless told
  otherwise and reports the chat's real settings; its `phase` is the chat's
  (`running`, `setting_up`, `failed`, `cancelled`).
- **A chat id finds its computer.** Chat tools without `machine` run here first;
  if the project has no such chat, `daex chat locate` asks every online computer,
  and the call reruns in the right project or forwards there, remembered per
  connection. Gone chats answer `state: "deleted"` (with `reopenable`) or
  `"not_found"`.
- **Knowing a chat finished.** `chat_events` answers what happened since a cursor;
  `chat_wait` defaults to 25 s. `chat_start`'s `notify_url` / `notify_token` arm a
  webhook (`chatWebhookRegistry.ts`, stored in `.ade/secrets/chat-webhooks.json`
  because the project database syncs) that POSTs on idle, needs-input or failure,
  retried about 13 minutes, for 7 days. The token travels on stdin. Only the brain
  running the chat posts.
- **Files.** `files_write` sends text on stdin, 256 KB per call; `offset` must
  equal the file size (appends cannot repeat). Answers `{path, bytes, sha256}`.
- **Proof.** `proof_review` runs `daex proof review --json` and returns frames
  plus a contact sheet or picture as an MCP `image` block (PNG/JPEG/WebP/GIF under
  the project's `.ade/cache` or `.ade/artifacts`, at most 2.5 MB). No video bytes
  cross MCP.
- **Secrets.** Agent- and shell-written output (chat transcripts, `terminal read`,
  `files search`, …) is masked with `redactOutgoingChatText` on the way out
  (`printsAgentOutput`). Read-only connections cannot read `.env` files.
- `projects_list` hides projects whose folder is gone (`include_missing` lists
  them).

`daex chat inbox` lists every chat and live agent CLI session in a project that
waits on the person, each item with its options and `requestId` (or an `ask`,
answered with `chat send`). `--all-machines` merges machines.

**Context budget.** `remoteMcpContextBudget.test.ts` measures `initialize`
instructions plus `tools/list` bytes per scope against
`remoteMcpContextBudget.json`; bigger or smaller both fail, so growth is a
reviewed JSON edit. Each rule is stated once, where the model reads it.

## Request path

```
AI app ──HTTPS──► tunnel-relay Worker ──► TunnelDurableObject(machineKey)
                   /m/<endpointKey>/mcp      │  {t:"http", rid, method, path, headers, body, mount?}
                   /a/<accountKey>/mcp       ▼  over the brain's existing control socket
                   (account object picks     brain: remoteMcpService.handleHttp
                    a member machine)        │  {t:"http_res", rid, status, headers, body}
AI app ◄────────────────────────────────────┘
```

- The relay holds no key and runs no DAEX logic. It answers early only when the
  machine is offline (503), off (404 `ade_mcp_off`, with `reason` `off` or
  `unknown_address` on the account route), or over limits (16 in flight, 300 a
  minute: 429, `mcpMachineForwarding.ts`).
- The account route tries the machine that answered last, then others newest
  first, moving on only when a machine was offline or off before the request
  reached it. A request lost with a closed control socket gets 503
  `x-ade-mcp-lost`, and the route retries elsewhere only for replay-safe bodies
  (`isReplaySafeMcpBody`: `initialize`, `ping`, lists and reads).
- The brain answers an account mount only for its own derived key while serving.
- A brain sends `mcp_state` (`{enabled, endpointKey, account?: {secret}}`) on
  every control open and on change; `account` is present only while serving.
- **URLs never contain the relay key.** The per-machine endpoint key is derived
  from the relay secret (`mcpEndpointKeyFor`), so an MCP URL cannot open `/connect`
  tunnels.

Routes (on both `<base>` = `https://<relay>/a/<accountKey>` and
`…/m/<endpointKey>`): `<base>/mcp` (POST only), RFC 9728 and RFC 8414 metadata
under `/.well-known/`, `<base>/oauth/register`, `<base>/oauth/authorize`,
`<base>/oauth/token`, the fixed `https://<relay>/oauth/callback` (routed to the
computer that started the sign-in), and `/m/<endpointKey>/oauth/consent`.

## Signing in

Both ways end in a **connection**: label, access level, and a token whose SHA-256
is in the vault. Tokens do not expire; revoke in Settings or `daex mcp remove`.
At most 50 connections per account; signing in again from the same registration
and return address replaces the old connection.

1. **Web sign-in.** The app registers (stateless: the client id is `ade1.` +
   base64url of its redirect URIs and name) and opens `<base>/oauth/authorize`.
   `recogniseRemoteMcpApp` names known apps from the redirect URI (and from the
   registered name only for loopback and app schemes); an unknown HTTPS app shows
   with its host and no logo. **Continue with DAEX** runs Clerk sign-in (public
   "DAEX CLI" client `Az7TbviBocyXjZk1`, PKCE) back to the relay's fixed callback.
   The brain redeems the code with a verifier only it holds and checks the
   subject is this computer's account (`verifyClerkAccountAttestation`). The
   person picks **Read & write** or **Read only** and allows; the token is minted
   at the code exchange. A per-machine URL grants `onlyMachine`.
2. **Token**: Settings › New token, or
   `daex mcp token create --read-only|--full-access` (access required). Shown once.

The relay cannot mint access: it never holds the PKCE verifier and never issues
tokens. Redirect URIs: HTTPS, loopback HTTP, or an app scheme; never
`javascript:`/`data:`/`file:` or fragments. Sign-ins last 10 minutes (20
waiting); codes 2 minutes, single use. Signing in as a different DAEX account is
refused.

## Access levels

| Level | Runs | CLI role |
|---|---|---|
| Read & write (default) | `FULL_ACCESS_COMMANDS`, minus the refusals below | `cto` |
| Read only | `describeReadOnlyCommands()` plus `daex actions run` for actions declared `read` that return no secret | `agent` |

Refused at every level (they would outlive or bypass the grant, or cut the
connection):

- commands `mcp`, `account`, `login`, `logout`, `connect`, `setup`, `reset`,
  `brain`, `serve`, `runtime`, `rpc`, `code`, `desktop`, and `machines`
  subcommands other than `list`/`show`;
- signing services in or out (`github app-auth login|clear`, `jira
  connect|disconnect`, `integrations connect`, provider account removal) and the
  matching credential actions through `daex actions`, plus `remote_mcp.*`, most
  `account.*`, and `actions call|direct|tool`;
- `daex android start --restart-adb` (and `restartAdb: true`);
- opening Simulator.app (`--window`, `--foreground`, `--open-simulator`, and the
  matching `ios_simulator` action flags);
- a first word that is not a plain command word (`--socket`, `--role`, …);
- `--machine`, `--all-machines`, `--machine-project`, and `--to` on chat
  handoff/move (use the tools' `machine` input), with one exception: exactly
  `--machine cloud` (and `--size`) on `chat create`, `lanes create` and
  `chat launch-status` (`isCloudLaneMachineUse`);
- `daex devices use`.

Read only also refuses `search --rebuild` and `chat wait --async|--background|--cancel`,
and allows `--help` only as the last word after plain words. A read-only
connection can only list lane shares; a full-access one can make Watch shares
only (at most 5 an hour; [lane sharing](../lanes/lane-sharing.md#shares-made-by-an-agent)).

The blocklist stops obvious routes, not a determined app: full access is real.
Revoking stops new calls, not what already ran.

## Running a command

- The brain spawns its own CLI entry with `process.execPath` (or the native
  binary), never a shell or a `.cmd` / `.ps1` shim, `--socket` first and
  `ADE_DEFAULT_ROLE` from the access level. The child does not inherit the
  brain's own lane or chat identity (`brainInheritedIdentity.ts`).
- `cwd` is the `project` argument or the most recently opened project whose
  folder exists (`projectFolderPresence.ts`, 250 ms budget). Every result starts
  `[project: <name> · <id> · <path>]`. Ambiguous names are refused.
- The child gets `ADE_REMOTE_MCP_CONNECTION_ID`, `…_LABEL` and `…_SCOPE` (named
  `ADE_*` for historical reasons): the CLI trims its help to the scope, hides
  personal skills, and labels chat turns "via <label>".
- stdin is closed unless the call passes `stdin` (256 KB max); stdin-reading
  commands are refused without it.
- 120 s default (5–600 s), then a process-group kill; 200 KB per stream; at most
  4 runs per machine and 3 per connection. Runs past 20 s log
  `remote_mcp.slow_run`.
- Failures come back as `isError: true` results with an actionable sentence;
  typed tools know their commands' non-error exit codes.

## Resources and prompts

`daex://commands` (`ade://commands` still reads) is `daex help --json` for the
connection's scope, cached five minutes.

The project's skills are MCP prompts (`prompts/list` for the default project,
`prompts/get` with `project`), from `agentSkillCatalogService`. **Personal skills
in the home folder never reach a connected app** (compared by real path).

DAEX Cloud guidance arrives through the `daex-cloud` prompt (only for accounts
with DAEX Cloud). An app counts as an unattended agent: held to agent limits, and
on the Free plan the server refuses its create, start, resize, copy, move and
message with 403 `outside_agent_free_plan`. See
[Guidance for agents](../ade-cloud/README.md#guidance-for-agents).

## MCP Apps

Hosts that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
show a tool result as a small DAEX view; others get the same text and
`structuredContent`.

- One self-contained HTML app (`ui://ade/app-<hash>.html`, no network); any
  `ui://ade/app*.html` read returns today's HTML.
- Tools with a view carry `_meta.ui.resourceUri`: `inbox`, `chat_list`,
  `chat_read`, `chat_respond`, `chat_send`, `chat_start`, `prs_*`, `lanes_list`,
  `diff_*`, `usage_limits`, `machines_list`. Unknown results render as a
  key/value card.
- The inbox view answers in place through `chat_respond` / `chat_send`; read-only
  connections see disabled buttons.
- Everything uses `textContent`; links open only `https:`, `http:` and `ade:`;
  messages are accepted only from the host frame.

## Events (SEP-3415)

`initialize` advertises `io.modelcontextprotocol/events` (and a top-level
`capabilities.events` for pre-SEP clients).

| Event | When |
|---|---|
| `chat.turn_ended` | A turn completed, failed or was interrupted; carries the final reply (≤ 4,000 chars, secrets removed) and errors (`httpStatus` for provider refusals). |
| `chat.needs_input` / `chat.input_resolved` | A chat waits on an approval, question or secret / that was settled. |
| `chat.deleted` | A chat or tracked provider CLI was deleted. |
| `pr.changed` | A PR opened, closed, merged, reopened, or its checks or reviews changed. |

Arguments: `project`, `machine`, and for chat events `session`,
`include_subagents` (`include_reply` on `turn_ended`).

- **Source**: each project runtime feeds `remoteMcpEventHub.ts` (newest 1,000
  events, in memory); titles and replies are read when an app reads the event.
- **Poll**: `events/poll` asks every reachable machine (others via a hidden
  forwarded call); the cursor holds one position per machine. `nextPollMs` is
  15 s; machines that did not answer are listed in
  `_meta["dev.ade/unreadMachines"]`. `events_poll` is the same as a tool for
  clients without Events.
- **Gaps**: a restart or more than 1,000 events gives `truncated: true` once (a
  webhook gets a `gap` envelope).
- **Webhooks**: `events/subscribe` checks the URL (public https) and `whsec_`
  secret, sends a signed verification, and stores the subscription in the
  account vault; each machine POSTs its own events (Standard Webhooks signing,
  DNS-pinned, 10 s per POST, retries at 30 s, 1, 2, 4 minutes). TTL 1 minute to
  1 day (default 1 hour). A webhook body's `eventId` equals `webhook-id` for
  draft-era clients.
- DAEX MCP speaks protocol `2025-11-25`, so SDKs built on the final SEP
  (`2026-07-28`) see no Events yet. `events/stream` answers `Unsupported`.

## Chat turns from an app

A message an app sends carries `metadata.remoteMcp = { connectionId, label }` and
shows "via <label>". It is still a person-side message (it clears attention).
This is provenance, not a boundary. `serverInfo.name` is `daex` and
`serverInfo.version` is DAEX's version.

## Cost

Per call: one Worker request, one Durable Object request, and Durable Object time
while the command runs. An idle machine adds nothing; the control socket
hibernates.
