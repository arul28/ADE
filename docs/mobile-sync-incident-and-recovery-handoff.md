# Mobile sync incident and recovery UX handoff

Date: 2026-09-08. Status: incident recovered. The recovery work proposed below now ships on this branch.
Source baseline: `a26f0ac367119ed9d5319e71a2dc49ec6f5c3e3c` (desktop/runtime 1.2.73).
Purpose: user-requested incident ledger. This document is the historical record of the incident and the direction it produced. It is not the description of the shipped behavior — for that, read `docs/features/sync-and-multi-device/` and `docs/features/chat/`, which this branch updates in present tense.

## Brief

The user's iPhone could reach the installed ADE brain, but project commands failed because a development runtime conflicted with mobile sync ownership on port 8787. The app displayed a small “Work hydration failed” card above chats even though multiple workspace surfaces were unusable. Stopping the conflicting runtime removed one obstacle, but the installed runtime then reported its own PID as the conflict. Restarting the installed brain restored its sync host. The phone authenticated again, route checks passed, and the user confirmed: “ok seems to work again.”

The requested product direction is clearer error states across mobile, a machine-level recovery screen for failures that prevent workspace use, and simple conflict recovery from the phone. Runtime management must appear **only when a conflict occurs**, not as a permanent machine-settings runtime list.

## Evidence and limits

Evidence below comes from read-only source inspection, live process/socket inspection, CLI status, and local logs during this conversation. Recovery was explicitly authorized by the user. No source code or pairing data was changed during recovery. No screenshot was captured: placement is supported by the user's report and the source, not visual proof.

Log sources:

- Machine log: `/Users/admin/.ade/runtime/brain.jsonl`.
- Project log: `/Users/admin/Projects/ADE/.ade/transcripts/logs/ade-cli.jsonl`.
- Live checks: `ade brain status --text`, `ade brain status --json`, `lsof -nP -iTCP:8787 -sTCP:LISTEN`, targeted `ps`, and `lsof -a -p 19621 -d cwd -Fn`.

All log timestamps below are UTC; local time was EDT (UTC minus four hours). Excerpts explicitly labeled “selected fields” omit unrelated fields and identifying device/network values. They are not complete raw records. Do not copy entire logs into a PR: they contain unrelated session and machine information.

## Incident ledger

| Time (UTC) | Verified observation | Meaning / limit |
| --- | --- | --- |
| 19:13:32 | Project log recorded `sync_host.peer_adopted` for `iPhone`, paired authentication, then replica reseed activity. | Earlier functioning project-host path existed. Does not prove every request succeeded. |
| 19:21:55 | `sync.tunnel_stopped_without_sync_host_lease`: “This runtime no longer holds the machine-wide sync host lease.” | Ownership was lost before diagnosis. The initiating actor was not established. |
| 19:33:04 | Startup failure attempt 18 identified conflicting PID 11440. | There was an earlier conflicting owner; we did not inspect that process while alive. |
| 19:36–19:40 | Repeated `SyncHostSingletonConflictError` identified PID 19621. Phone Work, chats, lanes and PR commands received `host_unavailable`. | Conflict persisted across retries; the UI's “few seconds” guidance was misleading for this case. |
| Before termination | PID 19621 was `node apps/ade-cli/dist/cli.cjs serve --socket /tmp/ade-remote-sim/sock/ade.sock`; cwd was the `improving-browser-4bb19b3f` lane. | Establishes origin directory and command, not who launched it or why. |
| Before termination | PID 19621 listened on `127.0.0.1:8787`; installed PID 91404 listened on `*:8787`. | Both listeners were reported simultaneously. Do not simplify this to a proven ordinary bind failure. |
| Recovery step 1 | Sent `SIGTERM` to the revalidated, user-authorized PID 19621. Subsequent `ps` showed it absent; only PID 91404 listened on 8787. | Conflicting test process stopped. No directory was deleted. |
| 19:42:06 | Startup attempt 36 now identified PID 91404 itself as the conflict. | Automatic recovery still failed. A stale ownership or self-conflict path is suspected; exact internal cause was not traced. |
| Recovery step 2 | Ran `ade brain restart`; CLI returned `ok: true` for service stop and start. | A service-managed restart was needed in this incident. |
| 19:42:31 onward | Installed brain PID 43674 owned 8787; sync discovery published; iPhone authenticated; listener, Tailscale and relay health passed. | Connectivity and host readiness recovered. Full replica completion was not established by this check. |
| User confirmation | “ok seems to work again.” | User confirmed practical recovery from the phone. |

### Original message

```text
Work hydration failed
This machine's project sync host is not running yet. It usually restarts within a few seconds — retry shortly, or reopen the project.
```

### Log excerpts

Verbatim complete record from the machine log:

