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
  /**
   * The provider the launch runs on, when the reader picked one.
   *
   * It used to be derived from the model id alone, through the catalog
   * (`resolveLaunchProviderAndModel`). The launch form asks the HOST for its
   * model now, and the host's answer names the provider it belongs to — so the
   * derivation is the fallback rather than the source, for a host that answers
   * no picker and a config restored from an older run.
   */
  provider?: string | null;
  reasoningEffort: string | null;
  fastMode: boolean;
  /** Editable kickoff prompt; when blank, a default issue-derived prompt is used. */
  kickoffPrompt: string;
  /** Editable branch name; when blank, derived from the issue identifier/title. */
  branchOverride: string;
  /** Chat (in-process SDK) vs CLI (tracked terminal agent). Defaults to "chat". */
  sessionType?: BatchLaunchSessionType;
  /**
   * The unified permission the launch carries — `AgentChatPermissionMode`. When
   * null the provider's own default stands.
   *
   * The compiled config also carried `nativeControls`, the provider-native
   * Claude/Codex/Cursor/Droid/OpenCode permission shape, and collapsed it to
   * this on the way out. The launch verbs accept the collapsed value and
   * nothing else, so the launch form offers the same per-provider CHOICES
   * (`pageCapabilities`) and stores the value each one maps to. The native
   * block itself is the renderer control's internals and has no counterpart.
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
 * `agent-error` with the runtime's own message.
 *
 * The page tier has both signals now, and they are not equivalent:
 *
 * - `host.subscribe({kinds:["lane","session"]})` frames carry ids and nothing
 *   else. `observeSessions` reads them, and can only ever answer "done" — that
 *   a session EXISTS says nothing about how its kickoff turn went, and a turn
 *   that failed server-side leaves a session that exists.
 * - `host.subscribe({kinds:["chat"]})` frames carry the turn itself.
 *   `observeChatTurn` reads them and is the only path that can answer
 *   `agent-error`, with the host's own message.
 *
 * Both are wired, because a host that reports no chat frames must still promote
 * a launched row out of "starting" rather than leaving it spinning forever. The
 * chat frame WINS when it arrives: it is the specific answer, and the inference
 * is the fallback.
 */
export class BatchLaunchAgentReadinessTracker {
  private bufferingUnknownSessions = false;
  private readonly issueIdBySessionId = new Map<string, string>();
  private readonly earlySessionIds = new Set<string>();
  /**
   * Turn outcomes that arrived before their launch call returned a session id.
   *
   * Held apart from `earlySessionIds`, which records only that a session was
   * SEEN. A turn that failed before its own launch resolved would otherwise be
   * flattened into "seen, therefore done" — reporting Ready for the one case
   * the chat frames exist to catch.
   */
  private readonly earlyOutcomeBySessionId = new Map<string, BatchLaunchAgentOutcome>();
  /**
   * Sessions the INFERENCE path has already reported ready.
   *
   * The mapping itself is not consumed when it does, and that is the whole
   * point: a kickoff turn can fail seconds after its session appears, and a
   * tracker that forgot the session on the first lane refresh would have
   * nothing left to attach the failure to. So the inference path remembers what
   * it has said instead of erasing what it knows, and a chat frame can still
   * correct it.
   */
  private readonly inferredSessionIds = new Set<string>();
  /** Sessions a chat frame has settled. A turn ends once. */
  private readonly settledSessionIds = new Set<string>();

  beginBatch(): void {
    this.bufferingUnknownSessions = true;
    this.issueIdBySessionId.clear();
    this.earlySessionIds.clear();
    this.earlyOutcomeBySessionId.clear();
    this.inferredSessionIds.clear();
    this.settledSessionIds.clear();
  }

  finishRegistration(): void {
    this.bufferingUnknownSessions = false;
    this.earlySessionIds.clear();
    this.earlyOutcomeBySessionId.clear();
  }

  registerSession(issueId: string, sessionId: string): BatchLaunchAgentOutcome | null {
    // The specific answer first: a buffered turn outcome knows whether the
    // kickoff worked, where a buffered sighting only knows the session is there.
    const earlyOutcome = this.earlyOutcomeBySessionId.get(sessionId);
    this.earlyOutcomeBySessionId.delete(sessionId);
    const early = this.earlySessionIds.has(sessionId);
    this.earlySessionIds.delete(sessionId);
    if (earlyOutcome) return earlyOutcome;
    if (early) {
      return { status: "done", error: null };
    }
    this.issueIdBySessionId.set(sessionId, issueId);
    return null;
  }

