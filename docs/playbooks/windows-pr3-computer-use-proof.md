# Windows desktop, account, and sync Computer Use proof

Use this runbook to prove the Windows stacked-PR worker scope after the
coordinator has assembled the stack. It is an installed-build acceptance test,
not a source-development checklist. Run it once on Windows 10 22H2 x64 and once
on Windows 11 x64.

Do not enable the public Windows release or download flags from this runbook.
Windows ARM64, WSL-backed execution, native Windows computer use, and Windows
SSH bootstrap are out of scope.

## Safety and evidence rules

- Use disposable repositories and test ADE accounts. Never use a production
  repository or a personal account with unrelated machines.
- Do not open, capture, print, or attach files below an ADE `secrets` directory.
  Do not capture OAuth query strings, authorization codes, access/refresh
  tokens, pairing secrets, DPoP material, cookies, or the contents of credential
  files.
- Pause recording before typing a pairing code, account credential, provider
  credential, or SSH credential. Resume only after the secret-bearing surface
  is gone.
- Browser DevTools Network and Application panels are not proof surfaces for
  OAuth. Prove the user-visible redirect and resulting signed-in state only.
- Prefer screenshots for steady state and short videos for transitions. Name
  artifacts `win-pr3-<os>-<phase>-<step>-<result>` and record the ADE version,
  package channel, Windows build, origin host OS, client OS, and route in the
  artifact note.
- A pass needs visible product state plus one independent origin-host check.
  Logs alone are supporting evidence. Redact usernames, hostnames, repository
  remotes, IP addresses, and email addresses before sharing logs.

## Required test topology

Prepare these machines or VMs:

| ID | System | Role |
| --- | --- | --- |
| W | Windows 10/11 x64 standard user | Installed ADE under test; test as both host and controller |
| M | Supported macOS | ADE host/controller and iOS pairing station |
| L | Supported Linux x64 | ADE host/controller |
| I | Physical iPhone on a supported iOS version | Mobile controller |
| B | Chrome/Edge profile with no ADE site data | Hosted-web controller |

Use the same disposable Git repository on W, M, and L, with a distinct clone on
each machine. Create one branch and one harmless unpushed commit per machine so
machine ownership and divergence are visible. Install Stable and Beta side by
side on W for the isolation phase.

Record a sanitized matrix before starting:

```text
ADE commit/version:
Package channel:
Windows edition/build/DPI:
W/M/L machine labels:
Test repository alias:
iOS version:
Expected account owner alias:
```

## 1. Windows desktop baseline

1. Launch installed ADE from the Start menu as a standard user. Capture the
   first visible window and confirm no console window flashes or remains open.
2. Exercise minimize, restore, maximize, double-click title-bar maximize,
   Windows 11 Snap Layouts, and 100/125/150/200% DPI. Confirm caption buttons,
   drag regions, and focus remain usable.
3. Open the disposable repository with the picker. Confirm the project path and
   recent-project row use normal Windows paths and no raw IPC error appears.
4. In Lanes, create a lane from the local primary branch, rename its color, and
   open Git Actions. Stage an untracked file, commit it, view history and diff,
   then restore a stash that includes an untracked file.
5. In Files, create/edit/rename/delete a text fixture, use Quick Open and content
   search, open Changes/Staged/Commit views, and copy a Windows path. Confirm
   drive-letter and UNC-looking text do not break navigation.
6. In PRs, open the lane's PR detail or the empty/no-PR state, refresh it, and
   exercise a non-mutating check/diff control. Do not create or merge a real PR.
7. In Work, open Chat, CLI, and Shell surfaces; switch tab/grid layout; resize the
   session list and tools pane; open Git, Files, App Control, and Browser. Confirm
   all tools remain reachable at a narrow width.
8. In a PowerShell PTY and a cmd PTY, print a Unicode fixture and a string
   containing spaces, quotes, `$`, `%`, `&`, and backticks. Resize, send Ctrl+C,
   close, and reopen the session.
9. Exercise fresh launch and resume UI for every installed provider. A provider
   that is not configured must show an actionable auth state without exposing a
   token. Do not add a real provider credential solely for this proof.
10. Open Browser, navigate between two benign pages, use back/forward/reload,
    download a disposable file, inspect a visible element, and capture a browser
    proof. Confirm App Control/CDP proof remains offered.
11. Invoke microphone dictation without granting access, confirm Windows privacy
    guidance, grant access in Windows Settings, relaunch ADE, and confirm the
    denial guidance clears. Do not record actual speech containing private data.
12. Trigger a harmless ADE notification and click it. Confirm it carries ADE's
    app identity and returns focus to the correct session.
