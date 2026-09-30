# Windows Desktop: a lane's own Windows screen

Status: plan locked, not built. Decisions locked with the owner on 2026-09-30 after
seven live spike rounds on a Windows 11 Pro 26200 PC. Spike notes and scripts:
`C:\Users\arul2\ade-spike` on that PC; results summarized below.

## Goal

Agents test Windows apps (Electron and native) and post proof the same way
they do on macOS with Mac Desktop: open apps, click, type, screenshot, record,
attach proof to the chat and the PR. The user keeps working on the same PC
without interference, and can watch or take over from any ADE client.

Constraint from the owner: no feature may require a paid Windows edition
upgrade, a paid VM license, or a paid cloud machine. Pro-only capabilities are
allowed only when a free fallback exists on Home.

## Modes

| Mode | When | What the agent gets | Effect on the user |
|---|---|---|---|
| **A: private session** (default) | Windows Pro, Enterprise, Education; child sessions available; password saved | A second Windows desktop of the user's own account (Remote Desktop child session). Its own pointer, keyboard, foreground. Real input with no lease. | None while the PC is unlocked |
| **B: shared desktop** (fallback) | Home, or A cannot start, and the user allows it | Windows parked in off-screen lane areas on the user's own desktop. UI Automation first; real input only under the lease. | Takes the foreground on most actions |

No VM mode and no cloud mode now. `DesktopSeatProvider` keeps room for them.

Only one child session exists per PC (Windows limit). A second lane that asks
for a private screen while another lane holds it can ask the user to take it
over, or use B (see Mode A lifecycle, item 7).
A and B can run at the same time in different lanes: they are independent
sessions.

## Spike results this spec rests on

| Fact | Result |
|---|---|
| Child session starts from the console session (RDP ActiveX `ConnectToChildSession`) | Yes, session in < 1 s |
| Working call order | Set `ConnectToChildSession` (IMsRdpExtendedSettings) first, then `Server = "localhost"`, `AdvancedSettings9.EnableCredSspSupport = true`. Server first, or no CredSSP, gives `E_INVALIDARG` |
| Remote Desktop must be allowed | `fDenyTSConnections = 0` is required (firewall rules can stay off; loopback only) |
| Automatic logon (no password) | Only when the user signed in with a password after child sessions were enabled. Windows Hello PIN sign-in always prompts |
| Saved password with PIN sign-in | Works: `UserName = "MicrosoftAccount\<email>"` + `IMsTscNonScriptable.ClearTextPassword` from a DPAPI-sealed value, no prompt |
| Separate local "agent" account in the child session | Refused (`0x80070005`). The child session only accepts the console user |
| Host window hidden (`Visible = false`), off-screen, no taskbar, transparent | Session keeps rendering and streaming |
| Host window minimized | Rendering stops (capture fails) |
| Console locked | Session stays connected, but capture fails, `SendInput` accepts 0 events, foreground changes fail. UI Automation still works. Everything resumes after unlock with state kept |
| Real mouse and keyboard in the child session | Work; the console pointer and foreground did not change (100 ms watcher) |
| Stream (spike: GDI capture 25 ms + JPEG 2–3 ms, 1280×800) over Tailscale | 15–20 fps, about 15 Mbit/s. H.264 must replace JPEG |
| B: off-screen parking (x > virtual screen right edge) | Windows stay parked; `PrintWindow(PW_RENDERFULLCONTENT)` 22–32 ms, about 79 fps |
| B: focus | Launching a window, UIA `Invoke`, and even `SelectionItem.Select` take the foreground. Shell COM `Navigate2` does not |
| Child logon side effects | The user's Run-key apps start in it (Battle.net, Steam, iCloud error dialog, runner keepalive) **and the ADE brain supervisor** |

External confirmation: the open-source childstream project uses the same
method (password once, DPAPI, one child session, Pro required, Hello-only
users must allow password sign-in). Microsoft's Agent Workspace is also a
Remote Desktop child session.

## Functional requirements

### Detection and setup (per machine, once)

1. `windowsDesktop.status` reports: edition, `WTSIsChildSessionsEnabled`,
   whether Remote Desktop is allowed, whether a sealed password exists, the
   console session id, and whether another lane holds the child session.
   Detect support at runtime; never decide from the edition name alone.
2. Setup flow in the Windows Desktop tab (first open), needs admin once:
   1. Enable child sessions (`WTSEnableChildSessions(TRUE)`).
   2. Allow Remote Desktop connections (`fDenyTSConnections = 0`). Do not
      enable the firewall rules; the connection is loopback only.
   3. Ask for the Windows password once in an ADE dialog. Seal it with DPAPI
      (current user) through ADE's credential store. Never log it, never sync
      it to other machines, never send it over the runtime RPC.
   4. Tell the user, in plain words, that the PC must stay unlocked while an
      agent uses the private screen, and that ADE keeps the display awake while
      a lane uses it.
