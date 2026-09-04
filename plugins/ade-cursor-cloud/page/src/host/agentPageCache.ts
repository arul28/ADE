/**
 * One agent page, remembered for as long as this page is mounted.
 *
 * The detail pane is a read the reader triggers by CLICKING, and a reader
 * walking a fleet clicks far faster than Cursor answers. Without a memory each
 * click paid the full read again — including the walk back to a row they had
 * already opened — so the pane spent most of its life on a spinner over
 * content it had already had.
 *
 * Three rules, and they are the whole module:
 *
 * - A cached page paints IMMEDIATELY, and the pane still re-reads behind it.
 *   Nothing here is ever the last word; it is the first one.
 * - Two callers asking for the same agent at once make ONE request. The
 *   prefetch of a neighbour and the reader arriving on that neighbour a moment
 *   later are exactly that case.
 * - Only a page the child answered CLEANLY is remembered. "It is not in this
 *   project's fleet." is a sentence about a moment — a fleet read that had not
 *   landed yet, an agent archived a second ago — and remembering it would make
 *   a transient refusal permanent for the life of the page.
 *
 * The map is bounded because a long session on a large fleet would otherwise
 * hold every agent the reader ever opened, artifacts and runs included. Oldest
 * insertion goes first, which for this access pattern is close enough to least
 * recently used and needs no bookkeeping.
 */

import { getAgentPage } from "./actions";
import type { CloudAgentPage } from "../types";

/** Agents remembered at once. Past this the oldest insertion is dropped. */
const MAX_REMEMBERED = 40;

/**
 * How long a remembered page may answer a read WITHOUT a re-read behind it.
 *
 * It exists for one motion: the pane prefetches the next row, the reader opens
 * that row a second later, and re-reading there would throw away the request
 * that was made for exactly this moment. Any longer and a pane could sit on a
 * status the reader can see is wrong on the row behind it.
 */
export const AGENT_PAGE_FRESH_MS = 10_000;

type Remembered = { page: CloudAgentPage; at: number };

const remembered = new Map<string, Remembered>();
const inFlight = new Map<string, Promise<CloudAgentPage>>();

function keep(agentId: string, page: CloudAgentPage): void {
  // A refusal and a not-found are moments, not facts. See the header.
  if (!page.entry || page.error) return;
  remembered.delete(agentId);
  remembered.set(agentId, { page, at: Date.now() });
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next();
    if (oldest.done) break;
    remembered.delete(oldest.value);
  }
}

/** What is already known about this agent, or null. Never a request. */
export function cachedAgentPage(agentId: string): CloudAgentPage | null {
  return remembered.get(agentId)?.page ?? null;
}

/**
 * Read one agent, through the memory.
 *
 * `maxAgeMs` is how stale a remembered page may be and still be answered
 * without touching the child; zero is the honest default, because most callers
 * are asking BECAUSE something changed.
 */
export function fetchAgentPage(
  agentId: string,
  options: { maxAgeMs?: number } = {},
): Promise<CloudAgentPage> {
  const maxAgeMs = options.maxAgeMs ?? 0;
  const hit = remembered.get(agentId);
  if (hit && maxAgeMs > 0 && Date.now() - hit.at <= maxAgeMs) return Promise.resolve(hit.page);

  const running = inFlight.get(agentId);
  if (running) return running;

  const request = getAgentPage(agentId)
    .then((page) => {
      keep(agentId, page);
      return page;
    })
    .finally(() => {
      if (inFlight.get(agentId) === request) inFlight.delete(agentId);
    });
  inFlight.set(agentId, request);
  return request;
}

/**
 * Warm one agent the reader has not asked for yet.
 *
 * Fire and forget, and deliberately silent: a neighbour that fails to prefetch
 * must not put an error anywhere, because nobody asked for it. The reader
 * arriving on that row later gets the failure through their own read, worded
 * where they can see it.
 */
export function prefetchAgentPage(agentId: string | null | undefined): void {
  if (!agentId) return;
  if (remembered.has(agentId) || inFlight.has(agentId)) return;
  void fetchAgentPage(agentId, { maxAgeMs: AGENT_PAGE_FRESH_MS }).catch(() => {});
}

/** Forget one agent. Pressed when the reader deletes it on Cursor. */
export function forgetAgentPage(agentId: string): void {
  remembered.delete(agentId);
  inFlight.delete(agentId);
}

/** Forget everything. For tests, which must not inherit the last walk's fleet. */
export function forgetAllAgentPages(): void {
  remembered.clear();
  inFlight.clear();
}
