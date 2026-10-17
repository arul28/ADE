import type { Logger } from "../logging/logger";
import type {
  AgentChatEventEnvelope,
  AgentChatApprovalDecision,
  AgentChatProvider,
  LaneLinearIssue,
  LinearAgentOverview,
  NormalizedLinearIssue,
  PendingInputRequest,
} from "../../../shared/types";
import type { AutomationTriggerType } from "../../../shared/types/config";
import type { LinearIngressEventRecord } from "../../../shared/types/linearSync";
import type {
  AutomationLinearAgentHooks,
  TriggerContext,
} from "../automations/automationService";
import { getModelById, resolveProviderGroupForModel } from "../../../shared/modelRegistry";
import { buildDeeplink } from "../../../shared/deeplinks";
import { normalizedLinearIssueToLaneIssue } from "../../../shared/laneLinearIssue";
import type { LinearAgentActivityContent, LinearAgentPlanStep, LinearAgentRelayClient } from "./linearAgentRelayClient";
import { getErrorMessage, isRecord, toOptionalString as asString } from "../shared/utils";
import { unwrapShell } from "../chat/sessionActivityDetector";

/**
 * Runs the ADE side of the Linear agent.
 *
 * Linear → ADE: the relay routes each `AgentSessionEvent` to the ADE account of
 * the person who delegated or mentioned the agent. Every machine of that
 * account sees it; a machine with a matching `linear.agent_*` automation rule
 * claims the session at the relay (first claim wins) and dispatches the rule.
 * The rule decides the model, lane mode and prompt, like any automation.
 *
 * ADE → Linear: while the chat runs, its events are translated into agent
 * activities (thoughts, actions, plan, questions, the final response) and
 * posted through the relay, which holds the workspace's app token.
 *
 * Linear replies come back as `prompted` events: a stop signal interrupts the
 * chat, an answer to an open question resolves it, anything else is sent to
 * the chat (steering a running turn, or starting a new one).
 */

type AgentSessionRecord = {
  agentSessionId: string;
  chatSessionId: string | null;
  laneId: string | null;
  runId: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  /** The Linear user who started the session; only they may direct it. */
  creatorId?: string | null;
  startedAt: string;
  /** The open question that a Linear reply should answer, if any. */
  pendingInput: { itemId: string; kind: "approval" | "question"; questionId: string | null; options: Array<{ label: string; value: string }> } | null;
};

export type LinearAgentServiceDeps = {
  relay: LinearAgentRelayClient;
  logger: Logger;
  machine: { id: string; name: string | null };
  /** The ADE account id of this brain's signed-in user, used to skip events routed to someone else. */
  getAccountId: () => string | null;
  kv: { getJson<T>(key: string): T | null; setJson(key: string, value: unknown): void };
  automation: {
    dispatchIngressTrigger: (args: {
      source: "linear-relay";
      eventKey: string;
      triggerType: AutomationTriggerType;
      eventName?: string | null;
      summary?: string | null;
      labels?: string[];
      rawPayload?: Record<string, unknown> | null;
      linear?: { issue: { id: string; title?: string; team?: string; project?: string; assignee?: string; state?: string; labels?: string[] } } | null;
      project?: string | null;
      team?: string | null;
      linearAgent?: TriggerContext["linearAgent"] | null;
    }) => Promise<{ status?: string; errorMessage?: string | null } | null>;
    hasMatchingLinearAgentRule: (args: { triggerType: AutomationTriggerType; team?: string | null; project?: string | null; labels?: string[] }) => boolean;
    setLinearAgentHooks: (hooks: AutomationLinearAgentHooks | null) => void;
    listAgentRules: () => LinearAgentOverview["rules"];
  };
  chat: {
    sendMessage: (args: { sessionId: string; text: string; displayText?: string }) => Promise<unknown>;
    interrupt: (args: { sessionId: string }) => Promise<unknown>;
    respondToInput: (args: { sessionId: string; itemId: string; decision?: AgentChatApprovalDecision; answers?: Record<string, string | string[]>; responseText?: string | null }) => Promise<void>;
    getAvailableModels: (args: { provider: AgentChatProvider; activateRuntime?: boolean }) => Promise<Array<{ id: string; modelId?: string | null }>>;
  };
  lanes: {
    /** Creates a lane for the issue (issue linked, Linear's branch name). */
    createLaneForIssue: (issue: LaneLinearIssue) => Promise<string>;
    /** Attaches the issue to the chat so the agent gets its context file and ids. */
    attachIssueToSession: (args: { chatSessionId: string; issue: LaneLinearIssue }) => Promise<void>;
    getLaneName: (laneId: string) => Promise<string | null>;
  };
  fetchIssue: (issueId: string) => Promise<NormalizedLinearIssue | null>;
};

