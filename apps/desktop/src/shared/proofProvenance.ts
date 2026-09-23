/**
 * Where a proof artifact's bytes came from, as the broker stamps it in
 * `metadata`, and the one quiet line each proof surface prints about it.
 *
 * Rows filed before these fields existed carry none of them. Missing means
 * unknown, and unknown prints nothing.
 */

export type ComputerUseProofSource = "ade-recorder" | "ade-capture" | "attached";

/**
 * Metadata keys only the broker may write. An input's own metadata is filed
 * too, so without this list a caller could claim "ade-recorder" for a file it
 * copied from somewhere.
 */
export const PROOF_PROVENANCE_METADATA_KEYS = [
  "proofSource",
  "recordedFrom",
  "recordedTo",
  "contentSha256",
  "contentBytes",
  "mediaCreatedAt",
  "recordedBeforeRequest",
] as const;

export const PROOF_DUPLICATE_CODE = "PROOF_DUPLICATE" as const;

export type ProofProvenance = {
  source: ComputerUseProofSource | null;
  recordedFrom: string | null;
  recordedTo: string | null;
  mediaCreatedAt: string | null;
  recordedBeforeRequest: boolean;
  /**
   * Still time the recorder left out of the video. The recorder writes it
   * into the input's own metadata; it only shortens the file, so a caller
   * claiming it gains nothing.
   */
  idleCutMs: number | null;
};

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

export function readProofProvenance(metadata: unknown): ProofProvenance {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const source = record.proofSource === "ade-recorder"
    || record.proofSource === "ade-capture"
    || record.proofSource === "attached"
    ? record.proofSource
    : null;
  return {
    source,
    recordedFrom: isoOrNull(record.recordedFrom),
    recordedTo: isoOrNull(record.recordedTo),
    mediaCreatedAt: isoOrNull(record.mediaCreatedAt),
    recordedBeforeRequest: record.recordedBeforeRequest === true,
    idleCutMs: typeof record.idleCutMs === "number" && Number.isFinite(record.idleCutMs) && record.idleCutMs > 0
      ? record.idleCutMs
      : null,
  };
}

/** "0:23" / "1:04:02". */
export function formatProofDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "idle cut 1:52", or null when less than a second was cut. */
export function proofIdleCutLabel(idleCutMs: number | null | undefined): string | null {
  if (typeof idleCutMs !== "number" || !Number.isFinite(idleCutMs) || idleCutMs < 1000) return null;
  return `idle cut ${formatProofDuration(idleCutMs)}`;
}

/** "10:24 AM" in the viewer's locale and time zone. */
export function formatProofClock(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/**
 * "10:24–10:25 AM". A day period both ends share is said once; a 24-hour
 * locale has none and reads "10:24–10:25". The period is everything after the
 * last digit, so a dotted one ("a.m.", "a. m.") stays whole.
 */
export function formatProofClockRange(fromIso: string, toIso: string, locale?: string): string {
  const from = formatProofClock(fromIso, locale);
  const to = formatProofClock(toIso, locale);
  if (from === to) return from;
  const period = /\P{Nd}+$/u.exec(to)?.[0] ?? "";
  if (period && from.endsWith(period)) return `${from.slice(0, -period.length)}–${to}`;
  return `${from}–${to}`;
}

/**
 * "Recorded by ADE · 10:24–10:27 AM · idle cut 1:52" / "Captured by ADE" /
 * "Attached by the agent". Null for a row that predates the field. The times
 * are wall-clock; the idle cut says why the video is shorter than they span.
 */
export function proofSourceLine(provenance: ProofProvenance, locale?: string): string | null {
  switch (provenance.source) {
    case "ade-recorder": {
      const { recordedFrom, recordedTo } = provenance;
      const idleCut = proofIdleCutLabel(provenance.idleCutMs);
      const suffix = idleCut ? ` · ${idleCut}` : "";
      if (recordedFrom && recordedTo) {
        return `Recorded by ADE · ${formatProofClockRange(recordedFrom, recordedTo, locale)}${suffix}`;
      }
      const single = recordedFrom ?? recordedTo;
      return single ? `Recorded by ADE · ${formatProofClock(single, locale)}${suffix}` : `Recorded by ADE${suffix}`;
    }
    case "ade-capture":
      return "Captured by ADE";
    case "attached":
      return "Attached by the agent";
    default:
      return null;
  }
}

/** "Recorded at 5:19 AM, before this request." Null unless flagged. */
export function proofRecordedBeforeRequestLine(provenance: ProofProvenance, locale?: string): string | null {
  if (!provenance.recordedBeforeRequest) return null;
  return provenance.mediaCreatedAt
    ? `Recorded at ${formatProofClock(provenance.mediaCreatedAt, locale)}, before this request.`
    : "Recorded before this request.";
}

/** Owner kinds some proof drawer lists by: lane, chat, automation run, PR and issue. */
const DRAWER_OWNER_KINDS: ReadonlySet<string> = new Set([
  "lane",
  "chat_session",
  "automation_run",
  "github_pr",
  "linear_issue",
]);

/** Whether a proof with these owners shows in any drawer. One with none is filed nowhere. */
export function hasDrawerOwner(owners: ReadonlyArray<{ kind: string | null | undefined }>): boolean {
  return owners.some((owner) => Boolean(owner.kind && DRAWER_OWNER_KINDS.has(owner.kind)));
}
