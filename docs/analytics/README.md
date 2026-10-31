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

## Sources of truth

- **Clerk is the record of accounts.** `ade_signed_up` (and
  `ade_account_deleted`) mirror Clerk's webhooks. When PostHog and Clerk
  disagree, Clerk is right: `scripts/analytics/reconcile-signups.mjs` compares
  them every week (`.github/workflows/analytics-reconcile.yml`) and backfills
  missing sign-ups with the same uuid, so PostHog never counts one twice.
- **PostHog is the record of product use.** It sees only installs with
  analytics on, so treat its counts as a lower bound.
- **This plan is the record of what is sent.** CI keeps it equal to the code.
