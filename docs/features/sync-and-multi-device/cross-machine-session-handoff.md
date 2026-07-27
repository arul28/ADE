# Cross-machine session handoff

Cross-machine handoff lets a user stop work in one local ADE Work chat and continue the same task on another connected ADE machine. The source lane and chat remain intact; the destination receives a compatible lane (created or safely reused) and a deterministic handoff chat recreated from portable state.

This document defines the v1 product, transport, recovery, and security contract.

## Product flow

The action lives in the chat actions drawer under **Handoff** as **Send to machine**.

1. ADE checks the source chat and Git lane.
2. The user selects an eligible connected machine and may add a continuation note. The picker reports each machine's repository presence while it is open, resolved from the same `listProjects` call the prepare step consumes, so the hint costs no extra round trip.
3. In the same setup step the user sets the destination chat's model, reasoning effort, fast mode, and permission mode. These are the composer's own control pills — the shared `PermissionModePicker` and `ReasoningEffortPicker`, not lookalikes — and each hides itself when the chosen model cannot honor it. The capsule carries these fields and the destination applies them, so this picker is the only place they are decided; nothing is inherited from the local handoff drawer. In fork mode the model picker stays constrained to the source provider.
4. ADE finds the same repository in the destination project registry.
5. If the repository is missing, ADE shows the destination path, free-space result, route warning, and an explicit clone confirmation.
6. ADE checks destination provider/model access, the published branch commit, and any existing destination lane.
7. The user reviews the bounded-context and transport disclosures, then confirms.
8. ADE rechecks the source chat, clean worktree, upstream, remote branch, and exact commit, then pins the transfer to the route shown in the review.
9. The destination recreates or reuses the lane, starts the chat, and either dispatches the first continuation turn or completes a fork whose default continuation needs no new turn.
10. Only after the destination runtime acknowledges a requested turn, or the no-turn fork reaches its durable dispatched checkpoint, does ADE mark the source chat as handed off.

While the transfer is in flight the modal reports the real durable checkpoints it has passed rather than an indeterminate spinner.

The setup modal can be opened while a turn is active. It explains the block and offers to stop the current response. Pending approvals or questions must be resolved in the source chat.

Once destination acceptance has been dispatched, a requester timeout or
connection loss does not prove that destination work stopped. The modal reports
that ADE lost confirmation, that the destination chat may still appear, and
that the user should check the other machine before retrying. Preflight and
source-validation failures that happen before destination acceptance starts
remain ordinary hard failures.

## Source contract

V1 intentionally requires a clean, published Git branch:

- no tracked, staged, or untracked working-tree changes;
- no rebase in progress;
- a named branch with an upstream;
- local `HEAD`, the upstream ref, and `git ls-remote origin refs/heads/<branch>` must resolve to the same commit; and
- an origin remote must exist.

The renderer provides a **Publish branch** action when a normal push is sufficient, and an **Update branch** action when the branch is strictly behind. Diverged branches still block: ADE does not pick a reconciliation strategy for the user.

Every one of these source blockers must render. They are modeled as `BlockedActionReason` values from `apps/desktop/src/renderer/components/shared/BlockedAction.tsx` — a title, a detail, and the action that clears it — rendered by `BlockedReasons`, and the primary button is a `BlockedActionButton` that takes those reasons instead of a `disabled` flag, so a surface cannot disable the action without also surfacing why. This is a deliberate guard against a bug ADE keeps regrowing: a blocking-error list that only ever feeds a `disabled` prop turns "update the source branch" into three green checks above a dead control. If a surface computes a blocker, that blocker must reach the user; a disabled control may never be the only signal.

Dirty patches, stashes, Git bundles, untracked files, and worktree metadata are not transferred. Git bundles alone do not encode the working tree, index, stash, hooks, configuration, or ADE lane metadata, so treating them as a complete handoff would be misleading. A future dirty-state protocol must define those semantics separately.

## Portable capsule

Brief mode does not treat provider-native thread or session identifiers as portable. Those identifiers can depend on machine-local provider storage, CLI state, credentials, or an auth account. A brief handoff therefore creates a bounded ADE capsule containing:

- source machine label, chat identifier, provider/model label, and chat title;
- repository origin, branch, and exact commit;
- destination model and permission settings, excluding machine-local Cursor configuration values;
- a compact handoff brief (maximum 16,000 characters);
- bounded recent file-change, command, and error references;
- up to 12 referenced Linear issues; and
- an optional user continuation note (maximum 4,000 characters), or ADE's default continuation instruction.

The brief capsule excludes:

- provider-native thread/session IDs and full provider history;
- full ADE transcripts;
- secrets and secret stores;
- PTYs and terminal scrollback;
- caches, dependency directories, and runtime processes;
- uncommitted file contents; and
- local artifact bytes.

ADE redacts common secret-shaped values and replaces source-only absolute repository/home paths before hashing the capsule. It also removes Git/issue URL credentials, query strings, and fragments, and applies the same sanitizer to user-controlled titles and lane names. The destination verifies the capsule fingerprint and all size/type bounds before using it.

## Fork mode

