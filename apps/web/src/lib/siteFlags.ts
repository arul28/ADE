/**
 * `/pricing` stays hidden until ADE Cloud launches: no link on the live site
 * points to it, and the route sends visitors home. Dev servers render the
 * route and its links so the page can be previewed. Turn this on at launch.
 */
export const PRICING_PAGE_LIVE = false;

/** Whether `/pricing` renders in this build. */
export const pricingPageVisible = PRICING_PAGE_LIVE || import.meta.env.DEV;

/** Whether the site links to `/pricing`. */
export const linkToPricing = PRICING_PAGE_LIVE || import.meta.env.DEV;
