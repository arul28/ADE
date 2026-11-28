/**
 * The product names a reader accepts in text it did not write: "DAEX", as this
 * build writes it, and "ADE", as older builds and stored data (transcripts,
 * saved errors, a machine mid-update) wrote it. Producers write `BRAND.NAME`
 * (`./brand`); only matchers use this.
 *
 * A regex source fragment (one non-capturing group). Build a matcher with
 * `new RegExp(String.raw`...${PRODUCT_NAME_PATTERN}...`)` so the rest of the
 * pattern reads as it would in a regex literal.
 */
export const PRODUCT_NAME_PATTERN = "(?:ADE|DAEX)";
