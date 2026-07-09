import { relativeWhen } from "../../../lib/format";
import type { ExternalSessionSummary } from "./contract";
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

export function sessionHeading(summary: ExternalSessionSummary): string {
  const title = summary.title?.trim();
  if (title) return title;
  const where = lastPathSegment(summary.cwd) ?? shortenCwd(summary.cwd);
  const when = formatUpdatedAt(summary.updatedAt);
  return when ? `${where} · ${when}` : where;
}
