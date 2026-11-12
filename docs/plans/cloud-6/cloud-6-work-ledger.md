# Cloud 6: the fix work, grouped (from the beta.14 test, 2026-11-11/12)

Source of every item: `docs/plans/cloud-beta12-test-ledger.md` (B14-n = beta.14 section; plain numbers = beta.12 section). Causes are recorded there with code paths and evidence. This file is the work list for the next lane and the split.

## FINAL SPLIT (owner + project lifecycle lane, 2026-11-12). Replaces the proposal below where they differ.

Two lanes do all the work: **C** (this, Cloud) and **L** (project lifecycle). Plan of record: `~/.claude/plans/account-owned-projects/plan-final.md` ("The split").

Method for both lanes: stacked PRs; parallel agents where files do not overlap; the dev loop on each PR; NO merge until the lane's whole stack is complete; then the owner runs the deep review (`/code-review ultra <PR>`, maybe more than once). C merges its stack first; L then moves its stack onto main.

Lane C scope:
- C1. G1-G5 below (the beta.14 fixes).
- C2. **Contract (bottom of the stack): connect to any machine of the account by machine key.** Input: the machine key only. Must not read or change a tab's or window's machine, must not add a default route. The caller gets an address for one machine and passes it with each call (CLAUDE.md remote rule). Report the file and exported names to the owner as soon as they exist, so L codes against them.
- C3. **Contract (bottom of the stack): a lane follows its computer** (same lane id and chat id, new machine key) after a move or a new computer. Same reporting.
- C4. One function "does this account have a credential git can use" checked before a computer is made (passes unchanged once L makes gh follow the account); no token left in `.git/config`.
- C5. Provider sign-ins sync down + one card per account. NO GitHub credential in it (gh for Copilot included: L changes how that is carried).
- C6. Server launcher for callers with no computer (web, phone, automations): make, sign in with no browser page, clone, hand off; first message, model, settings and files stored on the server; the computer reads its launch facts at start. A user with a computer still launches from it as today.
- C7. Cloud routes usable directly from browser and phone (list, start, wake, size, delete).
- C8. Start a provider sign-in on a cloud computer from phone or web; rule for providers that can't move; renewal owner when no owner computer exists.
- C9. Automations "Runs on: ADE Cloud" (server watches triggers; edge cases in the test ledger).
- C10. A route that deletes the cloud computers of one project (work pushed first); L's Delete project window calls it.
- Still with the CLI-sessions lane: CLI sessions on ADE Cloud use one launch flow; C replaces the cloud refusal with that lane's start step when it exists.

Constraints from L:
- Keep edits small, and tell L, in: `apps/desktop/src/preload/preload.ts`, `renderer/state/appStore.ts`, `main/main.ts` (window session), `ipc/registerIpc.ts`, `ipc/runtimeBridge.ts`, `renderer/components/app/TopBar.tsx`, the Add project components, `apps/ade-cli/src/services/projects/projectRegistry.ts`, `shared/accountSettingsScope.ts`, `shared/deeplinks.ts`, the web client adapters, the iPhone Hub.
- Every new preload method takes a machine address; none defaults to the tab's machine.
- Account-directory migrations: main is at 0027; L adds an account projects table; whichever lane merges second takes the next free number.
- The log sampling rate in the `wrangler.jsonc` of push-relay, account-directory and tunnel-relay is L's.
- Few new keys in account_settings (5,000-key limit).
- Later, not now: sharing a cloud lane (notes in plan-final.md).

## How to build it (proposed)

- One lane, one agent that runs groups in parallel where they touch different code, and opens a PR per group.
- Groups that depend on each other are STACKED (`/ship --stack-ready` for each layer, the lane merges the stack bottom-up). Groups that don't are separate PRs off main, so one slow review doesn't hold the rest.
- Order: foundations first (G1, G2), then features on top (G3, G4), the big UI redesign last (G5), because it touches the most files.
- Machine-agnostic rule (owner): nothing in these groups may assume Linux or Agent 37; a new OS or provider is data, not a new code path.

## G1. Cloud computer lifecycle (blockers). Base of the stack.

- B14-11/12: join race. Wait for Agent 37 health and network before the sign-in; retry the device start; show the computer's own reason on the card.
- B14-19: agent programs. Ship ADE's pinned agents inside the image (Agent 37: "bake binaries into /usr/local/bin"); never download for a status or model-list read; download only what a turn needs; never on the person's disk. Caches on the system layer with a ~7 GB budget, oldest out first, restored by `post-image-update.sh` if needed.
- B14-20 + B14-27: disk guard for cloud. Thresholds that follow the cloud disk; grow BEFORE the guard can block; when a grow is refused, a card in the thread with the reason and the way out, readable by agents (`ade cloud status`).
- B14-25: wake before resize, restart and restore (Agent 37 refuses them asleep); keep Agent 37's own error text everywhere (`provider.ts` `invalid_request` mapping).
- B14-16: hold a turn until its agent is ready; keep the agent's stderr in Details.
- Agent 37 docs: treat "running" as not ready until health says so; expect a fresh boot after any wake; ADE's own polling and exec must not keep a computer awake.

