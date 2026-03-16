import type {
  ArchiveLaneArgs,
  ClosePrArgs,
  CreateLaneArgs,
  CreatePrFromLaneArgs,
  LandPrArgs,
  ListLanesArgs,
  ListSessionsArgs,
  RequestPrReviewersArgs,
  SyncCommandPayload,
  SyncRemoteCommandAction,
  SyncRemoteCommandPolicy,
  SyncRunQuickCommandArgs,
  TerminalToolType,
} from "../../../shared/types";
import type { createLaneService } from "../lanes/laneService";
import type { Logger } from "../logging/logger";
import type { createPrService } from "../prs/prService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";

type SyncRemoteCommandServiceArgs = {
  laneService: ReturnType<typeof createLaneService>;
  prService: ReturnType<typeof createPrService>;
  ptyService: ReturnType<typeof createPtyService>;
  sessionService: ReturnType<typeof createSessionService>;
  logger: Logger;
};

type RegisteredRemoteCommand = {
  policy: SyncRemoteCommandPolicy;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asTrimmedString(entry)).filter((entry): entry is string => Boolean(entry));
}

function parseListLanesArgs(value: Record<string, unknown>): ListLanesArgs {
  return {
    includeArchived: asOptionalBoolean(value.includeArchived),
    includeStatus: asOptionalBoolean(value.includeStatus),
  };
}

function parseCreateLaneArgs(value: Record<string, unknown>): CreateLaneArgs {
  const name = asTrimmedString(value.name);
  if (!name) throw new Error("lanes.create requires name.");
  const description = asTrimmedString(value.description);
  const parentLaneId = asTrimmedString(value.parentLaneId);
  return {
    name,
    ...(description ? { description } : {}),
    ...(parentLaneId ? { parentLaneId } : {}),
  };
}

function parseArchiveLaneArgs(value: Record<string, unknown>): ArchiveLaneArgs {
  const laneId = asTrimmedString(value.laneId);
  if (!laneId) throw new Error("lanes.archive requires laneId.");
  return { laneId };
}

