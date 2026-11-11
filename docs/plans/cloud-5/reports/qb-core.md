# Quality Track B2: server, main, preload, shared, CLI, web (maintainability)

Branch `ade/cloud-5-dashboard-and-fixes` (PR #2177). Base `202dc0676`. The
standard is `.claude/skills/quality/references/thermo-nuclear-review.md`.
Scope: `apps/account-directory/**`, `apps/web/**`,
`apps/desktop/src/{main,preload,shared}/**` and `apps/ade-cli/**`, including the
uncommitted `syncRemoteCommandService.ts` change. This is a review only: no
files were edited.

The labels mean:
- **BP**: the fix is behavior-preserving, so synthesis can apply it directly.
- **J**: the fix needs human judgment, for the reason given.

## Summary

The new server features (free plan per computer, referrals, plan cleanup and
timed-wake notices) are correct in shape. Their wiring has three problems:

1. **`store.ts` crossed 1,000 lines and now imports the features built on top
   of it.** That creates import cycles: store and freePlan, store and
   referrals, store and planCleanup, and referrals and routes.
2. **Several rules are written twice.** Each pair is a TS rule beside its own
   SQL copy, or a server sentence beside its own client copy.
3. **The invite code has two parallel paths in desktop main.** An IPC handler
   and a cloud action do the same work, and one of the IPC channels has no
   caller.

The ready-machine removal is clean in code. The leftovers are one stale README
block and one compatibility check.

---

## High

### H1. `store.ts` is over the size rule and depends on the features above it (standards 2 and 5)
- **Where:**
  - `apps/account-directory/src/cloud/store.ts:25-28` imports `accountNotices`, `planCleanup`, `freePlan` and `referrals`.
  - `store.ts:997-1076` is `buildAccountState`.
- **The problem:** The file grew from 948 to 1,076 lines. Each feature module
  imports `store` back, so there are now four cycles:
  - store ↔ freePlan
  - store ↔ referrals
  - store ↔ planCleanup
  - billing → planCleanup → store → planCleanup

  Only function hoisting keeps the cycles working. That is an implicit
  ordering dependency.
- **Judo move:** Move `buildAccountState` and its private helpers
  (`recentlyDeletedInstanceIds`, `recentUsedMilli` if no other caller uses
  it) into a new `cloud/accountState.ts`. That file becomes the coordinator
  that imports store, freePlan, referrals, planCleanup and accountNotices.
  `routes.ts` imports `buildAccountState` from there.
- **Result:** store.ts drops back under 1,000 lines (about 990). With M1 it
  drops further. All four cycles are gone. **BP.**

### H2. `referrals.ts` imports `routes.ts`, which imports `referrals.ts` (standards 5 and 7)
- **Where:** `apps/account-directory/src/cloud/referrals.ts:17` imports `cloudAccessAllows` from `./routes`.
- **The problem:** `cloudAccessAllows` is an access rule. The router is only
  one of its callers.
- **Judo move:** Move `cloudAccessAllows` (routes.ts:207) into its own small
  `cloud/access.ts` (or into `http.ts`). routes.ts and referrals.ts both
  import it from there. **BP.**

### H3. `settleFreePlanComputer` returns an account that no caller reads, and keeps TS copies of its SQL only for that return (standard 1)
- **Where:**
  - The only caller is `routes.ts:1093`, which discards the result.
  - `freePlan.ts:137-167`: `refuse()` and `restore()` each run an `update`, then build the "account after" in TS. Line 154 is `included_milli: accountRules(account) === "free" ? 0 : …` and line 167 is the restore version.
  - `settle()` threads that return through every branch.
- **The problem:** The TS copies repeat the `FREE_RULES_SQL` case
  expressions, and nothing reads them.
- **Judo move:** Make `settleFreePlanComputer`, `settle`, `refuse` and
  `restore` return `Promise<void>`. Delete the object rebuilds and the
  `account.free_refused_at != null ? await restore(...) : account` returns.
  `settle` then reads as a list of guards. **BP.**

### H4. The invite-code redeem is implemented twice in desktop main, and `cloudGetReferral` has no caller (standards 1 and 4)
- **Where:**
  - `registerCloudIpc.ts:393-418` covers `IPC.cloudGetReferral` and `IPC.cloudRedeemInvite`.
  - `cloudAgentActions.ts:931-956` covers the `referral` and `invite_redeem` actions.
  - `cloudMachines.ts:583-593`.
- **Duplication:** Both redeem paths hold the same block: call the provider,
  log `cloud.invite_redeemed`, map `CloudProviderError("invite_refused")` to
  `{ ok: false, reason, message }`, and cast `error.detail.reason as
  CloudInviteRefusalReason`. One path goes through `deps.machines`. The other
  calls the provider directly.
- **Dead channel:** No renderer code calls `window.ade.cloud.getReferral`;
  only `browserMockCloud.ts:332` does. The account read already carries
  `referral`.
- **Judo move:**
  1. Delete `IPC.cloudGetReferral`. That is the handler, `ipc.ts:1173`,
     `preload.ts:13448`, the `global.d.ts` entry and the mock.
  2. Put one `redeemCloudInvite(machines, code, logger):
     Promise<CloudInviteRedeemOutcome>` in `cloudMachines.ts`. Both
     `IPC.cloudRedeemInvite` and the `invite_redeem` action call it.
  3. The action keeps its one real difference, which is rethrowing a
     non-invite error. Use a small flag at the call site, or let the IPC
     handler catch that error itself.

  Deleting the dead channel is **BP**. Merging the two redeems is **BP** if the
  IPC keeps mapping unknown errors to `unavailable`.

### H5. Referral summaries are parsed in some places but not others, with casts at the provider boundary (standard 6)
- **Where:**
  - `cloudServerProvider.ts:368-378`: `readReferral` and `redeemInvite` check two fields, then cast with `body as unknown as …`.
  - The callers then parse again with `readCloudReferralSummary` (`registerCloudIpc.ts:397, 412` and `cloudAgentActions.ts:949`).
  - `cloudAgentActions.referral()` (line 931) returns the provider's value **without** parsing it. So `ade cloud invite --json` and the IPC can return different shapes from one server answer.
  - `billingCheckout` at line 348 does the same: it checks only `cleanup.sentence`, then casts `cleanup as unknown as CloudPlanCleanup`.
- **Judo move:**
  - Parse once, at the provider: `readReferral` returns `readCloudReferralSummary(body)`, or throws `bad_response` when it gets null.
  - `redeemInvite` returns `{ …, referral: readCloudReferralSummary(body.referral) }`.
  - Drop the re-parse at every caller.
  - For `cleanup`, add a `readCloudPlanCleanup(value)` beside `readCloudReferralSummary` in `shared/adeCloud.ts`, or keep the cast and validate every field it claims.

  **BP** for the referral changes. The `cleanup` parser is new code, still BP.

---

## Medium

### M1. Dead fallback and a mode flag in `startFreshPeriod` (standards 1, 3 and 6)
- **Where:**
  - `store.ts:738`: `FreshPeriod.freeHours?: boolean`.
  - `store.ts:741`: `freeIncludedMilli`.
  - `store.ts:783-791`: the post-batch read and its `after?.… ?? …` fallbacks.
- **Dead code:** `after` always exists, because the batch just updated that
  row. Every `??` fallback is unreachable, and `freeIncludedMilli` (exported)
  is used only inside one of them.
- **The flag is redundant:** In all four callers, `freeHours` is `true`
  exactly when `included === FREE_INCLUDED_MILLI`.
- **Judo move:**
  1. Delete `freeIncludedMilli` and the fallbacks. Read `after` with
     `.first()` and treat null as a thrown invariant.
  2. Replace `included: number; freeHours?: boolean` with
     `included: "free" | number`. The SQL then binds
     `case when free_refused_at is not null then 0 else ? end` only for
     `"free"`.

  **BP.**

### M2. The paid-rules check is written three times, twice as SQL (standard 4)
- **Where:**
  - `store.ts:493`: `accountRules` in TS.
  - `store.ts:670-671`: `EARNED_DRAW_SQL` inlines `plan = 'paid' and coalesce(stripe_status, '') <> 'past_due'`.
  - `freePlan.ts:132`: `FREE_RULES_SQL` writes the negation as `(plan = 'free' or … = 'past_due')`.
- **Judo move:** Export one `PAID_RULES_SQL` from store.ts, next to
  `accountRules`. Add a one-line comment saying the two must match.
  `EARNED_DRAW_SQL` uses `PAID_RULES_SQL`, and freePlan uses
  `not ${PAID_RULES_SQL}`. **BP**, because the two forms are equivalent:
  `plan` is only `free` or `paid`.

### M3. Three different patterns for new `cloud_accounts` columns (standard 6)
- **Where:**
  - Migration 0026's columns are optional fields on `AccountRow` (`store.ts:159-168`).
  - Migration 0027's plan-cleanup columns are a subtype, `PlanCleanupAccountRow` (`planCleanup.ts:86`).
  - The wake-notice columns are a separate structural `NoticeColumns` (`accountNotices.ts:17`).
- **The problem:** All of them come from the same `select *`.
  `earned_granted_milli` and `earned_used_milli` are `not null default 0` in
  SQL, yet optional in TS, so every reader writes `?? 0`.
- **Judo move:**
  - Put every 0026 and 0027 column on `AccountRow`.
  - Make the `not null default 0` columns required.
  - Delete `PlanCleanupAccountRow` and `NoticeColumns`.
  - Test fixtures that build `AccountRow` by hand then need the new fields; that is the point.

  **BP** at runtime. It is a type-only change.

### M4. Sentences and labels written twice between server modules, and between server and client (standard 4)
- **Plan names:** `planCleanup.ts:206` `PLAN_NAMES` is identical to
  `contract.ts:600` `PLAN_LABELS`, which is private. **Judo:** export one map
  from contract (for example `CLOUD_PLAN_SENTENCE_NAMES`) and use it in both
  places. **BP.**
- **The "done" email:** `planCleanup.ts:235` `tellPlanCleanupDone` rewrites
  what `contract.ts:588` `planCleanupDoneSentence` says, with different
  wording. **Judo:** build the email body from `planCleanupDoneSentence(done)`.
  The email can keep its per-computer line list under that sentence if the
  extra detail is wanted. **J:** the email copy changes slightly.
- **The free-plan refusal sentence:** `contract.ts:487`
  `CLOUD_FREE_PLAN_REFUSED_SENTENCE` hard-codes "500 hours a month", which is
  `CLOUD_PLANS.plus.includedMilli`. `browserMockCloud.ts:209` copies the
  whole string. **Judo:** build the sentence in `freePlanOf` from
  `CLOUD_PLANS.plus` (plans.ts is pure, so freePlan can import it). Have the
  mock import the constant. **BP.**
- **The wake-block reason:** One union is written three ways:
  - `CloudTimedWakesCancelled.reason` (`contract.ts:577`)
  - `WakeBlock` (`accountNotices.ts:15`)
  - `stopAll`'s parameter (`cron.ts:304`)

  **Judo:** `export type WakeBlock = CloudTimedWakesCancelled["reason"]`, and
  `stopAll` takes `WakeBlock`. **BP.**

### M5. `referrals.ts` copies helpers that already exist (standard 4)
- **Rate limiter:** `admitLookup` (`referrals.ts:379-390`) is
  `checkDeviceRateLimit` (`deviceAuthorization.ts:346`) with another scope:
  the same table and the same upsert. **Judo:** export the limiter from
  `deviceAuthorization.ts` with `scope` widened to a string. **BP.**
- **Hashing:** `sha256Hex` (`referrals.ts:373`) is the fourth copy.
  `sinkUtils.ts:63` already exports one. **BP.**
- **Clerk:** `clerkFacts` (`referrals.ts:86-97`) fetches the same Clerk user
  as `email.ts:88` `accountEmail`, with its own URL constant and timeout.
  **Judo:** one `readClerkUser(env, userId)` in `email.ts` (or a new
  `clerk.ts`) that returns `{ email, createdAt, firstName }`. Both callers use
  it. **BP.**
- **Request body:** The hand-rolled body parse in `redeem`
  (`referrals.ts:200-207`) repeats `routes.ts:216` `readJson`, which has a
  size cap. **Judo:** export `readJson` (through the access/http module from
  H2) and use it. **BP**, except that the size cap becomes a new limit on an
  `{ code }` body, which is harmless.

### M6. One computer-id constant in two packages, and its shape typed four times (standards 4 and 6)
- **Where:**
  - `CLOUD_COMPUTER_ID_DOMAIN` is defined at `contract.ts:129` and again at `hardwareAnchor.ts:402`, with a "keep in step" comment. The server never reads the contract copy.
  - The `"unreadable"` sentinel is `CLOUD_COMPUTER_UNREADABLE` in contract, but a literal in `hardwareAnchor.ts:415` and `cloudAccess.ts:94`.
  - `{ id: string; platform: NodeJS.Platform } | null` is spelled out four times: `cloudAccess.ts:41` and `:89-90`, and `cloudServerProvider.ts:62`.
  - `readCloudComputerIdAsync(): Promise<string | "unreadable">` is just `Promise<string>`.
- **Judo move:**
  - `hardwareAnchor.ts` imports both constants from the contract. ade-cli already imports desktop shared, which imports the contract.
  - Export a `CloudComputerSignal` type from `cloudServerProvider.ts` and reuse it.

  **BP.**

### M7. `claudePassEndWarning.ts` no longer names what it does (standards 4 and 6)
- **The rename:** The file now also warns about provider keys with an end
  date. The renderer already calls the result `CloudSignInEndNotice`. **Judo:**
  rename across main and shared:
  - `claudePassEndWarning.ts` → `cloudSignInEndWarning.ts`
  - `readClaudePassEnd` → `readCloudSignInEnd`
  - `ClaudePassEndList` → `CloudSignInEndList`
  - `CloudPassEnd` → `CloudSignInEnd`
- **The window constant:** `keyEnd` uses Claude's `CLAUDE_PASS_NOTICE_MS` as
  the key-notice window. Lift it to one shared `SIGN_IN_END_NOTICE_MS`.
- **The `kind` field:** `CloudPassEnd.kind?` is documented as "absent on
  older answers". Main always sets it, and this IPC never crosses versions.
  Make it required.

  **BP**, apart from the mock (`browserMockProviderLogins.ts:933`), which
  must set `kind`.

### M8. The server path parse is duplicated (standards 3 and 5)
- **Where:** `routes.ts:1053-1059` `freePlanMomentOf` re-parses
  `/cloud/instances/<id>/<action>` the same way `routes.ts:1122` does.
- **Judo move:** Add one `instanceRouteOf(path): { instanceId, action, rest } |
  null`, used by both. **BP.**

### M9. The client copies server constants instead of importing them (standard 4)
- **Desktop and CLI:**
  - `shared/adeCloud.ts:29-36` re-exports `CLOUD_REFERRAL_REWARD_MILLI`, `CLOUD_REFERRAL_REWARD_LIMIT`, `CLOUD_REFERRAL_ENTER_DAYS`, `CLOUD_INVITE_URL_BASE`, `CLOUD_INVITE_DEEPLINK_BASE`, `CLOUD_FREE_PLAN_REFUSED_SENTENCE` and `planCleanupSentence`.
  - Nothing outside that file imports any of them.
  - Meanwhile these hard-code "20 hours", "10 rewards" and "30 days": `cli.ts:4791, 4814-4815`, `actionInputContracts.ts:213, 218`, `global.d.ts:4850` and `CloudInvite.tsx:38-39` (renderer).
  - **Judo:** template the help and contract strings from the constants, and drop the re-exports nothing uses. **BP.**
- **Web:** `apps/web/src/lib/invite.ts` copies the contract:
  - lines 9, 17-19 duplicate `parseCloudInviteCode` and the alphabet;
  - line 22 duplicates the `ade://invite/` base;
  - lines 25-26 duplicate the 50 free hours and the 20-hour reward;
  - `InvitePage.tsx:82` hard-codes "30 days".

  **J:** importing `account-directory/src/cloud/contract.ts` (no imports,
  pure) into `apps/web` crosses a package boundary that web does not cross
  today. Decide whether that is allowed. If it is, the copies go.
- **Stripe setup:** `stripe-setup.mjs:28-52` hard-codes each plan's hours,
  disk, computers and prices, plus the price amounts 500 and 2000. All of
  these are in `plans.ts` `CLOUD_PLANS`. **J:** the script can
  `import { CLOUD_PLANS } from "../src/cloud/plans.ts"` only on a Node with
  type stripping. Otherwise, add a check in `verify-deployment-config.mjs`
  that fails when the two differ.

### M10. One cloud-lane selector constant in two CLI modules, with different matching (standard 4)
- **Where:**
  - `cliMachineTargeting.ts:1150` matches `--machine` case-insensitively and trimmed.
  - `remoteMcpCommandPolicy.ts:275` redefines `CLOUD_LANE_MACHINE` and matches exactly.
- **Judo move:** Export `CLOUD_LANE_MACHINE` from one place
  (`shared/cloudLaneLaunch.ts`) and use it in both. **J:** stay exact in the
  policy, which is stricter on purpose, and say so in a comment. Or reuse
  `isCloudLaneMachineSelector`, which widens what the policy admits.

---

## Low

- **L1. `cron.ts:236, 263-276`:** `blockedUsers` (an array) and `blockedWhy` (a
  Map) record the same keys. Drop the array and return
  `new Set(blockedWhy.keys())`. **BP.**
- **L2. `cloudLaneLaunchAnalytics.ts`:** The name says "launch", but the file
  also holds the freed, cache-clear and default-size events. Three more
  points:
  - The union member `"cloud_default_size"` (line 13) is never sent from
    main; the renderer sends it itself (`appStore.ts:3051`). Remove it from
    the union.
  - Rename the file to `cloudLaneAnalytics.ts`.
  - Export its `Capture` type in place of the four
    `Parameters<typeof …>[0]` types (`cloudAgentActions.ts:154`,
    `registerCloudLaneLifeIpc.ts:38`, `registerCloudLaneLaunchIpc.ts:41`,
    `cloudLaneLaunchBrainHost.ts:173`).

  **BP.**
- **L3. `syncRemoteCommandService.ts:8453`:** The method list is typed out by
  hand. Use `["captureNow", ...PROVIDER_LOGIN_ACCOUNT_WRITES]` from
  `shared/types/providerLogins.ts:47`. A new account write then reaches the
  phone without a third edit. **BP.**
- **L4. `productAnalyticsPolicy.ts:703, 773-775`:** Two allowlists are copied
  from other lists:
  - The `size_*` values copy `CLOUD_TIER_IDS`.
  - The `refused_*` values copy `CloudInviteRefusalReason`.

  Make the refusal reasons a `const` array in the contract (which also gives
  H4/H5 a runtime check in place of the cast). Build both allowlists with
  `.map((x) => \`size_${x}\`)`. **J:** the policy comment says "added here
  deliberately", which is a review gate. Keep the lists literal if that gate
  is wanted.
- **L5. `cloudAccountStatus.ts:193`:** `diskShared: true` is now constant,
  and the CLI no longer reads it (`cliCloudStatus.ts:48`). **J:** it is still
  in the agent-facing `status` JSON and in `actionInputContracts.ts`. Delete
  it from both, or keep it as a documented constant.
- **L6. `marketingReplay.ts:43`:** This line re-tests `/invite` paths inline.
  Use `withoutInviteCode(normalized) === "/invite"` from
  `marketingAnalytics.ts`, as the pixel and the screen mapping already do.
  **BP.**
- **L7. `global.d.ts:4847, 4855`:** `getReferral?` and `redeemInvite?` are
  optional, but the preload always defines them. After H4, make
  `redeemInvite` required. **BP**, type only.
- **L8. Names that drift:** The same feature is "invite" in the CLI
  (`ade cloud invite`), in `invite_redeem` and in `cloudRedeemInvite`. It is
  "referral" in the `referral` action, `/cloud/referrals` and
  `cloudGetReferral`. The settings tab `ade-cloud` mixes id schemes:
  `integrations.ade-cloud-*` (kept for links) and new `ade-cloud.plans` and
  `ade-cloud.sizes`. Also, `integrations.ade-cloud-spending` now means "lanes
  and computers". **J:** these are public ids and paths. Record the chosen
  names, and do not rename now.
- **L9. Ready-machine leftovers:**
  - `apps/ade-cli/README.md:912-913` still documents `ade cloud ready` and
    `--machine cloud:ready`. Delete both lines. **BP**, docs.
  - `cloudKeepAwake.ts:509` `cloudReadySetupRunning` plus the template's
    `ready/job.sh` hook (`infra/ade-cloud/template/ade-entrypoint.sh`) now
    serve only computers an older ADE prepared. **J:** keep them until no
    such computer can exist, and write down when that is. Then delete both.
  - The literal `ade_ready*` keys in `cloudMachineCopy.ts:86-87` are a
    justified tombstone; keep them.
  - `cli.ts:21172-21174`, the `ade cloud ready` refusal, is a good tombstone;
    keep it.

## Checked and fine

- Remote scoping: `getReferral` and `redeemInvite` are account-level, with
  no pin, and say so.
- The `providerLogins.*` sync commands reuse the stateless domain service and
  keep the two this-computer-only actions off the phone.
- `clear_caches` moved from user-only to "an agent asks with a card". It is
  in the allowlist and in `CLOUD_APPROVED_ACTIONS`, and the machine check
  still refuses a cross-machine call.
- `cloudInstanceOps.ts` correctly takes the two shared helpers out of the
  deleted `cloudReadyClaim.ts`. No importer of the old module remains.
- `registerCloudIpc.ts` (642 lines) and `cloudAgentActions.ts` (996) both
  shrank and are under the size limit. `routes.ts` was already over 1,000
  lines at base (1,106 → 1,128) and grew only by the free-plan hook. H2 and M8
  keep it from growing further. A real split of `routes.ts` is out of scope.
- `cli.ts` grew by 11 net lines. The new `invite` sub-plan and its two
  formatters sit next to the other cloud formatters.

## Outside this track (for Track A)

- `referrals.ts:409`: `decodeURIComponent` on a public path throws `URIError`
  on a malformed `%` sequence, which gives an unhandled 500 instead of a 404.
- `cloudAccess.ts:92-95`: `cloudFreePlanComputer` caches a rejected id read as
  `unreadable` for the life of the process. One transient failure means that
  computer never claims a free plan until ADE restarts.
- `buildAccountState` (`store.ts`) calls `referralSummary` on every account
  read. On first use that writes an invite code. While the account has no
  referrer and Clerk has no `created_at`, it calls Clerk on every read.
