---
name: ade-desktop
description: Use this skill for any macOS desktop app work in a lane — launching an app, clicking or typing in it, reading what is on its screen, screenshotting or recording it, or proving a desktop change works — instead of driving the user's own screen. Each lane gets a private macOS display, driven by `ade mac-desktop`.
---

# ADE Mac Desktop

Each lane owns a private macOS screen. `ade mac-desktop ...` creates it, parks
apps on it, and drives them through the Accessibility API. The user's real
display and real pointer are never touched, so you never have to ask before
clicking — with one exception, the input lease below.

For web tasks, use ADE's built-in browser (`ade browser`, the **ade-browser**
skill) by default. Open Safari or another browser here only when the user names
that app or asks for the Mac Desktop.

macOS runtime hosts only. `ade mac-desktop status --text` answers everywhere;
every other command refuses off macOS with `MAC_DESKTOP_UNSUPPORTED_PLATFORM`.
`--lane` defaults to `ADE_LANE_ID`. In a chat, the command is pinned to that
chat's lane: `--lane` naming a different lane is refused, not silently swapped.

## Check each step before you report it

A click, type or press that returns `ok` only means ADE sent the input. It
does not mean the app did what you wanted. After each step that matters,
confirm it: read the screen the command printed, `ade mac-desktop wait --label
"<text>"`, `ade mac-desktop observe`, or a screenshot. Report only what you
confirmed. If a step failed, say which step, and do not describe the result
you meant to get. Before `record stop`, confirm the final state, so the video
ends on it.

## Common tasks

Use these directly; you do not need `--help` for them.

| Task | Command |
|---|---|
| Start the screen (do this first) | `ade mac-desktop start --text` |
| Open an app, file or URL | `ade mac-desktop open "Safari" --text` |
| What is on screen | `ade mac-desktop observe --text` |
| Click a control by its label | `ade mac-desktop click --text "Sign in" --text` |
| Type, then press Return | `ade mac-desktop type "reddit" --submit --text` |
| Press one key | `ade mac-desktop press return --text` (also `tab`, `escape`) |
| Wait for a label to appear | `ade mac-desktop wait --label "Done" --timeout 8000 --text` |
| Record a video | `ade mac-desktop record start --caption "<what>" --text`, then `record stop --text` |
| Take a screenshot | `ade mac-desktop screenshot --out shot.png --text` |
| Show the screen to the user | `ade mac-desktop show --text` (tools pane) or `--floating` |
| Close your own window | `ade mac-desktop press w --cmd --text` |
| Stop the screen (quits the apps the lane opened) | `ade mac-desktop stop --text` |

## Operating loop

### 1. Start the screen and put an app on it

```bash
ade mac-desktop status --text
ade mac-desktop start --text
ade mac-desktop open "Preview" --text
ade mac-desktop windows --text
```

`open` takes an app name, a bundle id, a path, or a URL; everything after `--`
is the app's own argv. Run `start` first: `open` and the rest refuse with "Start
one first" when the lane has no display. Viewing the screen does not start it,
and an idle display with no windows and no viewer closes itself after a while.
`open` starts a separate, blank copy of the app for the lane: no restored
windows, tabs or documents, and never a process shared with the user's windows.
The copy still shares that app's data with the user (cookies, history, recent
files). To adopt a window that is already running, claim it:

```bash
ade mac-desktop claim --window <id> --text
ade mac-desktop release --window <id> --text
```

`release` gives the window to the user. For an app the lane opened, the user
gets the whole app: all its windows move to the user's screen, the lane stops
watching it, and `stop` no longer quits it. A claimed window goes back alone.

Window ids die with their process. Re-run `windows` rather than caching one.

`open` answers before the app has a window (`watching: yes`, no windows yet).
Wait for it before you observe — `ade mac-desktop wait --label "<window title>"
--timeout 8000 --text`, or re-run `windows`. A document app such as TextEdit
opens an empty untitled document. An app that opens no window when launched
bare (Preview): open a file with it, or press ⌘N (`ade mac-desktop press n
--cmd --text`) once the app is up. `MAC_DESKTOP_NO_WINDOW` means the display
exists but has no window yet: open an app or claim a window; do not run
`start` again.

### 2. Observe before you act

```bash
ade mac-desktop observe --text
ade mac-desktop observe --window <id> --map --limit 80 --text
```

An observation gives you a screenshot and a numbered element list:
`[3] AXButton "Sign in" (912,430)`. The number is a handle valid only for that
observation. **Act by handle, not by coordinates** — a point is a guess that
the layout did not move. Add `--map` when you want a numbered image to look at.

### 3. Act — the result already contains the next observation

```bash
ade mac-desktop click obs-a1b2:e:3 --text
ade mac-desktop click --text "Sign in" --text
ade mac-desktop type "ada@example.com" --clear --target obs-a1b2:e:7 --text
ade mac-desktop type "typed into whatever has focus" --text
ade mac-desktop type "reddit" --submit --target obs-a1b2:e:4 --text
ade mac-desktop press return --text
ade mac-desktop press tab --text
ade mac-desktop press return --cmd --text
ade mac-desktop scroll down --amount 5 --text
ade mac-desktop drag --from obs-a1b2:e:3 --to 900,420 --text
ade mac-desktop wait --label "Saved" --timeout 8000 --text
```

