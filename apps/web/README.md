# ADE Web

Marketing site + download page for ADE (Agentic Development Environment).

## Dev

```bash
cd apps/web
npm install
npm run dev
```

If `npm install` fails due to cache permissions, use a repo-local cache:

```bash
cd apps/web
npm install --cache ../../.npm-cache
```

## Build

```bash
cd apps/web
npm run build
npm run preview
```

## Product analytics

The marketing site sends only manual, allowlisted PostHog capture events. It does not load the PostHog browser SDK, so autocapture, automatic pageviews, session replay, surveys, feature flags, and person profiles are not present. Conversion CTAs use `ade_marketing_cta_clicked` and are not duplicated as feature events. URLs, query strings, fragments, referrers, link destinations, visible text, and raw errors are excluded.

The transport follows PostHog's public [single-event capture API](https://posthog.com/docs/api/capture) and marks every event with `$process_person_profile: false`.

Set the public `phc_` project token and ingestion origin at build time:

```bash
VITE_POSTHOG_PROJECT_TOKEN=phc_... \
VITE_POSTHOG_HOST=https://us.i.posthog.com \
npm run build
```

Use `https://eu.i.posthog.com` for an EU Cloud project. With no project token or an invalid/non-HTTPS host, analytics is a no-op. The site applies a 40-event daily cap per browser, including at most 12 CTA clicks and 16 other feature clicks, plus lower event/key caps, burst deduplication, and one prior-day budget rollup. Analytics starts only after the visitor explicitly opts in through the consent prompt. Visitors can later withdraw consent on `/privacy` or through `window.adeAnalytics.setEnabled(false)`; the preference is stored locally.

Never put a personal `phx_` API key in either `VITE_` variable. Personal keys are server-side management credentials used only by `scripts/posthog/provision.mjs`; Vite variables are bundled into the public site. Analytics is default-off until the visitor consents and remains network-inert after opt-out.

Run the focused tests with:

```bash
npm run test:analytics
```
