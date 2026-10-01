import type {
  ArchiveActionArgs,
  ArchiveActionResult,
  ArchiveListArgs,
  ArchiveListResult,
  ArchiveSummary,
  ArchiveSummaryArgs,
} from "../../../shared/types/archive";
import { DEFAULT_ARCHIVE_STALE_DAYS } from "../../../shared/types/archive";
import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";

/**
 * `window.ade.archive` over the sync channel. Reads degrade to an empty
 * archive on a host that predates `archive.*`; restore and delete are writes,
 * so on such a host they fail rather than report work that never happened.
 */
export function createArchiveNamespace(infra: AdapterInfra): AdeNamespace<"archive"> {
  const { commands } = infra;

  const emptySummary = (olderThanDays?: number): ArchiveSummary => ({
    total: 0,
    byKind: { lane: 0, chat: 0, shell: 0 },
    olderThanDays: olderThanDays ?? DEFAULT_ARCHIVE_STALE_DAYS,
    staleTotal: 0,
    staleByKind: { lane: 0, chat: 0, shell: 0 },
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
        return await commands.call<ArchiveActionResult>("archive.restore", { ...args }, {
          fallback: () => {
            throw new Error("The archive is unavailable on the connected ADE host.");
          },
          idempotent: false,
        });
      } finally {
        invalidate();
      }
    },
    delete: async (args: ArchiveActionArgs, pin?: RuntimePinArg): Promise<ArchiveActionResult> => {
      assertWebRuntimePinRoutable("archive.delete", pin, infra);
      try {
        return await commands.call<ArchiveActionResult>("archive.delete", { ...args }, {
          fallback: () => {
            throw new Error("The archive is unavailable on the connected ADE host.");
          },
          idempotent: false,
        });
      } finally {
        invalidate();
      }
    },
  };
}
