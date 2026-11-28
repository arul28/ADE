# MCP servers

Settings › Integrations › MCP servers is where a person defines an MCP server
once and every DAEX agent gets it, on every computer they sign in on. Each
provider CLI keeps its own MCP list, so without this a server added to Claude
never reaches Codex, and a second computer starts with none. The page is
desktop only (`web: "hidden"`): a browser has no vault bridge and the checks
read local files.

## Source file map

- `apps/desktop/src/shared/mcpRegistry.ts`: the model (list and off lists,
  state, vault key names, conversion to provider shapes). At most 32 servers.
- `apps/desktop/src/shared/mcpCatalogue.ts`, `mcpCatalogueEntries.ts`: the
  built-in catalogue of quick setups. The entries file's header lists vendors
  left out and why.
- `apps/desktop/src/shared/mcpServerImport.ts`: parse a provider config entry
  or pasted JSON; `mcpPlainTextSecretFindings`.
- `apps/desktop/src/main/services/mcp/mcpRegistryService.ts`
  (`window.ade.mcpRegistry`): this-computer checks, vault writes, scan, import,
  sign-in. No call returns a secret value.
- `main/services/mcp/mcpOAuth.ts`: the browser sign-in and renewal.
- `main/services/mcp/mcpProviderConfigScan.ts`: reads provider CLI configs.
- `main/services/mcp/mcpServerRequest.ts`: agent add/remove requests.
- `main/services/chat/mcpRegistryLaunch.ts` (`resolveMcpRegistryForLaunch`):
  the registry as one launch sees it.
- `main/services/mcp/chatUserMcp.ts`, `mcpUserServersForLaunch.ts`,
  `trackedCliUserMcp.ts`: per-launch server sets for chats, DAEX accounts and
  tracked CLIs.
- `main/services/mcp/npxDirectLaunch.ts`: `npx` servers without npm's launcher.
- `main/services/mcp/codexMcpOff.ts`, `providerTaskMcpOff.ts`: no servers for
  background jobs.
- `apps/desktop/src/renderer/components/settings/mcp/`: the page
  (`McpServersSection.tsx`), dialogs, `useMcpRegistry.ts`.

## The data

Three plain JSON rows in the account settings store:

| Row | Scope | Holds |
|---|---|---|
| `mcp.servers` | `all` | name, transport (`stdio`, `http`, `sse`), command and args or URL, the NAMES of env variables and headers, `enabled` |
| `device.<deviceId>.mcp.off` | `all` | names off on one computer |
| `mcp.off` | `repo:<remote>` | names off in one repository |

- **A server never carries a secret value.** Values live in the account vault
  (kind `secret`, key `mcp/<server>/env/<NAME>` or `mcp/<server>/header/<NAME>`,
  `mcpSecretVaultKey`).
- **Arguments and URLs are not secret** and sync as written. The dialog warns
  (never blocks) when one looks like it holds a token
  (`mcpPlainTextSecretFindings`, a shape check) or a `${NAME}` reference, which
  DAEX passes as written.
- **A launch never puts a secret on a command line.** The Claude spawn
  (`claudeSubprocessReaper.spawnClaudeCodeProcess`, with
  `moveClaudeMcpConfigOffArgv` in `chat/claudeMcpConfigFile.ts`) moves the SDK's inline `--mcp-config <json>`
  into an owner-only file under `<ade home>/mcp-launch/chat/` and passes its
  path. The file is deleted on exit; a starting brain removes files no running
  process names (on Windows, files older than seven days).
- **The name is the key** for vault items, off lists and tool names, so it is
  not editable; renaming is remove and add.

## The page

- **In your account**: one row per server with a state tag (`mcpRegistryState`)
  and three switches: Your account, This computer, This project (needs a git
  remote).
- **Found on this computer, not in DAEX**: servers the provider CLIs already
  have, with Import.
- **Who gets them**: read off `registryMcpSupport`
  (`shared/callerMcpServers.ts`), which the launch path uses too.
- Row status is about this computer: a missing secret value (the server still
  starts without it), a `stdio` command not found
  (`resolveExecutableFromKnownLocations`), browser sign-in state.
- When the brain cannot answer, the page shows this computer's cached copy
  read-only.
- **Add/edit** (`McpServerDialog.tsx`): Command, HTTP or SSE; saved values show
  as "Saved" and are never read back. **Paste JSON instead** accepts the usual
  `mcpServers`, OpenCode's `mcp`, a bare map or one object.
