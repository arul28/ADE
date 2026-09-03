/**
 * The batch-launch orchestrator, moved out of the renderer.
 *
 * This is `apps/desktop/src/renderer/lib/linearBatchLaunch.ts` with exactly
 * three things changed, and nothing else:
 *
 *  1. **Host calls.** `BatchLaunchDeps` is retyped against the page bridge's
 *     `pageCreateLane` / `pageLaunchAgent` / `pageLaunchCli` / `pageDeleteLane`
 *     argument shapes instead of `window.ade.lanes.*` and
 *     `window.ade.agentChat.*`. The sequencing, the bounded-parallel pool, the
 *     rollback rule, the progress accounting and the result shape are the
 *     compiled file's, unchanged.
 *  2. **The model registry.** The page cannot import `shared/modelRegistry` or
 *     `ModelPicker/modelCatalog`, so `resolveLaunchProviderAndModel` and
 *     `resolveCliLaunchProviderAndModel` read the host's own catalog
 *     (`getChatModels()` → `{id,label,provider}[]`) rather than a descriptor.
 *  3. **The agent-readiness signal.** There is no agent-chat event stream in
 *     the bridge, so the tracker observes session ids arriving from
 *     `useHostLanes()` rather than `AgentChatEventEnvelope`s. See
 *     {@link BatchLaunchAgentReadinessTracker} for what that costs.
 *
 * `IssueConflict` is owned by `../components/LinearIssueBrowser` (it is the
 * browser's prop type) and re-exported from here so every call site reads the
 * same import path the compiled code used.
 */

import type { IssueConflict } from "../components/LinearIssueBrowser";
import type { LaneLinearIssue, PageChatModel, PageLane } from "../types";
import { linearIssueLaneName } from "./linearIssueBranch";

export type { IssueConflict };

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
   *
   * The compiled config also carried `nativeControls` (the provider-native
   * Claude/Codex/Cursor/Droid/OpenCode permission shape). The page bridge's
   * launch verbs accept a single `permissionMode` string and nothing else, so
   * the native block has no counterpart here and is dropped.
   */
  permissionMode?: string | null;
  /** When launching into an existing lane (skips lane creation). */
  existingLaneId?: string | null;
  /** When true the orchestrator only creates the lane (no agent kickoff). */
  laneOnly?: boolean;
};

export type BatchLaunchItemStatus =
  | "pending"
  | "creating-lane"
  | "launching-agent"
  | "initializing-agent"
  | "agent-error"
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

export function isBatchLaunchInFlight(status: BatchLaunchItemStatus): boolean {
  return status === "pending"
    || status === "creating-lane"
    || status === "launching-agent"
    || status === "initializing-agent";
}

export type BatchLaunchAgentOutcome =
  | { status: "done"; error: null }
  | { status: "agent-error"; error: string };

/**
 * Reconciles headless kickoff events that can arrive before the launch action
 * resolves with its durable session id.
 *
 * WHAT MOVED, AND WHAT DID NOT. The compiled tracker read
 * `AgentChatEventEnvelope`s off `window.ade.agentChat.onEvent` and classified
 * them: `user_message` and `status:started` meant the agent was alive (a
 * non-terminal "done"); `error`, `status:failed` and `done:failed` meant
 * `agent-error` with the runtime's own message. There is no agent-chat event
 * stream in the page bridge. The only live signal a guest gets is
 * `host.subscribe({kinds:["session"]})`, whose frames carry ids and nothing
 * else — no turn status, no message. So this tracker resolves a registered
 * session to "done" the moment the host reports that session exists, and can
 * NEVER report `agent-error`: a kickoff turn that fails server-side shows as
 * Ready here. `agent-error` remains in the status union because the toast and
 * the progress accounting still render it, and a future bridge verb carrying
 * turn status would light it up unchanged.
 */
export class BatchLaunchAgentReadinessTracker {
  private bufferingUnknownSessions = false;
  private readonly issueIdBySessionId = new Map<string, string>();
  private readonly earlySessionIds = new Set<string>();

  beginBatch(): void {
    this.bufferingUnknownSessions = true;
    this.issueIdBySessionId.clear();
    this.earlySessionIds.clear();
  }

  finishRegistration(): void {
    this.bufferingUnknownSessions = false;
    this.earlySessionIds.clear();
  }

  registerSession(issueId: string, sessionId: string): BatchLaunchAgentOutcome | null {
    const early = this.earlySessionIds.has(sessionId);
    this.earlySessionIds.delete(sessionId);
    if (early) {
      return { status: "done", error: null };
    }
    this.issueIdBySessionId.set(sessionId, issueId);
    return null;
  }

