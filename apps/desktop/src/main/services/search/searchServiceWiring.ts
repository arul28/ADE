import type {
  FilesQuickOpenArgs,
  FilesQuickOpenItem,
  FilesSearchTextArgs,
  FilesSearchTextMatch
} from "../../../shared/types";
import type { LaneSummary } from "../../../shared/types/lanes";
import type { GitBranchSummary, GitCommitSummary } from "../../../shared/types/git";
import type { PrComment, PrDetail, PrSummary } from "../../../shared/types/prs";
import type { TerminalSessionSummary } from "../../../shared/types/sessions";
import type { Logger } from "../logging/logger";
import { createSearchService, type SearchService } from "./searchService";

/**
 * Host-level assembly for the universal search service, shared by the desktop
 * main process and the `ade serve` daemon so their wiring cannot drift. It
 * binds the delegated sources, subscribes the session/chat hooks, and owns the
 * deferred backfill kickoff. Hosts keep only the hooks that live inside their
 * own event plumbing (PTY broadcastData, PR event emitter, lane lifecycle).
 *
 * Known limitation: when the desktop app and the brain daemon are both up for
 * one project, each runs its own ingestion over the shared index file. Writes
 * converge (doc ids are deterministic, upserts idempotent, cursors shared via
 * the sources table, WAL + busy_timeout serialize writers) at the cost of some
 * duplicate IO and occasional SQLITE_BUSY retry noise in logs.
 */

export type ProjectSearchServiceArgs = {
  cacheDir: string;
  transcriptsDir: string;
  chatTranscriptsDir: string;
  logger: Logger;
  sessionService: {
    list: (args: { limit: number | null }) => TerminalSessionSummary[];
    get: (sessionId: string) => TerminalSessionSummary | null;
    onChanged: (listener: (event: { sessionId: string; reason: string }) => void) => unknown;
  };
  laneService: {
    list: (args: { includeArchived: boolean; includeStatus: boolean }) => Promise<LaneSummary[]>;
  };
  agentChatService?: {
    subscribeToEvents: (callback: (envelope: { sessionId: string }) => void) => unknown;
  } | null;
  prService?: {
    listAll: (args?: { laneId?: string }) => PrSummary[] | Promise<PrSummary[]>;
    getDetail: (prId: string) => Promise<PrDetail | null>;
    getComments: (prId: string) => Promise<PrComment[]>;
  } | null;
  gitService?: {
    listRecentCommits: (args: { laneId: string; limit?: number }) => Promise<GitCommitSummary[]>;
    listBranches: (args: { laneId: string }) => Promise<GitBranchSummary[]>;
  } | null;
  fileService?: {
    quickOpen: (args: FilesQuickOpenArgs) => Promise<FilesQuickOpenItem[]>;
    searchText: (args: FilesSearchTextArgs) => Promise<FilesSearchTextMatch[]>;
  } | null;
  artifactBroker?: {
    listArtifacts: (args: { limit?: number }) => Array<{
      id: string;
      title: string;
      description: string | null;
      createdAt: string;
    }>;
  } | null;
  linearIssueTracker?: {
    searchIssues: (params: { query: string; first?: number }) => Promise<{
      issues: Array<{
        identifier: string;
        title: string;
        description?: string | null;
        updatedAt?: string | null;
      }>;
    }>;
  } | null;
  /** Delay before the initial backfill so index writes stay out of the host's boot window. */
  backfillDelayMs: number;
};

export function createProjectSearchService(args: ProjectSearchServiceArgs): SearchService {
  const { sessionService, laneService, prService, gitService, fileService } = args;

  const resolvePrimaryLaneId = async (): Promise<string | null> => {
    try {
      const lanes = await laneService.list({ includeArchived: false, includeStatus: false });
      return lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null;
    } catch {
      return null;
    }
  };

  const searchService = createSearchService({
    cacheDir: args.cacheDir,
    transcriptsDir: args.transcriptsDir,
    chatTranscriptsDir: args.chatTranscriptsDir,
    logger: args.logger,
    sessions: {
      list: async () => sessionService.list({ limit: null }),
      get: async (sessionId) => sessionService.get(sessionId)
    },
    lanes: {
      list: async () => laneService.list({ includeArchived: false, includeStatus: false })
    },
    prs: prService
      ? {
          listAll: (listArgs) => prService.listAll(listArgs),
          getDetail: (prId) => prService.getDetail(prId),
          getComments: (prId) => prService.getComments(prId)
        }
      : null,
    git: gitService
      ? {
          listRecentCommits: (gitArgs) => gitService.listRecentCommits(gitArgs),
          listBranches: (gitArgs) => gitService.listBranches(gitArgs)
        }
      : null,
    files: fileService
      ? {
          quickOpen: async (query, limit, laneId) => {
            const workspaceId = laneId ?? (await resolvePrimaryLaneId());
            if (!workspaceId) return [];
            return fileService.quickOpen({ workspaceId, query, limit });
          },
          searchText: async (query, limit, laneId) => {
            const workspaceId = laneId ?? (await resolvePrimaryLaneId());
            if (!workspaceId) return [];
            return fileService.searchText({ workspaceId, query, limit });
          }
        }
      : null,
    artifacts: args.artifactBroker
      ? {
          list: (limit) => args.artifactBroker!.listArtifacts({ limit })
        }
      : null,
    linear: args.linearIssueTracker
      ? {
          searchIssues: (query) => args.linearIssueTracker!.searchIssues({ query, first: 25 })
        }
      : null
  });

  const unsubscribeSession = sessionService.onChanged((event) => {
    searchService.notifySessionChanged(
      event.sessionId,
      event.reason === "deleted" ? "deleted" : "meta-updated"
    );
  });
  const unsubscribeChat = args.agentChatService?.subscribeToEvents?.((envelope) => {
    searchService.notifyChatEvent(envelope.sessionId);
  });

  const backfillTimer = setTimeout(() => searchService.startBackfill(), args.backfillDelayMs);
  backfillTimer.unref?.();

  return {
    ...searchService,
    dispose: () => {
      clearTimeout(backfillTimer);
      if (typeof unsubscribeSession === "function") unsubscribeSession();
      if (typeof unsubscribeChat === "function") unsubscribeChat();
      searchService.dispose();
    }
  };
}
