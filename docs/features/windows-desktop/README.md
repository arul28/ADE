# Windows Desktop

Each lane can own a Windows screen, the way it owns a private macOS screen. The
service, the lease, window ownership, proof, streaming and the Work-tools pane
are shared with [Mac Desktop](../mac-desktop/README.md); only the seat backend
differs, so read that page first. This page covers what Windows adds or changes.

The neutral command family is `ade screen`. `ade windows-desktop` and
`ade mac-desktop` are aliases, and the verbs are the Mac Desktop verbs.

## Source file map

Only the Windows-specific files; the shared service, lease, ownership,
streaming and proof files are in the [Mac Desktop map](../mac-desktop/README.md#source-file-map).

| Path | Role |
|---|---|
| `apps/desktop/native/ADEDesktopDriverWin/src/` | The native driver, `ade-desktop-driver.exe` (C++). Same NDJSON wire, ops and error codes as the Mac driver. |
| `.../src/modes.h`, `main.cpp` | One binary, three process modes: `host` (the brain's child in the console session), `child` (the engine inside the private screen, serving it to the host over named pipes) and `setup-elevated` (the one-time admin step). |
| `.../src/host.cpp`, `hostwindow.cpp/.h` | The console-side lifecycle and NDJSON bridge on an STA thread; the host's own window (the Remote Desktop control's frame, kept shown outside every monitor). The hard-deadline retire lives here. |
| `.../src/rdp.cpp/.h` | The Remote Desktop ActiveX control that opens the private child session. |
| `.../src/childtask.cpp/.h`, `child.cpp` | Starting the engine inside the child session through a one-use logon task (the Run entry is the fallback), and the child-mode engine process. |
| `.../src/ownedchild.cpp/.h` | `owned-child.json`: the child session this driver started, so a replacement driver signs out exactly that one and never a session ADE did not start. |
| `.../src/parkedwindows.cpp/.h` | `parked-windows.json`: the shared seat's parked windows on disk, so a host restores them at its hard deadline and at every start. |
| `.../src/engine.cpp/.h`, `engineLane.h`, `engineInput.cpp`, `engineLaunch.cpp`, `engineMedia.cpp` | The per-lane op table for one session (Mode A private, Mode B shared): lifecycle, input, app launch (including apps that hand a second launch to a running instance), and capture/recording. |
| `.../src/desk.cpp/.h` | Top-level windows, processes, app launch and `SendInput` for the session the process runs in. |
| `.../src/uia.cpp/.h` | UI Automation: the cached element walk behind `observe`, and element actions. |
| `.../src/capture.cpp/.h`, `video.cpp/.h` | GDI `BitBlt` (private) and `PrintWindow` (shared) frames; Media Foundation H.264 for the live view and the MP4 recording. |
| `.../src/credentials.cpp/.h`, `setup.cpp` | The saved Windows password in Credential Manager (never on the wire), and the bounded admin prompt that starts `setup-elevated`. |
| `.../src/common.cpp/.h`, `json.cpp/.h` | Error codes, logging, the line writer, and the JSON value. |
| `apps/desktop/scripts/build-windows-desktop-driver.mjs` | Builds `ade-desktop-driver.exe` into `resources/native`. |
| `apps/desktop/src/main/services/native/nativeHelperPaths.ts` | `resolveWindowsDesktopDriverBinary`, beside the Mac resolver. |
| `apps/desktop/src/main/services/windowsDesktop/windowsDesktopSeatProvider.ts` | The Windows `DesktopSeatProvider`: the Mac op set plus `windows.status` / `windows.setup` and the `seatMode` + consent fields on `display.create`. |
| `apps/desktop/src/main/services/windowsDesktop/windowsDesktopDriverClient.ts` | The NDJSON client for the `.exe`, reusing the Mac client (`macDesktopDriverClient.ts`) for the protocol, backoff, health, and the retire (exit 75) restart that replays queued requests. |
| `apps/desktop/src/main/services/windowsDesktop/windowsDesktopOperations.ts` | The Windows-only service parts: the setup / save-password / start operation record (`windowsDesktop.operation`, `phase`, `lastOperation`), the shared seat's per-host lease, and the window-verb gate. |
| `apps/desktop/src/main/services/macDesktop/macDesktopLeaseFlow.ts` | `askChatAllowDeny`: the button-only Allow / Don't allow card behind both the Mac input lease and the shared-seat request. |
| `apps/desktop/src/shared/desktopSeat.ts` | `desktopSeatKind`, `describeDesktopSeat` (the status JSON's `seat`) and `WINDOWS_DESKTOP_NEXT_STEP`; every text surface reads it. Re-exported from `shared/types/macDesktop.ts`, which also holds `isUserOnlyConsentCard`. |
| `apps/desktop/src/main/services/demoVideo/demoMp4Source.ts` | Reads the driver's MP4 for the desktop app's Chromium demo engine. |
| `apps/ade-cli/src/cliMacDesktop.ts`, `cliMacDesktopFormat.ts` | The `ade screen` plan builder (`start --shared`, `focus`/`minimize`/`close`, `setup`, `takeover`) and the host-aware text formatters and error hints. |
| `apps/ade-cli/src/tuiClient/rightPaneFormatters.ts` | The `ade code` right pane's host-aware screen block. |
| `apps/desktop/src/renderer/components/chat/WindowsDesktopStateCard.tsx` | The pane's no-picture states: setup, password, sign-in progress, a failed step, held, locked, unavailable, ready. |
| `apps/desktop/src/renderer/components/terminals/LaneMacDesktopMarker.tsx` | The lane mark: the Windows logo on a Windows host, with the seat in the tooltip. |
| `apps/desktop/src/renderer/components/app/AppShell.tsx` | The elevated-app warning banner (`ade.app.getElevatedDesktop` / `elevatedDesktopChanged`). |

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
  instead of showing a second card. The consent covers the chats of that lane
  and the user's own trusted `ade` (`ade --role cto screen …`, the same role
  that may run `screen start --shared --consent`): with no chat, the RPC layer
  gives it one stable holder of its own (`ade-cli-user`), so it drives the
  shared seat it started, still one lane per host, and a person who took
  control in the pane still wins. An agent cannot claim that holder: the RPC
  scope strips `holderId` from every agent caller. Any other caller with no
  chat (a plain `ade` shell, which may be an agent's) is refused with
  `MAC_DESKTOP_INPUT_LEASE_REQUIRED`. Keys on the shared seat are always real
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
it. The user's answer is the consent:

- The card has buttons only. The seat starts only when the answer is exactly
  the **Allow** option; typed text, **Don't allow**, a dismissal or anything
  else is a no. The real-input lease card on a Mac follows the same rule
  (`askChatAllowDeny` in `macDesktopLeaseFlow.ts`).
- Only a trusted user client (the desktop app, the phone, the web client) can
  answer the shared-seat card or the real-input lease card. An agent caller —
  session-bound, an unbound `ade` shell, or the CTO's approve tool — is refused
  by `chat.respondToInput` and `chat.approveToolUse` (`policyDenied`) and told
  to wait for the user (`isUserOnlyConsentCard`), whichever argument shape it
  sends; a call whose session and card ids cannot be read is refused too.
  `personalChats.call` never answers one either.
- The card is withdrawn after about 170 seconds without an answer, before the
  caller's own 180-second wait ends, so a late Allow cannot start a seat
  nobody is waiting for; the request fails with
  `WINDOWS_DESKTOP_CONSENT_REQUIRED`.
- If a private screen started on the lane while the card was open, the request
  fails with `WINDOWS_DESKTOP_CONSENT_REQUIRED` instead of reporting the
  private screen as the shared one.

A chat the user allowed is not asked again for that lane until the chat closes.
A caller with no chat is refused with `WINDOWS_DESKTOP_CONSENT_REQUIRED`.

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

Each code prints a one-line next step in the CLI (`macDesktopErrorHint`). The
service's message states only the fact; the next step for the Windows codes
comes from one table, `WINDOWS_DESKTOP_NEXT_STEP` in
`apps/desktop/src/shared/desktopSeat.ts`, which the status `next` line and
the agent-facing refusals read too.

The native driver retires itself (exit code 75) when its UI thread is wedged
after a teardown, or an operation passes its hard deadline, after replying.
That is not a crash: the brain starts a fresh driver at once, without backoff
or a crash-loop count, sends it the requests the old one had queued, and tells
the pane nothing unless a lane's screen went with it. A lane whose screen went
with it is reported lost.

Parked shared-seat windows never stay stranded off-screen. The host records
each window it parks (handle, process id, process start time and where the
window came from) in `<ADE home>\windows-desktop\parked-windows.json`,
written atomically, and removes the entry when the window is released or
closes. At the hard deadline the host first puts those windows back — only if
the record is free at that moment, never by waiting on the stuck operation —
then retires; its error says the host was reset and whether the windows were
put back. Every host also puts back, at start, any recorded window that still
matches a live window exactly (same handle, process and process start), then
clears the record, so a driver that crashed or was retired before it could
restore them leaves nothing behind.

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

- On a private screen the pane has no **Release**, **Add app** or **Bring to
  my screen**: a window cannot move between two Windows sessions. The shared
  seat keeps them.
- The proof viewer shows a demo video's steps as chapters; a click seeks the
  video to that step.
- The consent card for the main desktop explains, on its **Allow** option, what
  the agent does there and why it asks.
- The `ade` command returns the exit code of the CLI on Windows, so a failed
  command is not zero.
- The Work tools pane shows **Windows Desktop** on a Windows host and **Mac
  Desktop** on a Mac host; Browser and App Control show on both. Apple is
  Mac-only. A tool for the other platform is not shown at all; a host of the
  right platform that cannot run the tool (the driver is missing, say) keeps
  the card, disabled, with the host's own reason. The command palette reads
  the same host answer (`desktopToolContext`) and offers only the host's
  desktop tool.
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
  starts the shared seat in one click (the card already says what it means);
  **Take over** asks first. **Use main desktop** anywhere else asks first in a
  confirm dialog.
- **Stop** in the "Using your main Windows desktop" reminder asks first, like
  every other Stop, because it quits the apps the lane opened.
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
- Keystroke text is typed one character per `SendInput` with a short pause (a
  WinUI editor such as Windows 11 Notepad drops batched characters), so a long
  `type` takes real time. That covers real-input typing and every `type` on the
  private seat; Accessibility typing on the shared seat sets the value or
  posts the text at once and has no such limit. For keystroke typing the brain
  gives the driver 20 s plus 25 ms per character, and one `type` takes at most
  4,000 characters (`WINDOWS_DESKTOP_MAX_TYPED_CHARS`; the driver refuses more
  too). If the budget runs out the error says the driver may still be typing.
- A watch-only client (the phone, or a browser tab without control) gets a
  **Stop** for the lane's Windows screen on either seat, through the
  viewer-allowed `macDesktop.stopSeat` command: it signs the private screen
  out, or ends "Using your main Windows desktop", so the user always has the
  way out from any trusted device. It asks first, with the desktop's words for
  that seat. A Mac lane's display is refused (that stays the controller-only
  `macDesktop.stop`), and so is a lane with no Windows screen. The older
  `macDesktop.stopPrivate` (private screen only) stays for phones that predate
  `stopSeat`; a host that advertises neither shows no **Stop**.
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
  with the reason (text and JSON). A movie whose sample tables claim more
  entries than the file holds is refused the same way, before anything is
  allocated for it.
- A turn's time-lapse clip is deleted when a newer one replaces it, unless a
  proof artifact points at the file.
- An ADE desktop app started as administrator cannot be reached by the
  background service (Windows refuses the medium-integrity brain access to the
  elevated app's pipe), so agents get no built-in browser, App Control
  recording or demo videos. The app docks a warning banner saying so for as
  long as it runs; quit ADE and open it normally.
