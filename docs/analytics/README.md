# Analytics tracking plan

`tracking-plan.json` lists every event any ADE surface sends to PostHog: its
name, the platforms that send it, the file that owns it, why it exists, and the
properties it may carry (beyond the common ones listed at the top of the file).
`docs/logging.md` holds the privacy rules, consent, budgets and architecture;
this folder is the catalog.

`scripts/check-analytics-tracking-plan.mjs` runs in CI (the `validate-docs`
job) and fails when the code, the plan and the dashboards disagree: an event is
sent but not in the plan, the plan lists an event nothing sends, a desktop or
brain event is declared but never captured, or a dashboard in
`scripts/posthog/dashboard-spec.mjs` uses an event nothing sends.

## Where events come from

| Source | Events | Declared in |
|---|---|---|
| Desktop, brain, CLI, hosted web client | `ade_*` | `PRODUCT_ANALYTICS_EVENTS`, `apps/desktop/src/shared/types/productAnalytics.ts`; properties allowlisted in `productAnalyticsPolicy.ts` |
| In-app surveys (desktop) | `survey shown`, `survey dismissed`, `survey sent` | the same list; sent only by `main/services/analytics/surveyService.ts` |
| iOS | `ade_mobile_*` | `ADEAnalyticsEventName`, `apps/ios/ADE/Services/ProductAnalytics.swift` |
| Marketing site | `ade_marketing_*` | `MARKETING_ANALYTICS_EVENTS`, `apps/web/src/lib/marketingAnalytics.ts` |
| Account directory (server) | `ade_signed_up`, `ade_account_deleted` | `apps/account-directory/src/signupAnalytics.ts` (Clerk webhook) |
| PostHog identify | `$identify` | desktop `productAnalyticsService.ts`, iOS `ProductAnalytics.swift` |

## Naming rules

- App events are `ade_` + snake_case, object then verb in the past tense:
  `ade_project_opened`, `ade_update_install_aborted`. iOS adds `mobile_`, the
  marketing site `marketing_`, so one surface's numbers never mix with another's.
- Prefer a new value on an existing event over a new event. Most product facts
  are `ade_feature_used` with an allowlisted `feature`, `action` and `outcome`.
- Names PostHog defines keep PostHog's spelling exactly: `$identify`, and the
  survey events `survey shown`, `survey dismissed`, `survey sent` with their
  `$survey_*` properties. PostHog's Surveys page reads those names.
- Never rename a live event. Add the new one, keep both in the plan while
  dashboards move, then remove the old one from code and plan together.

## Property rules

- Every property is allowlisted per event, and string values are closed enums
  or slugs. Counts are numbers, flags are booleans. No paths, URLs, prompts,
  file names, emails, ids from other systems, or error messages.
- Local ids (project, session) are hashed with a per-install salt before they
  leave the machine.
- Common properties (`surface`, `client`, `interactive`, `is_internal`,
  `app_version`, `release_channel`, ...) are added by each surface's analytics
  client, never by a call site.
- The one free-text exception is a survey answer the person types and chooses to
  send. It is scrubbed for secrets and home-folder paths and cut at 2,000
  characters before it leaves the machine.

## How to add an event

1. Check whether an existing event and a new allowlisted value answer the
   question. If yes, add the value in the surface's policy and stop here.
2. Add the name to the surface's declaration (table above) and its properties,
   daily and per-minute budgets to the surface's policy.
3. Capture it at the owning service, after the fact it records happened.
4. Add an entry to `tracking-plan.json`: `name`, `platforms`, `owner` (the file
   that captures it), `source`, `purpose`, `properties`.
5. Add it to `EVENTS` in `scripts/posthog/dashboard-spec.mjs` (the 30-day volume
   cards count every event there) and to a dashboard insight if it answers a
   standing question.
6. Run `node scripts/check-analytics-tracking-plan.mjs` and
   `node scripts/posthog/provision.mjs --validate`.

## In-app surveys

ADE draws its own survey card (no posthog-js). A survey shows only when it is a
PostHog survey of type **API**, launched, and named with an ADE key prefix:

| Name starts with | Who sees it |
|---|---|
| `[ade:pmf]` | Used ADE on 7 or more days in the last 28 |
| `[ade:returning]` | Opened ADE after 10 or more days away |
| `[ade:early]` | 3 to 10 days after first open, used on at most 2 days |

