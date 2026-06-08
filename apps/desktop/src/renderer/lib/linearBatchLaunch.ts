import type {
  AgentChatCliLaunchProvider,
  AgentChatContextAttachment,
  AgentChatPermissionMode,
  AgentChatProvider,
  LaneLinearIssue,
  LaneSummary,
} from "../../shared/types";
import {
  makeLinearIssueContextAttachment,
} from "../../shared/chatContextAttachments";
import { linearIssueLaneName } from "../../shared/linearIssueBranch";
import {
  getModelById,
  getRuntimeModelRefForDescriptor,
  modelSupportsFastMode,
  resolveCursorCliModelVariant,
  resolveProviderGroupForModel,
  type ModelDescriptor,
} from "../../shared/modelRegistry";
import { resolveModelDescriptorWithRuntimeCatalog } from "../components/shared/ModelPicker/modelCatalog";

/** Whether an issue launches the in-process chat SDK or a tracked CLI agent. */
export type BatchLaunchSessionType = "chat" | "cli";

/** Per-issue launch configuration captured in the batch launch modal. */
export type BatchLaunchIssueConfig = {
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  /** Editable kickoff prompt; when blank, a default issue-derived prompt is used. */
  kickoffPrompt: string;
  /** Editable branch name; when blank, derived from the issue identifier/title. */
  branchOverride: string;
  /** Chat (in-process SDK) vs CLI (tracked terminal agent). Defaults to "chat". */
  sessionType?: BatchLaunchSessionType;
  /**
   * Unified permission mode for CLI launches; chat launches default the mode
   * server-side and ignore this. When null the CLI launch uses its default.
   */
  permissionMode?: AgentChatPermissionMode | null;
  /** When launching into an existing lane (skips lane creation). */
  existingLaneId?: string | null;
  /** When true the orchestrator only creates the lane (no agent kickoff). */
  laneOnly?: boolean;
};

export type BatchLaunchItemStatus =
  | "pending"
  | "creating-lane"
  | "launching-agent"
  | "done"
  | "failed";

export type BatchLaunchItemState = {
  issue: LaneLinearIssue;
  status: BatchLaunchItemStatus;
  laneId: string | null;
  sessionId: string | null;
  error: string | null;
};

export type BatchLaunchResult = {
  /** Lane ids created during this run, in completion order. */
  createdLaneIds: string[];
  /** Chat session ids launched during this run, in completion order. */
  createdSessionIds: string[];
  /** Issue ids that failed (lane create or agent launch). */
  failedIssueIds: string[];
};

/** Concurrency cap — keep the daemon git-worktree mutations and warmups bounded. */
export const BATCH_LAUNCH_CONCURRENCY = 3;

/**
 * Generic kickoff instruction — intentionally does NOT name a specific issue.
 * The concrete issue is carried per-session by the attached Linear context and
 * the `ADE_LINEAR_ISSUE_IDS` env var, so a single instruction is safe to share
 * across a batch (and "apply to all" can never cross-wire agents onto the wrong
 * ticket). Each agent reads ITS attached issue, not whatever the text names.
 */
export function defaultKickoffIntro(): string {
  return (
    "Resolve the Linear issue attached to this session. Its full details are in your context, and its identifier is in the `ADE_LINEAR_ISSUE_IDS` environment variable — work on THAT issue. " +
    "Start by verifying the issue is still relevant against the latest remote main — confirm it reproduces or still applies. " +
    "Then make the change the ticket describes (bug fix, implementation, or whatever it specifies), keeping your work scoped to that issue. " +
    "Read and update the issue with the `ade linear` CLI (issue, comment, set-state, assign, label) — see the ade-linear skill; prefer it over any Linear MCP."
  );
}

/**
 * The kickoff prompt sent to a freshly launched agent. Generic by design (see
 * defaultKickoffIntro) — the issue itself rides on the per-session context
 * attachment, so this same text is correct for every issue in a batch.
 */
export function defaultKickoffPrompt(): string {
  return defaultKickoffIntro();
}

function resolveDescriptor(modelId: string): ModelDescriptor | undefined {
  return resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
}

