# Mac Desktop details

## The `next:` line

An `unconfirmed` answer can carry a third line, `next:`. It names the one
input method to try next and why, and often a command to run:

- `observe` — keep the same method. Look at the new screen, or `wait` for the
  label you expect. The action probably applied, or the element is disabled.
- `background_input` — run the click it prints: the same click at the
  element's point, delivered to the app alone. No approval, no pointer moves.
- `real_input` — repeat the same command with `--real`.
- `lease` — real input is the fix, but this chat must ask for it first. Run
  the `ade screen lease` command it prints, then repeat with `--real`.
- `browser` — the target is a web page. Drive it in the ADE browser, unless
  the task needs that exact browser.

Follow `next:` instead of a guess. Today only the Mac Desktop prints it.

## Global and local points

Points are **global screen points**, the plane the element list uses, not
screenshot pixels. The lane's display sits somewhere on that plane (often far
from 0,0), and the observation's `points` line says where: the screenshot's
top-left pixel is the display's origin. Add the origin to a point read off the
screenshot, or pass `--local` and ADE adds it. A point off the lane's display is
refused with the display's range. A point that another lane window covers goes
to that window, the one on top, as a click would.

## Opening a document

A document is different. `open <file>` (or `open <app> -- <file>`) hands the
file to the copy this lane already runs, when it runs one. When the user (or
another lane) also runs that app, ADE refuses: macOS picks which running copy
gets the file, and it may be the user's. Open the file from the lane's copy
(its File menu), or pass `--new-instance` for a separate copy. When only the
user runs the app, the lane gets its own second copy, and the result says so.
Apps that hold a fixed port or a lock (Ableton Live, FL Studio) can misbehave
with two copies; if one does, quit the lane's copy with `ade screen quit
<pid>`.

## Moving windows

`claim` is also how you move a window onto the lane, a floating palette
included. `drag` cannot move a window: it posts mouse events to the app, and
only macOS moves windows, so a title bar or a frameless (Electron) drag region
stays put. ADE places a claimed window on the lane's display; `present main`
brings the lane's windows to the user's screen and `present display` sends them
back.

## Panels, alerts and sheets

Panels and alerts of the lane's apps are windows too. `windows` and `observe`
mark them `[panel]` (a floating palette) or `[modal panel]` (an alert or dialog
that blocks its app until it closes). Their elements come first in `observe`,
and `press` with no target sends the key to the modal panel when one is up. A
new panel that opens on the user's screen is moved onto the lane's display; if
ADE cannot move it, `observe` ends with a `Warning:` line naming the window.
Then do not act on it: ask the user to close it or drag it onto the lane's
screen. A lane app's macOS Open/Save panel opens on the lane's display and
shows up as one of the app's windows. ADE cannot move an Open/Save panel. A
sheet attached to a window or panel (a "Replace?" question on a Save panel) is
listed as `[sheet of #<id>]`. Its buttons are in `observe`, first, and a
`press return` with no target goes to it. Claiming a sheet claims its window.