```json
{"ts":"2026-09-08T19:42:06.986Z","level":"warn","event":"sync.host_start_failed","meta":{"signature":"SyncHostSingletonConflictError","attempt":36,"code":null,"errno":null,"provider":null,"message":"ADE brain sync host still failing (35 occurrences): ADE brain sync host failed: Another ADE brain is already hosting mobile sync on port 8787.\nRunning instance: ADE (pid 91404).\nQuit that brain before starting this ADE brain:\n  launchctl bootout gui/$(id -u)/com.ade.runtime 2>/dev/null || true; /bin/kill 91404 2>/dev/null || true"}}
```

The shell instructions inside that historical message are evidence, **not a recommended recovery procedure**. We used `ade brain restart` for the installed service and explicitly verified the test process before stopping it.

Selected fields, copied from real records:

```json
{"ts":"2026-09-08T19:40:19.070Z","event":"sync_brain.command_without_project_host","action":"work.listSessions"}
{"ts":"2026-09-08T19:40:19.388Z","event":"sync_brain.command_without_project_host","action":"prs.getGitHubSnapshot"}
{"ts":"2026-09-08T19:40:19.400Z","event":"sync_brain.command_without_project_host","action":"chat.listSessions"}
{"ts":"2026-09-08T19:42:31.548Z","event":"sync_host.tailnet_discovery_published","service":"svc:ade-sync","servicePort":8787,"target":"tcp://127.0.0.1:8787"}
{"ts":"2026-09-08T19:42:32.659Z","event":"sync_host.mobile_replica_reseed_skipped","targetDbVersion":60020253,"scanFromDbVersion":368628,"reason":"compacted_state_too_large","maxRows":10000,"maxBytes":4194304}
```

Post-restart `ade brain status --json` reported:

- `ok: true`, `starting: false`, PID 43674, `lastFailure: null`.
- iPhone, iOS app 1.1.10 build 70, `isAuthenticated: true`, connected at `19:42:31.435Z`.
- Listener: `listenerBound: true`, `loopbackAdeValidated: true`, port 8787.
- Tailscale: `tailscalePublished: true`, `tailscaleReachable: true`.
- Relay: `relayControlConnected: true`, `relayBridgeValidated: true`, end-to-end verified at `19:42:33.832Z` (262 ms).

### Other observed signals: do not conflate with the primary cause

- Replica reseed fell back because compacted state exceeded configured limits. The immediate status still showed `dbVersion: 0` and significant sync lag. This is evidence that transport recovery and full data readiness differ, not proof that reseeding caused the outage.
- A different device identity was repeatedly rejected as `unknown_device` over loopback. It was not the authenticated iPhone identity; its origin was not established. Do not reset the user's pairing based on this signal.
- A saved viewer connection to a LAN host on port 8790 failed with `ECONNREFUSED`, then `sync.role.viewer_stale_draft_reclaimed` appeared. Its causal relationship to the main incident remains unproven.
- The test process's cwd identifies a lane, but does not establish which session launched it. Avoid attributing responsibility without launch evidence.

## Source map and current behavior

Paths are relative to the implementation lane; line numbers refer to the baseline above and may move.

| Source | Relevant behavior |
| --- | --- |
| `apps/ade-cli/src/services/sync/brainProjectActionsSyncHandler.ts`, around 920–978 | Brain-level ingress handles commands without a project host and returns error code `host_unavailable` with the exact user-visible message. A working ingress is not a working project host. Personal-chat commands have a separate supported path here. |
| `apps/ade-cli/src/services/sync/syncHostSingleton.ts` | Conflict detection and owner representation; inspect lock, listener and self-ownership handling. |
| `apps/ade-cli/src/services/sync/syncHostStartupLoop.ts` and its test file | Retry loop and `sync.host_start_failed` reporting. |
| `apps/ade-cli/src/services/sync/syncService.ts` | Host lifecycle, ownership, role transitions and startup failures. |
| `apps/ios/ADE/Models/RemoteModels.swift`, around 356–404 | `SyncDomainStatus`, phases and `inlineHydrationFailureNotice`. All four domains use technical “hydration failed” titles and may expose raw `lastError` text. |
| `apps/ios/ADE/Views/Work/WorkRootScreen.swift`, around 537–554 | Shows `ADENoticeCard` with Retry above filters/content when domain failed and `isHostUnreachable` is false. Existing comment deliberately suppresses banners for unreachable hosts, but a reachable brain without a project host bypasses that distinction. |
| `apps/ios/ADE/Views/LanesTabView.swift`, `Views/Files/FilesRootScreen.swift`, `Views/PRs/PrsRootScreen.swift` | Equivalent inline failure notices exist in Lanes, Files and PRs. |
| `apps/ios/ADETests/ADETests.swift`, around 27216–27300 and 28094–28107 | Existing host-unavailable and domain-notice coverage, including an assertion for “Work hydration failed”; review intent before updating expectations. |

This is a verified starting map, not a complete audit of mobile errors, alerts or navigation state. Trace machine selection, connection state, domain loading and retry cancellation before implementation.

## Agreed direction and proposed design

The user wants understandable errors across mobile, with machine-wide failures surfaced when entering the machine rather than buried above chats. Runtime controls should be contextual to conflicts only. The following matrix and copy are proposed implementation guidance from the discussion, not finalized visual designs.