/** Maps a registry model id to the chat-runtime provider + runtime-facing model id. */
export function resolveLaunchProviderAndModel(modelId: string): {
  provider: AgentChatProvider;
  model: string;
  descriptor: ModelDescriptor | undefined;
} {
  const descriptor = resolveDescriptor(modelId);
  if (!descriptor) {
    return { provider: "opencode" as AgentChatProvider, model: modelId, descriptor };
  }
  const group = resolveProviderGroupForModel(descriptor);
  const model = group === "opencode" ? modelId : getRuntimeModelRefForDescriptor(descriptor, group);
  return { provider: group as AgentChatProvider, model, descriptor };
}

export function batchLaunchSupportsFastMode(modelId: string): boolean {
  return modelSupportsFastMode(resolveDescriptor(modelId));
}

/**
 * Maps a registry model id to the CLI launch provider + runtime model ref for a
 * tracked-terminal launch. The provider-group set
 * (claude|codex|cursor|droid|opencode) is identical to the CLI launch provider
 * set, so the group doubles as the CLI profile; unknown models fall back to
 * OpenCode with the raw model id.
 */
export function resolveCliLaunchProviderAndModel(
  modelId: string,
  options?: {
    reasoningEffort?: string | null;
    fastMode?: boolean | null;
  },
): {
  provider: AgentChatCliLaunchProvider;
  model: string;
} {
  const descriptor = resolveDescriptor(modelId);
  if (!descriptor) {
    return { provider: "opencode", model: modelId };
  }
  const group = resolveProviderGroupForModel(descriptor);
  const model = group === "cursor"
    ? resolveCursorCliModelVariant(descriptor, {
        reasoningEffort: options?.reasoningEffort,
        fastMode: options?.fastMode,
      })
    : group === "opencode"
      ? modelId
      : getRuntimeModelRefForDescriptor(descriptor, group);
  return { provider: group as AgentChatCliLaunchProvider, model };
}

/** Pre-launch conflict classification for the duplicate guard. */
export type IssueConflict = {
  /** A lane already attaches this exact issue (primary attachment or a chat/CLI session link). */
  laneId: string | null;
  laneName: string | null;
  /** Whether the existing attachment is the lane's primary issue or a session attachment. */
  reason: "lane" | "session";
};

/**
 * Flags issues that already have a lane or an attached chat/CLI session, per the
 * locked duplicate-guard spec. A lane's primary `linearIssue` is the strongest
 * signal; session attachments mirror into `lane.linearIssueLinks` (source
 * `chat_attach`) so we catch session-only links without an extra IPC round-trip.
 */
export function findIssueConflicts(
  issues: LaneLinearIssue[],
  lanes: LaneSummary[],
): Map<string, IssueConflict> {
  const conflicts = new Map<string, IssueConflict>();
  const primaryLaneByIssueId = new Map<string, LaneSummary>();
  const sessionLaneByIssueId = new Map<string, LaneSummary>();
  for (const lane of lanes) {
    const primary = lane.linearIssue;
    if (primary?.id && !primaryLaneByIssueId.has(primary.id)) {
      primaryLaneByIssueId.set(primary.id, lane);
    }
    for (const link of lane.linearIssueLinks ?? []) {
      const linkedId = link.issue?.id;
      if (linkedId && !sessionLaneByIssueId.has(linkedId)) {
        sessionLaneByIssueId.set(linkedId, lane);
      }
    }
  }
  for (const issue of issues) {
    const primaryLane = primaryLaneByIssueId.get(issue.id);
    if (primaryLane) {
      conflicts.set(issue.id, { laneId: primaryLane.id, laneName: primaryLane.name, reason: "lane" });
      continue;
    }
    const sessionLane = sessionLaneByIssueId.get(issue.id);
    if (sessionLane) {
      conflicts.set(issue.id, { laneId: sessionLane.id, laneName: sessionLane.name, reason: "session" });
    }
  }
  return conflicts;
}

