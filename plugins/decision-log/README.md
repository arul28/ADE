# Decision Log

Decisions get made in chats and then live nowhere. This keeps them.

Press **Log decision** at the top of any chat, type the decision in one line —
*"we're going with Postgres"* — and it is saved with the lane you were in and
the date, with a short card in the transcript confirming what got logged.

## What it adds

| Where | What |
|---|---|
| The chat header | **Log decision** — asks for one line, saves it, confirms it with a card. Its dropdown opens the log |
| ⌘K | **Log a decision** — the same thing, and it knows which chat you were looking at |
| A **Decisions** tab | The whole log, newest first, with quick filters for *Last 7 days*, *Last 30 days* and by lane |
| Each decision's row menu | **Mark as reversed**, behind a confirm. It stays in the log, marked, and can be un-reversed |
| The Lanes list | A count badge on lanes that have decisions. A lane with none shows nothing |
| Settings | A weekly digest you can turn on and pick the day for. It reschedules on save — no restart |

## Where each piece draws

Not every socket exists on every client, and an unsupported kind is *absent*
there rather than degraded:

- **Desktop and web** — all of it.
- **iPhone** — the Decisions tab, the lane badges and the confirmation cards.
  **Log decision** is a row in the chat's ⋯ overflow menu rather than a header
  button, because a phone nav bar holds a title and about two controls. The
  **command palette entry and the settings section do not render on iOS at
  all** — log from the chat menu, and set the digest on a computer.
- **`ade code`** — the lane badges and the row menu. The tab is reachable with
  `/plugin-view decision-log`.

Decisions sync, so the log reads the same on every device on your account.

## From the terminal

```bash
ade decision-log log "we're going with Postgres"
ade decision-log list
ade decision-log digest      # the same summary the weekly schedule sends
```

## What it stores, and what it does not

Everything lives in one synced collection, in the shape the row is drawn in.
The log is a **bounded window of the newest 400 decisions** — synced storage is
2 MiB and 4,000 rows per plugin per machine, and every byte of it replicates to
your phone, so history-shaped data has to be windowed rather than allowed to
append forever. Reaching a ceiling costs the newest write and nothing else.

It reads no transcripts. The chat button is handed the conversation's id, title
and status — not its contents — and the decision text is the line you typed.

## Tests

```bash
node --test plugins/decision-log/test/*.test.js
```

The suite stubs the host the way the host behaves *at its ceilings* — a `list`
that clamps, a `put` that refuses — and pins the cross-file agreements the
manifest parser cannot check: that every `actionId`, `refreshAction` and
`allowActions` id is really exported, and that the button's colour is one that
clears the 3:1 contrast gate on both themes.
