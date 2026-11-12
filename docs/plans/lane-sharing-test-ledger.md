# Lane sharing: end-to-end test ledger

First end-to-end run of lane sharing (PR #2165), on 2026-11-12.

## Setup

- **Host:** the installed ADE `1.2.130-beta.14` on the owner's Mac, project ADE,
  scratch lane `share-test` (`a8a59e45-…`). A second lane `share-test-delete`
  was made for the delete test and deleted.
- **Guests:** two test accounts of the owner, `+adetest` (existing) and
  `+adetest2` (made in this run by its invite).
  - Web client: isolated ADE browser profiles.
  - Desktop: a dev app of this branch on its own home (`~/.ade-lsguest`) and
    socket, with no project. A probe ran the real `LaneShareGuestConnection`
    in its renderer over CDP to send raw frames and log every inbound frame.
- No production deploy or migration. Test rows live in the production
  directory and are removed at the end.

## Proven

| # | Check | Result |
|---|-------|--------|
| 1 | Invite email (Resend key set in production) | Arrives within seconds, plain text, no lane or project name. |
| 2 | Invite link → web → sign in → accept | Works. The redirect keeps `?grant=`. |
| 2 | Wrong account opens the link | "This share is not for this account" with a clear next step. |
| 2 | No account → sign up from the invite | New account lands on the invite and accepts; grant becomes active. |
| 3 | Guest with no machine and no project | Web and desktop guests connect through the relay. |
| 4 | Watch: host refusals (raw commands) | send, steer, draft, comment, interrupt, model change, new chat, new CLI session: `lane_share_right_missing`. Another lane's chat or lane: `forbidden_command`. Unlisted actions (`lanes.list`, `git.push`, `files.writeText`): `forbidden_command`. |
| 4 | Watch: raw envelopes | `project_catalog_request`, `changeset_batch`, `terminal_resize`, `file_request` for another lane, `pairing_request`, `chat_subscribe` of another lane: no answer, connection stays. |
| 5 | Hide my machines | Guest header has no machine name. |
| 7 | Revoke while connected | Guest closed under 1 s ("The owner ended this share."); reconnect refused. |
| 8 | Archive | Guests paused with "The owner paused this shared lane." Unarchive + Try again reconnects. |
| 8 | Delete | Guest closed with "The owner ended this share."; the grant leaves the owner's list. |
| 9 | Frames of other lanes | None in 54+ frames while other lanes were busy (but see D1: field leaks inside the guest's own lane rows). |
| — | History before the share | A guest whose share started after a chat's messages sees none of them; new messages show. |
| 14 | Agents | CLI `--preset collaborate`, `actions run lane_share.create` with Speak rights, a spoofed `callerClass=person`, `confirmHighRisk`: all refused. `lane_share.updateRights`: "requires elevated role". A second share to the same person: refused. |

## Defects

| ID | Severity | What | Cause |
|----|----------|------|-------|
| D1 | Medium (privacy) | The guest's session list carries whole host rows: `transcriptPath` (absolute path on the owner's disk), `ownerPid`, `orchestrationParentSessionId` of a chat in another lane, settle internals. | `filterLaneShareGuestCommandResult` filters rows by lane and kind but never trims fields. |
| D2 | Low (privacy) | `chat.getSummary` sends internal fields (provider resume session id, instance id, automation ids, cache and compaction settings). | No field allow-list for the summary. |
| D3 | Medium (UX) | A chat or CLI session the owner starts after the guest connected does not appear until reload. | The guest reads the session list only on hello, when a watched chat's turn ends, and after its own start. The host sends no change notice. |
| D4 | Medium (UX) | Lane rename (and branch change) does not reach the guest: it keeps the name from share time. | The guest shows the directory's `laneLabel` from create; bootstrap skips rename and branch events on purpose. |
| D5 | Low | After unarchive, a paused guest stays paused until it presses Try again. | `paused` is a stop state with no retry. |
| D6 | Medium (UX) | Web `/shared` without `?grant=` goes to an empty Home ("No machines… No projects"). A guest with no machine has no way back to a shared lane without the email. Desktop Home has the same gap. | `webRoutes` parses `/shared` only with a grant; the shelf lives in the Work sidebar, which a machine-less guest never sees. |
| D7 | Low | The guest's list keeps "Active" for a share that ended. | The received list is not refreshed for the row after an `ended` stop. |
| D8 | Low | A deleted lane ends with the generic "The owner ended this share." | `endLane` closes with the revoke reason. |
| D9 | Low | Guest sees raw states "running", "disposed". | Session `status` is shown as is. |
| D10 | Low | "No messages yet." when earlier messages are hidden by the history rule. | The empty state does not know about the cutoff. |
| D11 | Low | `ade lanes share --lane <name>` says "Only an open lane on this computer can be shared." | Lane commands take ids; the missing-lane error does not say so. |
| D12 | Decision | A guest connects only while the owner's machine hosts that lane's project; otherwise "The owner's computer has another project open". A host project switch closes the guest. | One project host owns the shared sync listener at a time (`setConnectionHandler`, handoff closes guest peers). |
| D13 | Decision | A lane on ADE Cloud can be shared (brief: local only for now). The primary lane can be shared too. | No check in the menu or the host `create`. |
| D14 | Question | A share to the owner's Gmail address was accepted and emailed. | The self-invite check reads the account's verified emails; the owner's account probably uses another address. |

## Not proven yet (needs the owner or other machines)

- Presets above Watch, the high-risk confirm, locks, Hide my models, limits,
  revoke during a guest turn, revoke from another device with the host off,
  Settings › Sharing on the owner's side, shells read only.
- Old host refuses a guest; Windows host CLI typing; the move flow.

## Fixes on this branch (checked against a branch host)

Checked with this branch's brain as its own machine (`npm run dev:machine`,
signed in as the second test account) and the branch's guest desktop.

