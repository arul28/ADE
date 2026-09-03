# Plugin page tier — wave 2 spec (2026-09-03, locked with the owner)

Scope: Linear to one-to-one with the compiled integration, every other official
plugin ported to the page tier in one wave, the old vocabulary renderers
deleted, the header layout system, and one test round at the end. Decisions
below were locked in three plan rounds. Ticket: ADE-148.

## Contracts added in this wave (platform)

Sockets (declared in `plugin.json`, drawn by the host):

| Kind | Where it draws | Payload | Press |
|---|---|---|---|
| `composer-menu-item` | the composer's three-dot menu | label, icon | action; may answer `openWebview` placement `picker` or `composer.attach` |
| `chat-menu-item` | the chat three-dot menu, nested under `submenu` (e.g. `issue-context`) | label, icon, `submenu` | action; may answer `openWebview` placement `popover` anchored to the menu |
| `machine-entry` | the composer's machine picker | label, icon, `advancedSurfaceId` | selecting it makes Enter launch through the plugin (`ownsSend` semantics); Advanced opens the page inline from the row |
| `automation-trigger-tile` | Automations trigger grid, one tile per plugin | icon, label, `triggers[]` (id, label), `filters[]` (declarative fields: select from a plugin collection, text), `webhook` (statusAction, registerAction) | the tile replaces the generic Plugins tile for that plugin |
| `automation-template` | the templates gallery | icon, name, description, template body | creates the automation |

Bridge verbs (host pickers; the app's own components open as a popover and
return the choice): `ui.pickModel()`, `ui.pickLane()`,
`ui.pickPermissionMode({ provider })`, `ui.pickReasoningEffort({ provider, model })`,
`ui.pickProvider()`. Mirrored on web and iOS.

Header: pinned right cluster in order feedback, help, zoom, then usage,
connections, bell. Flexible region left of it: project tabs first (they win
space), then plugin `toolbar-action` buttons on the `app` surface in the user's
order, drag to reorder (handle on hover), order persisted per user. Overflow
behind a chevron at the region's end, shown only when something is hidden, with
the hidden buttons and a Reorder entry.

Page error card: a page that throws or fails to load draws a card with the
plugin name, the error, Reload and Open logs. `ade plugin doctor` checks pages:
dist present, entry loads, bundle size, CSP violations logged by the guest.
Phone: pull to refresh on a plugin page sends `refresh` to the page.

Naming: "Electron Control" and "iOS Sim Control" everywhere.

## Linear (plugins/ade-linear)

- Launch: the form's prompt is the first message of the new chat; failures show
  in the chat as they do for every launch.
- Remove: the top-bar quick view, the chat-header action, the composer bar
  button. Attach lives in the composer three-dot menu (`composer-menu-item`).
- Issue context: the chat menu's Issue context submenu gains the Linear row from
  the plugin (`chat-menu-item`), opening the anchored popover page with the
  issue, Open in Linear, Detach, or Attach.
- Settings card: connection (Reconnect, Disconnect, default team), GitHub
  reference links with Create, one line pointing at Automations. The two
  automation toggles are deleted; the clipboard toggle stays under the launch
  form, not in Settings.
- Automations: the Linear tile with the five triggers, filters project, team,
  assignee, label, state, and the webhook block: status line and one-click
  Register that creates the webhook through the Linear API after sign-in and
  stores the signing secret itself. Two automation templates.
- Launch form uses the host pickers for model, lane, permission mode,
  reasoning effort, provider.

## Cursor Cloud (plugins/ade-cursor-cloud), all of it

- Machine picker row "Cursor Cloud" with Advanced inline (`machine-entry`).
  Enter launches from the draft; Advanced opens the launch page over the
  composer with repo, model and secrets through host pickers.
- Cloud-agent chats draw exactly what main draws today through the chat runtime
  seam; port main's logic, invent nothing.
- Fleet: rail-tab page (also a Work-rail pane) listing all cloud agents with
  filters, detail, follow-up, artifacts. Fix the page-size bug (Cursor caps
  `limit` at 100).
- CLI words, trigger tile, unread badge as today. No new extras.
- A fresh merge of `origin/main` precedes this port.

## Ports (one wave)

- Graph and History: full page ports; React Flow and the git DAG run inside the
  page. Host engines for them are deleted.
- Review: page port (runs, launch form, findings, learnings, PR toolbar).
- Electron Control and iOS Sim Control: pages that embed the host-owned engine
  placement; the engines stay in the host.
- Themes: no port (token packs).
- Phone: Linear and Cursor Cloud pages; nothing for Electron Control and iOS
  Sim Control; History and Graph later.
- Old language: delete the desktop, web and iOS vocabulary renderers and their
  tests once no official plugin publishes a panel; keep the terminal profile.

## Order

1. Merge `origin/main`.
2. Platform batch (contracts above, header, error card, doctor, pull to refresh,
   iOS mirrors).
3. Plugin batches in parallel: Linear, Cursor Cloud, Graph + History, Review +
   Electron Control + iOS Sim Control.
4. Vocabulary deletion, docs, gates, MacBook builds (desktop + iOS), then the
   owner's one test round.