At most one survey per install every 21 days, never in the first session or
during onboarding, never the same survey twice, and nothing (not even the
fetch) while analytics is off. Supported questions: open text, rating (1–5,
1–7 or 0–10), single choice, multiple choice (with an optional "Other"), and
link. Put the question you want to read at a glance first: dashboards show the
first question's answer as `$survey_response`. Do not use PostHog targeting,
URL or event conditions; ADE's rules above decide who sees a survey.

## Weekly review

Every Monday, about 20 minutes:

1. **Sign-ups.** `ADE · Sign-ups & activation`: weekly sign-ups, sign-up to
   activation, desktop sign-in failures. Check the `Analytics reconcile`
   workflow run that morning is green.
2. **Retention and churn.** `ADE · Retention & churn`: the newest cohorts,
   dormant vs resurrecting, account deletions.
3. **Feedback.** `ADE · Feedback`: read every new open-text answer, track the
   PMF share answering "Very disappointed", and file what repeats.
4. **Reliability.** `ADE · Reliability and analytics budget`: incidents, errors,
   and the 30-day volume against the free allowance.
5. **Data health.** Check that the `Analytics health` workflow
   (`scripts/analytics/data-health.mjs`, every six hours) stayed green. It goes
   red when the site's `/_t/` proxy stops answering as PostHog, or when the
   site or the desktop app sends almost nothing for a day.

## Project settings that live in PostHog, not code

Set through the PostHog API on 2026-11-02 (free tier, billing limit $0). Change
them in PostHog and update this list in the same branch.

- **Transformation "Drop bots from website events"** (Filter Bot Events
  template): drops `ade_marketing_*` events from known bot, crawler, headless
  and scripted user agents and PostHog's known bot IPs, before ingestion, so
  they never count against the allowance. App, brain and iOS events are not
  touched. The site has sent `$raw_user_agent` since 2026-11-02; older site
  events have no user agent and cannot be filtered.
- **Alerts** (5 of 5, email to the owner): weekly active installs down 25% or
  more week over week; weekly sign-ups under 10; brain recoveries over 40 a
  day; renderer crash recoveries over 5 a day; brain action failures doubling
  day over day.
- **Subscriptions** (5 of 5): a Monday 14:00 UTC email with PostHog AI's
  summary of Sign-ups & activation, Retention & churn, Feedback, Reliability
  and analytics budget, and the 1,000 MAU goal dashboard.
- **Session replay**: recording on, minimum duration 5 seconds, console and
  performance capture off, project masking of inputs only. The desktop masks
  all text in code; the site keeps public text so replays show what people
  read. Heatmaps on (site). See `docs/logging.md` › Session replay.
- **Transformation "Fill release_channel from app_version"**: builds before
  1.2.128 do not send `release_channel`. For `ade_*` app events missing it,
  it is inferred from `app_version` (`-beta` → beta, `-alpha` → alpha, a
  development runtime → development, else stable) and marked
  `release_channel_inferred: true`. A sent value is never overwritten. It only
  applies to events ingested after 2026-11-03; older history still lacks the
  property (group by `app_version` for that).
- **Feature flag `session-replay-real-users`** (linked to recording): false
  for `is_internal` people, so ADE's own accounts are never recorded. Its only
  use; do not repurpose it. The site's per-browser opt-out is
  `?ade_no_replay=1`.
- **Dashboard "ADE · Agent turns (LLM analytics)"** is managed by
  `scripts/posthog/provision.mjs` like the others; PostHog's own LLM analytics
  and Error tracking pages read `$ai_generation` and `$exception` directly.
- **Transformation "Mark ADE team accounts internal"**: sets
  `is_internal: true` (and `is_internal_source: account`) on every event from a
  distinct id on its list: each Clerk account flagged `ade_internal` and each
  install that signed in to one, on every surface and build. A signed-in
  install sends as its account, so a new machine is covered from its first
  sign-in; its events before that are covered from the next sync. The
  `Analytics reconcile` workflow keeps the list and the `is_internal` person
  flag in sync (`reconcile-signups.mjs --sync-internal`, which needs the
  `POSTHOG_INTERNAL_SYNC_API_KEY` secret). After you flag a new account in
  Clerk, run that workflow by hand. The sync only adds; take an id off the list
  in PostHog. Like every transformation, it does not mark events ingested
  before an id was on the list (the owner's accounts: before 2026-11-05 07:00
  UTC).