export type BatchLaunchDeps = {
  /** Create a worktree lane for an issue. */
  createLane: (args: {
    name: string;
    branchName?: string;
    linearIssue: LaneLinearIssue;
  }) => Promise<{ id: string }>;
  /**
   * Create the agent chat session AND run the kickoff turn headlessly in a single
   * call — no mounted chat pane is required to drive the turn. Maps to
   * `window.ade.agentChat.launch`, which defaults the permission mode to an
   * autonomous-runnable mode, so callers do not pass `permissionMode`.
   */
  launch: (args: {
    laneId: string;
    provider: AgentChatProvider;
    model: string;
    modelId: string;
    reasoningEffort: string | null;
    fastMode?: boolean;
    permissionMode?: AgentChatPermissionMode | null;
    kickoffText: string;
    contextAttachments: AgentChatContextAttachment[];
  }) => Promise<{ id: string }>;
  /**
   * Launch a tracked CLI agent (terminal pty) for the lane with the issue
   * attached. Maps to `window.ade.agentChat.launchCli`, which injects
   * `ADE_LINEAR_*` env so the CLI agent can drive the issue via `ade linear`.
   * Optional: only required when an entry's config requests `sessionType: "cli"`;
   * chat-only callers may omit it.
   */
  launchCli?: (args: {
    laneId: string;
    provider: AgentChatCliLaunchProvider;
    model: string;
    reasoningEffort: string | null;
    fastMode?: boolean;
    permissionMode?: AgentChatPermissionMode | null;
    kickoffPrompt: string;
    linearIssues: LaneLinearIssue[];
  }) => Promise<{ sessionId: string }>;
  /** Roll back a lane created in this run when the agent launch fails. */
  deleteLane?: (args: {
    laneId: string;
    deleteBranch?: boolean;
    deleteRemoteBranch?: boolean;
    requireRemoteBranchDelete?: boolean;
    remoteName?: string;
    force?: boolean;
  }) => Promise<void>;
};

type RunOptions = {
  concurrency?: number;
  onItem: (issueId: string, patch: Partial<BatchLaunchItemState>) => void;
  signal?: { aborted: boolean };
};

/**
 * Bounded-parallel launch over the supplied issues. Each issue runs
 * create-lane → headless launch (session + kickoff turn) with its own model
 * config. Sibling failures never abort the pool: failures are recorded and the
 * remaining issues keep going. Returns the ids created so the caller can
 * reroute + highlight, and the failed ids so it can offer Retry failed.
 */
