---
name: ade-app-control
description: Use this skill when you need to run or drive a local Electron/desktop app and capture what it does — launch it or attach to a running renderer, read its logs or answer its terminal prompts, click and type in it, record a video or file proof of it, show it to the user, or pull screenshot-backed DOM/source context into the chat — through `ade app-control`.
---

# ADE App Control

App Control drives a desktop app you are building. Today that means an
Electron app. ADE launches it (or attaches to one that is running) through a
Chrome DevTools Protocol (CDP) port. Then you observe it, act on it, record it
and file proof from it. It works in the background: no cursor, no focus
stealing, and it captures the app's own window, not the user's screen.

Not sure App Control is the right surface? The **ade-computer-use** skill picks
between `ade apple`, `ade mac-desktop`, `ade app-control` and `ade browser`.

## Rules before your first command

- **One session per lane.** `--lane` defaults to `ADE_LANE_ID` and the chat to
  `ADE_CHAT_SESSION_ID`, so an agent never passes them. Every command acts on
  your lane's session. Another lane's session is not yours to drive.
- **`launch` refuses when your lane already has a live session.** Check
  `status` first. Use the running app, or `stop` it, or pass `--force` to
  replace it. `--force` only replaces a session in your own lane.
- **Check each step before you report it.** An act that returns `ok` only
  means ADE sent the input. Read the `hit:` and `effect:` lines and the new
  observation. Report only what you confirmed.
- **`ade: Unknown command 'app-control'` means your shell found an older
  `ade`.** Run the same command as `"$ADE_CLI_PATH" app-control ...`
  (PowerShell: `& $env:ADE_CLI_PATH app-control ...`) and keep using it for
  the rest of the task.
- **App Control needs the running ADE brain.** A session lives in the brain,
  so `--headless` is refused. If a command says no brain answered, you are
  running the wrong `ade`: use `$ADE_CLI_PATH`. Never start, stop or install a
  brain or service, and never `npm install` in the user's repo to fix ADE.
  Report the error instead.

## Common tasks

Use these directly; you do not need `--help` for them.

| Task | Command |
|---|---|
| What is running in this lane | `ade app-control status --text` |
| Launch the app | `ade app-control launch --command "npm run dev" --text` |
| Attach to a running app | `ade app-control connect --cdp-port 9222 --text` |
| What is on screen | `ade app-control observe --map --text` |
| Click a control by its label | `ade app-control click --text-match "Save" --text` |
| Fill a field | `ade app-control fill --selector "#name" --value "Ada" --text` |
| Wait for text to appear | `ade app-control wait --text-match "Saved" --timeout-ms 8000 --text` |
| Record a video | `ade app-control record start --caption "<what>" --text`, then `record stop --text` |
| File a still as proof | `ade app-control proof --caption "<what>" --text` |
| Show the app to the user | `ade app-control show --floating --text` |
| Read the app's terminal | `ade app-control logs --text` |
| Stop | `ade app-control stop --text` |

## The loop

### 1. Launch or attach

```bash
ade app-control status --text
ade app-control launch --command "npm run dev" --text
ade app-control launch pnpm dev --text                     # the words after launch are the command
ade app-control launch --command "pnpm dev" --cwd apps/desktop --text
ade app-control connect --cdp-port 9222 --text             # an app that is already running
```

`launch` runs the command in a visible terminal that belongs to your chat.
ADE sets `ADE_APP_CONTROL_CDP_PORT` and `ADE_APP_CONTROL_DEBUG_FLAGS` in its
environment. It forwards the debug flags on its own for npm, pnpm, yarn and bun
scripts and for a direct `electron` command. `--cwd` resolves a relative path
from the directory you run `ade` in.

`connect` attaches to an app you did not launch. The app must already expose a
CDP port (`--remote-debugging-port`). When you attach to something that is
already running, `ade app-control claim --lane <lane-id> --text` attributes it
to your lane.

### 2. Observe before you act

```bash
ade app-control observe --map --text        # screenshot + numbered element map + handles
ade app-control observe --no-dom --text     # screenshot only
```

An observation gives you a screenshot and numbered elements with handles
(`obs-…:e:7`). A handle is valid only for recent observations. ADE keeps the
newest 3 per session, so observe again when a handle is refused as expired.
**Act by handle or by label, not by coordinates.** A point is a guess that the
layout did not move.

Observations also carry console output, failed network requests and the
in-flight request count. That is usually the fastest way to see why a click
did nothing.

### 3. Act, then read the answer

```bash
ade app-control click --handle obs-...:e:7 --text
ade app-control click --text-match "Save" --text
ade app-control hover --test-id row-3 --text
ade app-control fill --selector "#name" --value "Ada" --text
ade app-control clear --selector "#name" --text
ade app-control type "hello" --text          # into the focused element
ade app-control press --key Enter --text     # alias: key
ade app-control scroll --x 120 --y 420 --delta-y 600 --text
ade app-control wait --text-match "Saved" --timeout-ms 8000 --text
ade app-control wait --load-state network-idle --text
ade app-control trace --limit 20 --text      # recent actions for this session
```

Targets are `--handle`, `--selector`, `--text-match`, `--test-id`,
`--element <n>`, or `--x`/`--y`. A disabled target is refused, not clicked.

Every act answers with two lines and a fresh observation:

- `hit:` — the element the command actually hit.
- `effect:` — `observed` (ADE saw the app change), `unconfirmed` (ADE looked
  and saw no change), or `not_checked` (ADE did not look).

