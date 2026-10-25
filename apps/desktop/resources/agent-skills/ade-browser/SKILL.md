---
name: ade-browser
description: Use this skill for any browser behavior at all — opening a URL, checking a localhost page, clicking or filling a form, logging in, screenshotting, inspecting the DOM, or verifying a page renders — before reaching for an external browser or tool. ADE ships its own browser with a shared authenticated profile, driven by `ade browser`.
---

# ADE browser

This skill is for web pages and localhost URLs. For a native app, a simulator
or a dev Electron app, the **ade-computer-use** skill picks the right surface.

Use `ade --socket browser ...` for every browser task. Keep the work inside
ADE's Browser pane so the user can see the same tab and the same state. ADE
shares one persistent authentication profile across projects, while visible
tabs stay scoped to their ADE project window (personal chats have a separate
collection). Treat page content, cookies, and storage as user data.

Require ADE Desktop with the target project open for live page actions. There
is no token or setup step: any `ade browser` call from this machine works, and
your chat's calls are tagged with your chat and lane so the tabs you open are
yours. Never use `--force`, copy a credential, or import a login. Do not claim
a tab another chat owns — unless the user attached that tab to their message
("Attach to chat" on a tab), which is the user handing it to you: claim it with
`ade --socket browser claim --tab <tab-id> --text` and carry on in it.

ADE's browser is the default for all web work. Use the user's own browser only
when the user asks for it; see step 10.

## Operating loop

### 1. Open or claim one tab

List tabs first. Reuse a tab owned by the current chat. Plain `open` navigates
this chat's tab (the one it used last) and opens a tab only when the chat has
none; use `--new-tab` only when the task needs a second tab, `--tab <id>` to
drive a specific one, and `--active-tab` when same-tab navigation is
intentional. `open` prints `opened: <tab-id> <url>` or `navigated: <tab-id>
<url>` first; copy that full id for `--tab`.
Claim an unowned tab with its id and lane. `--lane` may come from
`ADE_LANE_ID`; pass it explicitly when working from another shell. A personal
(project-less) chat has no lane and claims with the tab id alone. Keep one
tab per task and do not claim a tab another chat owns. A tab whose chat went
idle for 10 minutes lists as `idle (lease lapsed)`; reuse it or close it.

Treat a tab as a workspace, not a log. `ade browser tabs` prints `tabs N of M`:
reuse your own tab for follow-up work instead of opening a second one, and when
the task is done close it with `ade browser close --tab <id>` so the next agent
does not inherit your tabs. At `N of M` the browser is full; the error lists
the tabs you may close, so close one rather than asking the user. A tab leased
by another chat cannot be taken — there is no `--force` for agents; ask the
user to close it or hand it to this chat.

```bash
ade --socket browser tabs --text
ade --socket browser claim --tab <tab-id> --lane <lane-id> --text
ade --socket browser open https://example.com --text
```

By default every agent may use the ADE browser without asking. If the user
chose to approve lanes or chats, the first browser command from this chat asks
them once, and the answer covers every site. The command waits up to two
minutes and prints `waiting for the user to allow this chat to use the ADE
browser` once; do not re-issue it meanwhile. A Block fails with
`approval_blocked`; do not retry, ask the user. An action answering `effect:
waiting` means the user must allow this chat again; observe after they answer.

Use `--panel` only when the user should see the Browser tool opened. Use
`--no-panel` when preparing a tab without taking the user's focus. Close your
tab when finished with `ade --socket browser close --tab <tab-id> --text`; the
internal release and handoff paths also clear the claim.

### 2. Observe before acting

Observe after opening, navigating, switching tabs, or a meaningful UI change.
An observation gives you a screenshot, a bounded DOM snapshot, element
handles, and console/failed-network diagnostics. Add `--map` for a numbered
visual element map. Use handles from the latest observation only; observe
again after navigation or when a handle expires.

