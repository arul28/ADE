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

/**
 * Did the host actually ASK for something, or is it merely describing the
 * placement it drew?
 *
 * `surfaceId` is on every envelope, always, because it is how a guest knows
 * which of a manifest's surfaces it is drawing. Reading it as an instruction
 * made the stored surface unreachable: every open said "commits", so a reader
 * who left History on Activity came back to the commit graph, forever. A
 * pointer or a subject is the host saying "open AT this" — without one there is
 * no request, only a placement, and the reader's own last choice wins.
 */
function hostNamedATarget(context: PluginWebviewContext): boolean {
  const pointer = context.pointer;
  if (pointer && typeof pointer === "object" && Object.keys(pointer).length > 0) return true;
  return context.subject != null;
}

function asSurface(value: string | null): HistoryUiState["surface"] | null {
  return value === "activity" || value === "commits" ? value : null;
}

export function historyFocusFromContext(context: PluginWebviewContext): HistoryFocus {
  const pointer: Record<string, unknown> = context.pointer ?? {};
  const subject: Record<string, unknown> = context.subject ?? {};
  // A pointer that names a surface is unambiguous and always wins. `surfaceId`
  // is trusted only alongside a pointer or a subject; see `hostNamedATarget`.
  const surfaceFromHost =
    asSurface(text(pointer.surface))
    ?? (hostNamedATarget(context) ? asSurface(context.surfaceId ?? null) : null);
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