13. Confirm iOS Simulator, Xcode Preview, macOS Attention Notch, and native OS
    computer-use actions are hidden or capability-blocked. Browser/App Control
    and proof ingestion must remain available.

Required evidence: one overview video plus screenshots of Lanes Git, Work tools,
Files, Browser proof, microphone guidance, notification routing, and the
capability-gated Windows UI.

## 2. Deep links and project ownership

Use a generated disposable ADE link whose target is already visible in the UI.
Do not include account tokens or pairing data.

1. With ADE running, paste an `ade://` session or lane link into the Windows Run
   dialog. Confirm the existing process focuses and navigates to the exact
   target; no second ADE window/process remains.
2. Quit ADE completely and invoke the same link. Confirm cold launch opens the
   correct project and target after initialization.
3. Repeat with a file link containing a Windows-relevant path and line number.
4. Connect a remote project, generate an owner-scoped link for a session on that
   machine, and invoke it while another project is focused. Confirm ADE selects
   or reconnects the owning machine/project rather than opening a same-ID local
   row.
5. Repeat hot and cold on Stable and Beta. Stable owns the OS protocol binding;
   Beta must not steal it.

Required evidence: hot-link video, cold-link video, owner-scoped remote target,
and Stable/Beta process list after each invocation.

## 3. ADE account and Google OAuth

This is the first phase that performs a real login. The coordinator must run it
only after receiving explicit approval for the disposable account.

1. Start signed out. Open Account and press the Google sign-in action once.
   Confirm ADE opens the system default browser, not the built-in ADE Browser.
2. Pause recording before authentication. Complete Google/Clerk authentication.
   Resume after the browser shows ADE's success page and the callback query is
   no longer visible.
3. Confirm the desktop changes to signed in without restart and shows the
   expected provider/account identity and account machine directory.
4. Close and reopen ADE, then log off/on Windows. Confirm the account session is
   still available and no plaintext credential file is shown or inspected.
5. Sign out from Account. Confirm account-owned directory/Relay access closes,
   the signed-out UI appears, and directly paired machine trust remains listed.
6. Reauthenticate with the same disposable account. Confirm the machine
   directory repopulates and account-owned routes reconnect.
7. Begin another login, cancel before completing it, then finish the stale
   browser page. Confirm the cancelled callback cannot silently sign ADE in.
8. Sign in as a second disposable account and confirm machines owned by the
   first account do not reappear. Return to the first account only if needed for
   later phases.

Independent Windows check: while signed in, confirm the machine-owned account
session survives desktop exit because the background brain remains running;
after sign-out, confirm Relay closes without stopping local projects, agents, or
PTYs. Do not inspect credential contents.

## 4. Route matrix and origin-host execution

For every connection below, create or open a lane on the destination and start
a long-running harmless shell command that prints the destination OS, hostname,
and PID, then waits. From the controller, open its session and perform Git/Files/
PR/Browser reads. On the destination, independently confirm that PID exists. On
the controller, confirm no matching worker process exists. This proves live
processes stay on the origin host.

Run all rows:

| Controller | Origin host | Route | Expected |
| --- | --- | --- | --- |
| W | M | LAN, then Tailscale, then Relay | Same remote project/session; route changes without moving the process |
| W | L | LAN, then Tailscale, then Relay | Same |
| M | W | LAN, then Tailscale, then Relay | Windows project and ConPTY session remain on W |
| L | W | LAN, then Tailscale, then Relay | Windows project and ConPTY session remain on W |

For each row:

1. Start with LAN available. Connect from Machines and record the displayed
   route. Exercise project catalog, project open, lane list, Work union, Git,
   Files, PR snapshot, terminal input/resize, and remote browser preview.
2. Disable only the LAN path while leaving Tailscale available. Wait for the
   reconnect state, then confirm the same session resumes over Tailscale.
3. Disable the direct routes while both machines remain signed in. Confirm Relay
   becomes the observed route and the same session resumes.
4. Sign the controller out. Relay must close. Restore LAN or Tailscale and
   confirm direct device-bound pairing reconnects without account access.
5. Sign back in and confirm Relay becomes eligible again without replacing the
   direct pairing record.
6. Restart the destination brain while the controller is open. Confirm the UI
   enters reconnecting, returns to connected, rehydrates project/session state,
   and does not duplicate the session or execute a command twice.
7. Reboot the destination. Confirm the per-user background brain returns after
   login and the controller reconnects within the bounded retry policy.

Never use WSL or SSH bootstrap to make W look like a Linux host. A Windows host
must advertise platform `windows` and execute through its packaged native brain.

## 5. Windows Defender Firewall, Tailscale, and Relay

Run on W as the origin host with I or another desktop as controller.