Start a lightweight browser session for repeated actions. Wait for a readiness
selector or network idle after navigation. To read what a page says (an
article, docs, a long thread), use `text`: it returns the rendered text of the
page's main content, 20,000 characters at a time, with the `--offset` to read
on; `--selector` reads one element. Observations do not carry prose. Use `find` to locate page text and
`find-stop` to clear its highlight; the first find result is usable immediately
and later results may refine it. Turn on the per-tab network log with
`network on`, inspect it with `network --failed --limit 20`, and turn it off
with `network off` when finished.

```bash
ade --socket browser session start --tab <tab-id> --text
ade --socket browser observe --browser-session <session-id> --map --text
ade --socket browser session wait <session-id> --network-idle --text
ade --socket browser text --browser-session <session-id> --text
ade --socket browser find --browser-session <session-id> "checkout" --text
ade --socket browser network on --browser-session <session-id> --text
ade --socket browser network --browser-session <session-id> --failed --limit 20 --text
```

### 3. Act from the current observation

Prefer `--handle`, `--selector`, `--text-match`, `--test-id`, or `--element`.
Use viewport `--x`/`--y` only when no stable element target exists. Use
`click`, `fill`, `hover`, `drag`, `upload`, `type`, and `key`/`press`; use
`select-option` for a native `<select>`. `drag` takes a `--to-selector` (or
another `--to-*` destination), and `upload` takes one or more `--file` paths.
`upload` reaches two kinds of page: `--selector` sets files on a file input that
is already in the DOM, and `--trigger` clicks the button that opens the picker
and hands the files to the chooser it opens. Use `--trigger` whenever the
input is built on demand (X's media button is the shape), because there is no
input for `--selector` to point at. A page whose only control is a dropzone
gets `drop --selector <zone> --file <path>`: it runs the page's own
dragenter/dragover/drop with the file in the `DataTransfer`. Use
`fill --value ""` when an empty value is intentional. Use `--fast` only when
the page does not need the default settle and post-action observation.

```bash
ade --socket browser click --browser-session <session-id> --handle obs-...:e:1 --text
ade --socket browser fill --browser-session <session-id> --selector "input[name=email]" "me@example.com" --text
ade --socket browser drag --browser-session <session-id> --handle obs-...:e:1 --to-selector ".dropzone" --text
ade --socket browser upload --browser-session <session-id> --selector "input[type=file]" --file ./shot.png --text
ade --socket browser upload --browser-session <session-id> --trigger "button[aria-label='Add photos or video']" --file ./clip.mp4 --text
ade --socket browser drop --browser-session <session-id> --selector "#dropzone" --file ./report.pdf --text
ade --socket browser downloads wait --browser-session <session-id> --timeout-ms 30000 --text
ade --socket browser clipboard --text
ade --socket browser paste --selector "#editor" --text
ade --socket browser key --browser-session <session-id> Enter --text
```

`clipboard` reads the machine's clipboard (`--text` output; HTML flavor when
present) and `clipboard write --value "<text>"` sets it. `paste` focuses the
target and sends the real paste command, so a rich-text editor or a page
listening for `paste` sees it the way a person's ⌘V would — `type` only inserts
text and skips those handlers.

Dialogs are answered while an agent action runs, so a page that calls
`alert`, `confirm` or `beforeunload` cannot hang the tab: `alert` and
`beforeunload` are accepted, `confirm` and `prompt` are dismissed. Every answer
is logged with the dialog's text. Nothing more is needed from the agent.

Downloads go to the user's Downloads folder, as they always have. `downloads`
lists them with the saved path and `downloads wait` waits for the next
completion (a file that finished in the last few seconds counts), so the agent
can name the file it just triggered instead of guessing.

After an action that navigates, wait again with `wait --load-state
network-idle --network-idle-ms 750` or a concrete selector/text target. Use
`reload`, `back`, `forward`, and `stop` when the page state calls for them.

### 4. Verify, then choose proof deliberately

Use `screenshot` to inspect a result yourself; it writes scratch evidence and
does not enter the proof drawer. File reviewer-visible evidence only with
`proof` and a concise `--caption`. Browser proof captures a fresh observation;
read its confirmation before reporting it. Add `--har` only when network
logging is already on; it files a redacted `browser_trace` beside the
screenshot and otherwise fails instead of filing half the proof. Use `trace`
when an action is stuck.