- **Saving** (`useMcpRegistry.ts`): each change re-reads the row from the brain
  first, and shows only after the brain confirms. Secret values are written
  before the server joins the list; removal goes list, then off lists, then
  vault items.

## The catalogue

Quick setups, not the list of supported servers: any server can be added by
command or URL. `matchMcpCatalogue` matches by exact URL or package name and
gives the card a brand and **By <publisher>**; others say **Custom**. Every
`oauth` entry supports the dynamic client registration DAEX's sign-in needs.
Three entries are DAEX integrations (`native`: GitHub, Linear, Atlassian);
asking for one runs that integration's connect card instead.

Each non-native entry is also a settings entry (`integrations.mcp-<id>`, anchor
`#add-mcp-<id>`), so Settings search, Cmd-K and `daex settings find` find it.

## Agents adding and removing servers

An agent asks; the person answers on a card in the agent's chat, in every
permission mode. Both cards are user-only (`isUserOnlyConsentCard`). They run on
the chat's machine and write the account-wide list (`mcpServerRequest.ts`).

- `daex mcp servers add <name>` (`mcp_registry.request`): a catalogue name, a
  server another tool has (`--import`), or one the agent describes (`--url`, or
  a command after `--`). A one-word host with no port (`https://blurb/mcp`) is
  refused: an agent never guesses an address.
- `daex mcp servers remove <name>` (`mcp_registry.remove`): only when the person
  asked. Removes the server, its off-list entries and its vault items. If
  another machine replaced the server under that name meanwhile, nothing is
  removed.

The chat keeps its tools until the person presses **Refresh chat**.

## Browser sign-in

`mcpOAuth.ts` runs the MCP authorization flow once, instead of each CLI into
its own store:

1. Probe with an unauthenticated `initialize`; a `401` with a Bearer
   `resource_metadata` challenge means sign-in (cached per URL 10 minutes; a
   server with its own header is not probed).
2. Read protected-resource metadata (RFC 9728), then authorization-server
   metadata (RFC 8414, then OpenID).
3. Register via dynamic client registration for
   `http://127.0.0.1:<random port>/callback`.
4. Open the browser (PKCE S256, `state`, `resource`); wait up to five minutes.
5. Store the token as one vault item, `mcp/<server>/oauth/token`.

The sign-in always runs in this desktop's main process (the browser and the
redirect listener must share a computer), even when the tab is bound to another
machine; the vault makes every computer signed in. At launch
`mcpRegistryToCallerServers` adds `Authorization: Bearer <token>` unless the
person set that header. Tokens with a refresh token renew under 15 minutes left,
every five minutes while the desktop runs, one renewal per server at a time
(rotating refresh tokens break on reuse). Discovery refuses metadata for another
resource, requires HTTPS (except loopback) and never follows redirects.

## What the scan reads

