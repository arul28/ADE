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
the vault is sealed. The push relay accepts these slash-separated keys (one
or more segments, none empty or starting with a dot); before it did, one such
key failed its computer's whole vault upload.

**A launch never puts a secret on a command line.** The Claude Agent SDK hands
the Claude CLI every MCP server, env values and headers included, as one inline
`--mcp-config <json>` argument, which any process on the machine can read with
`ps` and which the subprocess reaper wrote to its registry file. ADE's Claude
spawn (`claudeSubprocessReaper.spawnClaudeCodeProcess`) moves that JSON into a
file only the user can read (`<ADE home>/mcp-launch/chat/<uuid>.json` through
`ensurePrivateDirectory` and `writePrivateFile`: 0700/0600 on POSIX, an
owner-only ACL on Windows; `moveClaudeMcpConfigOffArgv`) and passes its path, which the
CLI reads the same way, `${NAME}` expansion included (checked with the pinned
CLI: the same server env and `Authorization` header arrive both ways). The file
is deleted when the process exits; when a brain starts, files that no running
process names are deleted too (one `ps` read; on Windows, where no command
line can be read, files older than seven days, so a long-running chat's file
is kept). Tracked Claude terminals already
used a private file in the same folder
(`trackedCliUserMcp.ts`).

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
  `registryMcpSupport` (`shared/callerMcpServers.ts`), which the launch path
  uses too.

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
| Copilot | `~/.copilot/mcp-config.json` (`$COPILOT_HOME`), where `copilot mcp add` writes | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| OpenCode | `~/.config/opencode/opencode.json` or `.jsonc` (`$XDG_CONFIG_HOME`) | `mcp` |
| Droid | `<FACTORY_HOME_OVERRIDE or ~>/.factory/mcp.json` | `mcpServers` |
| Pi | `<Pi agent dir>/mcp.json`: `$PI_CODING_AGENT_DIR` when set, else `~/.pi/agent` (the directory ADE's Pi chats run on) | `mcpServers` |
| Muse | `$XDG_CONFIG_HOME/muse/settings.json` (`~/.config/muse`) | `mcpServers` |
| Qwen | `<QWEN_HOME>/settings.json` | `mcpServers`, Gemini's shape: `httpUrl` is streamable HTTP, a `url` with no `type` is SSE |
| Kimi | `<KIMI_CODE_HOME>/mcp.json` | `mcpServers` |
| Grok | `<GROK_HOME>/config.toml` | `[mcp_servers.<name>]` tables, read like Codex's |
| Devin | `mcp_config.json`, `mcp_config.local.json`, `config.json`, `config.local.json` under `~/.config/devin` (`%APPDATA%\devin`) | `mcpServers` |
| Antigravity | `~/.gemini/config/mcp_config.json` | `mcpServers` |

An entry may name its transport in `type` or `transport`, and its address in
`url`, `httpUrl` (always streamable HTTP) or `serverUrl` (Antigravity, Devin).

A project's own files (`.mcp.json`, `.github/mcp.json`, `.pi/mcp.json` and the
like) are not scanned: they come with the repository. A server defined only
there is added with **Add**. An env or header value that is a Pi reference
(`${NAME}`, or a `!command` that prints the value) imports as written: the
vault gets the reference text, not what Pi would resolve it to.

The same name in two providers is one row; the first definition found wins
(the order above) and the others add their provider to the row. A name the
registry cannot hold (it allows letters, numbers, `-` and `_`) is listed under
the section as not offered. ADE's own reserved names (`computer_use`,
`ade-cto`) are skipped.

Codex can name the env variable a token is read from (`bearer_token_env_var`,
`env_http_headers`) instead of storing the token. Import reads that variable
from the desktop's own environment; when it is not set there, the header is
imported with no value and the row shows it as missing.

