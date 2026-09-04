/**
 * Where this History page should open, from the host's own envelope.
 *
 * The compiled page kept the selected surface / lane / commit / event in the
 * renderer ROUTE. A guest has no route. The host puts the same facts on
 * `context` (a deeplink's `ctx`, a socket press, a pointer) and the page's
 * `ui-state` collection remembers where the reader was last time. Host always
 * wins: a page the host opened AT a commit never lands on last week's event.
 */

import type { PluginWebviewContext } from "../bridge";
import type { HistoryUiState } from "../host/uiState";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export type HistoryFocus = {
  surface: HistoryUiState["surface"] | null;
  laneId: string | null;
  commitSha: string | null;
  eventId: string | null;
};

export function historyFocusFromContext(context: PluginWebviewContext): HistoryFocus {
  const pointer: Record<string, unknown> = context.pointer ?? {};
  const subject: Record<string, unknown> = context.subject ?? {};
  const surfaceFromHost =
    context.surfaceId === "activity" || context.surfaceId === "commits"
      ? context.surfaceId
      : text(pointer.surface) === "activity" || text(pointer.surface) === "commits"
        ? (text(pointer.surface) as HistoryUiState["surface"])
        : null;
  const laneId =
    text(pointer.laneId)
    ?? (subject.kind === "lane" ? text(subject.id) : null)
    ?? text(subject.laneId);
  const commitSha =
    text(pointer.commitSha)
    ?? text(pointer.sha)
    ?? (subject.kind === "commit" ? text(subject.id) ?? text(subject.sha) : null)
    ?? text(subject.commitSha);
  const eventId =
    text(pointer.eventId)
    ?? text(pointer.operationId)
    ?? (subject.kind === "operation" ? text(subject.id) : null)
    ?? text(subject.eventId);
  return { surface: surfaceFromHost, laneId, commitSha, eventId };
}

export function applyHistoryPath(
  path: string,
): HistoryFocus | null {
  let url: URL;
  try {
    url = new URL(path, "https://ade.invalid");
  } catch {
    return null;
  }
  if (url.pathname !== "/history" && !url.pathname.startsWith("/history")) return null;
  const surfaceRaw = url.searchParams.get("surface");
  const surface =
    surfaceRaw === "activity" || surfaceRaw === "commits" ? surfaceRaw : null;
  return {
    surface,
    laneId: text(url.searchParams.get("laneId")),
    commitSha: text(url.searchParams.get("commitSha")),
    eventId: text(url.searchParams.get("eventId")),
  };
}
