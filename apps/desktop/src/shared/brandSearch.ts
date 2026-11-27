/**
 * People keep typing the old product name. A search query with the word
 * "ade" also searches as "daex", so "ade cloud" finds "Daex Cloud". The query
 * as typed is always tried first, so an exact match on "ADE" still wins.
 *
 * Settings search and the command palette use this. The iPhone app has no
 * settings search.
 */

import { BRAND } from "./brand";

const FORMER_WORD = new RegExp(`\\b${BRAND.FORMER_NAME}\\b`, "gi");

/** The query as typed, then (when it has the word "ade") the same query with "daex" in its place. */
export function brandSearchQueries(query: string): string[] {
  const renamed = query.replace(FORMER_WORD, BRAND.NAME.toLowerCase());
  return renamed === query ? [query] : [query, renamed];
}