| ID | Fix | Checked |
|----|-----|---------|
| D1, D2 | `filterLaneShareGuestCommandResult` keeps only listed fields of a session row (`GUEST_SESSION_ROW_FIELDS`) and a chat summary (`GUEST_CHAT_SUMMARY_FIELDS`), the launch model and mode of a CLI session, and a parent chat id only when the guest can see that chat. | Session row has no path, pid or settle fields. |
| D3 | The host pings a lane's connected guests (`lane_share_guest_changed`) when a session is created or removed (at once) or updated (at most every 5 s); nothing runs with no guest. | A shell started on the host appears in the guest view within seconds. |
| D4 | `laneShare.getGuestState` carries `lane: { name, branch }` from the host's lanes table; rename and branch change ping the guests; the guest shows the live name. | Renamed lane shows in the header and list at once. |
| D5 | A paused guest checks again every minute while its view is open, with no "access changed" notice. | Archive, then unarchive: the view reconnects by itself. |
| D6 | The web app opens `/shared` with no machine; Home's Projects card has a "N lanes shared with you · Open" line. | Desktop Home and the page checked; the web route change not run against a local web build. |
| D7 | A share the host ended stays ended in the guest's list over a stale directory read. | Revoke while viewing: "This share has ended", row gone. |
| D9, D10 | Plain session states (Working, Idle, Running, Ended, Failed); the empty chat says earlier messages are not shared. | — |
| D11 | Clear errors for an unknown lane id and an archived lane. | CLI. |
| D13 | The host refuses a share of the main checkout or of a lane on an ADE Cloud computer; the lane menu shows "Share lane…" disabled with the reason. | Main checkout refused on the branch host. Cloud: not run. |

D8 (delete reads "The owner ended this share.") is left as is.

Existing tests that change on purpose (for `/test`): two `syncHostService.test.ts`
cases read `presetId`, `modelHandoffHistory` and `crossMachineHandoff` from a
guest's `chat.getSummary`; those fields are no longer sent at all.

D12 detail: a brain hosts sync for one project at a time (the most recently
opened one, `projectScope.resolveActiveSyncHost`). With no project open, the
brain-level ingress answers every guest "has no project open"
(`brainProjectActionsSyncHandler.ts`). Seen on the branch host before its
project became the hosted one.

## D12 fixed: guests reach any project of the host

Owner's go on 2026-11-12. Checked on the branch's test machine with two
projects, the scratch one served: the guest's ticket was redeemed by the
served project, handed to the lane's project (`lane_share.router_routed`,
redeemed), and served by a guests-only host. Live chat events arrived, the
same 13 forbidden commands were refused, a revoke closed the guest in about
0.6 s, and the guests-only host stopped by itself after two idle checks.

Not run: the brain's own ingress path (no project served at all), and a
served-project switch while a guest is connected (the guest reconnects; the
client retries in a second).

### Independent security review of the routing (Opus subagent, read-only)

No blocker. Fixed on this branch:

- **High:** a guest hello at the brain's ingress, unchecked, could make the
  brain open a project. Now the ingress refuses a non-relay socket or a device
  id that is not the hello's own, and the router gives an unredeemed socket
  only to a project that is already open.
- **Medium:** the account check after a hop: the handoff carries the account
  that redeemed the ticket, and the next host refuses under another
  (`account_session_changed`).
- **Medium:** a second checkout of one repository (or a grant with no
  repository key): a host without the lane now routes the guest on (never back
  to itself, `fromProjectId`) before it refuses with "the share has ended".
- **Medium:** a guests-only host stays while a guest's queued message or a move
  it runs is pending, not only while a socket is open.
- **Low:** the router tries the next project when one cannot take the socket,
  and reads each checkout's live origin when the registry's copy misses.
- **Low:** the queued-guest gate in `agentChatService` is a stack, so a host
  that closes never removes the gate of the host that replaced it.

Left as is: frames a guest sends before `hello_ok` during the hop are dropped
(ADE's guest client sends none).

Rechecked after the fixes on the test machine: routed from the served scratch
project to the lane's project, guest connected.