Fork mode transports the provider-native session data needed to continue full history, plus ADE transcript envelopes so the destination UI can render the conversation before any optional continuation note. Native files and ADE envelopes are gzip-compressed and base64-encoded inside the fingerprinted capsule. The uncompressed limits are 18 MiB for the provider's main session file, 4 MiB total for Claude sidecars, and 3 MiB for ADE transcript envelopes. Encoded payloads also have independent base64 bounds so validation can reject oversized input before decoding.

Beyond the per-part limits, the whole fork capsule's base64 payload is held under a single ~20 MiB transport budget so it fits inside the sync envelope and WebSocket payload caps (both 25 MiB). When the main history plus transcript already fit but the Claude sidecars would push the total over budget, the sidecar group is dropped and the main conversation still travels. When the main history plus transcript alone exceed the budget, ADE returns the same "too large" failure the 18 MiB main-file cap produces, so the source can offer a brief instead.

Provider handling is explicit:

- **Claude:** ADE sends the session JSONL and, when they fit, its sibling `subagents/` and `tool-results/` sidecars. The destination assigns a new UUID and rewrites JSONL `sessionId` and `cwd` fields in both the main transcript and JSONL sidecars before wiring the Claude resume pointer.
- **Codex:** ADE sends the discovered rollout JSONL. The destination installs it under its own `CODEX_HOME/sessions/YYYY/MM/DD/` store, then calls app-server `thread/fork` with `excludeTurns: true` and persists the returned thread as the chat resume target. `.jsonl.zst` rollouts are not relocated in this phase and fall back to brief mode.
- **OpenCode:** the source runs `opencode export <session> --sanitize`. The destination runs `opencode import`, then calls native `session.fork` on the imported session and persists the forked session ID.

ADE transcript envelopes keep their existing provenance and gain `providerOrigin: "handoff_fork"` plus the source ADE session ID. If the transcript exceeds 3 MiB, ADE drops the oldest envelopes and keeps the newest JSONL tail in order. Provider-native blobs are not secret-redacted because full provider history is the feature being requested; the review UI discloses that scope before transport.

If the 18 MiB main-history limit is exceeded, ADE returns a typed “too large” failure so the source can offer a brief handoff instead. Claude sidecars that exceed their separate 4 MiB allowance are omitted as a group while the main conversation still travels.

Cross-machine fork requires the same provider and a usable destination runtime or CLI. Claude, Codex, and OpenCode support it. Cursor is brief-only because it has no native fork surface. Droid is also brief-only across machines: local Droid fork remains supported, but its machine-local session index and relocated-file resume behavior are not yet proven portable.

That distinction is encoded as `providerSupportsCrossMachineHandoffFork`, separate from the local-fork `providerSupportsHandoffFork`. Its backing list, `CROSS_MACHINE_HANDOFF_FORK_PROVIDERS`, is derived from the local `HANDOFF_FORK_PROVIDERS` by filtering Droid out rather than being restated, so adding a provider to one list cannot silently leave the other behind. The UI must gate its fork affordance on the cross-machine helper; gating on the local one leaves Droid's fork option selectable and guaranteed to throw at confirm time. The destination applies the same helper when it computes `forkHandoffSupport`, so a refused provider is named with a plain reason instead of failing late.

## Destination contract

Eligible machines must be connected, support multi-project RPC, and advertise the handoff storage-preflight capability. Fork destinations additionally advertise provider-specific fork support; an older destination that omits that field is never allowed to silently downgrade a fork into a brief. Older runtimes remain connected for compatible features but are excluded from the picker with an update message.

Repository matching uses a normalized Git origin identity, so SSH and HTTPS forms of the same remote compare consistently. If no registered project matches:

- automatic setup is offered only for GitHub repositories;
- the destination reports the target path, write access, target collision, free bytes, and required bytes;
- the destination runs `git ls-remote` against the published branch with destination-local Git credentials and blocks before clone when access fails;
- reported free space below the 1 GiB minimum blocks setup, while an unavailable disk-space reading is shown as a warning; and
- clone requires explicit confirmation.

The clone service owns partial-directory rollback. If cloning and project registration succeed but the response is lost during a disconnect, the setup re-lists destination projects and resumes from the matching origin instead of cloning again.

Once the project exists, the destination:

- verifies its origin matches the capsule;
- verifies provider authentication and selected-model availability;
- verifies the remote branch still points at the source commit;
- fetches that exact branch;
- reuses an existing lane only when it is clean, not rebasing, and at the exact commit;
- reports `laneFastForward` when that lane is instead clean and a *strict ancestor* of the source commit, so the source can offer **Fetch & fast-forward there** rather than dead-ending. The destination re-validates independently and only ever runs `git merge --ff-only`; it never resets and never touches a dirty or diverged lane. This is what makes handing off a shared branch such as `main` workable, since two machines' `main` are rarely at the same commit;
- blocks when a different local branch with the same name exists; or
- imports a new lane from the fetched remote branch.