`mcpProviderConfigScan.ts` reads each provider's user-level config,
best-effort: Claude (`~/.claude.json`, plus the open project's entry), Codex and
Grok (`[mcp_servers.<name>]` in `config.toml`), Copilot
(`~/.copilot/mcp-config.json`), Cursor, OpenCode (`mcp`), Droid, Pi (its agent
dir's `mcp.json`), Muse, Qwen (Gemini's shape), Kimi, Devin and Antigravity.

- Project files (`.mcp.json` and similar) are not scanned; they come with the
  repository.
- The same name in two providers is one row. Names outside `[A-Za-z0-9_-]` are
  listed as not offered. Reserved names (`computer_use`, `daex-cto`, and the
  pre-rename `ade-cto`) are skipped.
- Codex's `bearer_token_env_var` / `env_http_headers` are read from the
  desktop's environment; when unset, the header imports with no value.
- The Codex/Grok reader is not a full TOML parser: an inline
  `mcp_servers = { … }` table is not found.

## Who gets registry servers

Decided at launch by `resolveMcpRegistryForLaunch`
([Chat › The MCP registry](../chat/README.md#the-mcp-registry)).

| Agent | Gets |
|---|---|
| Claude, Cursor, Droid, OpenCode | every server that is on |
| Codex | all but SSE (no SSE client) |
| Pi | all but SSE, registered through `pi.registerMcpServer`; none in plan mode or a side chat ([Pi MCP servers](../chat/agent-routing.md#pi-mcp-servers)) |
| Kimi, Copilot | all (stdio, HTTP, SSE). Copilot reuses the registry's sign-in when its own config asks for the same URL ([Copilot › MCP servers](../chat/copilot-sdk-provider.md#mcp-servers)) |
| Antigravity | stdio only (`agy acp` advertises no MCP capabilities) |
| Grok, Qwen, Devin | none yet (their configs are still scanned for import) |
| Personal chats, side jobs, SDK chats | none |

A change reaches chats started after it. A running chat shows the **Refresh
chat** chip (`McpRefreshChip.tsx`, from `mcp_registry.chatStatus` on the chat's
machine); pressing it restarts the agent session and keeps the conversation.

**Same-named servers.** Claude, Codex and Copilot replace a same-named config
server with the launch's; Cursor's inline server wins; OpenCode merges by name.
Droid, Muse, Qwen, Kimi, Grok, Devin and Antigravity cannot be shown to
replace their own copy, so a registry server whose name their own config
declares is left to that config (`providerOwnMcpServerNames`). Pi drops a
registered server whose name its own `mcp.json` defines, by its own rule.

## Your servers on DAEX accounts

A DAEX-made Claude or Codex account runs on its own config home, which lacks the
machine login's servers. So a chat on such an account also gets the login's
user-scope servers (Claude `.claude.json`, Codex `config.toml`) at launch
(`mcpUserServersForLaunch.ts`), minus names the account or project declares,
servers off for the folder, and everything in strict MCP mode. Nothing is
written to either home. Routed Grok and Droid launches get the user's servers
copied into DAEX's own private config (`userGrokMcpServersToml`,
`mirrorUserDroidMcpConfig`).

### Tracked CLI terminals

A tracked CLI (a Work terminal DAEX launches, resumes or reattaches) gets the
registry's servers from the same resolver (`resolveTrackedCliUserMcp`). A
terminal's command line is kept for resume, so no secret rides on it:

| CLI | How | What |
|---|---|---|
| Claude | `--mcp-config <file>`, a private file under `<ade home>/mcp-launch/` | every server that is on, values included |
| Copilot | `--additional-mcp-config=@<file>`, a private file there | every server that is on, values included |
| Codex | `-c mcp_servers.<name>.…` flags | only servers carrying no secret (`codexEntryCarriesSecret`) |
| Cursor, Droid, Pi, Kimi, Qwen, Grok, Devin, Muse | none | no per-launch flag DAEX can use without writing the user's config |
| OpenCode | none | attaches to DAEX's shared OpenCode server |

A server missing its value or with an expired sign-in is left out of a terminal
(a chat starts it and says so). Values come from the vault through
`setTrackedCliRegistrySecretReader`, set by the brain at boot.

## `npx` servers start without npm's launcher

`npx <package>` keeps a whole npm process alive as the server's parent (about
95–190 MB and 1–1.5 s per server per chat). For chats DAEX starts,
`npxDirectLaunch.ts` runs the already-installed package with `node` directly,
only when that copy is provably what npx would run today: simple flags only; a
registry name with no version, an exact version or a dist-tag; npx's cache
records exactly that spec; nothing shadows it in the project or global prefix;
no other registry is configured; a tag matches the registry's current answer
(fetched by the brain, at most 1.5 s on the launch path); the bin is a plain
`node` script. The install's `.bin` goes first on `PATH`. Anything else launches
as written.

Registry `npx` servers are re-pointed for every provider. The user's own `npx`
servers are re-pointed for Codex, Claude, Copilot, Cursor and OpenCode (each
can replace a same-named config server); Droid, Muse, Qwen, Kimi, Grok, Devin,
Antigravity and Pi are left unchanged.

## Background jobs start no MCP servers

Background jobs (titles, summaries, one-shots) start none of the user's servers.

- **Have a switch**: Claude (`--strict-mcp-config`), Copilot (discovery off,
  every name disabled), Qwen (`--safe-mode`), Pi (`--no-extensions`), OpenCode
  (the shared server), Codex (`-c mcp_servers.<name>.enabled=false` per server,
  `codexMcpOff.ts`; `-c mcp_servers={}` does nothing because Codex merges
  tables).
- **No switch**: Droid, Kimi, Grok, Muse and Devin start every configured
  server. Their jobs run on a private copy of the config folder under `<ade
  home>/provider-task-homes/` with the MCP files left out or rewritten
  (`providerTaskMcpOff.ts`); every other entry is linked to the real one, and a
  file the CLI replaced by rename is copied back unless the real one changed.
  Kimi and Grok jobs also run in a scratch folder, since Grok starts a trusted
  project's servers.
- Cursor one-shots run on their own home,
  `<ade home>/provider-task-homes/cursor-home`.
- Servers a plugin adds are not in these files and still start.
