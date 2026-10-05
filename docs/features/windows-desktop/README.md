# Windows Desktop

Each lane can own a Windows screen, the way it owns a private macOS screen. The
service, the lease, window ownership, proof, streaming and the Work-tools pane
are shared with [Mac Desktop](../mac-desktop/README.md); only the seat backend
differs, so read that page first. This page covers what Windows adds or changes.

The neutral command family is `ade screen`. `ade windows-desktop` and
`ade mac-desktop` are aliases, and the verbs are the Mac Desktop verbs.

## The two seats

| Seat | When | What the agent gets | Effect on the user |
|---|---|---|---|
| **Private** (default) | A Windows host in the console session, set up, with a free holder | A second Windows desktop of the user's own account (a Remote Desktop child session). Its own pointer, keyboard and foreground. | None while the PC is unlocked |
| **Shared** (Mode B) | The user consents, and the private seat is out or unwanted | Windows windows parked off-screen, driven by UI Automation first and real input under the lease. | Takes the foreground on most actions |

Only one private child session exists per PC, so one lane holds it at a time.
Shared seats are independent of it and can run in other lanes.

The private seat shows the user's wallpaper and taskbar, because it is the same
account; every surface states the seat in words so an agent does not mistake it
for the user's screen.

### Real input and the lease

- **Private:** real input (point clicks, drags, `--real`) needs no lease. The
  seat has its own pointer and keyboard. A person who took control from the
  pane, or another chat holding the lane's lease, still wins.
- **Shared:** real input is under the lease, and the user's shared-seat consent
  covers it: the acting chat takes the lane's lease on its first real action
  instead of showing a second card. Keys on the shared seat are always real
  input. Two shared lanes share one pointer and foreground, so every action
  that takes the foreground on a shared seat — Accessibility (UI Automation)
  clicks and typing as well as real input, opening an app, closing a window —
  takes the lane's lease, and a lane is refused with
  `MAC_DESKTOP_LEASE_HELD_BY_OTHER`, naming the other lane, while another
  shared lane's lease is live (about a minute after its last action). Focus
  and minimize raise without activating there, so they need no lease.
- A private holder and a shared lane run at once without conflict: they are
  different Windows sessions.

### Asking for the shared seat

`ade screen start --shared --reason "<why>"` (action
`mac_desktop.requestSharedDesktop`) is agent-callable. It puts an Allow / Don't
allow card in the calling chat, and starts the shared seat when the user allows
it. The user's answer is the consent; the chat id comes from the authenticated
session, so an agent cannot answer for itself. A chat the user allowed is not
asked again for that lane until the chat closes. A caller with no chat is
refused with `WINDOWS_DESKTOP_CONSENT_REQUIRED`.

## Setup (once per PC, by the user)

Setup needs the user's Windows admin prompt and their Windows sign-in; an agent
cannot do it. The Windows Desktop pane's first card is the wizard, and an agent
asks with an ask card:

1. **Turn on private screens.** One admin prompt enables child sessions and
   Remote Desktop on this PC; ADE connects to the private session on this PC.
2. **Save your password.** Choose **Save Windows password** after setup. A
   native Windows dialog asks for your Windows account and password, not your
   PIN. ADE verifies a private sign-in, signs that test session out, and saves
   the credential in your Windows Credential Manager on this PC. Nothing is
   sent through the renderer, runtime RPC, logs, or sync. For a Microsoft
   account, use `MicrosoftAccount\email` as the user name.
   Private screens then use the saved credential. You can still start without
   saving it; Windows asks for sign-in each time.
3. **Keep the PC unlocked.** ADE holds the display awake while an agent works; a
   locked PC pauses the agent, and `WINDOWS_DESKTOP_LOCKED` says so.

**Forget saved password** removes ADE's credential. A rejected saved password
is forgotten instead of retried; save your current password again in the pane.
Saving or forgetting requires approval from a trusted ADE client. The CLI equivalents are
`ade screen setup --allow-prompt --save-password` and
`ade screen setup --allow-prompt --forget-password`; password text is never a
CLI argument. Password verification requires the private session to be free.

The private screen leaves the user's own startup apps alone. Use a dedicated
blank test document or app for proof; restored tabs can contain private files.
Setup and sign-in leave status/ping responsive. The setup prompt is bounded to
two minutes; password verification is bounded to 30 seconds after entry.

## How the private screen comes up

The driver signs a child session of the user's account in through the Remote
Desktop control, then starts its engine inside it with a one-use per-user
logon task (the startup entry and `child-launch.json` are the fallback;
Explorer delays startup entries until the new session is idle). The control
stays shown, outside every monitor and off the taskbar: hidden, Windows treats
the session as minimized and drops every injected click and key. A start takes
a few seconds after sign-in.

## Errors

The driver's Windows-only codes are mirrored in `macDesktop.ts` and reach the
CLI and the pane unchanged:

- `WINDOWS_DESKTOP_SETUP_REQUIRED` — setup has not been run.
- `WINDOWS_DESKTOP_HELD` — another lane holds the private screen; the user can
  take it over (a clean sign-out of the holder) or use the shared desktop. The
  same code names a Windows child session ADE did not start (Power Automate, a
  Windows agent workspace): ADE never signs those out, and the message tells
  the user to sign it out in Task Manager › Users. The driver records the child
  session it starts (`<ADE home>\windows-desktop\owned-child.json`: session
  id, account, logon and connect time, written atomically, removed on sign-out),
  so after a driver crash the next driver signs out exactly that session and
  starts normally.