The fast-forward offer is a separate destination call — the `chat` action-domain
action `fastForwardCrossMachineHandoffLane` (`{ laneId, expectedHead }`), also
registered as the sync remote command `chat.fastForwardCrossMachineHandoffLane`
— run before the handoff itself, with the source's preflight refreshed
afterwards. `laneFastForward` is reported as a warning so the offer can render,
but an unresolved one still gates Send: acceptance requires the destination lane
to be at the exact source commit, so sending first would fail hard after
destination work had already begun.

Nothing in the offer is trusted at execution time: the destination
re-fetches the branch, re-checks that `origin/<branch>` still points at the
expected commit, re-reads lane status for rebase and uncommitted changes,
re-verifies strict ancestry, and refuses a lane already at the expected commit.
The source-side decoder correspondingly rejects a `behindBy` that is not a
positive integer, so a zero-distance offer the destination would refuse can
never render.

## Idempotency and recovery

The destination owns the transaction record because it is the authority on what was created. Records are keyed by `handoffId` and bind that identifier to the capsule SHA-256 fingerprint.

The transaction states are:

`preparing` → `lane_ready` → `chat_ready` → `dispatched` → `complete`

`failed` retains any known lane/chat identifiers so retry can reconcile instead of restarting blindly.

The chat session ID is deterministically derived from the handoff replay key. A retry therefore returns the same compatible chat. Lane import is reconciled by branch and exact commit. Destination acceptance is serialized by handoff ID, and the durable `dispatched` state is written only after the provider backend acknowledges the prompt; an optimistic user-message event is never treated as acknowledgement.

Fork re-materialization is guarded by the same durable state. Installing the provider-native session files, calling the provider fork (`thread/fork`, `session.fork`, or the Claude resume rewrite), and seeding the ADE transcript envelopes run only when the record is not already `dispatched` or `complete`. A retry that finds the record past that point re-marks `dispatched` without importing again, so a resumed or reconnected fork never creates a duplicate forked thread or session. A fork whose continuation note is ADE's default sends no first turn — materializing the history and transcript is the continuation — and reaches `dispatched` directly; only a non-default note is dispatched as an acknowledged first user turn.

This covers process restarts and mid-transfer disconnects at each boundary:

- after lane creation, retry finds and validates the lane;
- after chat creation, retry resolves the deterministic chat;
- after first-turn dispatch, retry sees the durable dispatch acknowledgement; and
- after destination completion but before source marking, the UI reports success with a retryable source-marker warning.

Partial destination resources are never anonymous: they remain associated with the durable handoff record until the transaction completes or is retried.

The destination acceptance call is not cancellable through the paired runtime
transport. A request-local timeout or interrupted connection therefore leaves
the caller with an unknown outcome rather than a truthful cancellation. ADE
does not convert that state into a hard failure: the source UI uses the
still-completing notice above, and a user retry reconciles through the durable
handoff record instead of creating a second lane or chat.

## Transport and security

The handoff uses the existing authenticated remote runtime connection selected by ADE:

- SSH and Tailscale routes are shown as encrypted;
- direct LAN paired WebSocket and ADE relay routes are shown as authenticated but not end-to-end encrypted by ADE; and
- LAN/relay routes require an additional explicit confirmation before the capsule is sent.

The renderer follows live connection snapshots while setup is open. Final acceptance is bound to the exact reviewed route kind, and this sensitive action is not automatically replayed after a disconnect. A route change—especially an encrypted-to-LAN/relay downgrade—returns the user to review instead of sending silently.

For a paired desktop destination, the action is multi-project runtime JSON-RPC
carried through the sync WebSocket's `rpc_data` channel. The sync host forwards
those channel frames; its remote-command responder timeout does not wrap the
full `chat.acceptCrossMachineHandoff` execution. SSH destinations use the same
runtime RPC contract over `ade rpc --stdio`. In both cases the desktop applies
the request-local handoff timeout and preserves the unknown-outcome contract
when confirmation is lost.

The UI names what is included and excluded before final confirmation. Handoff clone authentication is always resolved on the destination: the main process strips renderer-supplied auth headers and disables ADE's normal one-shot source-token forwarding for this path. ADE does not put GitHub tokens in the capsule or the machine RPC. Artifact references are contextual text only and do not grant cross-machine file access.

## Source state after success

The source lane and chat are preserved. ADE emits a durable system notice containing the handoff ID and destination machine/lane/chat identifiers. The notice states that work stopped on the source after the destination chat started. The source is not deleted or silently archived.

## Required coverage

Tests should cover:

- existing destination project;
- missing project, storage preflight, clone confirmation, and partial-clone cleanup;
- dirty source state and unpublished/diverged branches;
- active source turn and pending approval;
- exact branch/commit mismatch;
- existing clean destination lane and conflicting local branch;
- destination provider/model auth failure;
- a behind source branch rendering its reason and its pull action, and a diverged branch rendering a blocker with no one-click fix;
- Droid cross-machine fork refused up front while local Droid fork still works;
- destination lane clean-and-behind offering a fast-forward, and dirty/diverged/non-ancestor lanes refusing one;
- incompatible destination runtime;
- timeout or disconnect after destination acceptance starts, including an
  unsuccessful reconnect, with unknown-outcome copy and no automatic replay;
  and
- capsule tampering, embedded remote credentials, size limits, and secret redaction.