const SESSIONS_KV_KEY = "linear.agent.sessions.v1";
const MAX_REMEMBERED_SESSIONS = 200;
/** A machine with no matching rule waits this long before it answers "no rule" itself. */
const NO_RULE_CLAIM_DELAY_MS = 20_000;
/**
 * A brain that reads the relay's backlog for the first time (a new machine, a
 * project that just connected Linear) sees old `created` events. Only recent
 * ones start work; the relay lets anyone take a claim that has gone stale.
 */
const MAX_CREATED_EVENT_AGE_MS = 10 * 60_000;
const THOUGHT_MIN_INTERVAL_MS = 8_000;
const ACTION_MIN_INTERVAL_MS = 2_500;
const MAX_THOUGHT_CHARS = 700;
const MAX_RESPONSE_CHARS = 6_000;
/** The relay lets another machine take a claim after 15 minutes; renew well before. */
const CLAIM_RENEW_MS = 5 * 60_000;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function lastParagraph(text: string): string {
  const parts = text.trim().split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? "";
}

/**
 * Drops the lane worktree prefix from paths: every step runs inside it, so it
 * only hides the part that differs. Anchored to the start of a token: unanchored,
 * the lazy prefix rescans a long token from every position (a pasted base64 blob
 * took ~600 ms per step on the main process at 50 KB).
 */
function shortenWorktreePaths(text: string): string {
  return text.replace(/(?<![^\s'"`])(?:[A-Za-z]:)?[^\s'"`]*?[\\/]\.ade[\\/]worktrees[\\/][^\\/\s'"`]+(?:[\\/]|(?=[\s'"`]|$))/g, "");
}

/**
 * The part of a shell command that says what it does. Agents start most
 * commands with `cd <lane worktree> &&`, and Codex wraps them in `bash -lc '…'`
 * (PowerShell or cmd on Windows); shown raw, every step reads the same. A bare
 * `cd` says nothing, so the tool's own description stands in for it.
 */