  /**
   * Observe one chat turn the host reported for a session.
   *
   * The precise signal, and the reason `chat` is a `host.subscribe` kind at all.
   * `observeSessions` below can only ever answer "done": it infers readiness
   * from a lane or session list having moved, which says a session exists and
   * nothing about how its kickoff turn went. A turn that FAILED server-side
   * leaves a session that exists — so inference alone reports Ready for a batch
   * that produced nothing, which is the worst thing this toast can say.
   *
   * Answers null for a session this batch is not waiting on, and for a
   * `started` turn: a turn that has begun is still initializing, which is the
   * state the row is already in. `interrupted` never arrives — the host maps it
   * onto `failed`, so a page has one error path rather than two.
   */
  observeChatTurn(turn: {
    sessionId: string;
    state: "started" | "completed" | "failed";
    message?: string | null;
  }): { issueId: string; outcome: BatchLaunchAgentOutcome } | null {
    if (turn.state === "started") return null;
    const outcome: BatchLaunchAgentOutcome = turn.state === "completed"
      ? { status: "done", error: null }
      : {
        status: "agent-error",
        // The host's own sentence when it sent one. The fallback names what
        // happened and nothing else: the row must say the agent is not working
        // rather than invent a reason it is not.
        error: turn.message?.trim() || "The kickoff turn failed.",
      };
    const issueId = this.issueIdBySessionId.get(turn.sessionId);
    if (!issueId) {
      // A turn for a session whose launch call has not returned its id yet.
      if (this.bufferingUnknownSessions) {
        this.earlyOutcomeBySessionId.set(turn.sessionId, outcome);
      }
      return null;
    }
    if (this.settledSessionIds.has(turn.sessionId)) return null;
    this.settledSessionIds.add(turn.sessionId);
    return { issueId, outcome };
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
        // Reported once, but the mapping is KEPT: a chat frame arriving later
        // is the specific answer and must still find its issue.
        if (this.inferredSessionIds.has(sessionId) || this.settledSessionIds.has(sessionId)) continue;
        this.inferredSessionIds.add(sessionId);
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
 * The provider and model one launch actually carries.
 *
 * The reader's own answer wins: `ui.pickModel()` names the provider its model
 * belongs to, and a provider read off the host's own picker cannot be wrong.
 * The catalog derivation stays as the fallback for a host that answers no
 * picker verb, where the model id is all there is to go on.
 *
 * Both launch kinds resolve it the same way — the provider-group set
 * (claude|codex|cursor|droid|opencode) is identical to the CLI launch provider
 * set, so the group doubles as the CLI profile.
 */
export function launchTarget(
  config: Pick<BatchLaunchIssueConfig, "modelId" | "provider">,
  models: readonly PageChatModel[],
): { provider: string; model: string } {
  // The model owns the provider. A leftover Provider chip used to win here
  // and launch Cursor against a Grok id.
  const descriptor = findChatModel(config.modelId, models);
  if (descriptor) return { provider: descriptor.provider, model: descriptor.id };
  const chosen = config.provider?.trim();
  if (chosen) return { provider: chosen, model: config.modelId };
  return { provider: "opencode", model: config.modelId };
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
      conflicts.set(issue.id, {
        laneId: sessionLane.id,
        laneName: sessionLane.name,
        lanePath: sessionLane.path,
        reason: "session",
      });
      continue;
    }
    const primaryLane =
      primaryLaneByIssueId.get(issue.id)
      ?? (issueKey ? primaryLaneByIssueKey.get(issueKey) : undefined);
    if (primaryLane) {
      conflicts.set(issue.id, {
        laneId: primaryLane.id,
        laneName: primaryLane.name,
        lanePath: primaryLane.path,
        reason: "lane",
      });
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
    /** The provider's fast service tier, when the form offered and the reader chose. */
    fastMode?: boolean;
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
    fastMode?: boolean;
    prompt: string;
  }) => Promise<{ sessionId: string }>;
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
    // An existing-lane launch reuses a pre-existing lane. A failed agent
    // launch leaves a newly created lane in place rather than deleting it:
    // the reader still has the worktree, and "Lane deleted" toasts on a
    // model-picker miss were treating that as cleanup.
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
        const { provider, model } = launchTarget(config, models);
        const session = await deps.launchCli({
          issueId: issue.id,
          laneId,
          provider,
          model,
          reasoningEffort: config.reasoningEffort,
          ...(config.permissionMode != null ? { permissionMode: config.permissionMode } : {}),
          // Only when the form drew the toggle. `false` for a model with no
          // fast tier would be a choice the reader never made.
          ...(config.fastMode ? { fastMode: true } : {}),
          prompt: config.kickoffPrompt.trim() || defaultKickoffIntro(),
        });
        result.createdSessionIds.push(session.sessionId);
        options.onItem(issue.id, { sessionId: session.sessionId, status: "done" });
        return;
      }

      const { provider, model } = launchTarget(config, models);
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
        ...(config.fastMode ? { fastMode: true } : {}),
        prompt: kickoffText,
      });
      result.createdSessionIds.push(session.id);
      // The launch action intentionally returns as soon as the durable session
      // exists; its kickoff turn continues in the background. Keep the launch
      // visibly in progress until the page observes the first host frame naming
      // this session instead of claiming the agent is already ready.
      options.onItem(issue.id, { sessionId: session.id, status: "initializing-agent" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
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
