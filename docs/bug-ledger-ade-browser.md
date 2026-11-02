# ADE Browser — Bug Ledger

Working ledger for the ADE browser (`ade browser` and the Browser pane).
Started 2026-10-31, from a real agent session: a chat that runs on the Mac
Studio, driven by the user from a MacBook Pro, tried to open a share link in
the user's ADE browser and test it.

Items are grouped by the broken code path, not by the order found. Line
numbers refer to `v1.2.128-beta.6` (08af57c37).

**Re-checked 2026-11-02** against `v1.2.128-beta.6`, the newest beta, and
`origin/main`. The beta adds certificate trust, a page context menu and a
search-engine setting. It changes none of the code paths below:
`remoteBrowserForwarder.ts`, `remoteBrowserCallHost.ts` and
`desktopBridgeMethods.ts` are the same as before, and the restore, tab-limit
and observation code is the same. No commit on `main` after the beta touches
the browser. All 17 items are still open. The CLI cannot read the MacBook's
version. The Mac Studio's installed ADE was still 1.2.127.

**Fixed 2026-11-02** in lane `ade-browser-fixes` (on `origin/main` @ ff01b6e,
not yet committed). Each item below ends with a **Fixed** line: what changed
and how it was checked. "Dev app" means the lane's dev build on the Mac Studio
(own socket, own user data, a throwaway project) driven with the dev CLI.
"Seam harness" means `remoteBrowserRouting.scratch.test.ts`: the real
forwarder against fake desktops (the user's MacBook, a Windows PC) and this
machine's bridge. A live two-machine check was not possible: the fixes run
only in a dev build, and the MacBook runs the installed beta.

Status legend:

- `live` — reproduced in a real session, with the output quoted.
- `code` — the cause is located in code; not reproduced live yet.
- `repro` — seen once; the cause is not located yet.

Severity: **High** (wrong machine, lost work, or wrong action), **Medium**
(blocks the agent or misleads it), **Low** (confusing text or layout).

---

## Summary

| ID | Severity | Status | Problem | Fix checked by |
| --- | --- | --- | --- | --- |
| R1 | High | fixed | Commands for one task go to two different machines | seam harness |
| R2 | High | fixed | Isolated tabs open where the user cannot see them, then cannot be reached | seam harness |
| R3 | High | fixed | The user's desktop answers only for chats it showed since its last reload | code + typecheck; needs a two-machine check |
| R4 | Medium | fixed | Errors never say which machine refused | dev app + seam harness |
| T1 | High | fixed | Agent tabs never go away: they persist, restore at start, and fill the cap | dev app restart |
| T2 | High | fixed | After a restart every tab is "opened by you" and "unowned" | dev app restart |
| T3 | Medium | fixed | Tab ids change at every start, so saved ids and error lists go stale | dev app restart |
| T4 | High | fixed | The tab-limit error tells agents to close tabs the user opened | dev app |
| T5 | Medium | fixed | The cap that refused is on another machine, and no screen shows it | dev app + seam harness |
| T6 | Low | fixed | "Tabs per browser" is really tabs per project window | label change |
| O1 | High | fixed | `observe` on the user's desktop fails with `EACCES mkdir '/Volumes/Dev'` | dev app |
| O2 | High | fixed | An action that worked reports a failure when its after-action observation fails | dev app |
| U1 | Medium | likely fixed | The user's pane shows 5 tabs; `ade browser tabs` on that machine says 0 | needs a two-machine check |
| U2 | Low | fixed | `tabs 9 of 10` with 8 rows listed | dev app |
| U3 | Low | fixed | The tabs table does not show which tabs are isolated | dev app |
| U4 | Low | fixed | `handoff --text` prints raw JSON | dev app |
| U5 | Medium | fixed | No command says where the next command will go, or why | dev app + seam harness |

Also asked for by the user and done in the same lane: the default tab cap is
20 (a saved limit is kept, and changing another browser setting no longer
saves the default as if chosen); every agent sees every tab on every machine
with its owner; a deleted or archived lane frees its tabs and closes none
(dev app: a lane-held tab turned `free` on archive and stayed open); any
agent may close any tab (dev app: chat A closed chat B's tab, and `close`
printed whose it was), with the skill and `ade browser --help` telling agents
to check the owner first.

Found and fixed while auditing (2026-11-02, second pass):

- **An agent with no tab took the user's.** A command without `--tab` from
  a chat that owned no tab ran in the tab in front, even one the user opened,
  and claimed it (`authorize` did the same). It is now refused with the next
  step, unless the tab in front is an agent's free tab. Dev app: `observe`
  from a tabless chat refused instead of reading the user's example.net tab.
- **A command without `--tab` could cross machines.** The forwarder now sends
  it to the machine of the tab this chat last used, so after the user's
  computer comes back, a plain `click` does not land on whatever tab is in
  front there. A plain `open` still follows the user. Seam harness.
- **Owners were two UUIDs.** `ade browser status` names them: `"Checkout
  flow test" · lane Primary (held)`, and `opened by "Checkout flow test"`.
  The user's own free tabs read `free (the user's tab; ask first)`. Dev app.
- **The held-tab refusal said to ask the user to close it.** It now says to
  open your own tab, or ask the user to hand this one over, and that it frees
  itself after 10 minutes.
- **A lane release reached a desktop only for chats it had shown.** The call
  host now serves `releaseLaneTabs` broadcasts for any chat. Code reading.
- **Saved machines were served forever.** A machine not shown for 7 days is
  not served again after a reload.

---

## R — Routing: which machine runs a command

The rule is "run in the browser of the computer the user sits at"
(`apps/ade-cli/src/services/builtInBrowser/remoteBrowserForwarder.ts`). The
route is picked again for each command, from hidden state. So one task can
move between machines in the middle.

### R1 `live` High — Commands for one task go to two different machines

**What happened.** `ade browser open … --profile guest-test --new-tab` failed
with "ADE browser is limited to 10 tabs" and listed 10 tabs to close. Each
`ade browser close --tab <id>` for those ids then failed with "Browser tab not
found". The open ran on the Mac Studio (the agent's machine). The close ran on
the MacBook (the user's machine). The 10 tabs exist only in the Mac Studio's
saved state (`~/Library/Application Support/ade-desktop/ade-browser-state.json`,
collection `project-840288c4f50c86e0`).

**Cause.**

- `routeContext` sends a command to the user's desktop only when it is not
  isolated (`remoteBrowserForwarder.ts:452`, `:463`). `--profile` makes the open
  isolated, so it runs on the agent's machine.
- `closeTab` has route `user-desktop` (`desktopBridgeMethods.ts:145`). It has no
  `--profile`, so it goes to the user's desktop.
- Nothing remembers which machine owns a tab id. `lastHost` exists, but only
  `routeLocalFileCommand` reads it (`remoteBrowserForwarder.ts:510`).

**Workaround today.** `ade browser close --tab <id> --here` reaches the agent's machine. On 2026-10-31 it closed the 8 stale tabs that were left.

**Fix direction.** Route by the tab. Record the host of each tab id that an
open returns, and send every later command for that id to the same host. When
the id is unknown, ask both machines, or fail with a message that names both.

**Fixed.** The forwarder remembers the machine of every tab and browser
session a result names (opens, status lists, sessions; a close forgets it).
A command with `--tab` / `--browser-session` goes to that machine. An id it
does not know is tried in the chat's browser, then looked up on this machine
and on every desktop (a broadcast `listTabsForAgent`); the failure lists the
machines asked. A desktop that holds the tab and does not answer is an error
("did not run anywhere"), never a run here. Seam harness: an isolated open,
its observe and its close all reach the MacBook; a tab opened here while the
MacBook was silent keeps its commands here after it comes back; an unknown id
is found on a Windows desktop; a silent holder fails without running here.

### R2 `live` High — Isolated tabs open where the user cannot see them, then cannot be reached

**What happens.** For a chat on another machine, `--profile` / `--isolated`
opens the tab on the agent's machine (`remoteBrowserForwarder.ts:448-452`). The
user does not see it. The skill says the opposite: "The user still sees it in
the Browser pane, marked with a detective icon"
(`apps/desktop/resources/agent-skills/ade-browser/SKILL.md`, step 6). After the
open, `observe --tab <id>`, `click --tab <id>` and `close --tab <id>` carry no
`--profile`, so they go to the user's desktop and get "tab not found".

**Reproduced 2026-11-02.** `ade browser open https://example.com/ --profile ledger-check`
opened `tab-76b1eb56-…` on the Mac Studio. `observe --tab tab-76b1eb56-…` and
`close --tab tab-76b1eb56-…` both answered "Browser tab not found". Only
`close … --here` closed it. The open also printed a misleading host line:
"The user drives this chat from another computer, which did not take the
command". The MacBook was never asked; the route skips it for isolated tabs.

