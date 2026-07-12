# Cross-machine session handoff

Cross-machine handoff lets a user stop work in one local ADE Work chat and continue the same task on another connected ADE machine. The source lane and chat remain intact; the destination receives a compatible lane (created or safely reused) and a deterministic handoff chat recreated from portable state.

This document defines the v1 product, transport, recovery, and security contract.

## Product flow

The action lives in the chat actions drawer under **Handoff** as **Send to machine**.

1. ADE checks the source chat and Git lane.
2. The user selects an eligible connected machine and may add a continuation note.
3. ADE finds the same repository in the destination project registry.
4. If the repository is missing, ADE shows the destination path, free-space result, route warning, and an explicit clone confirmation.
5. ADE checks destination provider/model access, the published branch commit, and any existing destination lane.
6. The user reviews the bounded-context and transport disclosures, then confirms.
7. ADE rechecks the source chat, clean worktree, upstream, remote branch, and exact commit, then pins the transfer to the route shown in the review.
8. The destination recreates or reuses the lane, starts the chat, and either dispatches the first continuation turn or completes a fork whose default continuation needs no new turn.
9. Only after the destination runtime acknowledges a requested turn, or the no-turn fork reaches its durable dispatched checkpoint, does ADE mark the source chat as handed off.

The setup modal can be opened while a turn is active. It explains the block and offers to stop the current response. Pending approvals or questions must be resolved in the source chat.

## Source contract

V1 intentionally requires a clean, published Git branch:

- no tracked, staged, or untracked working-tree changes;
- no rebase in progress;
- a named branch with an upstream;
- local `HEAD`, the upstream ref, and `git ls-remote origin refs/heads/<branch>` must resolve to the same commit; and
- an origin remote must exist.

The renderer provides a **Publish branch** action when a normal push is sufficient. Behind or diverged branches block the handoff instead of choosing a reconciliation strategy for the user.

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
- blocks when a different local branch with the same name exists; or
- imports a new lane from the fetched remote branch.

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

## Transport and security

The handoff uses the existing authenticated remote runtime connection selected by ADE:

- SSH and Tailscale routes are shown as encrypted;
- direct LAN paired WebSocket and ADE relay routes are shown as authenticated but not end-to-end encrypted by ADE; and
- LAN/relay routes require an additional explicit confirmation before the capsule is sent.

The renderer follows live connection snapshots while setup is open. Final acceptance is bound to the exact reviewed route kind, and this sensitive action is not automatically replayed after a disconnect. A route change—especially an encrypted-to-LAN/relay downgrade—returns the user to review instead of sending silently.

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
- incompatible destination runtime;
- disconnect after lane, chat, or first-turn creation; and
- capsule tampering, embedded remote credentials, size limits, and secret redaction.
