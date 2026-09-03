/**
 * Which run the page opens on.
 *
 * Moved from `apps/desktop/src/renderer/components/review/reviewRouteState.ts` (13),
 * with the one change the page tier forces: the compiled page kept the selected
 * run in the renderer ROUTE — `useSearchParams`, `?runId=…`, `navigate(…,
 * {replace: true})` — and a guest has no route to write. The page owns its own
 * navigation now, so the same two functions read and build a search STRING and
 * the caller decides where it lives.
 *
 * There are three places a run id can arrive from, and the order below is the
 * order they win in:
 *
 * 1. `context.pointer.runId` / `context.subject` — the host opened this page
 *    AT a run (a deeplink, a socket press on a row that names one). That is an
 *    instruction, not a preference.
 * 2. The page's own URL query, for a host that put the envelope there.
 * 3. The `ui-state` collection — where the reader was last time.
 */

import type { PluginWebviewContext } from "../bridge";

export function readReviewRunId(search: string): string | null {
  const params = new URLSearchParams(search);
  const runId = params.get("runId")?.trim();
  return runId && runId.length > 0 ? runId : null;
}

export function buildReviewSearch(runId: string | null): string {
  const params = new URLSearchParams();
  const trimmedRunId = runId?.trim();
  if (trimmedRunId) params.set("runId", trimmedRunId);
  const next = params.toString();
  return next.length ? `?${next}` : "";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The run the HOST asked for, if it asked for one. Never the stored one.
 *
 * Read from three places because the host puts it in three: a deeplink's `ctx`
 * (`ade://plugin/ade-review/runs?ctx={"runId":…}` — `ctx` is the only query key
 * that route passes through, so a run id has to ride inside it), a socket press
 * whose subject IS the run, and the pointer a host that navigates within the
 * page sets. `subject.runId` is read for ANY subject kind rather than only for
 * `review-run`: a deeplink context arrives as an opaque object, and refusing it
 * over its missing `kind` would lose the one instruction the reader gave.
 */
export function runIdFromContext(context: PluginWebviewContext): string | null {
  const pointer = context.pointer ?? {};
  const subject = context.subject ?? null;
  const fromHost =
    text(pointer.runId)
    ?? text(subject?.runId)
    ?? (subject?.kind === "review-run" ? text(subject.id) : null)
    ?? text(pointer.id);
  if (fromHost) return fromHost;
  if (typeof window === "undefined") return null;
  try {
    return readReviewRunId(window.location.search);
  } catch {
    return null;
  }
}

/** The lane the host opened this page at, for the launch form's default. */
export function laneIdFromContext(context: PluginWebviewContext): string | null {
  const pointer = context.pointer ?? {};
  const subject = context.subject ?? null;
  return (
    text(pointer.laneId)
    ?? (subject?.kind === "lane" ? text(subject.id) : null)
    ?? (subject ? text(subject.laneId) : null)
  );
}

/**
 * The pull request the host opened this page at.
 *
 * The `prs` toolbar button's whole payload: `{kind: "pr", id, laneId, number}`,
 * the same subject the compiled `PrRequestAiReviewDialog` was handed. A launch
 * form opened from it is locked to `pr` mode and `auto_publish`, exactly as that
 * dialog was.
 */
export function prFromContext(
  context: PluginWebviewContext,
): { prId: string; laneId: string | null; number: number | null } | null {
  const subject = context.subject ?? null;
  if (!subject || subject.kind !== "pr") return null;
  const prId = text(subject.id) ?? text(subject.prId);
  if (!prId) return null;
  const number = typeof subject.number === "number" && Number.isFinite(subject.number)
    ? subject.number
    : null;
  return { prId, laneId: text(subject.laneId), number };
}
