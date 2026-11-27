---
name: daex-app-control
description: "Run or drive a local Electron/desktop app via `daex app-control`: launch or attach to its renderer, read its logs, answer its terminal prompts, click and type, record video, file proof, show it to the user, pull screenshot-backed DOM/source context."
---

# Daex App Control

Daex was called ADE: the CLI is `daex`, and `ade …` still works the same (older transcripts and prompts use it).

App Control drives a desktop app you are building. Today that means an
Electron app. Daex launches it (or attaches to one that is running) through a
Chrome DevTools Protocol (CDP) port. Then you observe it, act on it, record it
and file proof from it. It works in the background: no cursor, no focus
stealing, and it captures the app's own window, not the user's screen.

Not sure App Control is the right surface? The **daex-computer-use** skill picks
between `daex apple`, `daex screen`, `daex app-control` and `daex browser`.

## Rules before your first command

- **One session per lane.** `--lane` defaults to `ADE_LANE_ID` and the chat to
  `ADE_CHAT_SESSION_ID`, so an agent never passes them. Every command acts on
  your lane's session. Another lane's session is not yours to drive.
- **`launch` refuses when your lane already has a live session.** Check
  `status` first. Use the running app, or `stop` it, or pass `--force` to
  replace it. `--force` only replaces a session in your own lane.
- **A relaunch reuses your launch terminal.** After `stop` (or with
  `--force`), your next `launch` usually runs in the same terminal session, so
  a rebuild-and-relaunch loop leaves one shell. (It gets a new one when someone
  typed into the old shell or the old app would not exit.) Pass `--new-shell`
  only when you truly need a separate terminal.
- **Check each step before you report it.** An act that returns `ok` only
  means Daex sent the input. Read the `hit:` and `effect:` lines and the new
  observation. Report only what you confirmed.
- **`ade: Unknown command 'app-control'` means your shell found an older
  `daex`.** Run the same command as `"$ADE_CLI_PATH" app-control ...`
  (PowerShell: `& $env:ADE_CLI_PATH app-control ...`) and keep using it for
  the rest of the task.
- **App Control needs the running Daex brain.** A session lives in the brain,
  so `--headless` is refused. If a command says no brain answered, you are
  running the wrong `daex`: use `$ADE_CLI_PATH`. Never start, stop or install a
  brain or service, and never `npm install` in the user's repo to fix Daex.
  Report the error instead.

## Common tasks

Use these directly; you do not need `--help` for them.

| Task | Command |
|---|---|
| What is running in this lane | `daex app-control status --text` |
| Launch the app | `daex app-control launch --command "npm run dev" --text` |
| Attach to a running app | `daex app-control connect --cdp-port 9222 --text` |
| What is on screen | `daex app-control observe --map --text` |
| Click a control by its label | `daex app-control click --text-match "Save" --text` |
| Right-click a control | `daex app-control right-click --text-match "Row" --text` |
| Fill a field | `daex app-control fill --selector "#name" --value "Ada" --text` |
| Wait for text to appear | `daex app-control wait --text-match "Saved" --timeout-ms 8000 --text` |
| Record a video | `daex app-control record start --caption "<what>" --text`, then `record stop --text` |
| File a still as proof | `daex app-control proof --caption "<what>" --text` |
| Show the app to the user | `daex app-control show --floating --text` |
| Read the app's terminal | `daex app-control logs --text` |
| Stop | `daex app-control stop --text` |

## The loop

### 1. Launch or attach

```bash
daex app-control status --text
daex app-control launch --command "npm run dev" --text
daex app-control launch pnpm dev --text                     # the words after launch are the command
daex app-control launch --command "pnpm dev" --cwd apps/desktop --text
daex app-control connect --cdp-port 9222 --text             # an app that is already running
```

`launch` runs the command in a visible terminal that belongs to your chat.
Daex sets `ADE_APP_CONTROL_CDP_PORT` and `ADE_APP_CONTROL_DEBUG_FLAGS` in its
environment. It forwards the debug flags on its own for npm, pnpm, yarn and bun
scripts and for a direct `electron` command. `--cwd` resolves a relative path
from the directory you run `daex` in.

An installed Electron app (Slack, a packaged build of the app you work on) is
launched the same way: name its binary and add `$ADE_APP_CONTROL_DEBUG_FLAGS`,
which Daex fills in itself, so it works in zsh too. The app must not already be
running; quit the user's copy only if they say so.

```bash
daex app-control launch --command '/Applications/Slack.app/Contents/MacOS/Slack $ADE_APP_CONTROL_DEBUG_FLAGS' --text
```

`connect` attaches to an app you did not launch. The app must already expose a
CDP port (`--remote-debugging-port`). When you attach to something that is
already running, `daex app-control claim --lane <lane-id> --text` attributes it
to your lane.