1. With the applicable ADE inbound firewall permission allowed, connect by LAN
   and record the route.
2. Block ADE inbound traffic in Windows Defender Firewall without stopping ADE.
   Confirm LAN fails with actionable connection state; no false connected state
   may be shown merely because loopback health is green.
3. With Tailscale running on both machines, confirm the controller reconnects by
   Tailscale. Stop Tailscale and confirm that route becomes unavailable.
4. With both machines signed in, confirm Relay reconnects after direct routes
   fail. Sign out on W and confirm Relay closes immediately.
5. Restore the firewall rule and LAN. Refresh discovery and confirm LAN becomes
   preferred again.
6. Repeat one connection after Windows logoff/logon and one after full reboot.

Capture the product route/status UI, not firewall rule details containing user
or network identifiers.

## 6. CRR, sessions, remote commands, web, and iOS compatibility

Use one Windows host and one macOS/Linux host. Test current-current first, then
repeat with the oldest supported released controller against the current host.

1. Pair I to W and select the disposable project. Create a lane-local state
   change on W that is represented in CRR data; confirm it appears on I.
2. Perform an allowed state mutation on I (for example settle/unsettle or a
   harmless draft/state change); confirm it appears on W without duplicate rows.
3. Start a Windows Work chat and PTY. Open both on I; verify transcript hydration,
   live events, terminal offsets, input ACK behavior, resize, disconnect, and
   replay after reconnect.
4. Invoke only advertised iOS remote commands: list/open project, list lanes and
   sessions, open Files/PR detail, settle/unsettle, and one harmless host-executed
   command. Confirm unsupported optional actions are hidden or return update
   guidance rather than breaking the socket.
5. Open B, sign in, adopt W through the account directory, and select the same
   project. Confirm web has no local shell/browser/App Control surface, but live
   project reads, Work transcript paging, terminal streaming, lifecycle controls,
   Files, and PR snapshot work through the host.
6. Disconnect/reconnect B during chat streaming. Confirm the hydration barrier
   produces neither a missing event nor a duplicate assistant row and older-page
   Retry preserves its cursor after a transient failure.
7. Run the same iOS and web checks with M or L as host while W remains a connected
   desktop controller. Confirm platform labels and machine ownership remain
   correct in every client.
8. With the oldest supported controller, confirm additive hello fields are
   ignored safely, required mobile actions determine limited mode, optional
   actions are feature-detected, and legacy session/CRR rows remain readable.

Required evidence: Windows CRR roundtrip, iOS command result, web project view,
chat reconnect with no duplication, terminal resume, and compatibility/limited
mode where applicable.

## 7. Stable/Beta and Windows-user isolation

1. Run Stable and Beta simultaneously under the same Windows account. Confirm
   distinct ADE homes, background brains, account-directory names, sync ports,
   runtime pipes, desktop-bridge pipes, projects, and sessions.
2. Invoke Stable's `ade://` link and confirm Beta does not claim it.
3. Sign in or pair only one channel and confirm the other does not inherit the
   session or pairing.
4. Repeat launch and local-project checks from a second standard Windows user.
   Confirm neither user's project catalog, account state, pairings, or runtime
   endpoint is visible to the other.

Do not prove isolation by opening either user's credential files. Prove it from
the visible product state and process/pipe names with user and hash values
redacted from shared artifacts.

## 8. Final recovery and negative checks

1. Quit the desktop while a harmless background brain-owned session is active.
   Confirm the process continues on its origin host; reopen ADE and reattach.
2. Restart the brain during an idle chat, an active terminal, and a pending
   controller reconnect. Confirm bounded recovery and no duplicate command.
3. Log out/in and reboot W. Confirm account state, project catalog, paired direct
   trust, and reconnect policy recover as designed.
4. Uninstall ADE. Confirm its background startup entry, owned terminal shim, and
   owned user `PATH` entry are removed, with unrelated user data untouched.
5. Record explicit non-goals: no Windows ARM64 package, no WSL execution path,
   no native Windows computer-use backend, no iOS Simulator/Xcode surface, and
   no Windows SSH-bootstrap promise.

## Pass report template

```text
Result: PASS | FAIL | BLOCKED
ADE version/commit:
Windows versions:
Client/host matrix completed:
Routes completed: LAN | Tailscale | Relay
OAuth/account completed by authorized coordinator: yes/no
CRR current-current: pass/fail
CRR oldest-supported compatibility: pass/fail
Origin-host process proof: pass/fail
Logout/reboot/brain-restart recovery: pass/fail
Stable/Beta/user isolation: pass/fail
Evidence artifact IDs:
Sanitized logs attached:
Defects/blockers with exact reproduction:
Public release flags changed: no
```
