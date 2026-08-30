# Work Journal

One-line notes from wherever you already are, tagged with the lane you were on,
and a standup written from them.

## Where it appears

| You press | Where | Clients |
|---|---|---|
| **Log it** (split button) | The header of every chat. Saves the conversation's title as a note. Its dropdown holds **Blocked**, **Done**, **Write my standup** and **Open the journal** | Desktop, web, iPhone (as rows in the chat's ⋯ menu). Not the TUI |
| `/note fixed the login bug` | The chat composer's command menu. The words after the command are the note, and the draft is cleared | Desktop and web only |
| A count badge on each lane | The Lanes list — today's notes for that lane. A lane with none shows `0` | Desktop, web, iPhone, TUI |
| **Add a note** | A lane's right-click menu. Opens a form already pointed at that lane | Desktop, web, iPhone, TUI |
| The **Journal** pane | Beside Terminal / Git / Files, and in the phone's plugin menu. Today's notes, with pull-to-refresh on the phone | Desktop, web, iPhone |
| The **Journal** tab | Every note, filtered by When / What / Lane with no round trip. Delete from a row's ⋯, with a confirm | Desktop, web, iPhone, TUI |
| **Write my standup** | ⌘K, `Mod+Shift+U`, the chat header's dropdown, or either panel. Writes today's notes into a card in your chat, with a Copy button | Palette and shortcut are desktop and web; the card itself is desktop, web and iPhone |
| Settings → Work Journal | Standup time, Slack webhook, auto-post | Desktop and web only |

## The terminal

```bash
ade journal today                                  # today's notes, as JSON
ade journal week
ade journal standup                                # the standup text
ade journal add "fixed the login bug" --done
ade journal add "waiting on ops" --blocked --lane auth
```

## Agents

Two tools, `plugin__journal__add_note` and `plugin__journal__list_notes`, plus a
skill telling the agent when logging is worth it and when it is noise. Both load
only where this plugin is installed and enabled, and reach an agent **from its
next turn** — a turn already running keeps the context it started with.

## Slack

Set an incoming-webhook URL in Settings → Work Journal, pick a time, and turn
auto-post on. The URL goes in this plugin's encrypted per-plugin secret store,
never in a synced collection. `hooks.slack.com` is the only host the manifest
declares, so the child process cannot reach anywhere else, and a URL that is not
one is refused before it is stored.

## Storage

Notes go in a synced collection, so every device on the account sees the same
journal. They are a rolling 120-day window with `evictOldest` on every write:
reaching the ceiling costs one note and never the plugin. Nothing else is
stored — no transcript, no message text. A plugin's runtime hooks carry metadata
only, and this one only reads `turn.start` to know which chat you were last in.

## Tests

```bash
node --test plugins/journal/test/*.test.js
```