The Codex and Grok reader is not a full TOML parser. It reads table headers and
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
| Pi | Every server that is on, except SSE ones (Pi has no legacy SSE client). The chat worker registers them in Pi's own MCP support (`pi.registerMcpServer`), values over the worker IPC only; the servers in Pi's own `mcp.json` load too. None in plan mode or a side chat. MCP calls ask in the modes where `bash` asks and in edit mode; full access runs them. See [Agent Routing › Pi MCP servers](../chat/agent-routing.md#pi-mcp-servers). |
| Kimi | Every server that is on (stdio, HTTP and SSE), through ACP `session/new`. The servers in Kimi's own config also load, and a same-named one there wins. |
| Copilot | Every server that is on (stdio, HTTP and SSE), through the SDK session's `mcpServers`. The servers in the user's own Copilot config and the workspace `.mcp.json` also run in interactive chats, and when one of those asks for a sign-in ADE hands over the registry's sign-in for the same URL (matched ignoring host case, a default port and a trailing slash), so Copilot does not open a browser for it. See [Copilot SDK provider › MCP servers](../chat/copilot-sdk-provider.md#mcp-servers). |
| Grok, Qwen, Devin, Antigravity | None yet. Their configs are still scanned, so their servers can be imported for the other agents. |
| Personal chats, side jobs, SDK chats | None. The light session profile and strict MCP chats decide their own servers. |

A change reaches chats started after it. A running chat keeps what it started
with.

A registry server whose name the provider's own config also declares is left
to that config (`providerOwnMcpServerNames`) for Droid, Muse, Qwen, Kimi, Grok,
Devin and Antigravity. "Import" copies a server rather than moving it; Droid
was not shown to drop its own copy (two would start), and Muse refuses a
session server whose name its config has. Claude, Codex and Copilot replace a
same-named server from the launch (each probed: one process, the launch's
command), Cursor documents that an inline server wins over its config layers,
and OpenCode merges its config by name, so those get the registry's.

Pi is the other way round, by its own documented rule: a server in Pi's
`mcp.json` (the agent directory's, or a trusted project's) takes precedence
over a registered one of the same name, and the registered one does not start
(confirmed in Pi 1.4's MCP extension: `registeredServers` skips every name
`mcp.json` defines, an `enabled: false` entry included, and Pi counts names
that differ only in `-` and `_` as one). ADE therefore hands Pi every
registry server and lets Pi drop the duplicate; it does not need a
`providerOwnMcpServerNames` entry.

| Provider | Own MCP config ADE reads for that check |
|---|---|
| Droid | `<FACTORY_HOME_OVERRIDE or ~>/.factory/mcp.json`, `.factory/mcp.json` in the folder and every folder above it |
| Muse | `$XDG_CONFIG_HOME/muse/settings.json` (`~/.config/muse`), the workspace `.mcp.json` |
| Qwen | `<QWEN_HOME>/settings.json`, `.qwen/settings.json` |
| Kimi | `<KIMI_CODE_HOME>/mcp.json`, `.kimi-code/mcp.json`, `.mcp.json` |
| Grok | `[mcp_servers.<name>]` in `<GROK_HOME>/config.toml` and `.grok/config.toml` |
| Devin | `mcp_config.json` / `mcp_config.local.json` (3000.3+) and `config.json` / `config.local.json` (older) under `~/.config/devin` (`%APPDATA%\devin`) and `.devin` |
| Antigravity | `~/.gemini/config/mcp_config.json`, `.agents/mcp_config.json` |

ADE hands Qwen, Grok, Devin and Antigravity chats no servers today (the ACP
session gets an empty list), so for them the check only matters once it does.

## Your servers on ADE accounts

An ADE account runs Claude or Codex on its own config home
(`provider-homes/<provider>/<id>/`), and that home has none of the MCP servers
configured for the machine's own login. So a Claude chat on an ADE account
also gets the servers in the login's `.claude.json` (user scope, and the local
scope for this project), and a Codex chat gets the login's `config.toml`
`mcp_servers`, at launch (`mcpUserServersForLaunch.ts`). A name the account's
own config has, a name the project's `.mcp.json` or `.codex/config.toml`
declares, and a server switched off for the folder are left out; a chat in
strict MCP mode gets none. Claude receives them through the launch's MCP
config (on its command line, as registry servers already are); Codex through
the thread config. Nothing is written to either config home.

