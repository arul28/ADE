---
name: ade-computer-use
description: Use this skill for any computer use — driving an app, a screen, a simulator or a web page; clicking, typing, screenshotting, recording, or proving a UI change works. It picks the right ADE surface (`ade apple`, `ade mac-desktop`, `ade app-control`, `ade browser`) and covers the lane's private macOS screen, so you never drive the user's own screen.
---

# ADE computer use

This is the one entry point for computer use in ADE. Pick the surface first,
then follow that surface's loop.

## Pick the surface

| What you need to drive | Surface | Skill |
|---|---|---|
| An iOS or SwiftUI app | `ade apple` | **ade-apple** |
| Any macOS app, or anything that must not touch the user's own screen | `ade mac-desktop` (the lane's private display) | this skill, below |
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
| Mac Desktop | `ade mac-desktop proof --caption "<what>"` | `ade mac-desktop record start --caption "<what>"`, then `record stop` |
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

On a Windows runtime host the same verbs drive a Windows screen, under the
neutral spelling `ade screen` (`ade windows-desktop` and `ade mac-desktop` still
work). The Work tools pane shows **Windows Desktop** instead of Mac Desktop;
Browser and App Control stay on both. A Windows-hosted chat hides Mac Desktop
and Apple; a Mac-hosted chat hides Windows Desktop.

Two seats exist and the user picks one:

- **Private screen** (default): a second Windows desktop of the user's own
  account, its own pointer and foreground. `ade screen start --text` asks for it.
  It needs a one-time setup the user runs (an admin prompt then the Windows
  sign-in), so an agent asks with an ask card rather than doing it.
- **Shared desktop** (Mode B): the user's own desktop, with windows parked
  off-screen. It **takes over the window the user is using while you act**, so it
  needs the user's explicit consent first. Ask; do not pass a consent flag
  yourself — the agent API refuses a shared start.

Agents may start the private screen after setup. These are the user's, not
yours, and fail with a `WINDOWS_DESKTOP_*` code if you try: `setup`, `takeover`
(only the pane does it, after a confirm), and any shared create.

Windows failures you will see and what they mean:

| Code | Meaning |
|---|---|
| `WINDOWS_DESKTOP_SETUP_REQUIRED` | The user has not run the one-time setup yet. Ask them to. |
| `WINDOWS_DESKTOP_HELD` | Another lane holds the private screen. Ask the user to take it over or use the shared desktop. |
| `WINDOWS_DESKTOP_LOCKED` | The PC is locked. Wait; unlock resumes it. |
| `WINDOWS_DESKTOP_NOT_CONSOLE_SESSION` | ADE is not running on this PC's desktop (e.g. over SSH), so the private seat is unavailable. |

The user can approve setup, takeover, and shared-desktop use from a trusted ADE
client on any device. They can choose **Save Windows password** after setup. The
native Windows dialog verifies sign-in and stores it in Windows Credential
Manager on that PC. Never ask for the password in chat or put it in a command.
A rejected saved password is forgotten; ask the user to save the new one.

In the private screen, ignore the user's own startup apps (v1 leaves them
alone): open only the apps and files you name. Never rely on a restored tab or a
file association.

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
| Quit apps the lane opened, released ones too (only when asked) | `ade mac-desktop quit [<app>] --text` |

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