  /**
   * Observe the session ids the host currently reports. Answers one transition
   * per session that this batch is waiting on, in registration order.
   */
  observeSessions(sessionIds: readonly string[]): Array<{
    issueId: string;
    outcome: BatchLaunchAgentOutcome;
  }> {
    const transitions: Array<{ issueId: string; outcome: BatchLaunchAgentOutcome }> = [];
    for (const sessionId of sessionIds) {
      const issueId = this.issueIdBySessionId.get(sessionId);
      if (issueId) {
        this.issueIdBySessionId.delete(sessionId);
        transitions.push({ issueId, outcome: { status: "done", error: null } });
        continue;
      }
      if (this.bufferingUnknownSessions) this.earlySessionIds.add(sessionId);
    }
    return transitions;
  }
}

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

/**
 * The host's chat-model catalog, as the launch form and the resolvers read it.
 *
 * The compiled resolvers took a `ModelDescriptor` from `shared/modelRegistry`
 * and derived the provider group from it. A page has no registry, so the
 * catalog row's own `provider` is the provider group, and the row's `id` is the
 * runtime-facing model ref.
 */
export function findChatModel(
  modelId: string,
  models: readonly PageChatModel[],
): PageChatModel | undefined {
  return models.find((model) => model.id === modelId);
}

/** Maps a catalog model id to the chat-runtime provider + runtime-facing model id. */
export function resolveLaunchProviderAndModel(
  modelId: string,
  models: readonly PageChatModel[],
): { provider: string; model: string } {
  const descriptor = findChatModel(modelId, models);
  if (!descriptor) {
    return { provider: "opencode", model: modelId };
  }
  return { provider: descriptor.provider, model: descriptor.id };
}

/**
 * Maps a catalog model id to the CLI launch provider + runtime model ref for a
 * tracked-terminal launch. The provider-group set
 * (claude|codex|cursor|droid|opencode) is identical to the CLI launch provider
 * set, so the group doubles as the CLI profile; unknown models fall back to
 * OpenCode with the raw model id.
 */
export function resolveCliLaunchProviderAndModel(
  modelId: string,
  models: readonly PageChatModel[],
): { provider: string; model: string } {
  return resolveLaunchProviderAndModel(modelId, models);
}

/**
 * Flags issues that are already being worked on, per the locked duplicate-guard
 * spec, and says WHICH of the two things is true.
 *
 * "This issue already has a lane" and "an agent is already working on this
 * issue" are different sentences, and only the second is worth hesitating over,
 * so the two are kept apart the way the compiled guard kept them: a lane's own
 * attachment (`linearIssueId` / `linearIssueKey`) reports `reason: "lane"`, and
 * an issue linked to a SESSION inside a lane (`linearIssueLinks`, which
 * `pageLanes` fills from `flows.sessionIssues`) reports `reason: "session"` —
 * the browser's "Has lane" / "Has agent" chip and the launch modal's tooltip
 * both switch on it.
 *
 * A session link WINS when both exist for the same issue: it is the stronger
 * claim on the issue. Both lookups match on issue id first and fall back to the
 * upper-cased issue key, because a lane row may carry only one of the two.
 */
export function findIssueConflicts(
  issues: LaneLinearIssue[],
  lanes: PageLane[],
): Map<string, IssueConflict> {
  const conflicts = new Map<string, IssueConflict>();
  const primaryLaneByIssueId = new Map<string, PageLane>();
  const primaryLaneByIssueKey = new Map<string, PageLane>();
  const sessionLaneByIssueId = new Map<string, PageLane>();
  const sessionLaneByIssueKey = new Map<string, PageLane>();
  for (const lane of lanes) {
    const issueId = lane.linearIssueId?.trim();
    if (issueId && !primaryLaneByIssueId.has(issueId)) {
      primaryLaneByIssueId.set(issueId, lane);
    }
    const issueKey = lane.linearIssueKey?.trim().toUpperCase();
    if (issueKey && !primaryLaneByIssueKey.has(issueKey)) {
      primaryLaneByIssueKey.set(issueKey, lane);
    }
    for (const link of lane.linearIssueLinks ?? []) {
      // A link with no session id is the lane's own attachment mirrored into
      // the list, not an agent: it must not read as "Has agent".
      if (!link.sessionId) continue;
      const linkedId = link.issueId?.trim();
      if (linkedId && !sessionLaneByIssueId.has(linkedId)) {
        sessionLaneByIssueId.set(linkedId, lane);
      }
      const linkedKey = link.issueKey?.trim().toUpperCase();
      if (linkedKey && !sessionLaneByIssueKey.has(linkedKey)) {
        sessionLaneByIssueKey.set(linkedKey, lane);
      }
    }
  }
  for (const issue of issues) {
    const issueKey = issue.identifier?.trim().toUpperCase() ?? "";
    const sessionLane =
      sessionLaneByIssueId.get(issue.id)
      ?? (issueKey ? sessionLaneByIssueKey.get(issueKey) : undefined);
    if (sessionLane) {
      conflicts.set(issue.id, { laneId: sessionLane.id, laneName: sessionLane.name, reason: "session" });
      continue;
    }
    const primaryLane =
      primaryLaneByIssueId.get(issue.id)
      ?? (issueKey ? primaryLaneByIssueKey.get(issueKey) : undefined);
    if (primaryLane) {
      conflicts.set(issue.id, { laneId: primaryLane.id, laneName: primaryLane.name, reason: "lane" });
    }
  }
  return conflicts;
}