function parseListSessionsArgs(value: Record<string, unknown>): ListSessionsArgs {
  const laneId = asTrimmedString(value.laneId);
  const status = asTrimmedString(value.status) as ListSessionsArgs["status"];
  const limit = asOptionalNumber(value.limit);
  return {
    ...(laneId ? { laneId } : {}),
    ...(status ? { status } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
  };
}

function parseQuickCommandArgs(value: Record<string, unknown>): SyncRunQuickCommandArgs {
  const laneId = asTrimmedString(value.laneId);
  const title = asTrimmedString(value.title);
  const startupCommand = asTrimmedString(value.startupCommand);
  if (!laneId || !title || !startupCommand) {
    throw new Error("work.runQuickCommand requires laneId, title, and startupCommand.");
  }
  return {
    laneId,
    title,
    startupCommand,
    cols: asOptionalNumber(value.cols),
    rows: asOptionalNumber(value.rows),
    toolType: asTrimmedString(value.toolType),
  };
}

function requirePrId(value: Record<string, unknown>, action: string): string {
  const prId = asTrimmedString(value.prId);
  if (!prId) throw new Error(`${action} requires prId.`);
  return prId;
}

function parseCreatePrArgs(value: Record<string, unknown>): CreatePrFromLaneArgs {
  const laneId = asTrimmedString(value.laneId);
  const title = asTrimmedString(value.title);
  const body = typeof value.body === "string" ? value.body : "";
  if (!laneId || !title) throw new Error("prs.createFromLane requires laneId and title.");
  return {
    laneId,
    title,
    body,
    draft: value.draft === true,
    ...(asTrimmedString(value.baseBranch) ? { baseBranch: asTrimmedString(value.baseBranch)! } : {}),
    ...(asStringArray(value.labels).length ? { labels: asStringArray(value.labels) } : {}),
    ...(asStringArray(value.reviewers).length ? { reviewers: asStringArray(value.reviewers) } : {}),
    ...(typeof value.allowDirtyWorktree === "boolean" ? { allowDirtyWorktree: value.allowDirtyWorktree } : {}),
  };
}

function parseLandPrArgs(value: Record<string, unknown>): LandPrArgs {
  const prId = requirePrId(value, "prs.land");
  const method = asTrimmedString(value.method) as LandPrArgs["method"];
  if (!method || !["merge", "squash", "rebase"].includes(method)) {
    throw new Error("prs.land requires method to be merge, squash, or rebase.");
  }
  return { prId, method };
}

function parseClosePrArgs(value: Record<string, unknown>): ClosePrArgs {
  const prId = requirePrId(value, "prs.close");
  return {
    prId,
    ...(typeof value.comment === "string" ? { comment: value.comment } : {}),
  };
}

function parseRequestReviewersArgs(value: Record<string, unknown>): RequestPrReviewersArgs {
  const prId = requirePrId(value, "prs.requestReviewers");
  const reviewers = asStringArray(value.reviewers);
  if (reviewers.length === 0) throw new Error("prs.requestReviewers requires at least one reviewer.");
  return { prId, reviewers };
}

export function createSyncRemoteCommandService(args: SyncRemoteCommandServiceArgs) {
  const registry = new Map<SyncRemoteCommandAction, RegisteredRemoteCommand>([
    ["lanes.list", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.laneService.list(parseListLanesArgs(payload)),
    }],
    ["lanes.refreshSnapshots", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.laneService.refreshSnapshots(parseListLanesArgs(payload)),
    }],
    ["lanes.create", {
      policy: { viewerAllowed: true, queueable: true },
      handler: async (payload) => args.laneService.create(parseCreateLaneArgs(payload)),
    }],
    ["lanes.archive", {
      policy: { viewerAllowed: true, queueable: true },
      handler: async (payload) => {
        await args.laneService.archive(parseArchiveLaneArgs(payload));
        return { ok: true };
      },
    }],
    ["lanes.unarchive", {
      policy: { viewerAllowed: true, queueable: true },
      handler: async (payload) => {
        await args.laneService.unarchive(parseArchiveLaneArgs(payload));
        return { ok: true };
      },
    }],
    ["work.listSessions", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.sessionService.list(parseListSessionsArgs(payload)),
    }],
    ["work.runQuickCommand", {
      policy: { viewerAllowed: true, queueable: true },
      handler: async (payload) => {
        const parsed = parseQuickCommandArgs(payload);
        return await args.ptyService.create({
          laneId: parsed.laneId,
          title: parsed.title,
          startupCommand: parsed.startupCommand,
          tracked: true,
          cols: parsed.cols ?? 120,
          rows: parsed.rows ?? 36,
          toolType: (parsed.toolType ?? "run-shell") as TerminalToolType,
        });
      },
    }],
    ["prs.list", {
      policy: { viewerAllowed: true },
      handler: async () => args.prService.listAll(),
    }],
    ["prs.refresh", {
      policy: { viewerAllowed: true },
      handler: async (payload) => {
        const prId = asTrimmedString(payload.prId);
        return await args.prService.refreshSnapshots(prId ? { prId } : {});
      },
    }],
    ["prs.getDetail", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.prService.getDetail(requirePrId(payload, "prs.getDetail")),
    }],
    ["prs.getStatus", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.prService.getStatus(requirePrId(payload, "prs.getStatus")),
    }],
    ["prs.getChecks", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.prService.getChecks(requirePrId(payload, "prs.getChecks")),
    }],
    ["prs.getReviews", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.prService.getReviews(requirePrId(payload, "prs.getReviews")),
    }],
    ["prs.getComments", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.prService.getComments(requirePrId(payload, "prs.getComments")),
    }],
    ["prs.getFiles", {
      policy: { viewerAllowed: true },
      handler: async (payload) => args.prService.getFiles(requirePrId(payload, "prs.getFiles")),
    }],
    ["prs.createFromLane", {
      policy: { viewerAllowed: true, queueable: true },
      handler: async (payload) => args.prService.createFromLane(parseCreatePrArgs(payload)),
    }],
    ["prs.land", {
      policy: { viewerAllowed: true, queueable: true },
      handler: async (payload) => args.prService.land(parseLandPrArgs(payload)),
    }],
    ["prs.close", {
      policy: { viewerAllowed: true, queueable: true },
      handler: async (payload) => {
        await args.prService.closePr(parseClosePrArgs(payload));
        return { ok: true };
      },
    }],
    ["prs.requestReviewers", {
      policy: { viewerAllowed: true, queueable: true },
      handler: async (payload) => {
        await args.prService.requestReviewers(parseRequestReviewersArgs(payload));
        return { ok: true };
      },
    }],
  ]);

  return {
    getSupportedActions(): SyncRemoteCommandAction[] {
      return [...registry.keys()];
    },

    getPolicy(action: string): SyncRemoteCommandPolicy | null {
      return registry.get(action as SyncRemoteCommandAction)?.policy ?? null;
    },

    async execute(payload: SyncCommandPayload): Promise<unknown> {
      const handler = registry.get(payload.action as SyncRemoteCommandAction);
      if (!handler) {
        throw new Error(`Unsupported remote command: ${payload.action}`);
      }
      const commandArgs = isRecord(payload.args) ? payload.args : {};
      args.logger.debug?.("sync.remote_command.execute", {
        action: payload.action,
        policy: handler.policy,
      });
      return await handler.handler(commandArgs);
    },
  };
}

export type SyncRemoteCommandService = ReturnType<typeof createSyncRemoteCommandService>;