**Fix direction.** Choose one:

1. Open isolated tabs on the user's desktop. The isolation is a partition
   there too, so the user's own sign-in is safe.
2. Keep them on the agent's machine, and route by tab (R1). Then print
   `browser: on this machine; the user cannot see this tab`, and correct the
   skill.

Option 1 matches the product promise.

**Fixed with option 1.** The promise is "the browser where the user sits":
they see the tab, and the isolation is a partition on their desktop too, so
their own sign-ins stay safe. Isolated opens now take the command path to the
user's desktop like any open. The one unsafe case is a `localhost` page,
which needs the pane's request path: that path now carries `profile` /
`isolated`, and a desktop says it does (`requestCarriesSignIn` on its
`needs_pane` reply). An older desktop does not say so, and then the tab opens
on the agent's machine, with the host line saying the user cannot see it.
The skill's step 6 is now true as written. Seam harness covers both.

### R3 `code` High — The user's desktop answers only for chats it showed since its last reload

**What happens.** The MacBook takes a command only for a chat that it has
registered (`apps/desktop/src/renderer/lib/remoteBrowserCallHost.ts:87`). It
registers a chat when the chat is in front on the Work page
(`TerminalsPage.tsx:1342`). The register map lives in renderer memory
(`remoteBrowserCallHost.ts:49`), so a reload or an update clears it. Then:

