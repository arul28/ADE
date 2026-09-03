## Linear

Browse Linear issues, start a lane and an agent on one, and keep the issue
moving — from ADE, on the desktop, the phone, the web client, and the
terminal.

Installing this plugin replaces ADE's compiled Linear surfaces. Disabling it
brings those compiled surfaces back.

### How it draws

Linear ships its own page. `dist/` is a built HTML application (`page/` is its
source), and every placement below is a `webview` surface pointing at it: the
tab, the Settings section, the composer menu's issue picker, the chat menu's
issue-context card, the lane badge's hover card and the two dialog pickers. One
build, six placements, told apart by the surface the host opened.

Every one of those surfaces still names a panel, and that panel is what the
phone, the terminal and an older desktop draw instead. Nothing is lost by not
hosting a page — the vocabulary panels are the same product, drawn with less.

### What it adds

- A **Linear** tab and work-rail pane: issues grouped by workflow state, nav-bar
  search and nav-bar verbs (Open in Linear, Refresh, settings), filters, and a
  batch bar for launching lanes or assigning.
- An **Attach a Linear issue** row in the composer's three-dot menu, and a
  **Linear** row in the chat's, under Issue context: open the issue in Linear,
  detach it, attach another, or comment the chat's progress onto it.
- An issue detail panel: description and comments as markdown, inline state and
  priority, assign, comment, and a sticky launch bar.
- A section on Settings > Integrations for the Linear connection: OAuth, an API
  key, the default team, and the GitHub reference links. The phone and the
  terminal draw no Settings page for a plugin, so the same panel is reachable
  from inside the Linear tab there.
- A **Linear** tile in Automations with the five triggers, filters for project,
  team, assignee, label and state, and a one-press Register that creates this
  workspace's webhook through the Linear API and stores its signing secret
  itself. Two templates beside it: move an issue to In Progress when a lane
  opens on it, and to Done when its pull request merges.
- Agent tools, CLI words, automation steps, a URL matcher for `linear.app` issue
  links, and a command-palette / keybinding entry.

### Notes

- The Linear token stays on this machine. Agents use the same connection.
- The webhook is registered from ADE, not pasted into it. Linear shows a
  webhook's signing secret once, at creation, so the flow that creates the hook
  is the flow that stores the secret — and a hook at ADE's URL whose secret this
  plugin does not hold is replaced rather than adopted, because ADE drops every
  delivery it cannot verify.
- Registering needs an OAuth sign-in. Linear delivers a data-change webhook only
  to an authorization carrying `admin`, and a personal API key carries no OAuth
  grant at all.
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
