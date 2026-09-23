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
  };
}

/** "10:24 AM" in the viewer's locale and time zone. */
export function formatProofClock(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/**
 * "10:24–10:25 AM". A day period both ends share is said once; a 24-hour
 * locale has none and reads "10:24–10:25".
 */
export function formatProofClockRange(fromIso: string, toIso: string, locale?: string): string {
  const from = formatProofClock(fromIso, locale);
  const to = formatProofClock(toIso, locale);
  if (from === to) return from;
  const period = /\s*[^\d\s:.]+\.?$/u.exec(to)?.[0] ?? "";
  if (period && from.endsWith(period)) return `${from.slice(0, -period.length)}–${to}`;
  return `${from}–${to}`;
}

/**
 * "Recorded by ADE · 10:24–10:25 AM" / "Captured by ADE" / "Attached by the
 * agent". Null for a row that predates the field.
 */
export function proofSourceLine(provenance: ProofProvenance, locale?: string): string | null {
  switch (provenance.source) {
    case "ade-recorder": {
      const { recordedFrom, recordedTo } = provenance;
      if (recordedFrom && recordedTo) {
        return `Recorded by ADE · ${formatProofClockRange(recordedFrom, recordedTo, locale)}`;
      }
      const single = recordedFrom ?? recordedTo;
      return single ? `Recorded by ADE · ${formatProofClock(single, locale)}` : "Recorded by ADE";
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
