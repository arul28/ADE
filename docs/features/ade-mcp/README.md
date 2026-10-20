# ADE MCP

Lets AI apps the person picks (claude.ai, ChatGPT, Cursor, VS Code, Claude
Code, Grok through its API, scripts) run the `ade` command on one of their
computers. Each computer is its own MCP server, reached through ADE Relay
(`apps/tunnel-relay`). Off until the person turns it on for that computer.

The server is **one tool, `ade`**: the words after `ade`, run as the real CLI
on that computer. Everything the CLI can do is available with no per-command
MCP work, and new CLI commands appear on their own.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/remoteMcp/remoteMcpService.ts` | The server: HTTP router, MCP JSON-RPC (stateless Streamable HTTP, JSON responses), OAuth endpoints, the `ade` tool, Settings actions. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpOAuth.ts` | Stateless client registration, redirect URI rules, authorize request parsing, PKCE, pending sign-ins and authorization codes, the sign-in and allow pages. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpCommandPolicy.ts` | Which commands run at each access level; the read-only allowlist; argv splitting; log redaction. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpRunner.ts` | Runs the CLI as a child of the brain: no shell, `--socket`, role by access level, timeout, output cap, process-tree kill. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpStore.ts` | `<secrets>/remote-mcp.json`: on/off and connections (token hashes only). |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpActivityLog.ts` | `<ade home>/remote-mcp/activity.jsonl`, capped at 512 KB with one rolled file. |
| `apps/ade-cli/src/services/remoteMcp/remoteMcpShared.ts` | The machine's one service instance. |
| `apps/ade-cli/src/services/sync/syncTunnelClientService.ts` | Control-socket messages `http` → `http_res`, and `mcp_state` (on/off) to the relay. |
| `apps/ade-cli/src/services/sync/machineRelayTunnel.ts` | Attaches the service to the machine's relay tunnel. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | `remoteMcp.call`, the machine method behind `ade mcp` (operator only; never a chat-bound agent). |
| `apps/ade-cli/src/cliRemoteMcp.ts` | `ade mcp` commands and their `--text` output. |
| `apps/tunnel-relay/src/relay.ts`, `tunnelDo.ts` | `/m/<endpointKey>/…` and OAuth discovery routes; endpoint-key → machine mapping; forwarding over the control socket; limits; CORS. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | `remote_mcp` action domain (Settings). |
| `apps/desktop/src/main/services/adeActions/actionPolicy.ts`, `apps/desktop/src/shared/adeActionAccess.ts` | `remote_mcp` is CTO-only; its writes are user-only (desktop clients); `createToken` is secret-bearing. |
| `apps/desktop/src/shared/types/remoteMcp.ts` | Wire types shared by the brain, preload and Settings. |
| `apps/desktop/src/renderer/components/settings/AdeMcpPage.tsx` | Settings → Computer → ADE MCP (its own page per machine). |

## Request path

```
AI app ──HTTPS──► ade-tunnel-relay Worker ──► TunnelDurableObject(machineKey)
                   /m/<endpointKey>/mcp        │  {t:"http", rid, method, path, headers, body}
                                               ▼  over the brain's existing control socket
                                          brain: remoteMcpService.handleHttp
                                               │  {t:"http_res", rid, status, headers, body}
AI app ◄──────────────────────────────────────┘
```

