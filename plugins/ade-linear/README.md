## Linear

Browse Linear issues, start a lane and an agent on one, and keep the issue
moving — from ADE, on the desktop, the phone, the web client, and the
terminal.

Installing this plugin replaces ADE's compiled Linear surfaces. Disabling it
brings those compiled surfaces back.

### What it adds

- A **Linear** tab and work-rail pane: issues grouped by workflow state, nav-bar
  search, filters, and a batch bar for launching lanes or assigning.
- An issue detail panel: description and comments as markdown, inline state and
  priority, assign, comment, and a sticky launch bar.
- Settings for the Linear connection, including OAuth, API key, and webhooks.
- Agent tools, CLI words, automation triggers and steps, a URL matcher for
  `linear.app` issue links, and a command-palette / keybinding entry.

### Notes

- The Linear token stays on this machine. Agents use the same connection.
- Search and the state / sort / team filters round-trip through Linear. Project,
  assignee, priority, and recency also filter on the client against rows already
  in memory.
- Identity icons use the Linear mark shipped as `icons/linear.svg`.
