/**
 * Pure view state for the CTO page: which lane hosts the thread, the one
 * status phrase the header and panel show, and the panel's remembered
 * open/closed state.
 */

export function resolveCtoPrimaryLaneId(lanes: Array<{ id: string; laneType?: string | null }>): string | null {
  return lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null;
}

export type CtoLiveFacts = {
  /** A turn is running on the CTO's thread. */
  turnActive: boolean;
  /** The running turn is writing its reply. */
  streamingText: boolean;
  /** The CTO asked a question or needs an approval. */
  awaitingInput: boolean;
  /** No model picked, or the home machine is out of reach. */
  asleep: boolean;
  /** Chats the CTO started that are still running. */
  runningChildren: number;
};

/** "Idle", "Working…", "Writing…", "Waiting on you", "Asleep", or "Working on 2 things". */
export function ctoStatusPhrase(facts: CtoLiveFacts): string {
  if (facts.asleep) return "Asleep";
  if (facts.awaitingInput) return "Waiting on you";
  if (facts.turnActive) return facts.streamingText ? "Writing…" : "Working…";
  if (facts.runningChildren > 0) {
    return `Working on ${facts.runningChildren} ${facts.runningChildren === 1 ? "thing" : "things"}`;
  }
  return "Idle";
}

const PANEL_STORAGE_PREFIX = "ade.cto.panelOpen.v1:";

/** The side panel's open state for one project; open unless the person closed it. */
export function readCtoPanelOpen(scopeKey: string | null | undefined): boolean {
  if (!scopeKey) return true;
  try {
    return window.localStorage.getItem(`${PANEL_STORAGE_PREFIX}${scopeKey}`) !== "closed";
  } catch {
    return true;
  }
}

export function writeCtoPanelOpen(scopeKey: string | null | undefined, open: boolean): void {
  if (!scopeKey) return;
  try {
    window.localStorage.setItem(`${PANEL_STORAGE_PREFIX}${scopeKey}`, open ? "open" : "closed");
  } catch {
    // Storage blocked: the panel still toggles for this session.
  }
}

/** Below this container width the panel stops docking and opens as a sheet. */
export const CTO_PANEL_DOCK_MIN_WIDTH = 960;