1. The MacBook ignores the command.
2. After 4 s (`CALL_TAKEN_TIMEOUT_MS`, `remoteBrowserForwarder.ts:60`), the Mac
   Studio runs it.
3. For the next 60 s (`USER_DESKTOP_RETRY_AFTER_MS`, `:68`), every command of the
   chat runs on the Mac Studio, without a new check.

So the route depends on what the user looked at, and when. In this session,
`ade browser tabs` printed `browser: on MacBook-Pro-567` early on. Later the
same command printed no host line and showed the Mac Studio's tabs.

**Fix direction.** Register the chats of the user's desktop in the main
process, from the Work list and not from the chat in front. Keep the map
across reloads. Show the 60 s fallback in the output.

**Fixed (renderer, not main).** The machine connections live in the
renderer's preload, so the fix stays there. Three changes in
`remoteBrowserCallHost.ts`: (1) a command addressed to this desktop by name is
run even for a chat the window has not shown, using the binding's root or the
personal collection the daemon now names (`collection` on the call); an older
daemon that does not name it is left alone as before. (2) Every chat pane
registers its remote chat (Work, the Chats page, the Browser tab's dock), not
only the Work page's front chat. (3) The served machines are saved in
localStorage and served again 4 s after a reload or update. The 60 s
fallback shows in `ade browser status` (`fallback` line). Checked by code
reading and typecheck only; needs a dev build on the MacBook to see live.

### R4 `live` Medium — Errors never say which machine refused

**What happens.** The `browser: on <machine>` line is added only to a
successful result (`withHostNote`, `remoteBrowserForwarder.ts:356`; printed at
`apps/ade-cli/src/cli.ts:37394`). A refusal (tab limit, tab not found, EACCES)
prints the bare error. In this session the refusal came from the Mac Studio,
and the last host line on screen said MacBook. The user then raised the
MacBook's cap to 20, and that did not help (see T5).

**Fix direction.** Add the host note to errors too. Example: "ADE browser on
Mac Studio is limited to 10 tabs …". For "tab not found", name the machine
that looked, and give the `--here` form when the tab may be on the other one.

**Fixed.** Every error the forwarder passes on names the machine, in place
(the error keeps its class and code): "ADE browser on Arul’s Mac Studio (this
machine) is limited to 20 tabs …", "ADE browser on MacBook-Pro-567 (the
user's computer): …". This machine is named by its device display name, the
one `ade browser attach` prints. "Tab not found" is looked up everywhere
first (R1), so `--here` is rarely needed. Dev app: the limit error; seam
harness: the not-found list.

---

## T — Tab lifecycle and the tab limit

### T1 `live` High — Agent tabs never go away

**What happens.** The Mac Studio's ADE project collection held 10 tabs that
agents opened for other tasks: `localhost:5174/5199/5391/8099/4181`, an
`accounts.ade-app.dev/oauth-consent` page, and others. Nobody sits at that
machine, so nobody saw them or closed them. They filled the cap, and every new
agent tab failed.

**Cause.**

- The state store saves every non-isolated tab (`builtInBrowserService.ts:2428`;
  `builtInBrowserStateStore.ts:126`).
- At start, `restorePersistedTabs` loads all of them again, up to the cap
  (`builtInBrowserService.ts:7177-7182`).
- Nothing closes a tab when its chat ends or its lease lapses. The skill asks
  agents to close their tabs, and the code does not enforce it.

**Still growing on 2026-11-02.** Two days after the cleanup, the Mac Studio
held 2 new hidden agent tabs from other chats: `localhost:5191/work` and
`localhost:5173/`.

**Side effects.** Each start loads every saved URL in the background. This
includes dev servers that no longer run, and OAuth consent pages with stale
PKCE `state` and `code_challenge` values.

**Fix direction.**

1. Do not restore a tab that a chat opened. Restore only the tabs a person
   opened.
2. Close a chat's tabs some time after its lease lapses, or when the chat
   ends.
3. Do not restore one-time URLs (OAuth callbacks and consent pages).

**Fixed (1 and 3; 2 replaced by release).** A tab a chat opened is not
restored at start unless a person kept it (navigated it by hand or handed it
to a chat). One-time URLs (`code_challenge`, `state` with `code` /
`client_id` / `redirect_uri`, tokens) are never saved. Direction 2 is not
done: the user asked that tabs be released, not closed, so a finished chat's
tab becomes free (lease lapse, lane delete/archive), shows as free to every
agent, and is offered first in the limit error. Dev app: after a restart only
the user's tab and the kept agent tab came back; the agent-only tab and the
OAuth page did not. Launch loads fewer pages than before.

### T2 `code` High — After a restart every tab is "opened by you" and "unowned"

**What happens.** The state store keeps only the URL
(`builtInBrowserStateStore.ts:43`). Restore creates each tab with
`openedBy: "human"` and no owner (`builtInBrowserService.ts:3883-3885`). So the
tabs table shows the agent's old tabs as `opened: you` and
`owner: not yours — ade browser claim …`. Both words are wrong: the user did
not open them, and anyone can claim them.

**Fix direction.** Save `openedBy` and the opener chat with each tab, or drop
chat tabs (T1). Print `owner: free — claim with …` for a tab with no owner.

**Fixed.** Each saved tab keeps its id, `openedBy`, opener chat and lane,
lane group and the kept flag. The table prints `opened by: the user` /
`this chat` / `chat <id>`, and `free — ade browser claim --tab <id>`. A file
written before this keeps restoring its tabs once, as the user's.

### T3 `live` Medium — Tab ids change at every start

**What happens.** The first limit error listed `tab-e9415868-…` for
`localhost:5174/work…`. A later error listed `tab-0d6197c1-…` for the same
URL. Restore makes new ids (`createTabState` → `randomUUID`,
`builtInBrowserService.ts:3866`, `:7182`). An id that an agent saved, or an id
in an old error, then fails with "tab not found". From the agent's view, this
looks the same as R1.

**Fix direction.** Save the id with the tab, and restore it.

**Fixed.** Dev app: `tab-01288b66-…` and `tab-ffceb3d5-…` had the same ids
after a restart.

### T4 `code` High — The tab-limit error tells agents to close tabs the user opened

**What happens.** `tabLimitError` lists the caller's tabs and every unowned
tab (`builtInBrowserService.ts:2978-2994`). A tab that a person opened has no
owner, so it is on the list. The skill then says: "the error lists the tabs
you may close, so close one rather than asking the user". After a restart
(T2), all of the user's tabs are on that list. An agent can close the user's
mail or a page with unsaved work.

**Fix direction.** List only tabs that a chat opened and that no live chat
holds. When nothing is on the list, ask the user. Never offer a tab a person
opened.

**Fixed.** The error lists the caller's own agent tabs and free agent tabs
nobody kept, counts the rest ("19 held by other chats, 1 opened or kept by
the user"), and says to ask the user when it lists none. Dev app: at 20 of
20, chat C was offered nothing and told to ask; chat A was offered its own 17.

### T5 `live` Medium — The cap that refused is on another machine, and no screen shows it

**What happens.** The user set "Tabs per browser" to 20 on the MacBook, and
the refusal continued. The cap that refused was the Mac Studio's: it has no
`builtInBrowserSettings` in `ade-state.json`, so it uses the default of 10
(`shared/types/builtInBrowser.ts:504`). The setting is correctly local
(`settingsTabContent.tsx:454`, `machine: "local"`). But the user cannot
see or change another machine's cap from the MacBook. The error does not name
the machine (R4).

**Fix direction.** Fix R1 to R3 first: then the user's own cap applies. Then
name the machine in the error. Show the agent machine's browser (its tabs and
its cap) on the user's computer, if agents keep tabs there.

**Fixed.** With R1 to R3, opens go to the user's browser and its cap. The
error names the machine (R4). `ade browser status` prints each reachable
browser's count and cap (`tabs  MacBook-Pro-567 (the user's): 3 of 20;
Arul’s Mac Studio (here): 2 of 20`). Not done: a pane on the MacBook showing
the Studio's tabs. With isolated tabs also on the user's computer, agents
keep tabs on the agent's machine only as a fallback, which the status shows.

### T6 `code` Low — "Tabs per browser" is really tabs per project window

**What happens.** The cap applies to each collection (each project window, and
the personal one): `getTabLimit` is passed to each window service
(`builtInBrowserService.ts:1014`). Ten projects can hold ten tabs each. The
label "Tabs per browser" (`BrowserSettingsSection.tsx:110`) suggests one total.

**Fix direction.** Rename the label to "Tabs per project", or make the cap one
total.

**Fixed with the rename.** The cap is per collection, and a total would let
one project's agents starve another's. The setting reads "Tabs per project",
with a hint that names the project-less chats too.

---

## O — Observations and actions

### O1 `live` High — `observe` on the user's desktop fails with `EACCES mkdir '/Volumes/Dev'`

**What happened.** On the MacBook, `ade browser observe`, `screenshot`, and
`click` (with its default after-action observation) failed with
`EACCES: permission denied, mkdir '/Volumes/Dev'`. `click --no-observe` worked.

**Cause.** The scratch folder for observations is `<projectRoot>/.ade/cache/
browser-observations` (`builtInBrowserService.ts:303`, `:1008`). For a window
bound to a remote project, `projectRoot` is the binding's `rootPath`
(`main.ts:2101`), and that is the path on the other machine. The MacBook tries
to make `/Volumes/Dev/…`, which does not exist there. On a Windows desktop the
same path would be made on the current drive.

**Still fails on 2026-11-02**, on the MacBook's new build: `observe --tab
tab-00d880af-…` gave the same `EACCES … mkdir '/Volumes/Dev'`. The MacBook's
tab list uses the same collection key and root as the Mac Studio
(`project-840288c4f50c86e0`, `/Volumes/Dev/Projects/ADE`).

**Fix direction.** For a remote binding, write observations under the
desktop's own user-data folder (`personalObservationRootPath`), keyed by the
binding. Do not use a path from another machine as a local path.

**Fixed.** A collection whose project root does not exist on this computer
writes under `<userData>/browser-observations/<collection key>/`, which the
remote-call packer already ships back. Dev app: a bridge call for
`/Volumes/NotOnThisMac/Projects/ADE` observed fine and wrote under the dev
user data.

### O2 `live` High — An action that worked reports a failure

**What happens.** `actionResult` runs after the click or the fill, and it
calls `observe` (`builtInBrowserService.ts:7066-7075`). When `observe` throws
(O1), the command fails, but the click already happened. The agent sees an
error and tries again. The second try clicks a second time: a second submit, a
second payment, a second message.

**Reproduced 2026-11-02.** On the MacBook, `click --tab tab-00d880af-…
--text-match "Learn more"` failed with the O1 `EACCES` error. The tab's URL
was then `https://www.iana.org/help/example-domains`, so the click had
happened.

