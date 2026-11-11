# /quality synthesis: decisions by the lead (2026-11-11)

Every finding in qa-server.md, qa-main.md, qa-ui.md, qb-core.md, qb-ui.md that is not listed below as SKIP is ACCEPTED: fix it in this run, at any severity. "J" (needs judgment) items are decided here.

## Decisions on judgment items
- qa-server B1: do all three steps (server allowlist: only `clean`/`pushed` count as safe; CLI: an unreadable lane status reports `failed`, and a lane whose branch is its base (the primary lane) counts commits not on any remote; server: refuse to free a computer whose tally has a primary lane unless it reports `pushed`).
- qa-server M2: store the warned instance ids (new column in 0027, unreleased) and free only warned ones; a newly picked computer gets its own warning and a new 3-day due date.
- qa-server M3: set `due_at` only after the email was `sent`; `failed` gives back and retries next run; `skipped` proceeds only outside production (in production `skipped` = treat like failed and report to Sentry once).
- qa-server L1: keep the computer when prepare-stop did not confirm (use its exit code / JSON).
- qa-server L9: refuse mutual referrals (reason `mutual`, add to the refusal reasons + sentence). On account deletion, re-key the kept rows (referrals, earned hours, free-plan claims) to `deleted:<sha256(userId)>` instead of the raw Clerk id; keep the claim.
- qa-server deploy note: `runPlanCleanups` runs only for accounts ADE Cloud lets in (`cloudAccessAllows`).
- qa-main H1: `invite_redeem` becomes user-only (ADE_ACTION_USER_ONLY.cloud). `ade cloud invite redeem` is removed; `ade cloud invite` says "Enter an invite in Settings › Account". Fix the help line, the action contract text and the comment.
- qa-main M1: stamp EVERY ADE Cloud approval card as user-only consent (provider metadata key + `isUserOnlyConsentCard`).
- qa-main L4: don't send the computer-id header on `/cloud/access`.
- qa-main L5: no change (by design); the PostHog insight "free plan unclaimed use" watches it.
- qa-main L6: no code change; note it in the release notes (owner's account only).
- qb-core M9 web: keep apps/web's copies (no cross-package import), add a comment naming the contract constants they mirror. stripe-setup.mjs: add a check in scripts/verify-deployment-config.mjs (or the script itself) that fails when its plan numbers differ from plans.ts CLOUD_PLANS.
- qb-core M10: export CLOUD_LANE_MACHINE from shared/cloudLaneLaunch.ts; the MCP policy stays exact-match on purpose (comment).
- qb-core L4: keep the analytics allowlists literal (the policy wants a deliberate review gate), but make the refusal reasons a const array in the contract.
- qb-core L5: keep `diskShared` as a documented constant.
- qb-core L8: no renames (public ids); record the names in the ADE Cloud README.
- qb-core L9: delete the ade-cli README lines; keep cloudKeepAwake/template hook with a comment "remove after <date>" (2026-12-31).
- qb-core M4 email: build the "done" email body from planCleanupDoneSentence(done) plus the per-computer list.
- qb-ui hero: keep the night sky (the owner's pick); record the exception in docs/design/visual-language.md.
- qb-ui B-M10: build lib/nudgePill.ts (shared schedule), storage per pill.
- qb-ui B-M11: rename `setAdeCloudMode` -> `setAdeCloudPicked` only; the single-state refactor is SKIP (wide, crosses useCursorCloudDraftState).
- qa-ui #5: drop "Change your plan in the ADE desktop app." from the iPhone plans card.
- qa-ui #9: the header ring, its title and the dashboard forecast count plan + earned hours left (one helper `cloudHoursLeftMilli` in shared/adeCloud.ts); the hero keeps the plan's own "of N h" line and the earned line.
