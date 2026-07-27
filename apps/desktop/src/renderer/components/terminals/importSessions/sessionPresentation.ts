import { relativeWhen } from "../../../lib/format";
import type { ExternalSessionMessage, ExternalSessionSummary } from "./contract";
import { shortenCwd } from "./affordances";

export function formatUpdatedAt(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  return relativeWhen(new Date(ms).toISOString());
}

function lastPathSegment(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const segments = cwd.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? null;
}

/** Collapses a prompt to one line so it can stand in as a heading. */
function asHeadingText(value: string | null | undefined): string | null {
  const collapsed = value?.replace(/\s+/gu, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > 72 ? `${collapsed.slice(0, 71).trimEnd()}…` : collapsed;
}

/**
 * Rows lead with a real provider-persisted title when there is one. Most Claude
 * CLI transcripts have none, which is why every such row used to degrade to
 * "ADE · 9m ago" — the folder name and a timestamp, telling you nothing about
 * the thread. The opening prompt (`preview`) is a far better name for the work,
 * so it comes next, and path+time stays as the last resort.
 */
export function sessionHeading(summary: ExternalSessionSummary): string {
  const title = summary.title?.trim();
  if (title) return title;
  const opening = asHeadingText(summary.preview);
  if (opening) return opening;
  const where = lastPathSegment(summary.cwd) ?? shortenCwd(summary.cwd);
  const when = formatUpdatedAt(summary.updatedAt);
  return when ? `${where} · ${when}` : where;
}

/**
 * The two anchors a row shows: what the thread started as, and where it left
 * off. Either may be absent — an older host predates both fields, and a thread
 * whose only human text was a slash command has no recoverable prompt.
 *
 * `started` is suppressed when the heading is already showing it, so a row never
 * prints the same sentence twice.
 */
export function sessionAnchors(summary: ExternalSessionSummary): {
  started: string | null;
  latest: ExternalSessionMessage | null;
} {
  const heading = sessionHeading(summary);
  const started = asHeadingText(summary.preview);
  const messages = summary.messages ?? [];
  const latest = messages.length > 0 ? messages[messages.length - 1]! : null;
  const latestText = latest ? asHeadingText(latest.text) : null;
  const startedText = started && started !== heading ? started : null;
  return {
    started: startedText,
    // `latest` is checked against both anchors. Against the heading because an
    // untitled single-message thread has heading === preview === that message,
    // and against `started` because a *titled* one has started === latest. Either
    // collision prints the same sentence twice, which reads as a rendering bug.
    latest: latest && latestText !== heading && latestText !== startedText ? latest : null,
  };
}
