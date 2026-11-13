# Windows Desktop

On Windows, `ade screen` is Windows Desktop (every output says
"Windows Desktop"). The verbs are the Mac ones in SKILL.md, with the Windows notes
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
| Administrator window (`WINDOWS_DESKTOP_ELEVATED_WINDOW`) | Ask the user to close or minimize it on the lane screen, or stop the sign-in task that opens it. Never close it yourself; it may be a service they need. |
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

- **Sign-in tasks:** the private seat is a real sign-in, so logon tasks and
  startup apps run there too. ADE cannot control administrator windows; status
  and window listings mark them `[admin]`.
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