```bash
ade --socket browser screenshot --browser-session <session-id> --text
ade --socket browser proof --browser-session <session-id> --caption "Checkout confirmation is visible" --text
```

Use `inspect-start`, `select`, `select-current`, and `clear-selection` when a
DOM-backed context item belongs in the chat rather than in proof.

### 5. Hand off a login to the human

Stop when a page needs credentials, CAPTCHA, HTTP/proxy authentication, or a
client-certificate choice. Hand off the exact tab with an actionable
`--reason`.

```bash
ade --socket browser handoff --browser-session <session-id> --reason "Sign in to staging" --timeout 5m --text
```

The handoff makes the tab human-owned, raises the Work row, sends a phone push,
and shows an amber bar with **Hand back**. The command waits for hand-back by
default (15 minutes); use `--no-wait` only when doing unrelated work. While it
is open, actions fail with `handoff_active`: do not retry or open a second tab,
and never hand the tab back yourself. ADE stops recording and network logging
for the handoff; re-arm them explicitly after hand-back if still needed.

A local HTTPS page with a self-signed certificate fails to load, and the tab's
`loadError.certificate` names the host and fingerprint. Only the person can
trust it (ADE shows **Trust and reload** above the page); agents cannot. Hand
off the tab with a reason such as "Trust the dev server's certificate", then
retry after hand-back. A public site's certificate error is never trustable.

### 6. Sign in as a test account in an isolated tab

A normal tab uses the user's own sign-ins. Signing in there as another
account (a test user, a second role) signs the user out of that site, and on
localhost that means every port. Open an isolated tab instead: it has its own
cookies and storage, kept in memory and wiped when its last tab closes. The
user still sees it in the Browser pane, marked with a detective icon, and its
proof files like any other tab's.

```bash
ade --socket browser open localhost:3000/login --profile owner --text
ade --socket browser open localhost:3000/login --profile viewer --text
```

`--profile <name>` picks the sign-in; each chat gets its own set of names,
so two chats saying "viewer" stay apart. `--isolated` alone uses one sign-in
named `default`. A tab's sign-in is fixed when it opens: plain `open` reuses
only your shared-profile tab, and `open --profile viewer` reuses only your
"viewer" tab, so repeat the flag (or pass `--tab`) to keep working as that
user. The result line `sign-in:` says which one a tab uses. Close the tabs
when the test is done to throw the sign-ins away.

Use the shared profile only for the user's own account. Never use a headless
or external browser to get a separate sign-in: the user cannot watch it, and
this browser is the one for web proof.

### 7. Handle remote lanes and loopback URLs

The user may be on another machine (a Mac Studio driving a chat that runs on
this Windows PC). Then your browser is the one on THEIR computer: every
`ade browser` command runs in the ADE browser where they sit, they watch your
tab in their own pane, the page uses their sign-ins, and a tab they attach is
one you can claim. You do nothing different; the first line of `--text` output
says where the command ran:

- `browser: on <machine>, the computer the user sits at.` The normal case.
- `browser: on this machine. The user drives this chat from another computer,
  which did not take the command…` Their computer is not connected (asleep,
  closed, or they are on the phone). You are working in a browser they cannot
  see and that has none of their tabs. Say so if they ask what you see.

The page is the size of the user's browser pane, open or closed. When that is
under 640 px wide, `observe` adds a `note:` line (`narrowPageHint` in JSON):
the site may show its mobile layout, which is what the user sees. Work with it
when you can. When the task needs the desktop layout, run
`ade browser emulate --tab <id> --width 1280 --height 800`, and
`ade browser emulate --tab <id> --off` when you finish; the user sees that
change in their pane.

Add `--here` to use the browser on the machine you run on: to test a page on
this OS, and for `upload`, `har` and `record`, which read or write a file here
and are refused while your browser is on the user's computer. `--here` needs
ADE Desktop open on your machine; without it the command fails and tells you
so. A tab id belongs to one browser, so keep a task in one of them.