export type BatchLaunchDeps = {
  /**
   * Create a worktree lane for an issue. Maps to the page bridge's
   * `createLaneForIssue({issueId, baseRef, name})` — the host links the issue
   * to the lane itself, which is why the compiled `linearIssue` payload is an
   * issue id here.
   */
  createLane: (args: {
    issueId: string;
    name: string;
    baseRef?: string | null;
  }) => Promise<{ id: string }>;
  /**
   * Create the agent chat session AND run the kickoff turn headlessly in a
   * single call — no mounted chat pane is required to drive the turn. Maps to
   * `launchAgentOnIssue`, which defaults the permission mode to an
   * autonomous-runnable mode when the caller passes none, and attaches the
   * issue to the session host-side (the compiled call passed an explicit
   * `contextAttachments: [makeLinearIssueContextAttachment(issue,"lane_link")]`;
   * the page has no attachment builder and does not need one).
   */
  launch: (args: {
    issueId: string;
    laneId: string;
    provider: string;
    model: string;
    reasoningEffort: string | null;
    permissionMode?: string | null;
    prompt: string;
  }) => Promise<{ id: string }>;
  /**
   * Launch a tracked CLI agent (terminal pty) for the lane with the issue
   * attached. Maps to `launchCliOnIssue`, which injects `ADE_LINEAR_*` env so
   * the CLI agent can drive the issue via `ade linear`. Optional: only required
   * when an entry's config requests `sessionType: "cli"`; chat-only callers may
   * omit it.
   */
  launchCli?: (args: {
    issueId: string;
    laneId: string;
    provider: string;
    model: string;
    reasoningEffort: string | null;
    permissionMode?: string | null;
    prompt: string;
  }) => Promise<{ sessionId: string }>;
  /** Roll back a lane created in this run when the agent launch fails. */
  deleteLane?: (args: { laneId: string }) => Promise<void>;
};

type RunOptions = {
  concurrency?: number;
  onItem: (issueId: string, patch: Partial<BatchLaunchItemState>) => void;
  signal?: { aborted: boolean };
  /** The host's chat-model catalog, for provider/model resolution. */
  models?: readonly PageChatModel[];
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
  const models = options.models ?? [];
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
        // `pageCreateLane` takes `baseRef`, not a branch name: the host mints
        // the lane's own branch from the issue. A typed branch override is
        // therefore forwarded as the base ref it most nearly means, and the
        // compiled `branchName` behaviour has no page counterpart.
        const lane = await deps.createLane({
          issueId: issue.id,
          name: linearIssueLaneName(issue),
          ...(branchOverride ? { baseRef: branchOverride } : {}),
        });
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
        const { provider, model } = resolveCliLaunchProviderAndModel(config.modelId, models);
        const session = await deps.launchCli({
          issueId: issue.id,
          laneId,
          provider,
          model,
          reasoningEffort: config.reasoningEffort,
          ...(config.permissionMode != null ? { permissionMode: config.permissionMode } : {}),
          prompt: config.kickoffPrompt.trim() || defaultKickoffIntro(),
        });
        result.createdSessionIds.push(session.sessionId);
        options.onItem(issue.id, { sessionId: session.sessionId, status: "done" });
        return;
      }

      const { provider, model } = resolveLaunchProviderAndModel(config.modelId, models);
      // Single headless launch: creates the session AND runs the kickoff turn
      // server-side (no mounted pane needed). The host persists the issue as
      // session context so the agent reads it and the session→issue link is
      // recorded (reused by PR-open closeout).
      const session = await deps.launch({
        issueId: issue.id,
        laneId,
        provider,
        model,
        reasoningEffort: config.reasoningEffort,
        ...(config.permissionMode != null ? { permissionMode: config.permissionMode } : {}),
        prompt: kickoffText,
      });
      result.createdSessionIds.push(session.id);
      // The launch action intentionally returns as soon as the durable session
      // exists; its kickoff turn continues in the background. Keep the launch
      // visibly in progress until the page observes the first host frame naming
      // this session instead of claiming the agent is already ready.
      options.onItem(issue.id, { sessionId: session.id, status: "initializing-agent" });
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
          // Best-effort cleanup. The compiled call also asked the daemon to
          // delete the lane's local and remote branch, deliberately without
          // `requireRemoteBranchDelete` so a transient remote failure stayed
          // non-fatal. `pageDeleteLane` takes a lane id and nothing else, so
          // the branch-teardown flags have no page counterpart and the host's
          // own default applies.
          await deps.deleteLane({ laneId });
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