- The relay holds no key and runs no ADE logic. It answers early only when the
  machine is offline (503), has the feature off (404 `ade_mcp_off`, from
  the control socket's `mcp` flag, so a disabled machine is never woken), or is
  over its limits (16 requests in flight, 300 a minute: 429). It forwards a
  short list of request headers and returns a short list of response headers.
- The control socket is the one the brain already keeps for phones, so an idle
  machine costs nothing extra. There is no session object and no second socket.
- A brain sends `mcp_state` on every control open and on every toggle. An older
  relay ignores it; an older brain never sends it, so its relay answers 404.

**The URL never contains the relay key.** It uses an endpoint key the brain
derives from its relay secret (`mcpEndpointKeyFor`) and registers with each
`mcp_state` over its signed control socket; the relay's `mcp-endpoint:<key>`
object maps it to the machine (first writer wins). Handing the URL to an AI
app therefore cannot open `/connect` tunnels or use up a machine's phone slots.

URLs, with `<base>` = `https://ade-tunnel-relay.arulsharma1028.workers.dev/m/<endpointKey>`:

| URL | What |
|---|---|
| `<base>/mcp` | MCP endpoint. POST only (stateless; GET/DELETE → 405). |
| `/.well-known/oauth-protected-resource/m/<endpointKey>/mcp` | RFC 9728 metadata (also `<base>/.well-known/oauth-protected-resource`). |
| `/.well-known/oauth-authorization-server/m/<endpointKey>` | RFC 8414 metadata; issuer is `<base>`. `openid-configuration` answers the same. |
| `<base>/oauth/register` | Dynamic client registration. |
| `<base>/oauth/authorize` | Start page; Continue with ADE. |
| `https://<relay>/oauth/callback` | ADE sign-in returns here; routed to `<base>/oauth/account-callback`. |
| `<base>/oauth/consent` | The allow page posts here. |
| `<base>/oauth/token` | Code → token. |

## Signing in

Two ways, both ending in a **connection**: a label, an access level and a
token whose SHA-256 is stored. Revoking deletes the record; the token fails on
the next request.

1. **Web sign-in** (claude.ai, ChatGPT, Cursor, VS Code, Claude Code): the app
   registers itself (dynamic registration) and opens `<base>/oauth/authorize`.
   - **Continue with ADE** sends the person to ADE's own sign-in (Clerk, the
     public "ADE CLI" client, PKCE). Clerk returns to the relay's one fixed
     callback, `https://<relay>/oauth/callback`; the relay routes it to the
     machine named before the dot in `state`.
   - The brain redeems the code itself, with a PKCE verifier only it holds, and
     checks the token with `verifyClerkAccountAttestation`: the subject must be
     the account this computer is signed in to (the check phone hellos use).
   - Then the person picks **Read & write** (default) or **Read only** and
     presses **Allow**; the app gets a code and exchanges it for its token.
2. **Token** (Grok and OpenAI APIs, scripts): Settings → ADE MCP → New token,
   or `ade mcp token create`. Shown once. Sent as `Authorization: Bearer …`.

Why the relay cannot mint access: it never holds the PKCE verifier for ADE's
sign-in, never issues tokens, and a code it sees in flight is useless without
the verifier. A compromised Worker learns the tokens it carries, but cannot
create a connection on any machine.

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
  even when the exchange fails. The token is minted at exchange, so an
  abandoned sign-in leaves none.
- Signing in as a different ADE account than the computer's is refused.
- Tokens do not expire. Revoke them in Settings or with `ade mcp remove`.

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
  `github app-auth login|clear` (and their aliases) and `jira connect|disconnect`;
- through `ade actions` (or its alias `action`): any `remote_mcp.*` action, any
  `account.*` action except `status` (tokens, sign-out), the GitHub, Linear and
  Jira credential actions (`github.setToken|clearToken|*AppUser*Auth`,
  `linear_credentials.*`, `linear_oauth.*`, `jira.connect|disconnect`), in both the
  `<domain.action>` and `<domain> <action>` spellings, and the raw tool doors
  `actions call|direct|tool`;
- a first word that is not a plain command word, so `--socket`, `--headless`,
  `--role` and a socket path cannot move a call to another brain or role;
- `--machine`, `--all-machines` and `--machine-project`: ADE MCP is switched
  on per computer, so a call never forwards to another machine.

Both levels fail closed: a top-level command in neither
`FULL_ACCESS_COMMANDS` nor `BLOCKED_COMMANDS` is refused, so a new `ade`
command is off for ADE MCP until someone classifies it. When you add a
command, put it in one of those lists (and in `READ_ONLY_COMMANDS` if it only
reads). `remoteMcpCommandPolicy.test.ts` fails for any command with help text
that is in neither, and `/quality` checks it (review rule 12).

Read only also refuses `search --rebuild`. The user-only action gate keeps
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
  registry) or the most recently opened project.
- 120 s default, 600 s maximum, then SIGTERM and SIGKILL of the process group
  (`taskkill /T /F` on Windows). 200 KB per stream. At most 4 commands at once
  per machine. `stopAllRemoteRuns()` runs on brain shutdown.
- A non-zero exit, a timeout or a refusal comes back as a tool result with
  `isError: true` and a sentence the model can act on.

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
  machine (`remoteMcpShared.ts`). A second brain on the same home (a dev brain)
  has its own, but shares the connections file.

## Cost

Per call: one Worker request, one Durable Object request, and Durable Object
time only while the command runs. An idle machine adds nothing; the control
socket hibernates as before.