`type --submit` presses Return after the text, to submit a search or a form.
`press` takes one key name (`return`, `tab`, `escape`, `f5`) or one character;
`key` is the same command.

Every acting command re-observes and prints what the screen looks like now.
Read that screen to confirm the step worked; `ok` alone does not confirm it.
If the change takes time to show, run `wait` for a label instead of acting
again. If a handle is refused as expired, observe again and retry.

### 4. Real input needs one approval per chat

Accessibility actions are the default and need nothing. Real pointer and
keyboard events (`--real`) are global to the Mac, so they sit behind a lease
the user grants once per chat:

```bash
ade mac-desktop lease --reason "drag the file onto the Dock" --text
ade mac-desktop click --x 900 --y 420 --real --text
```

Ask for it only when accessibility input genuinely cannot do the job — a drag,
a native menu, a control with no `AXPress`.

## Rules that will bite you

- **Never quit an app, and never touch a window you did not open.** An app
  like Safari, TextEdit or Finder is one process for all its windows, on every
  screen. ⌘Q on the lane screen also closes the user's own windows of that app.
  To finish, close your own window with `ade mac-desktop press w --cmd --text`
  (it presses the window's close button) or `release` it. ⌘W refuses a window
  the lane claimed from the user — release that one — and ⌘Q quits only an app
  the lane itself opened with `open`; for any other app it refuses. Do not
  "reset" an app the user has open to get a clean start — open a new window
  for your task instead.
- **`stop` quits the apps the lane opened, unsaved work included.** An app
  that shows a save or confirm dialog is force-quit after about three seconds.
  Save anything that matters before you stop. Windows you claimed go back to
  the user's screen; they are never quit. An app the user took with `release`
  is theirs and is not quit.
- **`ade: Unknown command 'mac-desktop'` means your shell found an older
  `ade`,** not that the lane has no screen: a login shell can rebuild PATH and
  put an installed CLI ahead of the one this ADE launched. Run the same command
  through the launched CLI: `"$ADE_CLI_PATH" mac-desktop status --text`, and
  keep using `"$ADE_CLI_PATH"` for the rest of the task.
- **If `ade mac-desktop` still refuses after that, stop and report it.** Do not
  fall back to the user's real screen, and do not record it with `ade proof
  record` — that command captures the user's whole screen.

- **The user can take control.** While they hold it your input is refused with
  `MAC_DESKTOP_USER_HAS_CONTROL`. Wait and retry; do not force anything.
- **Single-instance apps are one lane at a time.** Xcode, Finder and
  Simulator.app cannot be split. A second lane is refused with
  `MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE`, and the message names the holder.
- **Do not fight a window that keeps leaving the display.** It is released and
  reported on purpose, the same as `release`: for an app the lane opened, the
  whole app goes to the user. Report it too.

## Capture and proof

```bash
ade mac-desktop screenshot --out shot.png --text
ade mac-desktop record start --caption "the fix in motion" --text
ade mac-desktop record stop --text
ade mac-desktop proof --caption "Preferences now saves the API key" --text
```

`screenshot` writes a file and files nothing. `--out` must land inside the lane
worktree or the OS temp directory (`$TMPDIR`); anywhere else is refused. `proof`
is the intentional one and **refuses without `--caption`** — a record nobody can
judge is not proof. It captures, then re-observes, and prints the state it filed.

A recording cuts still stretches out by default, so the video shows only the
changes. Add `--keep-idle` to keep them at real length. A recording that a chat
started stops by itself after 10 minutes; `--max-seconds <n>` sets another
limit:

```bash
ade mac-desktop record start --caption "<what>" --keep-idle --max-seconds 1200 --text
```

`record stop` finalizes within about two seconds. If it fails, the status it
prints carries an `error` line and the partial file's path — report that instead
of assuming the clip exists.

If a recording fails, say so. Never attach an older recording or a copied
file in its place. ADE refuses copied proof.

**Read that state before you rely on the record.** If the observation it
returns does not show what your caption claims, the proof is wrong: fix the
screen, then file again. Filing a caption the capture does not support is worse
than filing nothing.

## Show the screen to the user

When the user asks to see the lane screen ("show me", "open the desktop"):

```bash
ade mac-desktop show --text              # the Mac Desktop in the tools pane
ade mac-desktop show --floating --text   # the floating card over the chat
```

`ade ui show mac-desktop` and `ade ui show floating-mac-desktop` do the same.
It targets your own chat and reports what really happened:

- `shown` — it is on screen now.
- `held` — a desktop window has this project open but the user cannot see
  it yet (your chat is not in front, or the window is hidden). It opens when
  the user goes to your chat. Say so.
- `no_desktop` (exit 1) — no desktop window is open for this chat, so nothing
  was shown. Tell the user; do not claim you opened it.

`show` does not start the screen. Run `ade mac-desktop start` first.