3. If a step fails or the user declines, the tab shows the B offer (below).
4. Password change: a logon failure (RDP disconnect reason 2055) clears the
   sealed password and asks again. Never retry a failed password.

### Mode A lifecycle

1. The brain starts `ADEDesktopDriverWin` in **host mode in the console
   session** (decided 2026-09-30: one binary, no separate helper). The host
   owns the RDP ActiveX control, connects with the sealed credential, and
   keeps its window `Visible = false`, not in the taskbar. Never minimized.
   The brain restarts it if it crashes, like the Mac driver lifecycle. If the
   brain is not in the console session (for example, started over SSH),
   status says why A is unavailable.
2. The host reports the child session id. **The driver starts from ADE's own
   Run entry** (decided 2026-09-30). The brain and its supervisor run as the
   user, not as SYSTEM, so they cannot call `WTSQueryUserToken`. The Run entry
   already runs at every logon, the child session's logon included. After the
   ADE-160 fix, the launcher script checks its session: in the console session
   it starts the supervisor; in a child session it starts the driver, which
   connects back to the console brain over the named pipe. No service, no
   SYSTEM, no extra admin step. (The spike used a SYSTEM scheduled task only
   because it had admin SSH.)
3. **Logon-app guard:** ADE must not run its own supervisor or brain in the
   child session. The launcher never starts the supervisor outside the console
   session (part of the ADE-160 fix). The user's other startup apps: see
   item 6.
4. **Keep awake:** while any lane's A session is live, the runtime host holds
   `SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED |
   ES_SYSTEM_REQUIRED)` from the console session, so the idle lock does not
   trigger. A manual lock (Win+L) or a policy lock still pauses the session;
   the tab and the agent then see state `paused_locked` and the agent waits.
5. Sign-out (decided 2026-09-30): no idle sign-out. The child session signs
   out on lane deletion, on the user's Stop button, and when the brain stops
   (decided 2026-09-30: not when only the desktop window closes; agents keep
   working, as on the Mac). The keep-awake hold applies only while an agent is acting in the
   session, never while the session only exists, so the PC can still lock when
   nothing runs.
6. Startup apps (decided 2026-09-30): after the child session signs in, the
   driver closes, inside that session only, every process that is not a
   Windows component (image outside `C:\Windows`, not the shell) and that ADE
   did not start. In a fresh child session, everything else came from logon,
   so this also catches helpers that a startup app starts. It never touches
   the console session. No allow list in v1 (decided 2026-09-30): ADE
   closes all of them.
7. One child session per PC, one holder (decided 2026-09-30; lanes do not
   share it). A lane that needs a Windows desktop while another lane holds it
   can: (a) force-claim it: the previous holder's chat gets the message "Lane
   <name> took the private Windows screen. Your actions on it are refused
   until you claim it again." and its next action fails with that reason;
   (b) use B with the warning; (c) use no desktop (browser and App Control
   only). No queue (decided 2026-09-30): a lane does not wait in line for the
   private screen.
   Decided 2026-09-30:
   - An agent never force-claims alone. It always asks the user with an ask
     card in its thread. The user can also force-claim from the tab.
   - **Clean slate on every change of holder.** On force-claim, on a normal
     hand-over to another lane, and on lane delete, ADE wipes the private
     screen before the next holder gets it: it signs the child session out
     and starts a fresh one (clears windows, clipboard, session state; the
     startup-app cleanup then runs again). Nothing of the previous lane
     carries over to another agent. (The previous holder's apps are not
     parked for later.)
   - The holder releases on lane delete or chat end. A stale holder is
     claimable without force.

### Mode B (shared desktop)

1. Only after explicit consent, per lane, with this message in the chat and
   the tab: "The private Windows screen is not available: <reason>. ADE can
   still work on your main Windows desktop, but it will take over the window
   you are using while it acts."
2. Lane areas are rectangles right of the virtual screen (spike: 5520 and 6920
   on a 5120 px wide desktop). Launched and claimed windows park there.
3. Quiet actions first (UIA Value, Scroll, Expand, Shell COM navigation).
   After any action that takes the foreground, restore the user's previous
   foreground window. Real input only under the lease (once per chat, as on
   Mac Desktop).
4. B does not work while the console is locked; report `paused_locked`.

### Driver: `ADEDesktopDriverWin`

A C++ helper in `apps/desktop/native/ADEDesktopDriverWin`, built, signed and
packaged like `ADECaptureHelperWin` (NDJSON over stdin/stdout, `{"type":"quit"}`
shutdown, exits when stdin closes, no blocking work on a thread that pumps
messages). One instance per session it serves (child session for A, console
for B). Same request set as the Mac driver where the meaning is the same:

- `windows.list`, `window.park`, `window.unpark`, `app.launch`, `app.quit`
  (only apps the lane launched);
- `observe`: UIA tree with stable handles + screenshot in one reply;
- `input`: UIA patterns (Invoke, Value, Toggle, ExpandCollapse, Scroll,
  SelectionItem), `SendInput` pointer and keys (A: always; B: lease only);
