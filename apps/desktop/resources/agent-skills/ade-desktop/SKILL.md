---
name: ade-desktop
description: Use this skill for any macOS desktop app work in a lane — launching an app, clicking or typing in it, reading what is on its screen, screenshotting or recording it, or proving a desktop change works — instead of driving the user's own screen. Each lane gets a private macOS display, driven by `ade mac-desktop`.
---

# ADE Mac Desktop

Each lane owns a private macOS screen. `ade mac-desktop ...` creates it, parks
apps on it, and drives them through the Accessibility API. The user's real
display and real pointer are never touched, so you never have to ask before
clicking — with one exception, the input lease below.

macOS runtime hosts only. `ade mac-desktop status --text` answers everywhere;
every other command refuses off macOS with `MAC_DESKTOP_UNSUPPORTED_PLATFORM`.
`--lane` defaults to `ADE_LANE_ID`. In a chat, the command is pinned to that
chat's lane: `--lane` naming a different lane is refused, not silently swapped.

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
one first" when the lane has no display, and an idle display with no windows
and no viewer closes itself after a while. `open` starts a separate copy of the
app for the lane, so it never shares a process with the user's windows. To
adopt a window that is already running, claim it:

```bash
ade mac-desktop claim --window <id> --text
ade mac-desktop release --window <id> --text
```

Window ids die with their process. Re-run `windows` rather than caching one.

`open` answers before the app has a window (`watching: yes`, no windows yet).
Wait for it before you observe — `ade mac-desktop wait --label "<window title>"
--timeout 8000 --text`, or re-run `windows`. Some apps open no window when
launched bare (TextEdit, Preview): open a file with them, or press ⌘N
(`ade mac-desktop press n --cmd --text`) once the app is up.

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
ade mac-desktop press return --cmd --text
ade mac-desktop scroll down --amount 5 --text
ade mac-desktop drag --from obs-a1b2:e:3 --to 900,420 --text
ade mac-desktop wait --label "Saved" --timeout 8000 --text
```

Every acting command re-observes and prints what the screen looks like now, so
you do not need a follow-up `observe` to learn whether your click landed. If a
handle is refused as expired, observe again and retry.

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
  the lane itself opened with `open`; for any other app it refuses. Do not "reset" an app the user has
  open to get a clean start — open a new window for your task instead.
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
  reported on purpose. Report it too.

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

`record stop` finalizes within about two seconds. If it fails, the status it
prints carries an `error` line and the partial file's path — report that instead
of assuming the clip exists.

**Read that state before you rely on the record.** If the observation it
returns does not show what your caption claims, the proof is wrong: fix the
screen, then file again. Filing a caption the capture does not support is worse
than filing nothing.
