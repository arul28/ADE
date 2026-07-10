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
8. The destination recreates or reuses the lane, starts the chat, and dispatches the first continuation turn.
9. Only after the destination runtime acknowledges that turn does ADE mark the source chat as handed off.

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

ADE does not treat provider-native thread or session identifiers as portable. Those identifiers can depend on machine-local provider storage, CLI state, credentials, or an auth account. Cross-machine handoff therefore creates a bounded ADE capsule containing:

- source machine label, chat identifier, provider/model label, and chat title;
- repository origin, branch, and exact commit;
- destination model and permission settings, excluding machine-local Cursor configuration values;
- a compact handoff brief (maximum 16,000 characters);
- bounded recent file-change, command, and error references;
- up to 12 referenced Linear issues; and
- an optional user continuation note (maximum 4,000 characters), or ADE's default continuation instruction.

The capsule excludes:

- provider-native thread/session IDs and full provider history;
- full ADE transcripts;
- secrets and secret stores;
- PTYs and terminal scrollback;
- caches, dependency directories, and runtime processes;
- uncommitted file contents; and
- local artifact bytes.

ADE redacts common secret-shaped values and replaces source-only absolute repository/home paths before hashing the capsule. It also removes Git/issue URL credentials, query strings, and fragments, and applies the same sanitizer to user-controlled titles and lane names. The destination verifies the capsule fingerprint and all size/type bounds before using it.

## Destination contract

Eligible machines must be connected, support multi-project RPC, and advertise the handoff storage-preflight capability. Older runtimes remain connected for compatible features but are excluded from the picker with an update message.

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