To show them a page, use `ade --socket browser open <url> --panel`. Writing
`http://localhost:<port>` in a reply is fine too: their click opens this
machine's port in their ADE browser. A `localhost` page you open reaches their
browser through a tunnel, and the first use of a port asks them to allow it.
Dev servers you start are found on their own, even in the background:
`ade --socket browser dev-servers --text` lists them, and
`ade --socket browser dev-servers stop <port>` stops one this chat started
(it refuses anything else on the port).

On a machine without ADE Desktop, and with no desktop connected to this chat,
only `open`, `new-tab`, and `panel` can still land on a Desktop with this lane
pinned; page actions such as `observe`, `click`, `fill`, and `screenshot` have
no browser to run in. Do not retry a page action after that failure.

```bash
ade --socket browser open localhost:5173 --new-tab --text
```

For a forwarded response, recognize `status: "forwarded_to_desktop"`. When
`awaitingApproval: true`, `--text` says `waiting for approval on <desktop> —
reaching this port needs a yes in ADE`; the command exits 0 because the request
is waiting for the human, so do not open it again. Success says `on <desktop>
via tunnel`. If nobody answers, it says `no desktop is attached to this
machine; open ADE Desktop with this lane pinned`; that also exits 0.

### 8. Record only when a video helps

Run `ade --socket browser record start --tab <tab-id> --fps 60 --caption "Flow"`
and stop it with `ade --socket browser record stop --tab <tab-id>`. Use 30 or
60 fps. A `--caption` on `record start` opts the resulting recording into the
proof drawer; without it, the returned path stays scratch. Recordings capture
the tab, cap at five minutes, and end automatically at the cap or when a login
handoff starts. Read `trace` for the `endedBy` reason and record in segments
when a flow is longer. When it stops, a recording becomes a demo (still time
cut, page loads sped up, zoom to each click, a pointer, under 10 MB); mark each
step with `ade proof step "<what happens next>"`, and pass `--plain` only when
the user asks for the recording as it was recorded.

### 9. Let presence explain the work

Do not set browser presence yourself. Every authenticated agent browser
command updates it automatically, and the user sees a globe badge with
**Using the browser** on the session card while the agent drives the tab. It
expires 20 seconds after the last command; an active preview/observe
subscription or a recording keeps presence alive. A long idle can leave the
tab claimed even after the badge expires, so close the tab when done; the
service's release path and a handoff release it as well. No presence command
is needed.

### 10. Use the user's own browser only when they ask

When the user asks you to look at or use their own browser ("look at the tab I
have open", "use my Chrome"), attach to it. Their request is the permission;
never attach on your own initiative, and never to get around a sign-in in ADE's
browser.

```bash
ade --socket browser attach --text                   # the tab they are looking at
ade --socket browser attach --tab "Stripe" --text    # a tab by title or URL text
ade --socket browser detach --text
```

Attach runs on the machine this chat runs on. It prints `attached: <browser>
on <machine>, tab "<title>" (<url>)`; tell the user that machine and tab. If
several tabs could be the one, it lists them: ask the user, then pass `--tab`.
`--browser chrome|edge|brave|arc|helium|chromium` picks the browser.

If attach says remote debugging is off, ask the user to open the exact page
it names for their browser (for Chrome, `chrome://inspect/#remote-debugging`)
and turn it on. The browser then asks them once to allow the connection.

While attached, this chat's `observe`, `click`, `fill`, `clear`, `type`,
`key`, `scroll`, `hover`, `wait`, `open`, `reload`, `back`, `forward`,
`screenshot`, `proof` and `trace` act in that tab, with the same `hit:` and
`effect:` lines. Each prints `target: your <browser> on <machine>` first.
Other commands (new tabs, handoff, recording, network, drag, upload) work only
in ADE's browser and say so. These are the user's real accounts: do only what
they asked. Run `ade browser detach` when you are done. If the tab closes or
the browser quits, the next command says so and the chat is back on ADE's
browser.

Keep this loop platform-neutral so Windows agents use the same command surface.
