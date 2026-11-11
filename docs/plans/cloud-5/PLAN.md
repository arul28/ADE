# Cloud 5 · ADE Cloud dashboard and the beta.12 fixes — plan

Lane `ade/cloud-5-dashboard-and-fixes`. Started 2026-11-11. The owner (Arul) is away and delegated the whole
lane: build, validate by hand, iterate, `/quality`, `/test`, `/ship`, merge, beta. Every merge that touches
`apps/account-directory/**`, the push-relay or the web client IS the production deploy.

Scope source: `cloud-beta12-test-ledger.md` (this folder, 18 items + "New things to build"). Background:
`/Volumes/Dev/Projects/ADE/.ade/worktrees/cloud-coordinator-c4921216/docs/plans/cloud-lane-archive/` (Cloud 3, Cloud 4
plans and reports). Feature doc: `docs/features/ade-cloud/README.md`.

## Owner decisions (2026-11-11, this lane)

1. **Forced downgrade pushes unpushed work first.** ADE removes the oldest cloud lanes past the cheaper plan's
   limits, but first pushes each lane's unpushed work to its branch on GitHub. A lane whose push fails is kept and the
   person is told. "You should never stop a user from paying less; the user is warned."
2. **The sign-in end warning covers Claude passes AND keys**, but for a key only when the provider gives ADE an end
   date (never a guess).
3. **No reward for starring the repo** (GitHub's Acceptable Use Policies forbid activity "incentivized by rewards").
   The existing star pill stays as is.
4. **Referral program is the only way to earn hours, for now.**
   - Each account has one invite link (`https://ade-app.dev/invite/<CODE>`) and the code in it.
   - The friend enters the link or the code: a box in the sign-up flow (desktop LaunchGate and iPhone sign-in), and
     the same box in Settings › Account for 30 days after the friend's account was created. The box accepts a full
     pasted link or a bare code. If ADE is installed, opening the link (`ade://invite/<CODE>` from the web page) fills it.
   - The invite page on the website: every download option, plus "Invited by <first name>. You both get 20 extra free
     cloud hours, on top of the 50 free every month."
   - Reward: **20 hours to both** when the friend's first chat runs on an ADE Cloud computer (free or paid plan).
     The referrer gets at most **10 rewards ever**; after that the friend still gets 20 h.
   - One referrer per account, never changed. Not your own code.
   - **Earned hours never expire.** Order of use: the month's plan hours, then earned hours, then paid extra hours.
   - Desktop pill: "Invite friends, get free cloud hours", same look as the star pill, own schedule: shown only after
     the person has used ADE Cloud once; after a dismissal it returns 40 sent messages later; three dismissals max.
   - The dashboard shows earned hours and the referral state (friends joined, hours earned, rewards left, the link).
   - Excellent analytics everywhere (desktop, web, iPhone): pill shown/dismissed, link copied, invite page opened,
     code entered (accepted / refused reason), reward paid. No codes or emails in analytics.
5. **Abuse gate: one free plan per physical computer** ("the computer id thing"; NOT the IP address).
   - The first time an account uses free hours, its computer's scrambled id (an HMAC on the server of the OS
     machine id, a NEW global hash, distinct from the per-account `hardware_id` of migration 0008) is claimed for
     that account's free plan. A second account on the same computer can sign in, use ADE, pay for Plus/Pro and buy
     extra hours, but gets 0 free plan hours; the dashboard says why in one sentence.
   - Settled per account, not per chat: an account whose computer is already claimed has 0 free hours everywhere
     (CLI, phone, MCP).
   - Referrals: no reward when both accounts share a computer, or when the friend's computer already used another
     account's free hours.
   - Free hours stay frictionless: sign up, log in, use cloud hours. Nothing to turn on.
   - Edge cases to handle deliberately: reinstall, a VM, a shared family computer, a computer that can't read its id,
     an account that has only used the phone or MCP, a computer that later signs into the original account again.
   - Logging/analytics/alerts: every claim, refusal and edge case logs, goes to PostHog, and Sentry alerts on spikes,
     so abuse and false refusals are easy to diagnose. Privacy policy gets one line: "We keep a scrambled id of your
     computer so the free plan is given once per computer."
   - Phone verification is a later step, only if abuse shows up.
6. **Hide ADE Cloud from everyone but the owner** (release blocker; stable ships from this lane's beta). Use the
   existing gate (`CLOUD_ACCESS_ACCOUNTS` on the server, `GET /cloud/access`, `renderer/state/cloudAccess.ts`
   `useAdeCloudEnabled`). Unknown / offline = hidden, never a flash. Shared sign-ins between a person's own computers
   stay visible. `CLOUD_ACCESS_ACCOUNTS` must be the owner's account only; check by behavior with a second test account
   (owner OK'd a Gmail plus-alias account), and re-set the secret to the owner only if anyone else gets in (owner OK'd).
7. **Stripe sandbox changes are OK'd** without asking each step (separate products named "ADE Cloud Plus", "ADE Cloud
   Pro", "Extra hours", "Extra disk", descriptions, plain units). Live Stripe untouched. List every change in the report.
8. **Helpers:** Opus 5.5 subagents, parallel, as many as useful. Helpers start no helpers.

## Root causes found

- **Item 14, local copy (MacBook):** `/Users/arul/ADE/.git/config` has `[extensions] worktreeConfig = true` (5.8 KB,
  one origin url). `readGitOriginUrlWithoutGit` returns undefined on `worktreeConfig = true`, and
  `registerCloudLaneLaunchIpc.ts:86` uses only that function, never the `git config` fallback
  (`readGitOriginUrlFromConfigOrGit`). Verified on the MacBook 2026-11-11 via `ade shell start --machine`.
- **Item 14, remote tab:** `preload.ts` `cloudLaneLaunchSource` sends only the binding's stamped `gitOriginUrl`;
  a remote binding without one reaches main with nothing.

## Tracks (who owns which files)

| Track | Owner | Items |
|---|---|---|
| D · Dashboard + composer menus + header meter | lead (me) | 1, 3, 4, 5, 6, 7, 9, 11, 12, 17, 18; header ADE Cloud meter |
| A · Launch fixes | helper | 14, 10, 13, 15, 16 |
| B · Referrals, earned hours, per-computer free plan (server + contract + main + web page + privacy) | helper | decisions 4, 5 |
| H · Hide ADE Cloud everywhere + `ade settings find` | helper | decision 6, item 2 |
| S · Server/billing cleanup + checkout | helper | Cloud 2 cleanup, item 8, decision 1 |
| C · Client cleanup + security | helper | Cloud 4 step 2b, end warning keys, Cloud 3 leftovers |
| R · Referral UI (pill, code boxes desktop/iPhone, dashboard card data) | helper, after B's contract | decision 4 |
| I · iPhone mirror + Cloud 4 P8 sign-in screens + web | helper, after D | |

Migrations: `0026` is B's. S uses `0027` if it needs one. (#2165 holds 0023-0025.)

## Status

- [x] Cost alarms: cherry-picked de0929fc6 + review-fixes patch (cloudAccount.test.ts 91 passed).
