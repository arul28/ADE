## Linear

Browse Linear issues, start a lane and an agent on one, and keep the issue
moving — from ADE, on the desktop, the phone, the web client, and the
terminal.

Installing this plugin replaces ADE's compiled Linear surfaces. Disabling it
brings those compiled surfaces back.

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
- Search and the state / sort / team filters round-trip through Linear. Project,
  assignee, priority, and recency also filter on the client against rows already
  in memory.
- Identity icons use the Linear mark shipped as `icons/linear.svg`.
