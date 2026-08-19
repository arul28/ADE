/**
 * Argument validation for the lane-story reads.
 *
 * It lives in its own module because FOUR entry points reach these reads — the
 * IPC action registry, preload, the sync remote-command host and the CLI — and
 * each one used to carry its own copy of the caps. One module means one place
 * where "how big may a read be" is decided, and no transport can bypass it:
 * the service itself calls these before touching the database.
 */

export const DEFAULT_LIST_LIMIT = 500;
export const MAX_LIST_LIMIT = 2000;
export const MAX_SUMMARY_LANES = 200;

/** A list request with every field decided: no optionals left to interpret. */
export type ValidatedListArgs = {
  laneId: string;
  limit: number;
  sinceTs: string | null;
  persistedOnly: boolean;
};

export function validateListArgs(rawArgs: unknown): ValidatedListArgs {
  const args = (rawArgs ?? {}) as { laneId?: unknown; limit?: unknown; sinceTs?: unknown; persistedOnly?: unknown };
  const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
  if (!laneId) throw new Error("laneEvents.list requires laneId as a non-empty string.");

  const rawLimit = args.limit;
  if (rawLimit != null && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit))) {
    throw new Error("laneEvents.list limit must be a finite number.");
  }
  const limit = rawLimit == null
    ? DEFAULT_LIST_LIMIT
    : Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(rawLimit)));

  const rawSince = args.sinceTs;
  if (rawSince != null && typeof rawSince !== "string") {
    throw new Error("laneEvents.list sinceTs must be a string or null.");
  }
  const trimmedSince = typeof rawSince === "string" ? rawSince.trim() : "";
  if (trimmedSince && Number.isNaN(Date.parse(trimmedSince))) {
    throw new Error("laneEvents.list sinceTs must be an ISO-8601 timestamp.");
  }

  const rawPersistedOnly = args.persistedOnly;
  if (rawPersistedOnly != null && typeof rawPersistedOnly !== "boolean") {
    throw new Error("laneEvents.list persistedOnly must be a boolean.");
  }

  return {
    laneId,
    limit,
    sinceTs: trimmedSince || null,
    persistedOnly: rawPersistedOnly === true,
  };
}

export function validateSummaryArgs(args: unknown): string[] {
  const raw = (args as { laneIds?: unknown } | null | undefined)?.laneIds;
  if (!Array.isArray(raw)) throw new Error("laneEvents.summary requires laneIds as an array.");
  const laneIds: string[] = [];
  for (const laneId of raw) {
    if (typeof laneId !== "string") throw new Error("laneEvents.summary laneIds must be strings.");
    const trimmed = laneId.trim();
    if (trimmed && !laneIds.includes(trimmed)) laneIds.push(trimmed);
  }
  // A capped fan-out: the List view asks for the lanes it can see, and an
  // unbounded array would turn one call into an unbounded number of reads.
  return laneIds.slice(0, MAX_SUMMARY_LANES);
}