### 2. Observe before you act

```bash
daex app-control observe --map --text        # screenshot + numbered element map + handles
daex app-control observe --no-dom --text     # screenshot only
```

An observation gives you a screenshot and numbered elements with handles
(`obs-…:e:7`). A handle is valid only for recent observations. Daex keeps the
newest 3 per session, so observe again when a handle is refused as expired.
**Act by handle or by label, not by coordinates.** A point is a guess that the
layout did not move.

Observations also carry console output, failed network requests and the
in-flight request count. That is usually the fastest way to see why a click
did nothing.

### 3. Act, then read the answer

```bash
daex app-control click --handle obs-...:e:7 --text
daex app-control click --text-match "Save" --text
daex app-control click --button right --text-match "Row" --text
daex app-control right-click --text-match "Row" --text   # same as click --button right
daex app-control hover --test-id row-3 --text
daex app-control fill --selector "#name" --value "Ada" --text
daex app-control clear --selector "#name" --text
daex app-control type "hello" --text          # into the focused element
daex app-control press --key Enter --text     # alias: key; Enter submits a focused form
daex app-control press --key "Meta+n" --text  # modifiers: Alt, Control/Ctrl, Meta/Cmd, Shift
daex app-control scroll --x 120 --y 420 --delta-y 600 --text
daex app-control wait --text-match "Saved" --timeout-ms 8000 --text
daex app-control wait --load-state network-idle --text
daex app-control trace --limit 20 --text      # recent actions for this session
```

Targets are `--handle`, `--selector`, `--text-match`, `--test-id`,
`--element <n>`, or `--x`/`--y`. A disabled target is refused, not clicked.

Every act answers with two lines and a fresh observation:

- `hit:` — the element the command actually hit.
- `effect:` — `observed` (Daex saw the app change), `unconfirmed` (Daex looked
  and saw no change), or `not_checked` (Daex did not look).

When the effect is `unconfirmed`, observe again before you act again or
report the step. Do not repeat the action blindly. If the change takes time,
use `wait` instead of acting again. `--fast` skips the settle delay;
`--no-observe` skips the observation (then you must check the step yourself).
`--session <id>` makes a command fail if the session has changed under you.

### 4. Record and file proof

```bash
daex app-control record start --caption "Settings save the API key" --text
# ... drive the app ...
daex app-control record status --text
daex app-control record stop --text
daex app-control proof --caption "Settings shows the saved key" --text
```

Use a **video** when the claim is about behavior over time: a flow, an
animation, a retry. Use a **still** (`proof`) when one screen proves the claim.

- `record start` captures the app's own window. When it stops, it becomes a
  demo: still time cut, waits sped up, zoom to each action, a pointer and
  click rings, under 10 MB. `--plain` keeps it as recorded; use it only when
  the user asks.
- Mark each step while recording with `daex proof step "<what happens next>"`.
  Each step is a caption in the video and a chapter in Daex's player.
- A recording stops itself after 5 minutes of real time, or after 2 minutes
  with no action. `--max-seconds <n>` sets a shorter limit. Record the flow
  that shows the claim, not the whole task.
- Always pass `--caption`. `record stop` files a captioned video as proof under
  your lane, your chat and the lane's PR. A video with no caption stays a
  scratch file (unless the cap or the app closing ended it).
- `record stop` prints `duration` (the demo), `real time` with the time cut,
  the `file`, and a `proof` line with the proof id. If it prints an `error`
  line, the recording failed: report that. Never attach an older file in its
  place. On macOS the first recording can need the Screen Recording grant; the
  answer says so.
- A recording also stops when the app closes (`stopped: the app closed`).
- Confirm the final state before `record stop`, so the video ends on it.
- `proof` observes the app and files that screenshot with your caption. Write
  a caption that says what the capture shows, then check that the screenshot
  really shows it. `screenshot --out shot.png --text` captures without filing
  anything and writes the PNG there (`--text` alone saves a temp file and
  prints its path).

The **daex-proof-artifacts** skill covers `daex proof attach`, allowed roots and
how to confirm a filing.

### 5. Show the user

When the user asks to see the app, or you want them to watch:

```bash
daex app-control show --text              # App Control in the tools pane
daex app-control show --floating --text   # the floating card over the chat
```

`daex ui show app-control` and `daex ui show floating-app-control` do the same.
The answer says what really happened: `shown`, `held` (the user is not on your
chat yet; it opens when they go there), or `no_desktop` (exit 1; nothing was
shown, so tell the user). The user can also watch the session live from Daex on
the web or the phone.

### 6. Stop

```bash
daex app-control stop --text
```

`stop` quits an app Daex launched, with its whole process tree. It only detaches
from an app you attached with `connect`; that app keeps running. Save anything
that matters first. Daex also releases the session when your chat ends and when
the lane is archived or deleted.

