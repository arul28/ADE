---
name: ade-computer-use
description: Use this skill for any computer use — driving an app, a screen, a simulator or a web page; clicking, typing, screenshotting, recording, or proving a UI change works. It picks the right ADE surface (`ade apple`, `ade screen` — Mac Desktop on a Mac, Windows Desktop on Windows — `ade app-control`, `ade browser`) and covers the lane's own screen on both hosts, so you never drive the user's screen by accident.
---

# ADE computer use

This is the one entry point for computer use in ADE. Pick the surface first,
then follow that surface's loop.

## Pick the surface

| What you need to drive | Surface | Skill |
|---|---|---|
| An iOS or SwiftUI app | `ade apple` | **ade-apple** |
| Any macOS app, or anything that must not touch the user's own screen | `ade mac-desktop` (the lane's private display) | this skill, below |
| Any Windows app (on a Windows host) | `ade screen` (Windows Desktop) | this skill, **Windows Desktop** below |
| A dev Electron app you launch or attach to | `ade app-control` (CDP, one session per lane, runs in the background, no cursor) | **ade-app-control** |
| A web page or a localhost URL | `ade browser` | **ade-browser** |

Pick App Control over Mac Desktop for an Electron app you build: it acts
through the DOM, so labels, selectors and test ids work, and it records and
proves the app's own window. App Control never needs the user's screen. If you
want the app fully separate from the user's screen, you may move its window
onto the lane's Mac Desktop with `ade mac-desktop claim --window <id>`. This is
optional.

Note: `ade desktop` is a different command. It launches the ADE desktop app.

## The same answer on every surface

Every surface works the same way: observe, act on a handle from the last
observation, then check the result. Every acting command (click, type, press,
fill, scroll, drag) reports two lines:

- `hit:` — the element the command actually hit.
- `effect:` — `observed` (ADE saw the screen change), `unconfirmed` (ADE
  looked and saw no change), `not_checked` (ADE did not look), or, in the
  browser, `waiting` (the action started a navigation that waits for the
  user to allow this chat to use the ADE browser; observe again after they
  answer).

When the effect is `unconfirmed`, observe again before you act again or report
the step. Do not repeat the action blindly.

## Proof per surface

| Surface | Still proof | Video |
|---|---|---|
| Apple | `ade apple proof --caption "<what>"` | `ade apple record-start`, then `ade apple record-stop --keep` |
| Mac Desktop / Windows Desktop | `ade screen proof --caption "<what>"` | `ade screen record start --caption "<what>"`, then `record stop` |
| App Control | `ade app-control proof --caption "<what>"` | `ade app-control record start --caption "<what>"`, then `record stop` |
| Browser | `ade browser proof --tab <id> --caption "<what>"` | `ade browser record start --tab <id> --caption "<what>"`, then `record stop --tab <id>` |

`ade proof capture` and `ade proof record` capture the lane's display. They
refuse the user's real screen unless you pass `--real-screen`. Pass it only
when the user asks for proof of their own screen. The **ade-proof-artifacts**
skill covers attaching files and confirming a filing.

Each of these commands prints a `cite:` line, such as
`![Settings saved](ade-proof://<id>)`. Paste it into your answer directly under
the claim it proves: the picture shows there, and a video plays there. For a
before/after, use a `proof-compare` block (see **ade-proof-artifacts**). Caption
each item, and say what it does not show.

## Show the user

```bash
ade ui show mac-desktop     # also: apple, browser, proof, app-control
ade mac-desktop show --text
ade mac-desktop show --floating --text
ade app-control show --floating --text
```

# Mac Desktop

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

# Windows Desktop

On a Windows host, `ade screen` is Windows Desktop (`ade windows-desktop` and
`ade mac-desktop` are aliases of the same Windows screen; every output says
"Windows Desktop"). The verbs are the Mac ones below, with the Windows notes
here. Start every task with `ade screen status --text`: it names the seat, who
holds the private screen, whether setup and the saved password are done, whether
the PC is locked, and a `next` line with the exact command or ask.

## The two seats

- **private** (default): a separate Windows session of the user's own account.
  **It shows their wallpaper and taskbar, but it is not their screen.** It has
  its own pointer, keyboard and foreground, so point clicks, drags and `--real`
  need no lease. One lane holds it at a time.