The same gap exists wherever ADE points a CLI at a config folder of its own.
Claude and Codex presets and routes are covered by the launch override above
(their env names the folder). A routed Grok launch (`GROK_HOME`) gets the
user's `[mcp_servers.*]` tables from `~/.grok/config.toml` appended to the
`config.toml` ADE writes for it, and a Droid preset or route
(`FACTORY_HOME_OVERRIDE`) gets a copy of the user's `.factory/mcp.json`
(`userGrokMcpServersToml`, `mirrorUserDroidMcpConfig`). Both files are
ADE-owned, private, and rewritten on each launch; the user's files are only
read. OpenCode presets add a config file (`OPENCODE_CONFIG`) rather than
replace the user's, so nothing is lost there.

Tracked Claude and Codex CLIs (Work terminals ADE launches, resumes, imports
or forks, including from the phone) get the same servers and the same `npx`
re-pointing (`trackedCliUserMcp.ts`), as `-c mcp_servers.<name>.<key>=…`
flags for Codex and `--mcp-config <file>` for Claude. A tracked CLI's
command line can be typed into the terminal as text and is kept for resume,
so no secret rides on it: Claude's servers go in a private file ADE writes
under `<ADE home>/mcp-launch/` (named by its contents), and a Codex server
whose env, headers, arguments or URL look like they hold a secret
(`mcpPlainTextSecretFindings`) is left to start as the user configured it.

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
- neither the package nor a command of its name is in the project tree or
  the global prefix (npx would run that one), and no `.npmrc` or
  `npm_config_registry` names another registry;
- an exact version matches the installed one; a tag or bare name matches the
  registry's answer for that tag, which the brain fetches (one small request,
  never more than 1.5 s on the launch path; an answer older than 15 minutes is
  used while a background check refreshes it, one older than six hours is not
  used; with no answer the launch keeps `npx`). Only packages that pass the
  checks above are ever asked about;
- the package's bin is a plain `node` script.

The direct launch puts the npx install's `node_modules/.bin` first on the
server's `PATH`, as npm's launcher does, so a server that runs one of its
dependencies' commands finds the same one.

Anything else launches as written. The user's config files are only read. A
CLI the user starts in a terminal is unchanged.

Which servers it applies to, per provider:

