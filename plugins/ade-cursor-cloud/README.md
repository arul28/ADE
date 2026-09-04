# Cursor Cloud

Launch Cursor Cloud agents from ADE, watch them from any client, and answer them
in an ordinary ADE chat.

A Cursor Cloud agent clones your lane's branch, works on it on Cursor's
machines, and pushes back. This plugin gives that four places to live inside
ADE:

- **A fleet.** Every cloud agent for this project, in one list, with the lane and
  branch each belongs to. Filter by status, by lane, and by whether it is
  archived, without a round trip.
- **A chat.** Open a cloud agent as an ADE conversation. Its history is
  backfilled into the transcript, your follow-ups go to Cursor, and its replies
  stream back where you already read everything else.
- **A row in the composer's machine picker.** "Cursor Cloud" sits beside your
  computers, because "where does this run" is one question. Picking it is cloud
  mode; pressing Enter launches. Advanced opens the full form — the lane, the
  model, the reasoning and speed params, the PR toggle, and any secrets the run
  needs.
- **Live status.** Cursor posts to ADE's relay when a run finishes or fails, so
  a chat nobody is watching still wakes up — and any automation rule you built
  on it fires.

## Before it works

**Connect a Cursor API key.** ADE holds it: Settings → AI connections → Cursor.
This plugin asks the host for that key one call at a time and never stores a
copy of its own. Without it the fleet says so rather than showing an empty list.

**Connect the repository to Cursor.** Cursor clones from its own GitHub
connection, not from this machine, so a repository Cursor has never seen cannot
be worked on. The launch form checks first and tells you which of the two is
missing.

**Paste the webhook URL into Cursor** for push updates. `ade plugin doctor
ade-cursor-cloud` prints the URL for the `cursor` channel. Without it the fleet
still refreshes every few seconds while the tab is visible, and an open chat
polls while you are looking at it. A webhook is what wakes a chat nobody is
watching.

## What it puts where

| Where | What |
|---|---|
| Rail tab **Cursor Cloud** | The fleet: a flat recency list with search and status chips. An unread pill appears when a run finishes while you are not looking. |
| Work rail pane | The same fleet, beside a chat. |
| Chat composer | **Cursor Cloud** in the machine picker. Enter launches; Advanced opens the launch page. |
| Chat header | **Cursor Cloud** opens the agent on cursor.com, with "Open the Cursor Cloud fleet", "Pull this run into the lane" and "Stop this cloud run" behind it. |
| Command palette | **Cursor Cloud fleet**. |
| The agent | `list_agents`, `launch_agent`, `stop_agent`, `pull_into_lane`. |
| Automations | Its own trigger tile: fires when a run **finishes** or **errors**, filtered by lane, repository or agent name, with the relay's status and the URL to paste into Cursor. Steps to stop an agent or pull its branch. |
| `ade` | `ade ade-cursor-cloud agents · runs · artifacts · repos · me` |

Every one of these is a public plugin socket. Nothing here is reserved for
plugins ADE publishes.

## Three pages, one child

The fleet, one agent's detail pane and the launch form are the plugin's own web
pages, and every client renders the same ones. They hold no Cursor client and no
key: the child assembles each row — the age, the cost, the status word, the
repository caption — and the page draws what it is given. That is what puts the
same fleet on a phone, in the web client and on the Mac.

A client that cannot host a page (the terminal) draws the vocabulary panel each
surface declares as its fallback, with the same words in it.

## The chat, in detail

Pressing **Open** on a fleet row binds that agent to an ADE chat session in the
lane it belongs to.

- **History is backfilled**, oldest first, paged, and deduplicated — so
  reopening a chat after a reconnect adds only what is new.
- **A follow-up is a new run** on the same agent, which is how Cursor spells
  "keep going".
- **Stop cancels the run** and settles the turn. Stopping is not an error: the
  chat goes idle, not failed.
- **Polling follows your attention.** The reply is read on a `3s → 8s → 20s →
  45s` ladder while the chat is on screen, and not at all when it is not. That
  is why the webhook matters — it is what wakes a chat nobody is watching.
- **The header says what the run is doing** — the status, the branch once it has
  pushed one, and the model — and it carries Cursor's own name for the agent.
  Cursor owns that name: ADE will not rename a cloud chat over it.
- **A finished run attaches its branch** to the session, along with its pull
  request when it opened one, so ADE fetches the branch into the lane worktree
  and the ordinary branch and PR affordances light up.
- **Artifact files** are listed on the chat as a proof card and written into
  `.ade/cache/plugin-artifacts/` in the lane. The plugin asks Cursor for a
  signed HTTPS URL; the host fetches it, because the child's declared-host
  guard only covers `api.cursor.com`.

## Launching, in detail

Enter in the composer runs exactly what the launch form's Submit runs:

1. **The reason first.** If Cursor Cloud cannot take this work, the send says
   which of the seven reasons it is — the repo list still loading, a probe that
   failed, no lane, the lane's remote still being read, a remote that could not
   be read, a lane with no GitHub remote, or a repo Cursor is not connected to.
   None of them is guessed from another.
2. **Origin gets the branch.** The cloud agent clones the remote, so ADE pushes
   the lane's branch first. A branch that is only *behind* origin is left alone;
   a branch that has diverged blocks the send rather than force-pushing over
   commits origin has and this machine does not.
3. **One key per draft.** A send that fails after Cursor accepted the create is
   retried with the same idempotency key, so the retry *adopts* the agent that
   is already running instead of launching a second one on the same branch.
4. **An existing PR wins.** If the branch already has a pull request, the agent
   attaches to it and Auto-PR is turned off for that run — one branch never ends
   up with two.

## Secrets

A cloud run can carry environment variables. They come from **this plugin's own
secret store** (`ade plugin secrets`), never from your project's `.env` — a
plugin reading project secrets would be a capability nobody granted at install.

Names beginning with `CURSOR_` are refused. That namespace belongs to the
agent's own credentials, and shadowing it breaks the run in a way nothing
explains.

Tick "Remember for this lane" and the *names* are stored against the lane, so
the next launch offers the same set. Values are never written to a collection, a
panel, or a log.

## What it costs

One `api.cursor.com` host, declared in the manifest and enforced by the child's
network guard. One list read per refresh, plus one run read per *active* agent —
a finished agent's row is already complete and is never enriched. The fleet
walks at most 200 rows, 100 to a page, because Cursor refuses a larger page.

## Uninstalling

Takes the tab, the pane, the composer button, the chat runtime, the triggers and
the CLI words with it. Chats already bound to a cloud agent keep their
transcripts; they simply stop receiving new turns, because the thing that
answered them is gone.
