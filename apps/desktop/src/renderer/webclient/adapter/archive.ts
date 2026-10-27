import type {
  ArchiveActionArgs,
  ArchiveActionResult,
  ArchiveListArgs,
  ArchiveListResult,
  ArchiveSummary,
  ArchiveSummaryArgs,
} from "../../../shared/types/archive";
import { DEFAULT_ARCHIVE_STALE_DAYS } from "../../../shared/types/archive";
import { emptyArchiveCounts } from "../../../shared/archive";
import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";

/**
 * `window.ade.archive` over the sync channel. Reads degrade to an empty
 * archive on a host that predates `archive.*`; restore and delete are writes,
 * so on such a host they fail rather than report work that never happened.
 */
export function createArchiveNamespace(infra: AdapterInfra): AdeNamespace<"archive"> {
  const { commands } = infra;
  // A read carries a fallback; a mutation has none — its fallback could never
  // be resolved — so the two shapes stay disjoint at the call site.
  const mutation = { idempotent: false } as const;

  const emptySummary = (olderThanDays?: number): ArchiveSummary => ({
    total: 0,
    byKind: emptyArchiveCounts(),
    olderThanDays: olderThanDays ?? DEFAULT_ARCHIVE_STALE_DAYS,
    staleTotal: 0,
    staleByKind: emptyArchiveCounts(),
    staleBytes: null,
    oldestArchivedAt: null,
  });

  const invalidate = () => {
    commands.invalidateCache(["archive.", "lanes.list", "lanes.refreshSnapshots", "sessions.list", "chat.listSessions"]);
  };

  return {
    list: async (args?: ArchiveListArgs, pin?: RuntimePinArg): Promise<ArchiveListResult> => {
      assertWebRuntimePinRoutable("archive.list", pin, infra);
      return commands.call<ArchiveListResult>("archive.list", { ...(args ?? {}) }, {
        fallback: { items: [] },
        idempotent: true,
      });
    },
    summary: async (args?: ArchiveSummaryArgs, pin?: RuntimePinArg): Promise<ArchiveSummary> => {
      assertWebRuntimePinRoutable("archive.summary", pin, infra);
      return commands.call<ArchiveSummary>("archive.summary", { ...(args ?? {}) }, {
        fallback: emptySummary(args?.olderThanDays),
        idempotent: true,
      });
    },
    restore: async (args: ArchiveActionArgs, pin?: RuntimePinArg): Promise<ArchiveActionResult> => {
      assertWebRuntimePinRoutable("archive.restore", pin, infra);
      try {
        return await commands.call<ArchiveActionResult>("archive.restore", { ...args }, mutation);
      } finally {
        invalidate();
      }
    },
    delete: async (args: ArchiveActionArgs, pin?: RuntimePinArg): Promise<ArchiveActionResult> => {
      assertWebRuntimePinRoutable("archive.delete", pin, infra);
      try {
        return await commands.call<ArchiveActionResult>("archive.delete", { ...args }, mutation);
      } finally {
        invalidate();
      }
    },
  };
}