export function describeShellCommand(command: string, description = ""): string {
  let text = unwrapShell(command);
  // `cmd /c "…"` hands back the command still inside the quotes cmd wrapped it in.
  if (text !== command.trim() && /^"[^"]*"$/.test(text)) text = text.slice(1, -1);
  for (;;) {
    const cd = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/.exec(text);
    if (!cd) break;
    // A cd into the lane is the agent's usual preamble; a cd into another checkout says which repository the command ran in.
    const target = cd[1]!.replace(/^["']|["']$/g, "");
    if (/^(?:[\\/]|~|[A-Za-z]:|\.\.)/.test(target) && !/\.ade[\\/]worktrees[\\/]/.test(target)) break;
    text = text.slice(cd[0].length);
  }
  if (!text || /^cd(?:\s+(?:"[^"]*"|'[^']*'|\S+))?\s*$/.test(text)) {
    return truncate(description || shortenWorktreePaths(text), 200);
  }
  return truncate(shortenWorktreePaths(text).replace(/\s+/g, " "), 200);
}

/** A short, human label for a tool call, in the style of Linear's own agents. */
export function describeToolCall(tool: string, args: unknown): { action: string; parameter: string } {
  const record = isRecord(args) ? args : {};
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const name = tool.toLowerCase();
  if (/(^|_)(bash|shell|exec|command|terminal)/.test(name)) {
    return { action: "Ran", parameter: describeShellCommand(pick("command", "cmd"), pick("description")) };
  }
  if (/(edit|write|patch|apply|create_file|str_replace)/.test(name)) return { action: "Edited", parameter: shortenWorktreePaths(pick("file_path", "path", "filePath", "file")) };
  if (/(read|view|open|cat)/.test(name)) return { action: "Read", parameter: shortenWorktreePaths(pick("file_path", "path", "filePath", "file")) };
  if (/(grep|search|find|glob|rg)/.test(name)) return { action: "Searched", parameter: truncate(pick("pattern", "query", "q", "glob"), 160) };
  if (/(web|fetch|browse)/.test(name)) return { action: "Fetched", parameter: truncate(pick("url", "query"), 200) };
  if (/(todo|plan)/.test(name)) return { action: "Planned", parameter: "" };
  if (name === "skill" || name.endsWith("_skill")) return { action: "Used skill", parameter: pick("name", "skill", "skill_name") };
  return { action: tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " "), parameter: truncate(pick("description", "prompt", "path", "query"), 160) };
}

function mapPlanStatus(status: string): LinearAgentPlanStep["status"] {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "inProgress";
  if (status === "failed" || status === "cancelled" || status === "canceled") return "canceled";
  return "pending";
}

function readAgentSession(payload: Record<string, unknown>) {
  const session = isRecord(payload.agentSession) ? payload.agentSession : null;
  const issue = session && isRecord(session.issue) ? session.issue : null;
  const creator = session && isRecord(session.creator) ? session.creator : null;
  const comment = session && isRecord(session.comment) ? session.comment : null;
  const sourceComment = session && isRecord(session.sourceComment) ? session.sourceComment : null;
  const commentText = comment ? asString(comment.body) : null;
  // Every session has a comment thread. For a delegation Linear writes it
  // ("This thread is for an agent session with …"); a mention is spawned from
  // the person's own comment.
  const systemThread = commentText ? /^This thread is for an agent session/i.test(commentText) : true;
  const mentioned = Boolean(session && asString(session.sourceCommentId)) || Boolean(sourceComment) || !systemThread;
  const team = issue && isRecord(issue.team) ? issue.team : null;
  const project = issue && isRecord(issue.project) ? issue.project : null;
  const labelNodes = issue && isRecord(issue.labels) && Array.isArray(issue.labels.nodes) ? issue.labels.nodes : Array.isArray(issue?.labels) ? issue.labels : [];
  return {
    id: session ? asString(session.id) : null,
    issueId: issue ? asString(issue.id) : null,
    issueIdentifier: issue ? asString(issue.identifier) : null,
    issueTitle: issue ? asString(issue.title) : null,
    teamName: team ? asString(team.name) : null,
    teamKey: team ? asString(team.key) : null,
    projectName: project ? asString(project.name) : null,
    labels: labelNodes.map((entry: unknown) => (isRecord(entry) ? asString(entry.name) : null)).filter((entry: string | null): entry is string => Boolean(entry)),
    creatorId: (session ? asString(session.creatorId) : null) ?? (creator ? asString(creator.id) : null),
    creatorName: creator ? (asString(creator.displayName) ?? asString(creator.name)) : null,
    createdAt: (session ? asString(session.createdAt) : null) ?? asString(payload.createdAt),
    mentioned,
    commentBody: mentioned ? ((sourceComment ? asString(sourceComment.body) : null) ?? commentText) : null,
    promptContext: asString(payload.promptContext),
  };
}

export function createLinearAgentService(deps: LinearAgentServiceDeps) {
  const { logger, relay } = deps;
  const sessions = new Map<string, AgentSessionRecord>();
  const byChat = new Map<string, string>();
  const lastClaimAt = new Map<string, number>();
  /** Sessions stopped from Linear: their "Stopped" response is already posted. */
  const stoppedFromLinear = new Set<string>();
  /** "No rule" waits, cancelled on dispose. */
  const noRuleTimers = new Set<NodeJS.Timeout>();
  const cancelNoRuleWait = new WeakMap<NodeJS.Timeout, () => void>();
  const turnState = new Map<string, {
    text: string;
    lastThoughtAt: number;
    lastActionAt: number;
    thoughtTimer: NodeJS.Timeout | null;
    finalText: string;
    /** Tool items already shown in Linear; a call is re-emitted when its arguments arrive. */
    postedToolItems: Set<string>;
    /** The last step shown, so back-to-back identical steps show once. */
    lastActionLabel: string | null;
    /** The last problem this turn, reported only if the turn fails. */
    lastError: string | null;
  }>();

  // ---- persistence -------------------------------------------------------
  const persist = (): void => {
    const all = [...sessions.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, MAX_REMEMBERED_SESSIONS);
    if (all.length < sessions.size) {
      const kept = new Set(all.map((entry) => entry.agentSessionId));
      for (const id of [...sessions.keys()]) {
        if (kept.has(id)) continue;
        const chatId = sessions.get(id)?.chatSessionId;
        if (chatId) byChat.delete(chatId);
        sessions.delete(id);
        lastClaimAt.delete(id);
        stoppedFromLinear.delete(id);
      }
    }
    deps.kv.setJson(SESSIONS_KV_KEY, all);
  };
  for (const entry of deps.kv.getJson<AgentSessionRecord[]>(SESSIONS_KV_KEY) ?? []) {
    if (!entry?.agentSessionId) continue;
    sessions.set(entry.agentSessionId, entry);
    if (entry.chatSessionId) byChat.set(entry.chatSessionId, entry.agentSessionId);
  }
  const remember = (record: AgentSessionRecord): void => {
    sessions.set(record.agentSessionId, record);
    if (record.chatSessionId) byChat.set(record.chatSessionId, record.agentSessionId);
    persist();
  };

  const post = (agentSessionId: string, content: LinearAgentActivityContent, options?: { ephemeral?: boolean }): void => {
    void relay.postActivity(agentSessionId, content, options).catch((error) => {
      logger.warn("linear_agent.post_activity_failed", { agentSessionId, type: content.type, error: getErrorMessage(error) });
    });
  };

  // ---- Linear → ADE --------------------------------------------------------
  const handleCreated = async (record: LinearIngressEventRecord, payload: Record<string, unknown>): Promise<void> => {
    const info = readAgentSession(payload);
    if (!info.id) return;
    if (sessions.has(info.id)) return;
    const createdAtMs = Date.parse(info.createdAt ?? record.createdAt);
    if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > MAX_CREATED_EVENT_AGE_MS) {
      logger.info("linear_agent.skip_old_session", { agentSessionId: info.id, createdAt: info.createdAt ?? record.createdAt });
      return;
    }
    const triggerType: AutomationTriggerType = info.mentioned ? "linear.agent_mentioned" : "linear.agent_delegated";
    // The webhook's issue has no project or labels; read them so the rule's
    // project and label filters can match.
    const fullIssue = info.issueId ? await deps.fetchIssue(info.issueId).catch(() => null) : null;
    if (fullIssue) {
      info.projectName = info.projectName ?? fullIssue.projectName ?? null;
      info.teamName = info.teamName ?? fullIssue.teamName ?? null;
      if (info.labels.length === 0) info.labels = (fullIssue.labelColors ?? []).map((label) => label.name).filter(Boolean);
      info.issueTitle = info.issueTitle ?? fullIssue.title;
    }
    const matchArgs = {
      triggerType,
      team: info.teamName,
      project: info.projectName,
      labels: info.labels,
    };
    const hasRule = deps.automation.hasMatchingLinearAgentRule(matchArgs);
    if (!hasRule) {
      // Let a machine that has a rule claim first. If nobody has claimed it by
      // then, this machine claims it only to explain why nothing started.
      const waited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          noRuleTimers.delete(timer);
          resolve(true);
        }, NO_RULE_CLAIM_DELAY_MS);
        timer.unref?.();
        noRuleTimers.add(timer);
        cancelNoRuleWait.set(timer, () => resolve(false));
      });
      if (!waited) return;
    }
    let claimed = false;
    try {
      claimed = (await relay.claimSession(info.id, { machineId: deps.machine.id, machineName: deps.machine.name })).claimed;
    } catch (error) {
      logger.warn("linear_agent.claim_failed", { agentSessionId: info.id, error: getErrorMessage(error) });
      return;
    }
    if (!claimed) return;
    lastClaimAt.set(info.id, Date.now());

    if (!hasRule) {
      post(info.id, {
        type: "error",
        body: [
          `No ADE automation handles ${triggerType === "linear.agent_mentioned" ? "mentions" : "delegations"} for this issue${deps.machine.name ? ` (checked on ${deps.machine.name})` : ""}.`,
          "",
          "Open ADE → **Settings → Integrations → Linear → ADE agent** and choose a model, or add a rule in **Automations** with the trigger *Delegated to ADE* / *Mentioned ADE*.",
        ].join("\n"),
      });
      return;
    }

    remember({
      agentSessionId: info.id,
      chatSessionId: null,
      laneId: null,
      runId: null,
      issueId: info.issueId,
      issueIdentifier: info.issueIdentifier,
      creatorId: info.creatorId,
      startedAt: new Date().toISOString(),
      pendingInput: null,
    });

    const result = await deps.automation.dispatchIngressTrigger({
      source: "linear-relay",
      eventKey: `agent-session:${info.id}`,
      triggerType,
      eventName: record.action,
      summary: info.issueIdentifier && info.issueTitle ? `${info.issueIdentifier}: ${info.issueTitle}` : record.summary,
      labels: info.labels,
      rawPayload: payload,
      linear: info.issueId
        ? { issue: { id: info.issueId, title: info.issueTitle ?? undefined, team: info.teamName ?? undefined, project: info.projectName ?? undefined, labels: info.labels } }
        : null,
      team: info.teamName,
      project: info.projectName,
      linearAgent: {
        agentSessionId: info.id,
        promptContext: info.promptContext,
        creatorName: info.creatorName,
        commentBody: info.commentBody,
      },
    }).catch((error) => {
      logger.warn("linear_agent.dispatch_failed", { agentSessionId: info.id, error: getErrorMessage(error) });
      return null;
    });
    if (result?.status === "ignored") {
      post(info.id, { type: "error", body: "No enabled ADE automation matched this issue, so nothing started. Check the rule's team, project and label filters in ADE → Automations." });
    }
  };

  const handlePrompted = async (payload: Record<string, unknown>): Promise<void> => {
    const info = readAgentSession(payload);
    if (!info.id) return;
    const record = sessions.get(info.id);
    if (!record?.chatSessionId) return;
    const activity = isRecord(payload.agentActivity) ? payload.agentActivity : null;
    const content = activity && isRecord(activity.content) ? activity.content : null;
    const signal = activity ? asString(activity.signal) : null;
    const body = (content ? asString(content.body) : null) ?? (activity ? asString(activity.body) : null) ?? "";
    const chatSessionId = record.chatSessionId;

    if (signal === "stop") {
      stoppedFromLinear.add(info.id);
      await deps.chat.interrupt({ sessionId: chatSessionId }).catch((error) => {
        logger.warn("linear_agent.stop_failed", { agentSessionId: info.id, error: getErrorMessage(error) });
      });
      post(info.id, { type: "response", body: "Stopped. The lane and chat are still in ADE if you want to pick it up again." });
      return;
    }
    if (!body.trim()) return;
    // The chat runs on the delegator's machine with their permissions, so only
    // the delegator may answer its questions or direct it. Anyone may stop it.
    const authorId = activity ? (asString(activity.userId) ?? (isRecord(activity.user) ? asString(activity.user.id) : null)) : null;
    const creatorId = info.creatorId ?? record.creatorId ?? null;
    if (!creatorId || authorId !== creatorId) {
      post(info.id, {
        type: "thought",
        body: `Only ${info.creatorName ?? "the person who started this session"} can direct this session, so ADE ignored that reply.`,
      });
      return;
    }

    const pending = record.pendingInput;
    if (pending) {
      const answer = body.trim();
      const matched = pending.options.find((option) => option.label.toLowerCase() === answer.toLowerCase() || option.value.toLowerCase() === answer.toLowerCase());
      try {
        if (pending.kind === "approval") {
          const explicit = matched?.value
            ?? (/^(yes|allow|accept|approve)\b/i.test(answer) ? "accept"
              : /^(no|deny|decline|reject|stop|cancel)\b/i.test(answer) ? "decline" : null);
          if (explicit !== "accept" && explicit !== "decline") throw new Error("not an approval answer");
          const decision: AgentChatApprovalDecision = explicit;
          await deps.chat.respondToInput({ sessionId: chatSessionId, itemId: pending.itemId, decision });
        } else {
          await deps.chat.respondToInput({
            sessionId: chatSessionId,
            itemId: pending.itemId,
            // A missing decision reads as a decline downstream.
            decision: "accept",
            ...(pending.questionId ? { answers: { [pending.questionId]: matched?.value ?? answer } } : { responseText: answer }),
          });
        }
        remember({ ...record, pendingInput: null });
        return;
      } catch (error) {
        logger.warn("linear_agent.answer_failed", { agentSessionId: info.id, error: getErrorMessage(error) });
      }
    }
    await deps.chat.sendMessage({
      sessionId: chatSessionId,
      text: `${info.creatorName ?? "The Linear user"} replied in Linear:\n\n${body.trim()}`,
      displayText: body.trim(),
    }).catch((error) => {
      post(info.id!, { type: "error", body: `ADE could not pass your message to the agent: ${getErrorMessage(error)}` });
    });
  };

  const handleEvent = async (record: LinearIngressEventRecord): Promise<void> => {
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!payload) return;
    // The relay sets `routedAccountId` on every agent event it could route. A
    // reader with workspace-wide access also sees sessions routed to others
    // (or to nobody); those are not this machine's to answer.
    if (record.routedAccountId === undefined) return;
    const mine = deps.getAccountId();
    if (!record.routedAccountId || (mine && record.routedAccountId !== mine)) return;
    if (record.action === "created") await handleCreated(record, payload);
    else if (record.action === "prompted") await handlePrompted(payload);
  };

  // ---- automation hooks ---------------------------------------------------
  const hooks: AutomationLinearAgentHooks = {
    async beforeRun({ rule }) {
      const modelId = rule.modelConfig?.modelId?.trim();
      if (!modelId) throw new Error(`The automation "${rule.name}" has no model. Choose one in ADE → Automations; the ADE agent never picks a model on its own.`);
      const descriptor = getModelById(modelId);
      if (!descriptor) throw new Error(`The automation "${rule.name}" uses the model "${modelId}", which this ADE does not know.`);
      const provider = resolveProviderGroupForModel(descriptor);
      const available = await deps.chat.getAvailableModels({ provider, activateRuntime: provider !== "claude" && provider !== "codex" })
        .catch(() => [] as Array<{ id: string; modelId?: string | null }>);
      if (!available.some((model) => model.id === descriptor.id || model.modelId === descriptor.id)) {
        throw new Error(`${descriptor.displayName ?? modelId} is not available on ${deps.machine.name ?? "this machine"} (the ${provider} provider is signed out, missing, or out of usage).`);
      }
    },

    async resolveLane({ rule, trigger }) {
      if ((rule.execution?.laneMode ?? "reuse") !== "create") return null;
      const issueId = trigger.linear?.issue.id;
      if (!issueId) return null;
      const issue = await deps.fetchIssue(issueId).catch(() => null);
      if (!issue) return null;
      return await deps.lanes.createLaneForIssue(normalizedLinearIssueToLaneIssue(issue));
    },

    async onSessionCreated({ trigger, runId, sessionId, laneId }) {
      const agentSessionId = trigger.linearAgent?.agentSessionId;
      if (!agentSessionId) return;
      const existing = sessions.get(agentSessionId);
      remember({
        agentSessionId,
        chatSessionId: sessionId,
        laneId,
        runId,
        issueId: existing?.issueId ?? trigger.linear?.issue.id ?? null,
        issueIdentifier: existing?.issueIdentifier ?? null,
        creatorId: existing?.creatorId ?? null,
        startedAt: existing?.startedAt ?? new Date().toISOString(),
        pendingInput: null,
      });
      const issueId = trigger.linear?.issue.id;
      if (issueId) {
        const issue = await deps.fetchIssue(issueId).catch(() => null);
        if (issue) {
          await deps.lanes.attachIssueToSession({ chatSessionId: sessionId, issue: normalizedLinearIssueToLaneIssue(issue) }).catch((error) => {
            logger.warn("linear_agent.attach_issue_failed", { agentSessionId, error: getErrorMessage(error) });
          });
        }
      }
      const url = buildDeeplink({ kind: "session", sessionId, laneId });
      void relay.updateSession(agentSessionId, { addedExternalUrls: [{ label: "Open in ADE", url }] }).catch(() => {});
      void relay.startWork(agentSessionId).catch(() => {});
      const laneName = await deps.lanes.getLaneName(laneId).catch(() => null);
      post(agentSessionId, {
        type: "thought",
        body: `Working in lane **${laneName ?? laneId}**${deps.machine.name ? ` on ${deps.machine.name}` : ""}.`,
      });
    },

    onRunFinished({ trigger, status, error, sessionId }) {
      const agentSessionId = trigger.linearAgent?.agentSessionId;
      if (!agentSessionId || status !== "failed") return;
      // A failure after the chat started is reported by the chat's own error
      // event; only report failures that happened before it existed.
      if (sessionId && byChat.has(sessionId)) return;
      post(agentSessionId, {
        type: "error",
        body: `ADE could not start: ${error ?? "unknown error"}\n\nThe failed run is in ADE → Automations → History.`,
      });
    },
  };
  deps.automation.setLinearAgentHooks(hooks);

  // ---- ADE → Linear --------------------------------------------------------
  const flushThought = (agentSessionId: string, chatSessionId: string): void => {
    const state = turnState.get(chatSessionId);
    if (!state) return;
    if (state.thoughtTimer) {
      clearTimeout(state.thoughtTimer);
      state.thoughtTimer = null;
    }
    const paragraph = lastParagraph(state.text);
    state.text = "";
    if (!paragraph) return;
    state.lastThoughtAt = Date.now();
    post(agentSessionId, { type: "thought", body: truncate(paragraph, MAX_THOUGHT_CHARS) });
  };

  const stateFor = (chatSessionId: string) => {
    let state = turnState.get(chatSessionId);
    if (!state) {
      state = { text: "", lastThoughtAt: 0, lastActionAt: 0, thoughtTimer: null, finalText: "", postedToolItems: new Set(), lastActionLabel: null, lastError: null };
      turnState.set(chatSessionId, state);
    }
    return state;
  };

  /** Shows one step of the turn in Linear: each item once, and never the same line twice in a row. */
  const postStep = (
    agentSessionId: string,
    chatSessionId: string,
    itemKey: string,
    described: { action: string; parameter: string },
  ): void => {
    const state = stateFor(chatSessionId);
    if (state.text.trim()) flushThought(agentSessionId, chatSessionId);
    state.finalText = "";
    // The first emission of an item often has no arguments yet; wait for the
    // one that does, and show each item once.
    if (!described.parameter || state.postedToolItems.has(itemKey)) return;
    state.postedToolItems.add(itemKey);
    const label = `${described.action}\u0000${described.parameter}`;
    if (label === state.lastActionLabel) return;
    state.lastActionLabel = label;
    const now = Date.now();
    // Reads and searches are cheap and many: show them as ephemeral so the
    // timeline keeps only the meaningful steps.
    const ephemeral = described.action === "Read" || described.action === "Searched" || now - state.lastActionAt < ACTION_MIN_INTERVAL_MS;
    state.lastActionAt = now;
    post(agentSessionId, { type: "action", action: described.action, parameter: described.parameter }, { ephemeral });
  };

  const pendingFromApproval = (event: { itemId: string; description: string; detail?: unknown; requestKind?: string }) => {
    const detail = isRecord(event.detail) ? event.detail : null;
    const request = detail && isRecord(detail.request) ? (detail.request as unknown as PendingInputRequest) : null;
    const question = request?.questions?.[0] ?? null;
    const isQuestion = event.requestKind === "question" || Boolean(question);
    const options = (question?.options ?? request?.options ?? []).map((option) => ({ label: option.label, value: option.value }));
    const body = question?.question ?? request?.description ?? request?.title ?? event.description;
    return {
      pending: {
        itemId: event.itemId,
        kind: isQuestion ? "question" as const : "approval" as const,
        questionId: question?.id ?? null,
        options: isQuestion ? options : [{ label: "Allow", value: "accept" }, { label: "Deny", value: "decline" }],
      },
      body: isQuestion ? body : `The agent needs your approval: ${body}`,
    };
  };

  const onChatEvent = (envelope: AgentChatEventEnvelope): void => {
    const agentSessionId = byChat.get(envelope.sessionId);
    if (!agentSessionId) return;
    const record = sessions.get(agentSessionId);
    if (!record) return;
    const now = Date.now();
    if (now - (lastClaimAt.get(agentSessionId) ?? 0) >= CLAIM_RENEW_MS) {
      lastClaimAt.set(agentSessionId, now);
      void relay.claimSession(agentSessionId, { machineId: deps.machine.id, machineName: deps.machine.name }).catch(() => {});
    }
    const event = envelope.event;
    const state = stateFor(envelope.sessionId);
    switch (event.type) {
      case "text": {
        state.text += event.text;
        state.finalText += event.text;
        if (!state.thoughtTimer && Date.now() - state.lastThoughtAt >= THOUGHT_MIN_INTERVAL_MS) {
          state.thoughtTimer = setTimeout(() => flushThought(agentSessionId, envelope.sessionId), 1_500);
          state.thoughtTimer.unref?.();
        }
        break;
      }
      // Claude, Cursor, Droid and OpenCode report steps as tool calls; Codex
      // reports shell commands and file edits as their own events.
      case "tool_call": {
        postStep(agentSessionId, envelope.sessionId, event.logicalItemId ?? event.itemId, describeToolCall(event.tool, event.args));
        break;
      }
      case "command": {
        // A `!` run typed into the chat is the user's own shell, not a step the agent took.
        if (event.source === "userShell") break;
        postStep(agentSessionId, envelope.sessionId, event.logicalItemId ?? event.itemId, { action: "Ran", parameter: describeShellCommand(event.command) });
        break;
      }
      case "file_change": {
        const action = event.kind === "create" ? "Created" : event.kind === "delete" ? "Deleted" : "Edited";
        // One Codex item can carry several files, each emitted with the same item id: key by path too.
        postStep(agentSessionId, envelope.sessionId, `${event.logicalItemId ?? event.itemId}:${event.path}`, { action, parameter: shortenWorktreePaths(event.path) });
        break;
      }
      case "plan": {
        void relay.updateSession(agentSessionId, {
          plan: event.steps.map((step) => ({ content: truncate(step.text, 300), status: mapPlanStatus(step.status) })),
        }).catch(() => {});
        break;
      }
      case "todo_update": {
        void relay.updateSession(agentSessionId, {
          plan: event.items.map((item) => ({
            content: truncate(item.description, 300),
            status: item.cancelled ? "canceled" : mapPlanStatus(item.status),
          })),
        }).catch(() => {});
        break;
      }
      case "approval_request": {
        const { pending, body } = pendingFromApproval(event);
        remember({ ...record, pendingInput: pending });
        post(agentSessionId, {
          type: "elicitation",
          body: truncate(body, 2_000),
          ...(pending.options.length ? { signal: "select" as const, signalMetadata: { options: pending.options } } : {}),
        });
        break;
      }
      case "structured_question": {
        const options = (event.options ?? []).map((option) => ({ label: option.label, value: option.value }));
        remember({ ...record, pendingInput: { itemId: event.itemId, kind: "question", questionId: null, options } });
        post(agentSessionId, {
          type: "elicitation",
          body: truncate(event.question, 2_000),
          ...(options.length ? { signal: "select" as const, signalMetadata: { options } } : {}),
        });
        break;
      }
      case "pending_input_resolved": {
        if (record.pendingInput?.itemId === event.itemId) remember({ ...record, pendingInput: null });
        break;
      }
      case "error": {
        // Most chat errors are recoverable (a declined or failed tool); a
        // Linear error would mark the whole session failed. Show it as a note
        // and report an error only if the turn itself fails.
        state.lastError = event.message;
        post(agentSessionId, { type: "thought", body: truncate(`Problem: ${event.message}`, MAX_THOUGHT_CHARS) });
        break;
      }
      case "done": {
        if (state.thoughtTimer) clearTimeout(state.thoughtTimer);
        const final = state.finalText.trim();
        turnState.delete(envelope.sessionId);
        if (event.status === "completed") {
          post(agentSessionId, { type: "response", body: truncate(final || "Done.", MAX_RESPONSE_CHARS) });
        } else if (event.status === "failed") {
          post(agentSessionId, {
            type: "error",
            body: truncate(state.lastError ?? (final || "The agent's turn failed. The chat in ADE has the details."), MAX_RESPONSE_CHARS),
          });
        } else if (event.status === "interrupted" && !stoppedFromLinear.delete(agentSessionId)) {
          // A declined tool can end the turn too; say why instead of a bare "Stopped.".
          const why = state.lastError ? `Stopped: ${state.lastError}` : "Stopped.";
          post(agentSessionId, { type: "response", body: truncate(final ? `${final}\n\n(${why})` : why, MAX_RESPONSE_CHARS) });
        }
        break;
      }
      default:
        break;
    }
  };

  return {
    handleEvent,
    onChatEvent,
    async getOverview(): Promise<LinearAgentOverview> {
      const rules = deps.automation.listAgentRules();
      const activeSessions = [...sessions.values()]
        .filter((entry) => entry.chatSessionId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 20)
        .map((entry) => ({
          agentSessionId: entry.agentSessionId,
          chatSessionId: entry.chatSessionId!,
          laneId: entry.laneId,
          issueIdentifier: entry.issueIdentifier,
          startedAt: entry.startedAt,
        }));
      try {
        const status = await relay.getStatus();
        return { available: true, message: null, status, rules, activeSessions };
      } catch (error) {
        return { available: false, message: getErrorMessage(error), status: null, rules, activeSessions };
      }
    },
    dispose(): void {
      deps.automation.setLinearAgentHooks(null);
      for (const state of turnState.values()) if (state.thoughtTimer) clearTimeout(state.thoughtTimer);
      turnState.clear();
      for (const timer of noRuleTimers) {
        clearTimeout(timer);
        cancelNoRuleWait.get(timer)?.();
      }
      noRuleTimers.clear();
    },
  };
}

export type LinearAgentService = ReturnType<typeof createLinearAgentService>;
