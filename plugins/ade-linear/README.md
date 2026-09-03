## Linear

Browse Linear issues, start a lane and an agent on one, and keep the issue
moving — from ADE, on the desktop, the phone, the web client, and the
terminal.

Installing this plugin replaces ADE's compiled Linear surfaces. Disabling it
brings those compiled surfaces back.

### How it draws

Linear ships its own page. `dist/` is a built HTML application (`page/` is its
source), and every placement below is a `webview` surface pointing at it: the
tab, the top-bar quick view, the Settings section, the composer and chat-header
pickers, the lane badge's hover card and the transcript's issue context. One
build, six placements, told apart by the surface the host opened.

Every one of those surfaces still names a panel, and that panel is what the
phone, the terminal and an older desktop draw instead. Nothing is lost by not
hosting a page — the vocabulary panels are the same product, drawn with less.

### What it adds

- A **Linear** tab and work-rail pane: issues grouped by workflow state, nav-bar
  search and nav-bar verbs (Open in Linear, Refresh, settings), filters, and a
  batch bar for launching lanes or assigning.
- A **Linear** button in the window's top bar, which opens the issue list as a
  quick view beside it.
- An issue detail panel: description and comments as markdown, inline state and
  priority, assign, comment, and a sticky launch bar.
- A section on Settings > Integrations for the Linear connection, including
  OAuth, API key, and webhooks. The phone and the terminal draw no Settings page
  for a plugin, so the same panel is reachable from inside the Linear tab there.
- Agent tools, CLI words, automation triggers and steps, a URL matcher for
  `linear.app` issue links, and a command-palette / keybinding entry.

### Notes

- The Linear token stays on this machine. Agents use the same connection.
- Signing in is this plugin's own. It never inherits the connection ADE's
  compiled Linear surface holds, so a fresh install signs in like any other.
- A completed sign-in reads Linear and rewrites both the issue list and the
  connection panel before it is done, so the issues are there without leaving
  the tab and coming back. The panel the Connect button was pressed on is the
  one written last.
- Search and the state / sort / team filters round-trip through Linear. Project,
  assignee, priority, and recency also filter on the client against rows already
  in memory.
- Identity icons use the Linear mark shipped as `icons/linear.svg`.
- The page's filters and selection live in the plugin's `ui-state` collection,
  not in browser storage: a plugin page's storage partition is non-persistent
  and dies with the placement.
- `page/node_modules` is a BUILD dependency only. It is git-ignored and the
  installer never copies it, so nothing under it reaches a user's machine. See
  `page/README.md` for the build, and `page/PARITY.md` for what the page carries
  against ADE's compiled Linear and what it does not.