| Provider | User's own `npx` servers | ADE registry `npx` servers |
|---|---|---|
| Codex | Re-pointed per thread: `mcp_servers.<name> = { command, args }` in the thread config, merged into config.toml's table, so env, tool approvals and timeouts stay. Skipped in strict mode, for a name a caller or ADE also sets, for a server with `cwd`, and for a name the project's `.codex/config.toml` redefines. | Re-pointed |
| Claude | Re-pointed through the launch's MCP config: a server named there replaces the same name from the user and local scopes, and the user's other servers still load. Only for an entry that is just `command` and `args` (an `env` would have to be copied onto a command line), not for a name the project's `.mcp.json` declares or that the user switched off for the folder, and not in strict mode. | Re-pointed |
| Copilot, Cursor, OpenCode | Re-pointed through the servers ADE hands the chat (Copilot session `mcpServers`, Cursor inline `mcpServers`, OpenCode's shared-server config): a server of that name replaces the user's (Copilot probed; Cursor documents inline first; OpenCode merges by key). Only an entry that is just a command (plus Copilot's `tools`), not a name a workspace or project file overrides, and not in strict mode. | Re-pointed |
| Droid, Muse, Qwen, Kimi, Grok, Devin, Antigravity | Unchanged. These cannot be shown to replace their own copy of a same-named server, and passing one would start a second. | Re-pointed (ADE hands these over itself) |
| Pi | Unchanged. Pi starts the servers in its own `mcp.json` itself, and stops a stdio server's whole process group, `npx` wrappers included. | Re-pointed (ADE hands these over itself) |

## Background jobs start no MCP servers

Background jobs (titles, summaries and other one-shots) start none of the
user's servers on any provider. Claude (`--strict-mcp-config`), Codex (by
name, below), Copilot (config discovery off and every configured name
disabled), Qwen (`--safe-mode`), Pi (`pi -p --no-extensions`, which also turns
off Pi's built-in MCP support) and OpenCode (reuses the one shared server)
have a switch for it.

Droid, Kimi, Grok, Muse and Devin have none: each starts every server in its
config at launch, even for a job that calls none (measured with a stdio
marker server on the pinned 0.244, 2.3.1, 1.0.46, 1.4.7 and 3000.11.3;
Droid's `--settings` with `mcpPolicy.enabled: false` and Muse's
`-c mcpServers...` do not stop it). Their jobs run on a private copy of the
config folder, built per job under `<ADE home>/provider-task-homes/` and
removed after it (`providerTaskMcpOff.ts`):

| Provider | Points at the copy with | Left out or rewritten |
|---|---|---|
| Droid | `FACTORY_HOME_OVERRIDE` | `.factory/mcp.json` |
| Kimi | `KIMI_CODE_HOME` | `mcp.json` |
| Grok | `GROK_HOME` | `config.toml` without `[mcp_servers.*]`, plus `mcps = false` in `[compat.claude]`, `[compat.cursor]` and `[compat.codex]`: Grok also imports the servers in `~/.claude.json`, `.mcp.json` and `.cursor/mcp.json` |
| Muse | `XDG_CONFIG_HOME` | `muse/settings.json` without `mcpServers` |
| Devin | `XDG_CONFIG_HOME` (`APPDATA` on Windows) | `devin/mcp_config.json` and `mcp_config.local.json`; `devin/config.json` without `mcpServers` and with every `read_config_from` import off (Devin imports Claude's, Cursor's and other tools' servers by default) |

Every other entry of the real folder is linked in (a symlink; on Windows a
junction for a folder and a hard link for a file), so the sign-in, history
and session files are the real ones. A CLI that saves a linked file by
writing a new one and renaming it (Grok does) replaces only the link, so when
the job ends ADE copies such a file back over the real one, unless the real
one changed during the job. A refreshed token is kept. Droid, Kimi and Muse
get no copy when their file lists no server. When a link cannot be made, the
job runs on the real folder as before. Copies older than six hours (a
crashed brain, a removal Windows refused) are removed when the next copy is
made. Kimi and Grok jobs also run in ADE's scratch folder rather than the
project, like Droid's and Devin's: in a project the user trusted, Grok starts
the project's `.grok/config.toml` and `.mcp.json` servers (measured on
1.0.46). Servers a plugin adds (a Grok or Droid plugin, a Claude plugin Grok
imports) are not in these files and still start.

Cursor one-shots run on a home of their own,
`<ADE home>/provider-task-homes/cursor-home`, instead of the user's:
they sign in with an API key, and the worker writes ADE's tool-gate hook into
the home it runs on, so the user layer there holds the gate and no servers.
Strict MCP mode drops the project and plugin layers.

Codex runs that need none of the user's servers start none of the
config.toml ones: background utilities (`codex exec`, chat titles and the
like), the private app-server a fork runs in, and the voice relay. Each gets
`-c mcp_servers.<name>.enabled=false` per server (`codexMcpOff.ts`). `-c mcp_servers={}` does not do this;
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
| `apps/desktop/src/main/services/mcp/mcpProviderConfigScan.ts` | Reading the six provider configs, including the Codex TOML tables. |
| `apps/desktop/src/main/services/chat/mcpRegistryLaunch.ts` | The registry as one chat launch sees it. |
| `apps/desktop/src/main/services/mcp/npxDirectLaunch.ts` | Runs an `npx` server's installed package with `node` when it is provably the copy npx would run. |
| `apps/desktop/src/main/services/mcp/chatUserMcp.ts` | The seam the chat service calls at each launch step: registry servers minus double copies, the user's own servers per provider, the Codex overlay and the two Claude halves. |
| `apps/desktop/src/main/services/mcp/mcpUserServersForLaunch.ts` | The user's own servers for one Claude or Codex launch: the machine login's servers on an ADE account, and `npx` servers re-pointed. |
| `apps/desktop/src/main/services/mcp/trackedCliUserMcp.ts` | The same servers for a tracked Claude or Codex CLI, without secret-bearing ones; `trackedCliUserMcpFlags` in `shared/cliLaunch.ts` renders them. |
| `apps/desktop/src/main/services/mcp/codexMcpOff.ts` | Switches every config.toml server off by name for Codex runs that need none. |
| `apps/desktop/src/main/services/mcp/providerTaskMcpOff.ts` | The private config-folder copy a Droid, Kimi, Grok, Muse or Devin background job runs on, its write-back, and the Cursor one-shot home. |
| `apps/desktop/src/renderer/components/settings/mcp/` | The page, the add and edit dialog, the hook and the layout CSS. |
