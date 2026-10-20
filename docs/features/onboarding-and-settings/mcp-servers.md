# MCP servers

Settings › MCP servers is where a user defines an MCP server one time and
every ADE agent gets it, on every computer they sign in on. Each provider CLI
keeps its own MCP list, so without this a server added to Claude never reaches
Codex and a second computer starts with none.

The page is under **Account** in the settings sidebar. It is desktop only: the
hosted web client hides it (`web: "hidden"` in `settingsManifest.ts`), because
a browser has no account-settings or vault bridge and the page's checks read
files on a computer.

## The data

Three plain JSON rows in the account settings store, and nothing else. The
model is `apps/desktop/src/shared/mcpRegistry.ts`.

| Row | Scope | Holds |
|---|---|---|
| `mcp.servers` | `all` | The list: name, transport (`stdio`, `http`, `sse`), command and arguments or URL, the NAMES of env variables and headers, and `enabled`. At most 32 servers. |
| `device.<deviceId>.mcp.off` | `all` | Names switched off on one computer. |
| `mcp.off` | `repo:<remote>` | Names switched off in one repository, on every computer. |

**A server never carries a secret value.** The list holds the names of its env
variables and headers. Their values live in the account vault: kind `secret`,
scope `all`, key `mcp/<server>/env/<NAME>` or `mcp/<server>/header/<NAME>`
(`mcpSecretVaultKey`). Settings rows are stored and synced as readable JSON;
the vault is sealed.

Two things are not secrets in this model and do sync in the list as written: a
command's arguments, and a URL. A token passed as an argument or in a query
string is stored in the list. Put it in an env variable or a header instead.

The page warns about this, and never blocks: the add and edit dialog and each
found server show a line when an argument or the URL looks like it holds a
secret (a long token-like string, `Bearer ...`, a `--token`-style flag with a
value, `key=` or `token=` in a query string), and when one holds a `${NAME}`
reference, which ADE hands over as written and does not fill in. The check is
`mcpPlainTextSecretFindings` in `shared/mcpServerImport.ts`; it reads the
text's shape, so it can miss a secret and can flag a harmless id.

A server's name is its key. The vault items, the off lists and the tool names
agents see all hang off it, so the name is set when the server is added and is
not editable afterwards. The dialog says so; renaming is remove and add again.

## The page

`renderer/components/settings/mcp/McpServersSection.tsx`, built from
`ModernPage`, `ModernSection` and `ModernRows`.

- **In your account.** One row per registry server: its transport, what it
  runs or where it answers, one state tag (On, Off everywhere, Off on this
  computer, Off in this project, from `mcpRegistryState`), and three switches:
  Your account, This computer, This project. The project switch needs an open
  project with a git remote; the computer switch needs this computer's sync
  device id. Add, edit and remove are here.
- **Found on this computer, not in ADE.** Servers the provider CLIs already
  have in their own settings, with the providers each came from and an Import
  button. Servers already in the registry (by name) are left out.
- **Who gets them.** Which agents the registry reaches, read off
  `CALLER_MCP_SUPPORT`, the table the launch path uses.

Status on each row is about this computer:

- **A secret value is missing.** One note per env variable or header whose
  value this computer's vault does not hold, with a field to enter it. A server
  with a missing value still starts, without that value.
- **The command was not found.** For a `stdio` server whose program is neither
  on `PATH` nor in a known install folder (`resolveExecutableFromKnownLocations`,
  which honours `PATHEXT` on Windows), or whose path is not a file.
