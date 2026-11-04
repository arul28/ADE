# The Work board, activity labels and card drags

## Activity detail on the card

ADE derives the parent state automatically, and for ADE chats it also detects
the activity detail (Exploring, Implementing, Testing, Reviewing, Shipping,
Monitoring) from your tool calls, so you do not need to report it. Some
provider adapters also surface structured activity, such as Plan mode or a
background monitor. ADE offers agent-reported activity only when the current
provider can invoke the session's ADE CLI; use it to correct or refine the
detected state (Debugging, which looks like testing to the detector). When available, session-specific guidance gives the exact
command and allowed values. For tracked terminals, `ade chat activity` targets
`ADE_ACTIVITY_SESSION_ID`, while other ADE commands continue to use the owning
chat in `ADE_CHAT_SESSION_ID`. Use that guidance to report or clear a detail;
when it is absent, do not try to set one.

An activity report refines a Working card and never moves it to Needs you,
Waiting, or Done. ADE clears it when a new user turn is accepted. Update it
when the work changes; do not keep a stale label. Each card shows at most one
status: Needs you has priority, otherwise one current activity detail occupies
the label in place of generic Working.

## Board and status

The Work tab has a board view with four columns. Your row sits in exactly one of
them. The host derives the column; you never write it directly.

| Column | How the host derives it |
| --- | --- |
| **Needs you** | Your row has a raised hand or an unanswered approval card. |
| **Working** | A turn is running and nothing waits on the user. |
| **Waiting** | The row is snoozed, or its lane PR has CI pending or a review requested. |
| **Done** | The session ended or the user settled it. |

Two rules follow from that:

- **The column is derived, so keep the inputs true.** Call `ade chat note` when
  the state changes, and call `ade chat ask` whenever you need an answer or a
  decision from the user, even while background work keeps running. A stale note makes a correct column read as the wrong work.
- **Never claim a column.** There is no command that moves your own row. Do not
  say a row is Done; end the turn and leave a note.

**The user can drag your card.** A drag writes the status and then delivers one
message to you. It arrives as a normal message with a board-move marker and a
fixed sentence. React to it, do not ignore it:

- **Done to Working.** The user reopened work you thought was finished. Re-read
  the recent transcript, continue the work, and if the next step is genuinely
  unclear, ask rather than guess.
- **Any column to Needs you.** The user parked the work for their input. Stop
  what you are doing, summarise where you are in one short message, and list
  exactly what you need from them.
- **Working to Done.** The user filed the row. No message reaches you.

If your provider cannot take a message mid-turn, the board move still applies
and the message arrives at the next turn boundary. Handle it then.

Snoozing a row is the user's call; do not snooze. To come back to something
later, use the table under **Waiting for work to finish** in SKILL.md.