- `WINDOWS_DESKTOP_LOCKED` — the PC is locked; unlock resumes.
- `WINDOWS_DESKTOP_NOT_CONSOLE_SESSION` — the brain is not in the console
  session (for example, started over SSH), so the private seat is unavailable.
- `WINDOWS_DESKTOP_SIGN_IN_FAILED` / `WINDOWS_DESKTOP_WRONG_PASSWORD` /
  `WINDOWS_DESKTOP_CANCELLED` — the interactive sign-in step.
- `WINDOWS_DESKTOP_CONSENT_REQUIRED` — a shared seat was asked for without the
  user's consent, or the user said no. Enforced in the service, not by prompt.

Each code prints a one-line next step in the CLI (`macDesktopErrorHint`).

The native driver retires itself (exit code 75) when its UI thread is wedged
after a teardown, or an operation passes its hard deadline, after replying.
That is not a crash: the brain starts a fresh driver at once, without backoff
or a crash-loop count, sends it the requests the old one had queued, and tells
the pane nothing unless a lane's screen went with it.

## Policy

Policy lives at the service and action boundaries, never in prompts:

- `mac_desktop.setupWindows`, `mac_desktop.takeoverWindows` and
  `mac_desktop.useSharedDesktop` are CTO-only actions. A session-bound agent
  cannot reach them, so it cannot self-authorize an admin prompt, a takeover, or
  Mode B by passing `allowPrompt: true` or `sharedDesktopConsent: true`.
- `mac_desktop.start` refuses `seatMode: "shared"`; only `useSharedDesktop`
  (CTO-only) and `requestSharedDesktop` (the user's answer on a card) carry
  consent, and the service refuses a shared create without it.
- The window verbs and `requestSharedDesktop` are agent-callable, scoped to the
  caller's own lane like every `mac_desktop` action.
- Trusted ADE clients on the Mac, phone, or web can approve setup, takeover,
  and shared-desktop consent. Session-bound agents cannot approve these actions.
- Saving a password requires a local native dialog and a successful sign-in;
  otherwise a private screen requires the user's local sign-in. Setup requires
  their local admin prompt.

## Tooling

- The Work tools pane shows **Windows Desktop** on a Windows host and **Mac
  Desktop** on a Mac host; Browser and App Control show on both. Apple is
  Mac-only.
- While a shared seat is live the pane keeps an inline reminder banner
  ("Using your main Windows desktop") with a **Stop** action, so the user always
  has the way out.
- Setup, saving the password and starting the private screen are tracked by the
  service (`windowsDesktop.operation`, `phase`, `lastOperation` on the status),
  so the pane shows the same progress and clock after leaving and returning to
  the chat — "Waiting for your password", "Checking your password…", "Finishing
  up…" — and a failed step says what happened, whether anything was saved, and
  offers **Try again**. **Save password and start** continues straight into the
  private screen.
- When another lane holds the private screen, **Use main desktop** on that card
  starts the shared seat in one click; **Take over** asks first.
- The floating preview, the session card's lane mark and the chat header show
  the Windows logo while the lane's screen is live, with "Private Windows
  screen" or "Using your main Windows desktop" as the tooltip. The header mark
  opens the pane.
- `ade screen …` drives it. `ade screen status --text` leads with "ADE Windows
  Desktop" and reports the seat in words, whether real input needs a lease,
  whether private is available and why not, the holder lane, whether setup is
  done and a password is saved, whether the PC is locked, an in-flight
  operation, and a `next` line with the exact command or ask. The same summary
  is on the status JSON as `seat` (`describeDesktopSeat`). Every observation,
  action, recording, open, lease and window result names "Windows Desktop" on
  a Windows host. `ade screen --help` is host-neutral and names both seats; on
  a Windows host `ade mac-desktop --help` shows the same page.
- `ade screen open` prints the windows that appeared, the resolved executable
  and the lane-private browser profile when the driver added one, or one line
  saying why no window appeared (for example `handedOff`: the request went to an
  instance that was already running) and what to run next. A trailing `--text`
  or `--json` after `--` is the CLI's output flag, not the app's argument.
- `ade screen focus|minimize|close --window <id>` (actions `focusWindow`,
  `minimizeWindow`, `closeWindow`; driver ops `window.focus`,
  `window.minimize`, `window.close`) act on the lane's own windows only. A Mac
  host refuses them with `MAC_DESKTOP_UNSUPPORTED_PLATFORM`.
- Modifier keys are `--ctrl`, `--alt`, `--shift` and `--win`; `--cmd` is sent as
  Ctrl and `--opt` as Alt. A Mac host refuses `--win`.
- A watch-only client (the phone, or a browser tab without control) gets a
  **Stop** that signs the private screen out through the viewer-allowed
  `macDesktop.stopPrivate` command.
- Proof, recording, streaming and the turn time-lapse are the Mac Desktop
  contract, unchanged, so a phone or browser can watch a Windows lane with the
  same viewers.
- A recording's raw file is the driver's H.264 MP4. At the stop the desktop
  app's Chromium demo engine makes the demo from it (cuts, speed-ups, zoom,
  pointer, step captions, chapters), as `ade-media` does on macOS; see
  [proof](../proof.md#how-it-works). With no desktop app attached it is filed
  as recorded, with its real length, and `record stop` and the proof both say
  "Filed as recorded: the ADE desktop app was not connected to make the demo";
  an empty or unfinished one is not filed, and `record stop` exits non-zero
  with the reason (text and JSON).
- An ADE desktop app started as administrator cannot be reached by the
  background service (Windows refuses the medium-integrity brain access to the
  elevated app's pipe), so agents get no built-in browser, App Control
  recording or demo videos. The app shows a notification saying so; quit ADE
  and open it normally.