- **Browser sign-in.** An HTTP or SSE server that answers an unauthenticated
  request with `401` and a Bearer challenge shows **Needs sign-in** and a
  **Sign in** button. A signed-in one shows when its sign-in runs out, with
  **Sign in again** and **Sign out**. See [Browser sign-in](#browser-sign-in).

When the background service cannot be asked (it is restarting, or a dev brain
runs with `--no-sync` and has no account store), the page shows this
computer's last saved copy of the list, read off the same settings cache a
chat launch reads, with a banner. Nothing can be changed until it answers.
The switches and their labels are dimmed while they cannot be used.

### Add and edit

`McpServerDialog.tsx`. A name, how ADE reaches it (Command, HTTP, SSE), then
the command and its arguments (one per line) or the URL, then env variables or
headers as name and value pairs. In an edit, a value this computer holds shows
as "Saved" and is never read back; leaving its box empty keeps it.

**Paste JSON instead** fills the form from a snippet: the usual
`{"mcpServers": {...}}`, OpenCode's `{"mcp": {...}}`, a bare `{"name": {...}}`
map, or one server object. Comments and trailing commas are accepted. A snippet
with several servers fills the first and says so. The parser is
`shared/mcpServerImport.ts`, shared with the scan.

### Saving

`useMcpRegistry.ts`. The three rows are read and written through
`window.ade.accountSettings`, the bridge every account setting uses. Each
change re-reads the row from the brain first and changes that copy, so two
computers editing different servers do not undo each other. A change is shown
only after the brain confirmed it; a refusal comes back as a toast, or as a
line in the dialog.

Order matters in two places. Secret values are written before the server is
added to the list, so the next chat never starts a server whose values are not
there yet. Removing a server removes it from the list first, then from the two
off lists it can reach, then its vault items.

### Browser sign-in

`main/services/mcp/mcpOAuth.ts`. ADE runs the MCP authorization flow itself,
once, instead of each provider CLI running it into its own credential store:

1. Probe the URL with an MCP `initialize` and no credentials. A `401` with
   `WWW-Authenticate: Bearer resource_metadata=...` means it wants a sign-in.
   The answer is cached per URL for ten minutes; an unreachable server is not
   shown as needing one. A server with a header of its own is not probed.
2. Read the protected-resource metadata (RFC 9728), then the authorization
   server's metadata (RFC 8414, then OpenID). Old servers with neither get the
   spec's fixed `/authorize`, `/token` and `/register` paths.
3. Register ADE with dynamic client registration for this sign-in's redirect,
   `http://127.0.0.1:<random port>/callback`. A server with no registration
   endpoint cannot be signed in to here; the message says to use a header.
4. Open the browser on the authorize URL (PKCE S256, `state`, `resource`) and
   wait up to five minutes. A second sign-in for the same server cancels the
   first.
5. Exchange the code and keep the result in the account vault as one JSON item,
   `mcp/<server>/oauth/token` (`mcpOAuthVaultKey`): the token, the refresh
   token if any, the expiry, the client and the URL it was issued for.

The browser and the redirect listener must be on the same computer, so the
sign-in always runs in the desktop's own main process, even when the project
tab is bound to another machine. Because the token goes to the account vault,
every computer of the account starts its chats signed in.

At launch `mcpRegistryToCallerServers` adds `Authorization: Bearer <token>` to
the server, which every provider adapter already passes on. A header the user
set by hand named `Authorization` wins. A token for a different URL (the server
was edited) is ignored. An expired one is left out and the chat gets a notice
to sign in again.

A sign-in with a refresh token is renewed when it has less than 15 minutes
left, or after it ran out: by `check` when the page loads, and every five
minutes while the desktop app runs (`startRenewal`), so agents stay signed in
to servers that issue one-hour tokens. One renewal per server runs at a time,
because a server that rotates refresh tokens can revoke the grant when the old
one is used twice. Chats on other computers read the renewed token from the
vault. OpenRouter gives no refresh token, so its sign-in lasts its seven days.
An edit keeps the sign-in; removing the server deletes it.

Discovery also refuses metadata whose `resource` is not this server's URL (or
a path above it on the same origin), and every endpoint it names must be HTTPS
(plain HTTP only from a server on this computer to this computer). Requests
never follow redirects. The sign-in IPC call is allowed six minutes, longer
than the five the sign-in waits on the browser.

## The main process