- **shared**: the user's main desktop, only after the user says yes. Actions
  take over the window the user is using. Real input there is covered by the
  user's yes; only one shared lane drives at a time
  (`MAC_DESKTOP_LEASE_HELD_BY_OTHER` names the other lane: wait and retry).

## What needs the user — ask, never do it yourself

| Situation (`status` / error) | What you do |
|---|---|
| Setup not done (`WINDOWS_DESKTOP_SETUP_REQUIRED`) | Ask the user to run the setup card in the Windows Desktop pane. You cannot. |
| Password not saved | `start` still works; Windows asks the user to sign in on the PC. Tell them, and suggest **Save Windows password** in the pane. Never ask for the password in chat. |
| Private screen held by another lane (`WINDOWS_DESKTOP_HELD`) | Ask the user to **Take over** in the pane, or ask for the main desktop: `ade screen start --shared --reason "<what for>" --text`. |
| Private unavailable (`WINDOWS_DESKTOP_NOT_CONSOLE_SESSION`, Home edition) | `ade screen start --shared --reason "<what for>" --text` |
| PC locked (`WINDOWS_DESKTOP_LOCKED`) | Ask the user to unlock it, then retry the same command. |
| User said no (`WINDOWS_DESKTOP_CONSENT_REQUIRED`) | Stop and say what you could not do. Do not ask again this turn. |

`start --shared` puts an Allow / Don't allow card in your chat and waits; on
Allow it starts the shared seat. Only the user's button press counts: typed
text is not an answer, and an agent that tries to answer the card itself (or
the real-input lease card) is refused. If nobody answers within about three
minutes the card is withdrawn and the command fails; ask again later. The same
chat is not asked twice. Never pass `--consent` or `--allow-prompt`: those are
the user's clients' flags and an agent is refused. A command with no chat (a
plain shell outside one) cannot act on the main desktop at all; only the
user's own `ade --role cto` can. Never use that role yourself; a `holderId`
you pass is stripped.

## Windows specifics

- **Long text:** on the private seat, and for `--real` typing, Windows types
  one character at a time, so `type` takes about 25 ms per character and
  refuses more than 4,000 characters in one call; split longer text.
- **Browsers:** `ade screen open chrome` (or `msedge`) on the private seat gets
  a lane-private profile, not the user's. `open` prints the windows that
  appeared; if none did it says why (for example the request was handed to an
  instance that was already running) and what to run next. Do not invent a
  `--user-data-dir`. For web tasks prefer `ade browser`.
- **Editors restore the user's tabs.** Notepad reopens the user's open files,
  which can hold secrets. Create a blank file for the task and open that one:
  `ade screen open notepad -- C:\Users\<you>\AppData\Local\Temp\ade-proof.txt --text`.
  Then `observe` (or look at the screenshot) **before** you record or file
  proof, and stop if anything private is visible.
- **Modifier keys:** `--ctrl`, `--alt`, `--shift`, `--win`. `--cmd` is sent as
  Ctrl. Example: `ade screen press s --ctrl --text`.
- **Windows:** `ade screen focus --window <id>` raises one of your lane's
  windows, `minimize --window <id>` hides it, `close --window <id>` closes it
  (it reports `closed no` when a save prompt kept it open). Only your lane's
  windows; ids come from `ade screen windows --text`.
- **Paths** print with backslashes; quote them. `--out` must be in the lane
  worktree or `%TEMP%`.

## Proof on Windows

```bash
ade screen observe --text                       # check nothing private shows
ade screen record start --caption "Notepad saves hello" --text
ade proof step "Type hello"
ade screen type "hello" --text
ade screen wait --label "hello" --text
ade screen record stop --text                   # prints duration and a cite line
ade screen proof --caption "hello typed in a blank Notepad file" --text
```

Paste the `cite` line under your claim. The shared seat files proof the same way.

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
| Start the screen (do this first) | `ade screen start --text` |
| Open an app, file or URL | `ade screen open "Safari" --text` |
| What is on screen | `ade screen observe --text` |
| Click a control by its label | `ade screen click --text "Sign in" --text` |
| Type, then press Return | `ade screen type "reddit" --submit --text` |
| Press one key | `ade screen press return --text` (also `tab`, `escape`) |
| Wait for a label to appear | `ade screen wait --label "Done" --timeout 8000 --text` |
| Record a video | `ade screen record start --caption "<what>" --text`, then `record stop --text` |
| Take a screenshot | `ade screen screenshot --out shot.png --text` |
| Show the screen to the user | `ade screen show --text` (tools pane) or `--floating` |
| Close your own window | `ade screen press w --cmd --text` (Windows: `ade screen close --window <id> --text`) |
| Stop the screen (quits the apps the lane opened) | `ade screen stop --text` |
| Quit apps the lane opened, released ones too (only when asked) | `ade screen quit [<app>] --text` |

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