**Fix direction.** Catch an observation failure after an action. Return
`ok: true` with `observation: null` and an `observationError` field. Print
`effect: not checked — the observation failed: <reason>`.

**Fixed as described.** The effect reason also says not to repeat the
action. Dev app: with the tab's observation folder made read-only, `click
--text "Learn more"` returned `ok: true`, `observationError: EACCES …`,
effect `not_checked`, and the tab was on iana.org.

---

## U — Clarity of the output and the UI

### U1 `repro` Medium — The user's pane shows 5 tabs; `ade browser tabs` on that machine says 0

**What happened.** `ade browser tabs`, with `browser: on MacBook-Pro-567`,
printed `tabs 0 of 10` and "(no browser tabs)". The user saw 5 tabs in their
Browser pane on the MacBook at about the same time.

**Likely cause (not confirmed).** The MacBook answers from the collection of
the chat's `projectRoot` (`remoteBrowserCallHost.ts:125-127`). That root is the
remote checkout path. The pane may show a different collection (the window's
own collection, or personal). Then the agent and the user look at two
different tab lists on one machine.

**Next step.** On the MacBook, open the remote ADE project, open 2 tabs by
hand, and run `ade browser tabs --text` from the chat. Compare the
`collectionKey` in the JSON with the collection of the pane.

**Likely fixed, not confirmed.** A desktop now answers for any chat
addressed to it from the binding's own root, the same root the pane keys
its tabs by (`browserCheckoutRoot`), instead of the root of whichever chat
was in front when it registered. The next step above still applies on a
dev build of the MacBook.

### U2 `repro` Low — `tabs 9 of 10` with 8 rows listed

`ade browser tabs --here --text` printed `tabs 9 of 10` and listed 8 rows. A
second call printed `8 of 10`. This can be a tab that closed during the call,
or a tab that the count includes and the list does not (for example, a
destroyed or isolated tab). Check whether `tabCount` and `tabs` come from the
same filter.

**Fixed.** The cause: `tabCount` counted every tab and `tabs` hid other
chats' tabs. Every agent now sees every tab, marked `claimable` (free) or
`heldByOtherChat`, so the count and the rows agree. Dev app: 2 of 20 with 2
rows, one of them chat B's `(held)`.

### U3 `live` Low — The tabs table does not show which tabs are isolated

The `open` result prints `sign-in: isolated profile "guest-test"`. The
`ade browser tabs` table has no such column. The JSON has `isolatedProfile`.
Add a `sign-in` column, so an agent can pick the right tab for a role.

**Fixed.** The table has `sign-in` (`shared` / `isolated "<name>"`) and
`machine` columns.

### U4 `live` Low — `handoff --text` prints raw JSON

`ade browser handoff … --no-wait --text` printed:

```
ADE result
handoff    {"domain":"built_in_browser","action":"startHandoff","result":{"tabId":"tab-8461…
attention  {"domain":"session","action":"requestSessionAttention","result":{"ok":true,…
```

Print one plain line instead. Example: "Handed tab-8461… to the user on
MacBook-Pro-567: Sign in to ADE. The Work row is raised."

**Fixed.** Dev app: `Handed tab-209b032c-… to the user: Sign in to staging.
The Work row is raised and the user is alerted.` and a second line for the
wait outcome or `--no-wait`.

### U5 `code` Medium — No command says where the next command will go, or why

The route depends on the chat's last input origin, the isolated flag,
`--here`, the 60 s silent-desktop memory (R3), and whether the desktop
registered the chat. None of this is visible. An agent cannot predict where a
command runs, and the user cannot tell why their setting does not apply.

**Fix direction.** Add the route to `ade browser status --text`. Example:

```
route   MacBook-Pro-567 (the user's computer), because the last message came from it
        isolated tabs: this machine (Mac Studio)
        fallback: this machine, for 60 s after the MacBook does not answer
```

**Fixed.** `ade browser status --text` prints `route` (the browser `open`
uses and why), `isolated tabs`, `--tab commands` and, while the user's
computer is silent, `fallback` with the time it is asked again.

---

## Notes for the fix work

- The cross-machine items (R1 to R4, T5, O1, U1) need a test with two
  machines: the chat on one, and the user's desktop on another. Check each fix
  with the four questions in **Built for remote machines** (`CLAUDE.md`).
- T1 and T4 change behavior that the skill describes. Update
  `apps/desktop/resources/agent-skills/ade-browser/SKILL.md` in the same
  change.
- T1 loads hidden pages at every start. Measure launch before and after with
  the scripts in `docs/perf/macos-baseline.md`.