`window.ade.mcpRegistry` (`main/services/mcp/mcpRegistryService.ts`) is what
the renderer cannot do itself. No call returns a secret value.

| Call | Does |
|---|---|
| `context` | Where this computer and this project file their off lists, and this computer's cached copy of the three rows. |
| `check` | For a list of servers: which vault keys this computer holds, and which `stdio` commands are missing. |
| `setSecret`, `removeSecret` | Write or remove one registry secret. The server and field names are validated, so the path can only reach `mcp/<server>/...` keys of kind `secret`. |
| `pruneSecrets` | Remove the vault items a server no longer names; all of them when the server is removed. |
| `scan` | The servers in the provider CLIs' own configs, names only. |
| `import` | Move one found server's values from the provider's file into the vault, inside the main process, and answer with its definition. The renderer then adds it to the list. |
| `signIn`, `cancelSignIn`, `signOut` | Run a server's browser sign-in on this computer and keep its token in the vault; stop one that is waiting; remove the token. `check` also answers each HTTP / SSE server's sign-in state (`needed`, `valid`, `expired`), never the token. |

### What the scan reads

`main/services/mcp/mcpProviderConfigScan.ts`. Every read is best-effort: a
missing or malformed file contributes nothing.

| Provider | File | Where the servers are |
|---|---|---|
| Claude | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set) | `mcpServers`, and `projects[<path>].mcpServers` for the open project |
| Codex | `~/.codex/config.toml` (`$CODEX_HOME`) | `[mcp_servers.<name>]` tables with their `env` and `http_headers` sub-tables |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| OpenCode | `~/.config/opencode/opencode.json` or `.jsonc` (`$XDG_CONFIG_HOME`) | `mcp` |
| Droid | `~/.factory/mcp.json` | `mcpServers` |

Muse Code is not scanned. A Muse chat still receives the registry's servers;
only importing servers from Muse's own config files is missing.

The same name in two providers is one row; the first definition found wins
(the order above) and the others add their provider to the row. A name the
registry cannot hold (it allows letters, numbers, `-` and `_`) is listed under
the section as not offered. ADE's own reserved names (`computer_use`,
`ade-cto`) are skipped.

Codex can name the env variable a token is read from (`bearer_token_env_var`,
`env_http_headers`) instead of storing the token. Import reads that variable
from the desktop's own environment; when it is not set there, the header is
imported with no value and the row shows it as missing.

The Codex reader is not a full TOML parser. It reads table headers and
`key = value` lines under `mcp_servers`, which is how Codex writes them. A
server declared only as an inline `mcp_servers = { ... }` table is not found.

## Who gets registry servers

Decided at launch by `resolveMcpRegistryForLaunch`
(`main/services/chat/mcpRegistryLaunch.ts`); see
[Chat › The MCP registry](../chat/README.md#the-mcp-registry).

| Agent | Gets |
|---|---|
| Claude, Cursor, Droid, OpenCode | Every server that is on. |
| Codex | Every server that is on, except SSE ones. Codex has no SSE client. |
| Pi | None. The Pi SDK has no MCP configuration. |
| Copilot | ADE's own servers and the registry's, through the SDK's `mcpServers`. Servers the user configured in their Copilot config still run in interactive chats. ADE hands a registry sign-in to Copilot, so Copilot does not open a browser for it. See [Copilot SDK provider › MCP servers](../chat/copilot-sdk-provider.md#mcp-servers). |
| Grok, Kimi, Qwen, Devin | None yet. |
| Personal chats, side jobs, SDK chats | None. The light session profile and strict MCP chats decide their own servers. |

A change reaches chats started after it. A running chat keeps what it started
with.

## `npx` servers start without npm's launcher

`npx <package>` keeps a whole npm CLI (`npm exec ...`) running as the parent
of the server for as long as the server lives, and for a tag or a bare name it
asks the registry first. Every chat starts its own copy, so the launcher is
paid once per chat: about 95-190 MB and 1-1.5 s per server.

For chats ADE starts, the launch runs the package npx already installed with
`node` directly (`main/services/mcp/npxDirectLaunch.ts`). It does so only
when that copy is provably the one npx would run today:

- the command is `npx` with at most `-y`, `--yes`, `-q`, `--quiet` or
  `--silent` before the package, and the package is a registry name with no
  version, an exact version, or a dist-tag (not a range, git, path or URL);
- npx's own cache folder for that spec (`<npm cache>/_npx/<sha512 16>`)
  records exactly that spec, and holds the package;
- the package is not in the project tree or the global prefix (npx would run
  that one), and no `.npmrc` or `npm_config_registry` names another registry;
- an exact version matches the installed one; a tag or bare name matches the
  registry's answer for that tag, which the brain fetches (one small request,
  kept six hours, never more than 1.5 s on the launch path; with no answer the
  launch keeps `npx`);