- `screenshot` and `record` via Windows.Graphics.Capture (fall back to Desktop
  Duplication for the whole child desktop); H.264 via Media Foundation;
- `stream`: token-guarded loopback HTTP, same framing as the Mac stream server,
  so the existing WebCodecs viewers work unchanged;
- `health`: session id, locked state, capture ok, input ok.

### Agent surface

- One vocabulary for both operating systems. Add a neutral command family
  (`ade screen …`) with `ade mac-desktop` kept as an alias on macOS. Verbs are
  the Mac Desktop verbs. `ade screen` is part of this PR.
- The existing `ade-computer-use` skill gains a short Windows section; no new
  skill. The system prompt line appears only when the lane's host is Windows
  and the tool is on.
- Rules for agents: open explicit files and apps only; never rely on restored
  tabs or file associations (spike: Notepad restored the user's tab; a `.txt`
  opened in ADE). Ignore the user's startup apps in the private screen.

### Contract changes

- `DesktopSeatProvider.id` becomes a union:
  `"mac-virtual-display" | "windows-child-session" | "windows-shared-desktop"`.
- `WORK_TOOL_IDS` gains a separate `windows-desktop` tool. Tools follow the
  chat's machine (decided 2026-09-30): a Windows-hosted chat shows Windows
  Desktop and hides Mac Desktop and Apple; a Mac-hosted chat shows Mac Desktop
  and Apple and hides Windows Desktop. Browser and App Control show on both.
- Lease, ownership, proof, streaming, time-lapse and tools-state mirroring stay
  in the service and are shared.

### Proof

Unchanged contract: `record` and `proof` go through the existing broker, are
filed under the lane, the chat and the linked PR, and follow the "validate
before attaching" rule.

## Prerequisite bug

ADE-160 merges in the same PR as this work (decided 2026-09-30: one PR with
ADE-160, `ade screen`, and Windows Desktop): every sign-in on the spike PC
started two supervisors, because the Run-value name hashes `USERDOMAIN`
(`WORKGROUP` over SSH, the machine name on the desktop). A child session is a
second logon of the same user, so the supervisor must also refuse to run
outside the console session.

## Windows parity and other platforms

- macOS: unchanged (Mac Desktop).
- Windows Home: B only; the tab says why A is not available.
- Linux hosts: tool hidden (Linux seat is a separate, later plan).
- Any client OS can view and control a Windows-hosted screen through the
  existing stream and RPC routes.

## UI (round 2, decided 2026-09-30)

Design rule from the owner: every card is short, clear, and easy to read.
No blocks of text. One sentence says what is happening; the buttons say what
the user can do. Reuse the Mac Desktop pane parts (state card, status strip,
floating player, lane mark, time-lapse card).

1. **Setup: a step-by-step wizard** (a dialog), opened the first time the
   Windows Desktop tool opens on a PC that is not set up. One short screen per
   step:
   1. Turn on private screens. One Windows admin prompt turns on child
      sessions and local-only Remote Desktop together.
   2. Save your Windows password. A password field in the dialog. One line
      says it stays on this PC.
   3. Keep this PC unlocked. One line: ADE keeps the display awake while an
      agent works; a locked PC pauses the agent.
   4. Done.
   Each step has a skip path to "Use main desktop" (the Mode B consent). An
   agent cannot run the wizard (it needs the user's admin prompt and
   password); it shows an ask card in the thread that opens it.
2. **Held by another lane:** the standard state card names the holder lane
   and offers two buttons: Take over, Use main desktop. One
   line under them: take over starts a clean screen. Take over asks for a
   confirm first. The agent's ask card in the thread offers the same choices
   plus No.
3. **Console locked:** keep the last frame, dimmed, with a centered note:
   "This PC is locked. Unlock it to continue." The status strip says Paused.
   The agent's actions fail with the same reason, and it waits.
4. **Mode B:** a consent card, once per lane, in the thread and in the pane,
   with the agreed message and two buttons (Use main desktop, No). After
   consent, the pane's status strip stays amber for the whole time B is on,
   with a short reminder and a Stop button.

## Extras (round 3, decided 2026-09-30)

1. **Screen size:** the Mac Desktop presets (1080p, 1440p, 4K; default
   1440p) and the same picker. A change applies at the next fresh sign-in,
   because Windows sets the child session size at connect.
2. **`ade doctor` on Windows** reports child sessions, local Remote Desktop,
   saved password, the brain's session (console or not), and the ADE-160
   single-supervisor state. Each failed row has one fix line.
3. **Stop from the phone:** the phone view (view-only today) gets a Stop
   button that signs the private screen out.
4. **Password check on save:** the wizard tests the password with a real
   sign-in to the private screen before it saves it. A wrong password fails in
   the wizard, not at the agent's first action.
5. Not in v1: an allow list for startup apps; a queue for the private
   screen.

## Open questions for /plan

1. Home support is detected at runtime, so no Home test is required. Optional
   free check later: a Windows 11 Home VM without activation under Hyper-V on
   the Pro PC.
