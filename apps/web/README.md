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

## Cloud prices

`/pricing` and the home page's cloud section show today's prices, or Pricing v3's when the account server says so. One request per page load reads `GET /public/pricing` (`src/lib/siteOffer.ts`); on `/` and `/pricing` a script in `index.html` starts it beside the site's code (`siteOfferEarlyScript` in `vite.config.ts`). A missing, slow (over 4 s) or unreadable answer shows today's prices, and `/pricing` holds its prices for at most 600 ms so they don't change under the reader.

`src/lib/pricingView.ts` turns the answer and the "With ads / No ads" control into the numbers on the page. The rates, the credit scale and the ad rounding come from the account server's `plans.ts`, never from copies here. The control shows only where the answer has `ads`; with no `ads` (or a discount of 0) the page says nothing about ads.

To see each visitor locally, run `npm run dev` and open `/pricing?offer=us`, `?offer=ca`, `?offer=world` or `?offer=off` (add `&mac=1`, `&pct=`, `&window=`). This works only in `vite dev`; a build always asks the server.

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
