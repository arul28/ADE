# ADE MCP

Lets AI apps the person picks (claude.ai, ChatGPT, Cursor, VS Code, Claude
Code, Grok through its API, scripts) run the `ade` command on any of their
computers. The ADE account has one MCP server, reached through ADE Relay
(`apps/tunnel-relay`): any included computer that is online answers its URL,
and a call for another computer is sent on to it (see
[Account server](#account-server)). Off until the person turns it on for the
account.

The server's main tool is **`ade`**: the words after `ade`, run as the real
CLI on that computer. Everything the CLI can do is available with no
per-command MCP work, and new CLI commands appear on their own.

Next to it, **typed tools** take named inputs a client can check before
calling. See [Typed tools](#typed-tools). Tools with a view come back as an
**MCP App** in hosts that show them; see [MCP Apps](#mcp-apps).

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/remoteMcp/remoteMcpService.ts` | The server: HTTP router (stateless Streamable HTTP, JSON responses), token checks, OAuth endpoints, Settings actions. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpProtocol.ts` | MCP JSON-RPC for a signed-in connection: tools (`ade` and the typed tools), the `ade://commands` resource, prompts, project resolution, run limits. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpOAuth.ts` | Stateless client registration, redirect URI rules, authorize request parsing, PKCE, pending sign-ins and authorization codes, the sign-in and allow pages. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpTools.ts` | The typed tools: inputs, the argv each builds, how its JSON is trimmed, its `next` hint, and its result shape. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpContextBudget.test.ts`, `.json` | The context-size ratchet. |
| `apps/ade-cli/src/cliChatInbox.ts` | `ade chat inbox`, the command behind the `inbox` tool. |
| `evals/ade-mcp/` | The eval of how models use these tools. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpCommandPolicy.ts` | Which commands run at each access level; the read-only allowlist; argv splitting; log redaction. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpRunner.ts` | Runs the CLI as a child of the brain: no shell, `--socket`, role by access level, timeout, output cap, process-tree kill. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpStore.ts` | The account's connections in the account vault (token hashes only); reading the per-computer `remote-mcp.json` from before accounts, for the migration. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpAccount.ts` | The account secret and account key, and the account settings keys (`ade_mcp.enabled`, each computer's entry, last used). |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpForward.ts` | The account's computers (settings entries + account directory), and sending a tool call on to another one. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpActivityLog.ts` | `<ade home>/remote-mcp/activity.jsonl`, capped at 512 KB with one rolled file. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpShared.ts` | The machine's one service instance, built on the machine's shared account vault and settings stores. |
| `apps/ade-cli/src/services/sync/syncTunnelClientService.ts` | Control-socket messages `http` → `http_res`, and `mcp_state` (on/off) to the relay. |
| `apps/ade-cli/src/services/sync/machineRelayTunnel.ts` | Attaches the service to the machine's relay tunnel. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | `remoteMcp.call`, the machine method behind `ade mcp` (operator only; never a chat-bound agent). |
| `apps/ade-cli/src/cliRemoteMcp.ts` | `ade mcp` commands and their `--text` output. |
| `apps/tunnel-relay/src/relay.ts`, `tunnelDo.ts` | `/m/<endpointKey>/…` and OAuth discovery routes; endpoint-key → machine mapping; forwarding over the control socket; limits; CORS. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | `remote_mcp` action domain (Settings). |
| `apps/desktop/src/main/services/adeActions/actionPolicy.ts`, `apps/desktop/src/shared/adeActionAccess.ts` | `remote_mcp` is CTO-only; its writes are user-only (desktop clients); `createToken` is secret-bearing. |
| `apps/desktop/src/shared/types/remoteMcp.ts` | Wire types shared by the brain, preload and Settings. |
| `apps/desktop/src/renderer/components/settings/AdeMcpPage.tsx` | Settings → You → ADE MCP, the account's page. It calls this desktop's own brain with no pin: everything on it is the account's except Activity, which is this computer's. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpApps.ts`, `remoteMcpApp/` | The MCP App: one self-contained HTML view (`ui://ade/app-<hash>.html`) and the `_meta.ui` the tools carry. Its source is the TypeScript modules and `app.css` in `remoteMcpApp/` (entry `app.ts`); `npm run mcp-app:build` (`scripts/generate-remote-mcp-app.mjs`, an esbuild bundle) writes `app.generated.ts`, and `mcp-app:check` (run by `pretest`) fails when it is stale. |

## Account server

ADE MCP is one server per ADE account. The person turns it on once (Settings →
ADE MCP, or `ade mcp on`) and gives an app one URL,
`https://<relay>/a/<accountKey>/mcp`. Any computer of the account that is
serving can answer that URL, and a call can name the computer it runs on.

What makes it one server lives in the account stores, never in the relay:

| Where | Key | What |
|---|---|---|
| Vault (scope `all`, kind `ade_mcp`) | `account-secret` | 32 random bytes, base64url. Made by the first computer that turns ADE MCP on (after a fresh pull, so a second computer adopts the first one's). If two make one at the same moment, the vault keeps one and every computer derives from the vault's current value on its next pull. |
| Vault | `connection:<id>` | One connection: `{id, kind, label, scope, tokenHash, tokenHint, createdAt, redirectHost, clientKey?}`. Never the token. |
| Settings (scope `all`) | `ade_mcp.enabled` | On or off for the whole account. |
| Settings | `ade_mcp.machine.<machineKey>` | `{name, endpointKey, included, version, updatedAt}`. Each computer that runs this code writes its own name, per-machine endpoint key and version while ADE MCP is on, and only when one of them changed (after a pull, keeping `included`). Any computer may set another's `included` from Settings; the owner reads it. |
| Settings | `ade_mcp.lastUsed.<id>` | When a connection was last used, written at most every 10 minutes per connection per computer. Settings shows the newest. |

`accountKey = hex(HMAC-SHA256(key = utf8(secret), msg = "ade-mcp-account")).slice(0, 40)`
(`deriveRemoteMcpAccountKey`). The brain sends the secret, not the key, in
`mcp_state.account`; the relay derives the key itself, so a brain can join
only an account whose secret it holds.

A computer **serves** (answers both URLs) when it is signed in, ADE MCP is on
for the account, it is not left out, the vault holds the secret, and it has a
relay identity. Otherwise it tells the relay it is off and the relay answers
404 for it. A signed-out computer never serves: ADE MCP always needed the
account for sign-in.

**Tokens across computers.** Each computer checks a bearer against its own
copy of the vault (`remoteMcpService.authenticate`):

- A miss pulls the vault and looks again. The pull is forced (a token made on
  another computer seconds after this one's last pull would otherwise stay
  unseen), shared by concurrent misses, and at most one per 15 s whatever the
  tokens. A bearer without the `ade_mcp_` prefix never pulls.
- A hit starts a background pull when this computer's copy is older than 60 s.
  **Revocation bound:** revoking on one computer refuses the token there at
  once; another computer refuses it within about a minute of its last pull,
  plus the one request that starts the pull. While ADE MCP is on, an idle
  computer still pulls at least every 5 minutes.
- Signing out purges the vault copy (a project runtime does it), so its
  tokens stop at once on that computer.

**Migration.** A computer with a `<secrets>/remote-mcp.json` from before
accounts copies its connections into the vault on start once it is signed in
and the vault answers, with the same ids and hashes, so their tokens keep
working. It turns `ade_mcp.enabled` on if it was on locally and the account
has no value yet, then empties the file and marks it migrated. Old app configs
with the per-machine URL keep working: that URL is still served, and it is the
forwarding target.

**Another computer.** Every tool takes an optional `machine` (a name or key
from `machines_list`). With none, or this computer, the call runs here; on the
account URL the result still starts with `[machine: <name>]`, because any
computer may have answered. Another computer gets the same `tools/call`
(with `machine` removed) at `https://<relay>/m/<its endpointKey>/mcp`, with the
app's own bearer, `content-type` and `accept: application/json`,
`mcp-protocol-version`, a real `user-agent`, and `x-ade-mcp-via: <this
computer's name>` (URL-encoded). The target checks the token against its own
vault copy and runs the call under its own policy: no new trust between
brains, the token is the account's. Its answer comes back as it is, with a
first text line `[machine: <name>]` and `structuredContent.machine = {key, name}`.

- One hop: a request with `x-ade-mcp-via` never forwards again; naming a third
  computer there is refused with a sentence that says so.
- Before forwarding, the sender refuses with a sentence the model can act on:
  a computer with no entry ("ADE on <name> is older and can't take account
  calls yet. Update ADE there."), one left out, or one the directory shows
  offline. A target that answers 401 (an older ADE whose own store does not
  know account tokens, or a token it has not pulled yet) gets "update ADE
  there; if it was just set up, try again in a minute". The relay's 404
  `ade_mcp_off`, 429 and 503 have their own sentences.
- Budget: the tool's own timeout + 30 s, at most 10 minutes.
- `machine: "all"` on `projects_list`, `chat_list`, `inbox`, `usage_limits` and
  `lanes_list` runs on every included computer, six at a time with 60 s each,
  and returns `{machines: [{machine, ok, result | error}]}`; one failing
  computer is one row.
- Online state comes from the account directory, read at most every 15 s
  (5 s after a failure); when it cannot be read, computers show online
  "unknown" and calls are still tried.
- Activity: the sender logs `forwardedTo`, the target logs `via`.

`machines_list` returns the account's computers: name, key, online, included,
serving, supported (runs this code) and which one is answering.

## Typed tools

Reads: `projects_list`, `lanes_list`, `lanes_show`, `files_tree`, `files_read`,
`files_search`, `diff_changes`, `diff_patch`, `git_status`, `prs_list`,
`prs_show`, `prs_checks`, `chat_list`, `chat_read`, `chat_status`,
`chat_wait`, `usage_limits`, `machines_list`, and `inbox`, the attention
loop. Without `project`, `inbox` reads each project opened on the computer in
the last 30 days (at most six, two at a time, in one run slot) and tags every
item with its project; `chat_start` without `provider` or `model` starts on the
model the computer last launched a chat with (`chat-launch-defaults.json`).

Writes, which are listed only for full-access connections: `chat_respond`
answers a question or approval, `chat_send` messages or steers a chat, and
`chat_start` starts a chat on a new lane. A read-only connection that calls
one anyway is refused with the reason, before anything runs.

- **One command each.** A typed tool only builds the words of one `ade`
  command. The service runs it through the same policy check and runner as
  the `ade` tool, so a typed tool can never do more than the connection's
  scope. Every typed tool is a CLI command too: `inbox` is `ade chat inbox`,
  `chat_respond` is `ade chat respond`, `chat_send` is `ade chat send`, and
  `chat_start` is `ade chat launch --wait`. Free text goes as one
  `--flag=<text>` word, so text that looks like a flag stays text.
- **Results.** Each tool asks the CLI for JSON and returns `structuredContent`
  as `{ project, result, next? }`. `result` is trimmed (the CLI's `prs list`
  and `chat list` run past a megabyte), and its shape per tool is noted in
  `remoteMcpTools.ts`, because the ADE MCP app renders it. Chat results carry
  a `link` that opens the chat in ADE.
- **Guidance lives in results.** `next` is the next step, written where the
  model decides it (T3 Code's lesson, pingdotgg/t3code#24782). A running
  `chat_status` says "chat_wait returns when it is done". A `chat_wait` that
  timed out says to call it again. An empty `inbox` says nothing waits. A
  `chat_respond` names what it approved or answered. A `chat_wait` that ends
  without the state (timed out, waiting on the person, no such chat yet) is
  an answer, not an error.
- **A chat id finds its computer.** `chat_read`, `chat_status`,
  `chat_wait`, `chat_send` and `chat_respond` without `machine` run here
  first. When the answer says this computer has no such chat, the service runs
  `ade chat locate` (every online computer is asked, read-only), forwards the
  call to the one that has it with the app's own token, and remembers that
  computer for the chat, so the next call goes straight there. A call that was
  itself forwarded is answered where it landed (one hop). An `onlyMachine`
  connection, or a computer left out, gets a refusal that names where the
  chat is.
- **Text is short.** Each rule is stated once, where the model reads it when it
  decides. The project rule lives in the instructions and in the `project`
  input. `projects_list` and `usage_limits` answer for the whole computer and
  take no `project`. Hints the MCP spec already defaults are left out.

`ade chat inbox [--json|--text]` lists every chat in the project that waits on
the person. It composes `session.list` (the Work rows, with their needs-you
signals) with `chat.listPendingInputs` for up to 12 chats. An item is one
question, approval or plan, with its options inline and the `requestId` that
`chat respond --item` takes, or an `ask` (from `ade chat ask`), which has no
card and is answered with `chat send`. `--all-machines` merges every
machine's inbox. The inbox covers one project; `attention.*` is CTO-only, so a
read-only connection cannot read across projects.

### Context budget

`remoteMcpContextBudget.test.ts` measures what an app pays before it does
anything: the `initialize` instructions and the `tools/list` JSON, in bytes,
for each scope, with the machine router in place, as a signed-in brain serves
them. It compares them with `remoteMcpContextBudget.json`. A bigger number
fails. A smaller one also fails and asks you to lower the baseline, so cuts
stay cut. Growth on purpose means editing the JSON in the same change, where
review sees it. After this change, write scope went from 14,130 bytes (18
tools) to the number in the JSON, now with 23 tools, the machine input and
the MCP Apps `_meta`.

### Eval

`evals/ade-mcp/` replays realistic outside-agent requests against the real
tool text over a fake stdio server, drives `claude -p`, and grades the tool
calls. Its README says how to run it, what it costs, and when to add a case.
Run it when you change tool text.

## Request path

```
AI app ──HTTPS──► ade-tunnel-relay Worker ──► TunnelDurableObject(machineKey)
                   /m/<endpointKey>/mcp        │  {t:"http", rid, method, path, headers, body, mount?}
                   /a/<accountKey>/mcp         ▼  over the brain's existing control socket
                     (account object picks     brain: remoteMcpService.handleHttp
                      a member machine)        │  {t:"http_res", rid, status, headers, body}
AI app ◄──────────────────────────────────────┘
```

- The relay holds no key and runs no ADE logic. It answers early only when the
  machine is offline (503), has the feature off (404 `ade_mcp_off`, from
  the control socket's `mcp` flag, so a disabled machine is never woken), or is
  over its limits (16 requests in flight, 300 a minute: 429). It forwards a
  short list of request headers (including `x-ade-mcp-via`) and returns a
  short list of response headers.
- The account route reads the account object (`mcp-account:<accountKey>`:
  member machines and the one that last answered), tries that one first and
  the others newest first, and moves on only when a machine is offline or off
  before the request reached its brain. It marks the message with
  `mount: {kind: "account", key}`.
- The brain answers an account mount only when the key is its own derived
  account key and it is serving; otherwise 404 `ade_mcp_off`. A malformed
  `mount` gets 400. No `mount` is the per-machine URL.
- The control socket is the one the brain already keeps for phones, so an idle
  machine costs nothing extra. There is no session object and no second socket.
- A brain sends `mcp_state` on every control open and whenever serving or the
  account secret changes: `{t: "mcp_state", enabled, endpointKey, account?:
  {secret}}`. `account` is present only while serving; leaving it out takes
  the machine off the account. An older relay ignores `account` (an older one
  still, the whole message); an older brain never sends it.
- **Deploy order:** push-relay first (it must accept the vault kind `ade_mcp`,
  or the account secret and connections never leave the computer that made
  them), then the tunnel relay (account routes), then the app.

**The URLs never contain the relay key.** The per-machine one uses an endpoint
key the brain derives from its relay secret (`mcpEndpointKeyFor`) and registers
with each `mcp_state` over its signed control socket; the relay's
`mcp-endpoint:<key>` object maps it to the machine (first writer wins). The
account one uses the account key. Handing either URL to an AI app therefore
cannot open `/connect` tunnels or use up a machine's phone slots.

URLs, with `<base>` = `https://ade-tunnel-relay.arulsharma1028.workers.dev/a/<accountKey>`
(the account) or `…/m/<endpointKey>` (one computer). Every route below answers
on both; OAuth metadata names the base the request came on.

| URL | What |
|---|---|
| `<base>/mcp` | MCP endpoint. POST only (stateless; GET/DELETE → 405). |
| `/.well-known/oauth-protected-resource/a/<accountKey>/mcp` | RFC 9728 metadata (also `<base>/.well-known/oauth-protected-resource`, and the `/m/<endpointKey>` forms). |
| `/.well-known/oauth-authorization-server/a/<accountKey>` | RFC 8414 metadata; issuer is `<base>`. `openid-configuration` answers the same. |
| `<base>/oauth/register` | Dynamic client registration. |
| `<base>/oauth/authorize` | Start page; Continue with ADE. |
| `https://<relay>/oauth/callback` | ADE sign-in returns here; routed to `/m/<endpointKey>/oauth/account-callback` of the computer that started it. |
| `/m/<endpointKey>/oauth/consent` | The allow page posts here, on the computer holding the sign-in. |
| `<base>/oauth/token` | Code → token. |

## Signing in

Two ways, both ending in a **connection** of the account: a label, an access
level and a token whose SHA-256 is stored in the account vault. The token
works on every included computer. Revoking deletes the record; the token
fails at once on the computer that revoked it and within about a minute on
the others (see **Account server**).

1. **Web sign-in** (claude.ai, ChatGPT, Cursor, VS Code, Claude Code): the app
   registers itself (dynamic registration) and opens `<base>/oauth/authorize`,
   normally on the account URL.
   - **Continue with ADE** sends the person to ADE's own sign-in (Clerk, the
     public "ADE CLI" client, PKCE). Clerk returns to the relay's one fixed
     callback, `https://<relay>/oauth/callback`; the relay routes it to the
     machine named before the dot in `state`. That is always the computer
     that answered the authorize request (its per-machine endpoint key), the
     one holding the pending sign-in, even when it began on the account URL.
   - The brain redeems the code itself, with a PKCE verifier only it holds, and
     checks the token with `verifyClerkAccountAttestation`: the subject must be
     the account this computer is signed in to (the check phone hellos use).
   - Then the person picks **Read & write** (default) or **Read only** and
     presses **Allow** (the page posts to the per-machine URL). The app gets a
     code, and `iss` is the issuer it started with (the account base when it
     began there; the brain remembers it per sign-in). The app exchanges the
     code at its token endpoint; the token is minted then and written to the
     vault, so the other computers find it on their next pull.
2. **Token** (Grok and OpenAI APIs, scripts): Settings → ADE MCP → New token,
   or `ade mcp token create --read-only|--full-access` (the access is required;
   there is no default). Shown once. Sent as `Authorization: Bearer …`.

Why the relay cannot mint access: it never holds the PKCE verifier for ADE's
sign-in, never issues tokens, and a code it sees in flight is useless without
the verifier. A compromised Worker learns the tokens it carries and the
account secret brains send it (which only names the account address), but
cannot create a connection.

- The callback address is registered on the Clerk OAuth application "ADE CLI"
  (`Az7TbviBocyXjZk1`). A new relay origin needs its own callback added there.
- Registration is stateless: the client id is `ade1.` + base64url of the
  registered redirect URIs and name. Nothing to store, fill or lose on restart.
  Open registration grants nothing; every client is public and still needs an
  ADE sign-in.
- Redirect URIs: HTTPS anywhere, HTTP only on loopback, or an app scheme
  (`cursor://`). Never `javascript:`, `data:`, `file:` and similar, never a
  fragment. An unregistered redirect gets our error page, not a redirect.
- Sign-ins: 10 minutes, at most 20 waiting; the accept form carries a CSRF
  value and is single use. Authorization codes: 2 minutes, single use, spent
  even when the exchange fails, and held in memory on the computer that issued
  them: the token exchange on the account URL reaches it because the relay
  keeps answering from the machine that answered last. The token is minted at
  exchange, so an abandoned sign-in leaves none.
- Signing in as a different ADE account than the computer's is refused.
- Tokens do not expire. Revoke them in Settings or with `ade mcp remove`.
- At most 50 connections per account.

## Access levels

| Level | Runs | CLI role |
|---|---|---|
| Read & write (default) | Any command in `FULL_ACCESS_COMMANDS`, minus the refusals below. | `cto` (a person's terminal) |
| Read only | An allowlist of reading commands (`describeReadOnlyCommands()`), plus `ade actions run` for actions `adeActionAccess` declares `read` and that return no secret. | `agent` |

Refused at every level, because they would outlive or get around the switch
that grants access, or cut the connection:

- the commands `mcp`, `account`, `login`, `logout`, `connect`, `setup`,
  `reset`, `brain`, `serve`, `runtime`, `rpc`, `code` and `desktop`, and every
  `machines` (or `machine`) subcommand except `list`/`show` (renaming,
  removing or re-pairing account machines);
- signing this computer in or out of a connected service:
  `github app-auth login|clear` (and their aliases, and `gh`),
  `jira connect|disconnect` and `providers opencode accounts remove`;
- through `ade actions` (or its alias `action`): any `remote_mcp.*` action, any
  `account.*` action except `status` (tokens, sign-out), the GitHub, Linear and
  Jira credential actions (`github.setToken|clearToken|*AppUser*Auth`,
  `linear_credentials.*`, `linear_oauth.*`, `linear_agent.startInstall|uninstall`,
  `jira.connect|disconnect`, and the AI provider sign-in and API-key actions in
  `ai`), in both the
  `<domain.action>` and `<domain> <action>` spellings, and the raw tool doors
  `actions call|direct|tool`;
- a first word that is not a plain command word, so `--socket`, `--headless`,
  `--role` and a socket path cannot move a call to another brain or role;
- `--machine`, `--all-machines` and `--machine-project`: a call reaches
  another computer through the tools' own `machine` input, which goes through
  that computer's own token check and policy, never through the CLI's agent
  bridge.

Both levels fail closed: a top-level command in neither
`FULL_ACCESS_COMMANDS` nor `BLOCKED_COMMANDS` is refused, so a new `ade`
command is off for ADE MCP until someone classifies it. When you add a
command, put it in one of those lists (and in `READ_ONLY_COMMANDS` if it only
reads). `remoteMcpCommandPolicy.test.ts` fails for any command with help text
that is in neither, and `/quality` checks it (review rule 12).

Read only also refuses `search --rebuild`, and `chat wait --async`,
`--background` and `--cancel` (they arm, hold or cancel a wait; a plain
`chat wait` only watches). `<command> [<sub>…] --help` is allowed at read only,
in exactly that shape (plain words, then `--help` last): after a flag that takes
a value, the CLI reads `--help` as the value and runs the command
(`chat send <id> --project-root --help`). The user-only action gate keeps
every `remote_mcp` action (reads included) away from any client but the
desktop, whatever its role.

The blocklist stops the obvious routes, not a determined app: full access is
real, and an app can start shells and agents, so it can do what the person
can. Revoking stops new calls; it does not undo anything already done.

An app that signs in again with the same registration replaces its earlier
connection (and that token stops working), so re-authorizing never piles up
rows or fills the 50-connection cap.

## Running a command

- The brain spawns its own CLI entry with `process.execPath` (or the native
  binary), never a shell or a `.cmd` wrapper, with `--socket` first and
  `ADE_DEFAULT_ROLE` set from the access level.
- `cwd` is the `project` argument (name, id or path from the brain's project
  registry) or the most recently opened project. That default changes when the
  person opens another project, so **every result starts with the project it
  ran in** (`[project: <name> · <id> · <path>]`; typed tools also put it in
  `structuredContent.project`), and the activity log records it. With no
  project registered at all, commands run in the home folder and say so.
- The child gets `ADE_REMOTE_MCP_CONNECTION_ID`, `ADE_REMOTE_MCP_CONNECTION_LABEL`
  and `ADE_REMOTE_MCP_SCOPE`. The CLI uses them to drop the help banner and
  list only this scope's commands, to hide personal skills, and to label chat
  turns the app sends ("via <label>").
- stdin is closed unless the call passes `stdin` (256 KB at most). A command
  that reads stdin (`--stdin`, `--json-stdin`, `--token-stdin`, or `-` after a
  `--…-file` or `--prompt` flag) is refused without it, because with stdin
  closed `files write --stdin` would write an empty file.
- 120 s default, clamped to 5–600 s, then SIGTERM and SIGKILL of the process
  group (`taskkill /T /F` on Windows). 200 KB per stream (typed tools that trim
  their JSON allow more). At most 4 commands at once per machine and 3 per
  connection, so one app's long `chat_wait` cannot shut the others out. A
  JSON-RPC batch runs its messages one after another. `stopAllRemoteRuns()`
  runs on brain shutdown.
- A non-zero exit, a timeout or a refusal comes back as a tool result with
  `isError: true` and a sentence the model can act on. Typed tools know their
  command's answers: `chat_status` exits 1 for idle and 2 for blocked, which
  are results, not errors.

## Resources

`ade://commands` is `ade help --json` as the connection's scope sees it: every
command it can run, with a summary, usage lines and, at read only, the allowed
subcommands. The brain reads it once per scope and keeps it five minutes. The
tool description points here instead of listing the read-only allowlist inline.

## MCP Apps

Hosts that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
(Claude, ChatGPT, VS Code, Goose) show a tool's result as a small ADE view in
the conversation instead of JSON. Hosts that don't get the same text and
`structuredContent` as before.

- One self-contained HTML app serves every view: `ui://ade/app-<hash>.html`,
  `text/html;profile=mcp-app`, no network, no CDN, about 44 KB. The hash
  changes with the HTML, so a host that caches resources gets the new view;
  `resources/read` answers any `ui://ade/app*.html` with today's HTML.
- Tools with a view carry `_meta.ui.resourceUri` (and the older flat
  `ui/resourceUri`): `inbox`, `chat_list`, `chat_read`, `chat_respond`,
  `chat_send`, `chat_start`, `prs_list`, `prs_show`, `prs_checks`,
  `lanes_list`, `diff_changes`, `diff_patch`, `usage_limits`, `machines_list`.
  The view picks itself from the host's tool name, else from
  `structuredContent.view`; anything unknown is a key/value card, never a
  blank frame. Provider colours come from `PROVIDER_COLOR_TABLE`.
- The inbox view answers in place: its option, Approve and Deny buttons call
  `chat_respond` (or `chat_send` for an `ask`) through the host, with the
  card's own `project` and `machine`, and show the answered state. Read-only
  connections see the buttons disabled.
- Everything is drawn with `textContent`; links open only `https:`, `http:`
  and `ade:` through `ui/open-link`; messages are accepted only from the host
  frame. Colours are the host's style variables when it gives them and ADE's
  tokens otherwise, light and dark.

## Prompts

The project's skills are MCP prompts, so an app can start from "context" the
way an ADE chat would. `prompts/list` lists the default project's skills (prompt
names must be unique, so one project's); `prompts/get` takes a `project`
argument for another one and returns the SKILL.md body. Discovery runs in the
brain through `agentSkillCatalogService`, the same catalog `ade skill list`
uses: project skills (`.agents`, `.claude`, `.ade`, `.cursor`, `.codex` from the
project up), then ADE's bundled skills. **Personal skills in the home folder
never reach a connected app**: prompts leave them out, and `ade skill list|show`
hide them whenever `ADE_REMOTE_MCP_CONNECTION_ID` is set. The check compares
real paths, so a project folder linked to `~/.agents/skills` stays hidden too.

## Chat turns from an app

A message an app sends with `ade chat send|message|steer` or `chat create
--prompt` carries `metadata.remoteMcp = { connectionId, label }`, and the chat
shows "via <label>" under it, so the person and their agents can tell it from
the person's own messages. It is still a person-side message (it is not in the
host-authored key lists): it clears attention like any message the person sends.
This is provenance, not a boundary: a full-access app can already pass its own
metadata. `chat send --after` carries the label too: the brain strips a
caller's own provenance from a delayed send, except this one key from an
unbound CLI (`armWaitArgsWithoutCallerProvenance` in `adeRpcServer.ts`).

`serverInfo.version` is ADE's version, so a client can tell which tools a
machine's server has.

## Gotchas

- **Never run `wrangler dev` on port 8787 on a machine with ADE installed.**
  The brain's sync listener uses 8787; a local Worker there makes the brain's
  relay bridge check fail and the phone loses relay. Use another port.
- Cloudflare's bot check answers `error code: 1010` to some default HTTP
  library user agents (Python `urllib`). Real MCP clients are fine; test
  scripts must send a user agent.
- The installed brain only serves this once it runs this code. The relay part
  is independent: deploying it first is safe (old brains never send
  `mcp_state`, so their relay answers 404).
- Pending sign-ins and authorization codes are in memory: one service per
  machine (`remoteMcpShared.ts`). A sign-in on the account URL relies on the
  relay keeping the same front computer for its few requests; if that computer
  goes offline mid-sign-in, the app starts it again. A second brain on the
  same home (a dev brain) has its own sign-ins, but shares the account vault.
- Forwarding assumes every computer uses the same relay URL (production
  does); a computer on a custom `ADE_TUNNEL_RELAY_URL` can answer its own
  calls but not be forwarded to from the others.
- Deploy order: push relay (`ade_mcp` vault kind) first, then the tunnel relay,
  then ADE. An older push relay refuses a whole batch for a kind it does not
  know, so the vault uploads `ade_mcp` rows in their own batch
  (`NEWER_VAULT_KINDS`): against an older Worker only those rows wait (and the
  connections stay on the computer that made them); every other credential
  keeps syncing.
- Connections imported from a computer's own ADE MCP (before it covered the
  account) keep reaching only that computer (`onlyMachine`); reconnecting the
  app makes an account-wide one.
- The `ade_mcp` vault kind and the `ade_mcp.*` account settings are written
  only by the ADE MCP service, in process. The `account_vault` and
  `account_settings` actions refuse them for every caller, so no agent or
  connected app can mint a token, read the account secret, or point a
  computer's entry somewhere else.

## Cost

Per call: one Worker request, one Durable Object request, and Durable Object
time only while the command runs. An idle machine adds nothing; the control
socket hibernates as before.
