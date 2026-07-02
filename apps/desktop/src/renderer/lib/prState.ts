import type { PrSummary } from "../../shared/types";

// Terminal PR states can never advance on GitHub (merged is permanent; closed
// only leaves via an explicit reopen), so surfaces treat a terminal local
// state as authoritative over a stale non-terminal GitHub snapshot row.
export function isTerminalPrState(state: PrSummary["state"]): boolean {
  return state === "merged" || state === "closed";
}