- the package's bin is a plain `node` script.

Anything else launches as written. The user's config files are only read. A
CLI the user starts in a terminal is unchanged.

Which servers it applies to, per provider:

| Provider | User's own `npx` servers | ADE registry `npx` servers |
|---|---|---|
| Codex | Re-pointed per thread: `mcp_servers.<name> = { command, args }` in the thread config, merged into config.toml's table, so env, tool approvals and timeouts stay. Skipped in strict mode, for a name a caller or ADE also sets, for a server with `cwd`, and for a name the project's `.codex/config.toml` redefines. | Re-pointed |
| Claude | Re-pointed through the launch's MCP config: a server named there replaces the same name from the user and local scopes, and the user's other servers still load. Only for an entry that is just `command` and `args` (an `env` would have to be copied onto a command line), not for a name the project's `.mcp.json` declares or that the user switched off for the folder, and not in strict mode. | Re-pointed |
| Cursor, Droid, Copilot, OpenCode, Muse, Qwen, Kimi, Grok, Devin, Antigravity | Unchanged. These cannot be shown to replace their own copy of a same-named server, and passing one would start a second. | Re-pointed (ADE hands these over itself) |
| Pi | No MCP. | No MCP. |

Codex side jobs (chat titles and other background utilities, `codex exec`)
start none of the user's config.toml servers: each one gets
`-c mcp_servers.<name>.enabled=false`. `-c mcp_servers={}` does not do this;
Codex merges an override table into config.toml, so an empty one changes
nothing. Servers a Codex plugin adds are not in the file and still start.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/mcpRegistry.ts` | The model: normalizing the list and the off lists, state, vault key names, and the conversion to the shape provider adapters take. |
| `apps/desktop/src/shared/mcpServerImport.ts` | One provider config entry, or a pasted snippet, as a server definition with its values kept beside it. |
| `apps/desktop/src/shared/types/mcpRegistry.ts` | The wire types of `window.ade.mcpRegistry`. |
| `apps/desktop/src/main/services/mcp/mcpRegistryService.ts` | Context, this-computer checks, the vault path, scan, import and sign-in. |
| `apps/desktop/src/main/services/mcp/mcpOAuth.ts` | The browser sign-in: the probe, discovery, client registration, the loopback redirect, the token exchange and renewal. |
| `apps/desktop/src/main/services/mcp/mcpProviderConfigScan.ts` | Reading the five provider configs, including the Codex TOML tables. |
| `apps/desktop/src/main/services/chat/mcpRegistryLaunch.ts` | The registry as one chat launch sees it. |
| `apps/desktop/src/main/services/mcp/npxDirectLaunch.ts` | Runs an `npx` server's installed package with `node` when it is provably the copy npx would run. |
| `apps/desktop/src/main/services/mcp/mcpUserServerNpxDirect.ts` | The Codex thread overlay and the Claude launch servers that re-point the user's own `npx` servers. |
| `apps/desktop/src/renderer/components/settings/mcp/` | The page, the add and edit dialog, the hook and the layout CSS. |
