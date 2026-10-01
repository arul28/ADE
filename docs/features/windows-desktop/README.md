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

## Errors

The driver's Windows-only codes are mirrored in `macDesktop.ts` and reach the
CLI and the pane unchanged:

- `WINDOWS_DESKTOP_SETUP_REQUIRED` — setup has not been run.
- `WINDOWS_DESKTOP_HELD` — another lane holds the private screen; the user can
  take it over (a clean sign-out of the holder) or use the shared desktop.
- `WINDOWS_DESKTOP_LOCKED` — the PC is locked; unlock resumes.
- `WINDOWS_DESKTOP_NOT_CONSOLE_SESSION` — the brain is not in the console
  session (for example, started over SSH), so the private seat is unavailable.
- `WINDOWS_DESKTOP_SIGN_IN_FAILED` / `WINDOWS_DESKTOP_WRONG_PASSWORD` /
  `WINDOWS_DESKTOP_CANCELLED` — the interactive sign-in step.
- `WINDOWS_DESKTOP_CONSENT_REQUIRED` — a shared seat was asked for without the
  user's consent. Enforced in the service, not by prompt.

## Policy

Policy lives at the service and action boundaries, never in prompts:

- `mac_desktop.setupWindows`, `mac_desktop.takeoverWindows` and
  `mac_desktop.useSharedDesktop` are CTO-only actions. A session-bound agent
  cannot reach them, so it cannot self-authorize an admin prompt, a takeover, or
  Mode B by passing `allowPrompt: true` or `sharedDesktopConsent: true`.
- `mac_desktop.start` refuses `seatMode: "shared"`; only `useSharedDesktop`
  carries consent, and the service refuses a shared create without it.
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
- `ade screen …` drives it; `ade screen status` reports the host, the seat, the
  holder, and whether private is available. `ade screen --help` is host-neutral
  and names both seats; `ade mac-desktop --help` is the Mac detail.
- A watch-only client (the phone, or a browser tab without control) gets a
  **Stop** that signs the private screen out through the viewer-allowed
  `macDesktop.stopPrivate` command.
- Proof, recording, streaming and the turn time-lapse are the Mac Desktop
  contract, unchanged, so a phone or browser can watch a Windows lane with the
  same viewers.