When the effect is `unconfirmed`, observe again before you act again or
report the step. Do not repeat the action blindly. If the change takes time,
use `wait` instead of acting again. `--fast` skips the settle delay;
`--no-observe` skips the observation (then you must check the step yourself).
`--session <id>` makes a command fail if the session has changed under you.

### 4. Record and file proof

```bash
ade app-control record start --caption "Settings save the API key" --text
# ... drive the app ...
ade app-control record status --text
ade app-control record stop --text
ade app-control proof --caption "Settings shows the saved key" --text
```

Use a **video** when the claim is about behavior over time: a flow, an
animation, a retry. Use a **still** (`proof`) when one screen proves the claim.

- `record start` captures the app's own window. Still stretches are cut unless
  you pass `--keep-idle`. A recording stops itself after 10 minutes of real
  time; `--max-seconds <n>` sets another limit.
- Set the cap from the real pace of your steps, not a guess. Each command
  takes seconds of real time, so count your steps and time one. When you
  cannot tell, pass a large cap and stop the recording yourself.
- Always pass `--caption`. `record stop` files a captioned video as proof under
  your lane, your chat and the lane's PR. A video with no caption stays a
  scratch file (unless the cap or the app closing ended it).
- `record stop` prints `duration` (the video), `real time` with the idle cut,
  the `file`, and a `proof` line with the proof id. If it prints an `error`
  line, the recording failed: report that. Never attach an older file in its
  place. On macOS the first recording can need the Screen Recording grant; the
  answer says so.
- A recording also stops when the app closes (`stopped: the app closed`).
- Confirm the final state before `record stop`, so the video ends on it.
- `proof` observes the app and files that screenshot with your caption. Write
  a caption that says what the capture shows, then check that the screenshot
  really shows it. `screenshot` captures without filing anything.

The **ade-proof-artifacts** skill covers `ade proof attach`, allowed roots and
how to confirm a filing.

### 5. Show the user

When the user asks to see the app, or you want them to watch:

```bash
ade app-control show --text              # App Control in the tools pane
ade app-control show --floating --text   # the floating card over the chat
```

`ade ui show app-control` and `ade ui show floating-app-control` do the same.
The answer says what really happened: `shown`, `held` (the user is not on your
chat yet; it opens when they go there), or `no_desktop` (exit 1; nothing was
shown, so tell the user). The user can also watch the session live from ADE on
the web or the phone.

### 6. Stop

```bash
ade app-control stop --text
```

`stop` quits an app ADE launched, with its whole process tree. It only detaches
from an app you attached with `connect`; that app keeps running. Save anything
that matters first. ADE also releases the session when your chat ends and when
the lane is archived or deleted.

## Optional: keep the app off the user's screen

App Control never needs the user's screen. On a Mac host you may still move the
app's window onto the lane's private Mac Desktop:

```bash
ade mac-desktop start --text
ade mac-desktop windows --text
ade mac-desktop claim --window <id> --text
```

This is optional. Keep driving it with `ade app-control`.

## Context for the chat

```bash
ade app-control snapshot --text              # screenshot + DOM element refs
ade app-control inspect --x 120 --y 420      # hit-test a point, add nothing to the chat
ade app-control select --x 120 --y 420       # add that element to the chat as context
```

`select` returns screenshot-backed DOM, selector and source context, and
attaches it to the chat that owns the session.

## Windows, targets and drivers

```bash
ade app-control windows --text                     # debuggable windows
ade app-control switch-window --target <id> --text # drive another window
ade app-control targets --text                     # raw CDP targets
ade app-control attach-target --target <id> --text
ade app-control drivers --text                     # cdp | computer_use availability
```

Switching windows clears the action trace, and handles from the old window stop
resolving. Observe again after a switch. `computer_use` is listed but not
implemented; it reports `unavailable`.

## Logs and terminal

```bash
ade app-control logs --text --max-bytes 8388608
ade app-control terminal write --data "y\n" --text
ade app-control terminal signal --signal SIGINT --text
```

Use `ade terminal list --text` and `ade terminal read ...` only when no App
Control terminal is active.

## Troubleshooting

- **`Waiting for CDP on 127.0.0.1:<port>` never clears.** The app did not open
  the debug port. A custom launcher (a shell script, a wrapper, `concurrently`,
  a dev script that starts Electron itself) must pass
  `ADE_APP_CONTROL_DEBUG_FLAGS` through to Electron, or read
  `ADE_APP_CONTROL_CDP_PORT` and pass `--remote-debugging-port`. You can also
  put the placeholder in the command, and ADE substitutes it:
  `ade app-control launch --command "/path/script.sh {ADE_APP_CONTROL_DEBUG_FLAGS}" --text`.
  Read `ade app-control logs --text` to see what the app printed.
- **The port is taken.** Another app (or an old run) holds it. `stop` the old
  session, or pass `--cdp-port <free port>`.
- **The app restarted and the session looks stale.** Dev servers that rebuild
  the main process restart Electron. Find the new page and re-attach:

  ```bash
  ade app-control targets --text
  ade app-control attach-target --target <id> --text
  ade app-control observe --text
  ```

- **`launch` refused: the lane already has a session.** Run `status`. Reuse
  it, `stop` it, or pass `--force` to replace it.

## Launching ADE itself from inside ADE

If you run inside one ADE (Beta or stable) and need the ADE dev app under App
Control, the dev launcher is isolated and safe:

```bash
ade app-control launch --command "npm run dev" --text
```

`npm run dev` uses its own runtime socket (`/tmp/ade-runtime-dev.sock`) and its
own Electron profile (`ade-desktop-dev`), so it does not collide with the ADE
that hosts you. `ade runtime status --text` tells you which socket the CLI uses.