Every acting command re-observes and prints what the screen looks like now,
with its `hit:` and `effect:` lines. Read them and that screen to confirm the
step worked; `ok` alone does not confirm it.
If the change takes time to show, run `wait` for a label instead of acting
again. If a handle is refused as expired, observe again and retry.

### 4. Real input needs one approval per chat

Accessibility actions are the default and need nothing. On a Mac, real pointer
and keyboard events (`--real`, a point click, a drag) are global to the Mac, so
they sit behind a lease the user grants once per chat (a Windows private seat
needs none; on the Windows shared seat the user's yes covers it):

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
- **Leave the screen and its apps running when you finish.** Do not `stop`
  on your own: the user may want to look at the result. When the user asks
  you to close, clean up or shut down what you opened, run `ade mac-desktop
  quit --text` (every app the lane opened, including apps you released to
  the user; `quit <app>` for one), then `ade mac-desktop stop --text`, and
  report what quit. `stop` alone does not quit a released app. When the user
  wants to keep using an app, `release` it (see above): its windows move to
  the user's screen.
- **Do not leave an app waiting on unsaved work.** An app with an unsaved
  document shows a save dialog on the lane screen when it quits, and the user
  cannot see that dialog. Close your own document window without saving
  before you finish (`ade mac-desktop press w --cmd --text`, then choose
  "Don't Save"), or save it where the user asked.
- **Open a file as a document:** `ade mac-desktop open "<absolute path>"`
  opens it in its app, and `ade mac-desktop open TextEdit -- "<absolute
  path>"` opens it in that app. Do not type a file's text into a new document
  to stand in for the file: that checks nothing and leaves unsaved work.
- **`ade: Unknown command 'mac-desktop'` means your shell found an older
  `ade`,** not that the lane has no screen: a login shell can rebuild PATH and
  put an installed CLI ahead of the one this ADE launched. Run the same command
  through the launched CLI: `"$ADE_CLI_PATH" mac-desktop status --text`
  (PowerShell: `& $env:ADE_CLI_PATH mac-desktop status --text`), and keep
  using it for the rest of the task.
- **Never repair ADE from a task.** Do not start, stop or install a brain or
  service (another channel may own it), and do not `npm install` in the user's
  repo to fix ADE's own errors. Report the error.
- **If `ade mac-desktop` still refuses after that, stop and report it.** Do not
  fall back to the user's real screen, and do not record it with `ade proof
  record --real-screen`.

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

A recording becomes a **demo** when it stops. ADE cuts still time, speeds up
waits (a load, a spinner) with a small `4×` badge, zooms to the part of the
screen where the actions happen (not on a phone, unless you pass `--zoom`),
draws the pointer and a ring on each click, and keeps the file under 10 MB.
You do none of that; you only choose what to record.

- **Record the flow that shows the claim, not the whole task.** Do the setup
  first (open the app, reach the starting screen), start recording, run the
  flow, and stop as soon as the result is on screen. Saving files, retries and
  troubleshooting stay out of the video; if the flow went wrong, fix it and
  record again. A recording stops itself after 5 minutes, or after 2 minutes
  with no action. `--max-seconds <n>` sets a shorter limit.
- **Mark the steps.** While recording, run `ade proof step "<what happens
  next>"` before each part of the flow. Each step is a caption in the video
  and a chapter in ADE's player. Keep steps short and in the user's words.
- **Wait for the result, not for a time.** Use the surface's wait command
  instead of `sleep` (for example `ade app-control wait --text-match "Saved"`
  or `ade apple wait-for-element --label "Saved"`): the recording stops as
  soon as the result shows, and a slow load still gets its time.
- **`--plain`** files the recording as it was recorded (no cuts, zoom, pointer
  or captions), still under 10 MB. Use it only when the user asks for it.

```bash
ade mac-desktop record start --caption "Preferences saves the API key" --text
ade proof step "Open Preferences"
# ... act ...
ade proof step "Save the key"
# ... act, then confirm the result on screen ...
ade mac-desktop record stop --text
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