- **Self-driving** (reports only, PR generation off, nothing starts on its
  own): connected to `arul28/ADE`. The destination "Self-driving reports →
  Linear (ADE)" files each surfaced `$scout_report_emitted` of priority P0–P2
  as a Linear issue in team ADE with the `posthog` label and Linear priority
  (P0 Urgent, P1 High, P2 Medium); P3, P4 and unranked reports stay in the
  PostHog inbox. No report gets `auto-fix`, and the automation rules that
  started an ADE agent from it (`posthog-report-investigate`,
  `linear-auto-fix-labeled`) are off: a person decides what an agent works on.
  It authenticates with the project secret `LINEAR_POSTHOG_API_KEY`.
  - Scouts on (daily unless noted): General, Anomaly detection, Customer
    analytics, Inbox validation, Product analytics (Mondays), Surveys
    (Mondays), Data pipelines (Mondays), and ADE's own "ADE reliability" and
    "ADE update installs" (Mondays), which feed the others and do not report
    on their own. The rest are paused: they watch products ADE does not use
    or repeat the Sentry and error-tracking sources.
  - The team instructions every scout reads say who is internal, which data
    breaks are known (the list below), and that ADE sends no autocapture.
    Each source (Sentry, error tracking, GitHub, Linear) has steering that
    keeps only fixable defects on current builds and skips issues labeled
    `posthog` or `auto-fix`. Change them in PostHog and here together.
  - Automation gaps found along the way are tracked in
    `docs/features/automations/known-gaps.md`.

## Known breaks in the series

- **Marketing site events, replay and heatmaps are missing from 2026-11-03
  22:20 UTC to about 2026-11-05 07:00 UTC.** The `/_t/` proxy rewrite in
  `apps/web/vercel.json` used `:path*`, which Vercel does not match against a
  path that ends in `/`, so every capture went to the site's `index.html`
  (PR #2066 fixed it). Do not read that window as a traffic drop.
- **"Active" means a person did something**, on every build. The managed
  insights that count active or retained installs (weekly active
  installations, feature-use retention, feature adoption, sign-up retention,
  sign-up to repeat use) leave out the background events of
  `productAnalyticsPolicy.ts` and the feature uses the app runs on its own,
  by event name for builds before 1.2.128, which send no `interactive`. Since
  2026-11-05 their history reads lower than before: about half of the
  "feature-active" installs in the week to 2026-11-05 had only automatic
  activity.
- **Download clicks leave out the `/open` link page** from 2026-11-05. Link
  scanners load it and press each footer link once; they were most of the
  iPhone "download" clicks.
- **`error_kind` on a failed chat turn** says why it failed (`rate_limit`,
  `permission`, `budget`, `network`, `busy`, `cli_missing`) from the first
  desktop release after 1.2.129-beta.8; earlier it is always `other`.
  `ade_brain_action_failed` carries `brain_action` and `expected_kind` from
  1.2.129-beta.6; on older builds most of its `error_code` values are
  `unknown`.
- **`metadata_regenerated`** is sent at most once per outcome per install an
  hour from the first desktop release after 1.2.129-beta.8. Before, it was a
  quarter of the events of the installs that reached their daily budget.
- **Automatic feature uses are non-interactive** from the first desktop release
  after 1.2.128: a scheduled storage sweep and a chat title regenerated after a
  turn now carry `mode: "automatic"` and `interactive: false`. Charts filtered
  to interactive events step down at that release; it is a correction, not a
  drop in use.
- **`release_channel`** is sent by 1.2.128 and later; older builds' events from
  2026-11-03 on get it from the transformation above, and earlier history has
  none (use `app_version`).
- **`$ai_generation` and `$exception`** start with the first release after
  1.2.128. They have their own allowances and are left out of the 30-day
  product-analytics volume cards.

## Sources of truth

- **Clerk is the record of accounts.** `ade_signed_up` (and
  `ade_account_deleted`) mirror Clerk's webhooks. When PostHog and Clerk
  disagree, Clerk is right: `scripts/analytics/reconcile-signups.mjs` compares
  them every week (`.github/workflows/analytics-reconcile.yml`) and backfills
  missing sign-ups with the same uuid, so PostHog never counts one twice. The
  same run keeps ADE's own accounts marked internal (above).
- **Which events fill a daily budget.** `ade_analytics_budget` says how many
  events an install dropped and why, not which. Ask PostHog for the events of
  the installs that dropped `daily_budget` on that day; most `dropped_count`
  is `duplicate`, which is the dedupe working, not lost use.
- **PostHog is the record of product use.** It sees only installs with
  analytics on, so treat its counts as a lower bound.
- **This plan is the record of what is sent.** CI keeps it equal to the code.