## Optional: keep the app off the user's screen

App Control never needs the user's screen. On a Mac you may still move the
app's window onto the lane's private Mac Desktop:

```bash
daex screen start --text
daex screen windows --text
daex screen claim --window <id> --text
```

This is optional. Keep driving it with `daex app-control`.

## Context for the chat

```bash
daex app-control snapshot --text              # screenshot + DOM element refs
daex app-control inspect --x 120 --y 420      # hit-test a point, add nothing to the chat
daex app-control select --x 120 --y 420       # add that element to the chat as context
```

`select` returns screenshot-backed DOM, selector and source context, and
attaches it to the chat that owns the session.

## Windows, targets and drivers

```bash
daex app-control windows --text                     # debuggable windows
daex app-control switch-window --target <id> --text # drive another window
daex app-control targets --text                     # raw CDP targets
daex app-control attach-target --target <id> --text
daex app-control drivers --text                     # cdp | computer_use availability
```

Switching windows clears the action trace, and handles from the old window stop
resolving. Observe again after a switch. `computer_use` is listed but not
implemented; it reports `unavailable`.

## Logs and terminal

```bash
daex app-control logs --text --max-bytes 8388608
daex app-control terminal write --data "y\n" --text
daex app-control terminal signal --signal SIGINT --text
```

Use `daex terminal list --text` and `daex terminal read ...` only when no App
Control terminal is active.

## Troubleshooting

- **`Waiting for CDP on 127.0.0.1:<port>` never clears.** The app did not open
  the debug port. A custom launcher (a shell script, a wrapper, `concurrently`,
  a dev script that starts Electron itself) must pass
  `ADE_APP_CONTROL_DEBUG_FLAGS` through to Electron, or read
  `ADE_APP_CONTROL_CDP_PORT` and pass `--remote-debugging-port`. You can also
  put the placeholder in the command, and Daex substitutes it:
  `daex app-control launch --command "/path/script.sh {ADE_APP_CONTROL_DEBUG_FLAGS}" --text`.
  Read `daex app-control logs --text` to see what the app printed.
- **A browser (Chrome, Edge) never opens the port.** It needs its own profile
  folder, as an absolute path: `--user-data-dir=/tmp/ade-profile` (Windows:
  `--user-data-dir="$env:TEMP\ade-profile"`). Chrome on Windows ignores a
  relative one and exits silently. On a Linux machine with no display, the app
  opens on the lane's own screen (`daex screen`), started for it.
- **The port is taken.** Another app (or an old run) holds it. `stop` the old
  session, or pass `--cdp-port <free port>`.
- **The app restarted and the session looks stale.** Dev servers that rebuild
  the main process restart Electron. Find the new page and re-attach:

  ```bash
  daex app-control targets --text
  daex app-control attach-target --target <id> --text
  daex app-control observe --text
  ```

- **`launch` refused: the lane already has a session.** Run `status`. Reuse
  it, `stop` it, or pass `--force` to replace it.

## Launching Daex itself from inside Daex

If you run inside one Daex (Beta or stable) and need the Daex dev app under App
Control, the dev launcher is isolated and safe:

```bash
daex app-control launch --command "NO_DEVTOOLS=1 npm run dev" --text
daex app-control launch --command "NO_DEVTOOLS=1 npm run dev:desktop -- --socket /tmp/ade-runtime-app.sock {ADE_APP_CONTROL_DEBUG_FLAGS}" --text
```

On Windows the command runs in PowerShell, which has no `NAME=value cmd`
form, and the socket is a named pipe:

```powershell
daex app-control launch --command '$env:NO_DEVTOOLS="1"; npm run dev:desktop -- --socket //./pipe/ade-runtime-app {ADE_APP_CONTROL_DEBUG_FLAGS}' --text
```

Put `NO_DEVTOOLS=1` in the launch command (`--command "NO_DEVTOOLS=1 npm run dev:desktop -- …"`):
App Control cannot tell your launch from a person's, so the dev launcher only
skips the DevTools window by itself for a shell an agent runs, and you have CDP
anyway. Run one at a time, check `memory_pressure | tail -1` first and wait
while free memory is under ~30%, and `stop` it when you are done.

`npm run dev` uses its own runtime socket (`/tmp/ade-runtime-dev.sock`) and its
own Electron profile (`ade-desktop-dev`), so it does not collide with the Daex
that hosts you. `daex runtime status --text` tells you which socket the CLI uses.
The `dev-desktop` launcher accepts App Control's `{ADE_APP_CONTROL_DEBUG_FLAGS}`
placeholder (and the `ADE_APP_CONTROL_CDP_PORT` it exports) and passes the CDP
port and render flags through to Electron, so `launch` connects on the port
App Control expects.