| Failure scope | Proposed presentation | Recovery |
| --- | --- | --- |
| Initial machine reachability, authentication or project-service failure blocks workspace use | Full-screen recovery within the selected machine | Relevant retry/reauthentication; always allow switching machine |
| Connection drops while working | Persistent reconnecting banner; retain loaded content and identify stale/disabled actions | Reconnect; escalate to actionable recovery when needed |
| One domain fails but others remain usable | Error state within that tab, preserving useful cached content | Retry that domain |
| One transcript, chat or PR fails | Error at the affected item | Retry that item |
| A mutation fails | Feedback attached to the attempted action | Explain outcome; avoid duplicate execution on retry |

“Hydration” should remain an implementation term. Prefer “Couldn't load your chats” for a Work-only load failure, “Can't reach this machine” for reachability, and specific service/conflict wording when the connection itself works. Do not indiscriminately label every failure “Can't connect.”

Proposed conflict screen:

```text
Another ADE runtime is blocking this machine

A development runtime is using the connection your phone needs.

[Resolve conflict]
Retry connection     Switch machine
```

Conflict details should distinguish “Installed ADE — the runtime you're connecting to” from “Development runtime — blocking mobile sync.” Show project/lane, start time and active-work impact when reliably known. Keep PIDs and socket paths in optional technical details. Do not require users to understand them or choose blindly between identical “ADE” labels.

The primary action can be “Stop conflicting runtime and reconnect.” Show explicit impact if stopping it will interrupt active work. Unknown ownership or unknown impact must not be presented as known-safe. No permanent runtime-management screen is requested.

## Recovery architecture to investigate

1. Separate transport connection, authentication, project-service readiness and domain data readiness. Do not call a machine usable just because its WebSocket connected. Do not wait for full historical replication before enabling every otherwise-working action.
2. Expose typed conflict diagnostics and narrowly scoped recovery through the reachable machine-level service, independent of the unavailable project host. Existing `host_unavailable` ingress is evidence of a possible control path, not proof that recovery APIs already exist.
3. Return structured conflict reason and verified owner identity; do not parse human log messages on the phone. Resolve target identity again on execution, guarding against PID reuse and ownership changes.
4. Enforce device authorization and runtime-management permissions server-side. Pairing alone must not silently imply arbitrary process-control authority. Never expose arbitrary PID termination or shell execution as the recovery contract.
5. Stop the identified conflicting runtime through its supported lifecycle where possible. Wait for process/lease release, retry desired-host startup, then restart the intended service only if necessary. This incident requires coverage of the self-conflict after the other owner exits.
6. Make recovery idempotent and observable across reconnects: return an operation identity/status, report progress and failure, prevent duplicate destructive actions, and verify a project request before declaring workspace recovery.
7. Preserve identity, pairing, project data and session state. Do not solve conflicts by deleting state or resetting pairing. Use existing cross-platform lifecycle abstractions, including Windows service/process semantics.

A phone cannot recover a completely offline machine through an unreachable service. That case needs honest offline guidance. If a restart disconnects the recovery transport, the client must reconnect and discover the result rather than treat the socket close as definitive failure.

## Implementation acceptance and handoff

Create an implementation lane from this branch. Start with a complete inventory of mobile inline cards, empty states, alerts/modals and connection screens; classify each by failure scope using the matrix. Keep this record as historical evidence; update the matching feature documentation in present tense when behavior ships.

Required proof for the eventual change:

- A reachable/authenticated brain with no project host shows machine-level recovery before a misleading usable workspace, and does not generate duplicate banners across tabs.
- Single-domain and single-item failures do not unnecessarily block healthy surfaces; cached data and stale-action behavior are explicit.
- Conflict UI appears only for a verified conflict; runtime choices are understandable and target identity/impact are accurate.
- An authorized phone can recover the exact observed sequence: other runtime owns sync, other runtime stops, desired runtime self-conflicts, desired runtime restarts, project calls succeed.
- Unauthorized clients cannot enumerate sensitive runtime details or stop/restart runtimes. PID reuse, ownership races, multiple taps and reconnects cannot target another process or repeat an unsafe action.
- Logs distinguish connection, authentication, project readiness, replica progress and recovery operation outcomes without secrets.
- Test local, remote/Tailscale and relay paths; review desktop, hosted web, CLI and TUI contracts and Windows parity where shared recovery services change. Provider adapters need an explicit impact decision if active-work detection depends on them.
- Capture before/after mobile images and a short recovery video in isolated development state. Never reproduce by claiming live port 8787 or writing to the user's production `.ade` state.
- Follow repository Xcode storage/process safeguards; use focused tests first and do not launch concurrent Xcode builds/tests.

Open engineering questions: why did the development runtime acquire production sync ownership; why did the installed host later conflict with itself; which identity/active-work metadata can be trusted; and how should machine readiness avoid blocking on unrelated replica backlog? These were not resolved during the incident and should not be asserted as fixed.

Authored from the Codex conversation and live diagnostic evidence. The implementation that answers this handoff landed on the same branch; the feature docs above carry the shipped behavior.