## G2. Connections and moves. Stacked on G1. OVERLAPS the multi-machine lane.

- B14-31: any of the person's computers connects to any of their cloud computers on demand (as the background ADE already does); never "Deleted computer" for a computer that exists.
- B14-35: after a move or any computer change, connect the person's desktops to the new computer and re-point the lane and its chat, Android panel and tools; show the progress and the result (see G4, B14-24).
- B14-32: lanes from computers that really are gone: one clear "deleted computer" place, not mixed with live lanes.
- Their item 56: a cloud lane keeps one chat id and one lane id when its computer changes.

## G3. Sign-ins and GitHub on ADE Cloud. Separate PR off main (touches sign-in code, not G1/G2 files), except the GitHub preflight which sits on G1.

- B14-4: pasted codes are written with Enter in the same write and never submitted (`shared/cliLoginPty.ts` `writeLoginCode`). Affects every pasted-code sign-in (Claude pass AND Claude's normal sign-in, `agentCliLoginRunner.ts`, `providerLoginRunner.ts`). Read Claude's "OAuth error" line and show Try again.
- B14-15: the pre-send sign-in card for ADE Cloud (asks the account's ADE Cloud sign-ins and Claude passes for the picked model), Send held until done; same for every cloud target.
- B14-5: one card per account (email), "from N computers", freshest copy with fallback (fallback already exists in `cloudPlacePicks`).
- B14-9: sign-ins sync DOWN to the person's computers (all but Claude, which stays separate by design).
- B14-10: check for a git-capable GitHub credential before making a computer; never leave the token in the clone's `.git/config`. (Making gh and App sign-ins follow the account is the multi-machine lane's item 25 / D3.)
- "From arul" label: show the machine's display name.

## G4. Chat, launch and progress UX. Separate PR off main.

- B14-26: one clean state per turn (what, why, one action), in time order, no duplicates; same rule for every cloud warning and error.
- B14-13 + B14-34 + beta.12 #10: the pick (ADE Cloud, size, model, effort, permissions) is saved and shown right during setup, after a failure, and on every computer.
- B14-33: one name per lane everywhere (lane name; chat title only inside the lane).
- B14-24: size change and move progress as a small panel bottom right (like a CLI new-lane launch), the lane row updates in place, a card in the chat, failure with reason and an X. Fix the stuck failed state on the ADE Cloud page.
- B14-18 (real total time), B14-17 (no "refresh and try again" banner with Report for an expected download), B14-29 (size change keeps the disk: say so, offer to grow), B14-30 (delete feedback), B14-37 (Tools grid copy; Linux screen on cloud).
- B14-38: say before a move that Android needs about 7.2 GB free and what plan or cleanup gives it.
- beta.12 #13 + B14-15 follow-up: Cursor and Devin Cloud pickable from any computer with the shared sign-in.

## G5. ADE Cloud dashboard, menus and checkout (design). Last; separate PR off main.

- Sidebar position second under General (B14-7); invite card at the bottom right, highlight on jump (B14-1/2).
- Size cards: specs, disk, full desktop on every size, "N h of agent time", one shared line on awake time (B14-8); sizes and labels consistent (B14-3, B14-36).
- Change size dialog uses the same cards (B14-23); row actions not as tiny buttons (B14-22); cloud icon in each cloud chat header to manage its computer (B14-21).
- Disk breakdown with true labels (B14-28).
- Run on menu, size menu, ADE Cloud chip (B14-14, beta.12 #9/#11/#12).
- Checkout page (beta.12 #8): code changes only; Stripe account changes need the owner's OK.

## Not in this lane (next scope, already agreed in the ledger)

- One launch flow for chats and CLI sessions on ADE Cloud, every provider (with the CLI-sessions lane).
- Automations with "Runs on: ADE Cloud" (server watches triggers).
- The server launcher for callers with no desktop (multi-machine lane D6 / item 50).
- Windows (Daytona first) and macOS (NoMac) offers.

## Owner rules for the lane

- Tests: only for critical contracts, per CLAUDE.md. Proof on the real app for every UI change.
- The test computer "Test" (lz6d27viiq, full computer, asleep) may be reused to prove fixes; owner's OK per destructive step.
- Merges to account-directory or the relay are production deploys: say so before each.