export async function runBatchLaunch(
  entries: Array<{ issue: LaneLinearIssue; config: BatchLaunchIssueConfig }>,
  deps: BatchLaunchDeps,
  options: RunOptions,
): Promise<BatchLaunchResult> {
  const concurrency = Math.max(1, options.concurrency ?? BATCH_LAUNCH_CONCURRENCY);
  const result: BatchLaunchResult = {
    createdLaneIds: [],
    createdSessionIds: [],
    failedIssueIds: [],
  };

  const queue = [...entries];
  const launchOne = async (entry: { issue: LaneLinearIssue; config: BatchLaunchIssueConfig }) => {
    const { issue, config } = entry;
    if (options.signal?.aborted) return;
    // An existing-lane launch reuses a pre-existing lane: we did not create it
    // this run, so it must never be rolled back on agent-launch failure.
    const existingLaneId = config.existingLaneId?.trim() || null;
    let laneId: string | null = null;
    let createdLane = false;
    try {
      if (existingLaneId) {
        laneId = existingLaneId;
        options.onItem(issue.id, { status: "launching-agent", error: null, laneId });
      } else {
        options.onItem(issue.id, { status: "creating-lane", error: null });
        const branchOverride = config.branchOverride.trim();
        const createArgs: Parameters<BatchLaunchDeps["createLane"]>[0] = {
          name: linearIssueLaneName(issue),
          linearIssue: issue,
        };
        if (branchOverride) createArgs.branchName = branchOverride;
        const lane = await deps.createLane(createArgs);
        laneId = lane.id;
        createdLane = true;
        result.createdLaneIds.push(lane.id);
        options.onItem(issue.id, { laneId: lane.id });

        if (config.laneOnly) {
          options.onItem(issue.id, { status: "done" });
          return;
        }
        options.onItem(issue.id, { status: "launching-agent" });
      }

      const kickoffText = config.kickoffPrompt.trim() || defaultKickoffPrompt();
      if (config.sessionType === "cli") {
        // Tracked CLI agent: spawns a terminal process with the issue attached
        // and ADE_LINEAR_* injected so it can run `ade linear` directly. The CLI
        // kickoff prompt carries the issue identifier/title; the env carries the
        // structured context, so the formatted attachment block is unnecessary.
        if (!deps.launchCli) {
          throw new Error("CLI session launch requested but no launchCli dependency was provided.");
        }
        const { provider, model } = resolveCliLaunchProviderAndModel(config.modelId, {
          reasoningEffort: config.reasoningEffort,
          fastMode: config.fastMode,
        });
        const session = await deps.launchCli({
          laneId,
          provider,
          model,
          reasoningEffort: config.reasoningEffort,
          ...(batchLaunchSupportsFastMode(config.modelId) ? { fastMode: config.fastMode } : {}),
          permissionMode: config.permissionMode ?? null,
          kickoffPrompt: config.kickoffPrompt.trim() || defaultKickoffIntro(),
          linearIssues: [issue],
        });
        result.createdSessionIds.push(session.sessionId);
        options.onItem(issue.id, { sessionId: session.sessionId, status: "done" });
        return;
      }

      const { provider, model } = resolveLaunchProviderAndModel(config.modelId);
      // Single headless launch: creates the session AND runs the kickoff turn
      // server-side (no mounted pane needed). Persist the issue as session context
      // so the agent reads it and the session→issue link is recorded (reused by
      // PR-open closeout).
      const session = await deps.launch({
        laneId,
        provider,
        model,
        modelId: config.modelId,
        reasoningEffort: config.reasoningEffort,
        ...(batchLaunchSupportsFastMode(config.modelId) ? { fastMode: config.fastMode } : {}),
        ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
        kickoffText,
        contextAttachments: [makeLinearIssueContextAttachment(issue, "lane_link")],
      });
      result.createdSessionIds.push(session.id);
      options.onItem(issue.id, { sessionId: session.id, status: "done" });
    } catch (error) {
      let detail = error instanceof Error ? error.message : String(error);
      // If the agent launch failed but we created the lane this run, roll the
      // lane back so retries don't pile up orphan lanes for the same issue.
      // Existing-lane launches are left untouched. If the rollback itself fails,
      // do NOT swallow it: keep the lane visible (left in createdLaneIds and in
      // the failed status' laneId) and surface the orphan so the user can
      // open/clean it up, rather than leaving an invisible orphan.
      if (laneId && createdLane && deps.deleteLane) {
        try {
          // Best-effort cleanup of any branch the lane pushed at create time.
          // Deliberately NOT requireRemoteBranchDelete: a transient remote/network
          // failure must stay non-fatal so the local teardown (worktree + DB row)
          // still completes and the lane is fully rolled back rather than left as a
          // half-deleted visible orphan. A genuinely fatal failure (worktree/DB)
          // still throws and is surfaced below.
          await deps.deleteLane({
            laneId,
            force: true,
            deleteBranch: true,
            deleteRemoteBranch: true,
            remoteName: "origin",
          });
          const idx = result.createdLaneIds.indexOf(laneId);
          if (idx >= 0) result.createdLaneIds.splice(idx, 1);
          laneId = null;
        } catch (rollbackError) {
          const rollbackMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          console.error("[Linear] Lane rollback failed after agent launch failure", {
            laneId,
            error: rollbackMessage,
          });
          detail = `${detail} — lane could not be rolled back and may need manual cleanup (${rollbackMessage})`;
        }
      }
      result.failedIssueIds.push(issue.id);
      options.onItem(issue.id, { status: "failed", error: detail, laneId });
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push((async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await launchOne(next);
      }
    })());
  }
  await Promise.all(workers);
  return result;
}
