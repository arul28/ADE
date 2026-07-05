/**
 * Defensive normalization for the Claude Agent SDK's `workflow_progress`
 * payload on `system:task_progress` messages.
 *
 * The field is deliberate wire surface (the CLI's own /workflows view renders
 * it) but is absent from the published SDK types, so every read here must
 * tolerate absence, shape drift, and unknown phases: malformed entries and
 * unknown entry types are dropped, previews are clipped, and entry counts are
 * capped. Nothing in this module throws on hostile input — a snapshot that
 * can't be understood returns `undefined` and the caller falls back to
 * today's generic task rendering.
 *
 * The payload is a CUMULATIVE snapshot (phases + agents + narration) re-sent
 * on every progress tick, last write wins per agent/phase index. To fold it
 * into ADE's existing subagent snapshot model (one `subagent_*` event stream
 * per agent, keyed `agentId ?? taskId`), `planClaudeWorkflowAgentTransitions`
 * diffs each tick against the per-task emit state and returns only the
 * started/progress/result transitions, under a stable per-(task, agent)
 * identity so stream reconnects upsert one row instead of duplicating.
 */

export type ClaudeWorkflowPhase = {
  index: number;
  title: string;
};

export type ClaudeWorkflowAgent = {
  /**
   * Stable fold identity: the SDK agentId when present, else a synthetic
   * `<taskId>::a<index>`. Never the workflow's own taskId — that would
   * collide with (and re-key away) the parent workflow row in the snapshot
   * folds.
   */
  key: string;
  index: number;
  name: string;
  status: "running" | "completed" | "failed";
  summary: string;
  /** Real SDK agent id (enables per-agent transcript drill-down). */
  agentId?: string;
  agentType?: string;
  phaseTitle?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  lastToolName?: string;
};

export type ClaudeWorkflowProgressSnapshot = {
  phases: ClaudeWorkflowPhase[];
  /** Agents that have started or finished. Queued agents are only counted. */
  agents: ClaudeWorkflowAgent[];
  queuedCount: number;
  runningCount: number;
  doneCount: number;
  failedCount: number;
};

const MAX_AGENT_ENTRIES = 300;
const MAX_PHASE_ENTRIES = 50;
const MAX_PREVIEW_CHARS = 240;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readClippedString(value: unknown, limit: number): string | undefined {
  const text = readString(value);
  if (text === undefined) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type RawAgentEntry = {
  index: number;
  state: string;
  started: boolean;
  terminal: boolean;
  failed: boolean;
  label?: string;
  agentId?: string;
  agentType?: string;
  phaseTitle?: string;
  blocked: boolean;
  error?: string;
  resultPreview?: string;
  lastToolSummary?: string;
  lastToolName?: string;
  promptPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
};

function normalizeAgentEntry(entry: Record<string, unknown>): RawAgentEntry | undefined {
  const index = readFiniteNumber(entry.index);
  const state = readString(entry.state);
  if (index === undefined || state === undefined) return undefined;
  const terminal = state === "done" || state === "error";
  const started = terminal
    || readFiniteNumber(entry.startedAt) !== undefined
    || readFiniteNumber(entry.lastProgressAt) !== undefined;
  return {
    index,
    state,
    started,
    terminal,
    failed: state === "error",
    label: readClippedString(entry.label, MAX_PREVIEW_CHARS),
    agentId: readString(entry.agentId),
    agentType: readString(entry.agentType),
    phaseTitle: readClippedString(entry.phaseTitle, MAX_PREVIEW_CHARS),
    blocked: entry.blocked === true,
    error: readClippedString(entry.error, MAX_PREVIEW_CHARS),
    resultPreview: readClippedString(entry.resultPreview, MAX_PREVIEW_CHARS),
    lastToolSummary: readClippedString(entry.lastToolSummary, MAX_PREVIEW_CHARS),
    lastToolName: readString(entry.lastToolName),
    promptPreview: readClippedString(entry.promptPreview, MAX_PREVIEW_CHARS),
    tokens: readFiniteNumber(entry.tokens),
    toolCalls: readFiniteNumber(entry.toolCalls),
    durationMs: readFiniteNumber(entry.durationMs),
  };
}

function agentSummary(entry: RawAgentEntry): string {
  const detail = entry.failed
    ? (entry.error ?? "failed")
    : entry.terminal
      ? (entry.resultPreview ?? "done")
      : (entry.lastToolSummary
        ?? (entry.lastToolName ? `running ${entry.lastToolName}` : undefined)
        ?? entry.promptPreview
        ?? "running");
  const parts: string[] = [];
  if (entry.phaseTitle) parts.push(entry.phaseTitle);
  if (entry.blocked) parts.push("blocked by safety filter");
  parts.push(detail);
  return parts.join(" · ");
}

/**
 * Parse one `workflow_progress` snapshot. Returns `undefined` when the value
 * isn't a recognizable snapshot (absent field, shape drift, empty array).
 */
export function parseClaudeWorkflowProgress(
  value: unknown,
  taskId: string,
): ClaudeWorkflowProgressSnapshot | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  // Last write wins per index: the snapshot may re-emit an agent/phase slot
  // (retries, later progress) and the caps must count unique slots.
  const agentsByIndex = new Map<number, RawAgentEntry>();
  const phasesByIndex = new Map<number, ClaudeWorkflowPhase>();
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    switch (entry.type) {
      case "workflow_agent": {
        const agent = normalizeAgentEntry(entry);
        if (agent && (agentsByIndex.has(agent.index) || agentsByIndex.size < MAX_AGENT_ENTRIES)) {
          agentsByIndex.set(agent.index, agent);
        }
        break;
      }
      case "workflow_phase": {
        const index = readFiniteNumber(entry.index);
        const title = readClippedString(entry.title, MAX_PREVIEW_CHARS);
        if (index !== undefined && title !== undefined
          && (phasesByIndex.has(index) || phasesByIndex.size < MAX_PHASE_ENTRIES)) {
          phasesByIndex.set(index, { index, title });
        }
        break;
      }
      default:
        // Unknown entry types (workflow_log, future additions) are skipped —
        // never a reason to drop the snapshot.
        break;
    }
  }
  if (agentsByIndex.size === 0 && phasesByIndex.size === 0) return undefined;

  const agents: ClaudeWorkflowAgent[] = [];
  let queuedCount = 0;
  let runningCount = 0;
  let doneCount = 0;
  let failedCount = 0;
  for (const entry of [...agentsByIndex.values()].sort((a, b) => a.index - b.index)) {
    if (!entry.started) {
      queuedCount += 1;
      continue;
    }
    const status: ClaudeWorkflowAgent["status"] = entry.failed
      ? "failed"
      : entry.terminal
        ? "completed"
        : "running";
    if (status === "running") runningCount += 1;
    else if (status === "failed") failedCount += 1;
    else doneCount += 1;
    agents.push({
      key: entry.agentId ?? `${taskId}::a${entry.index}`,
      index: entry.index,
      name: entry.label ?? entry.agentType ?? `Agent #${entry.index + 1}`,
      status,
      summary: agentSummary(entry),
      ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
      ...(entry.agentType !== undefined ? { agentType: entry.agentType } : {}),
      ...(entry.phaseTitle !== undefined ? { phaseTitle: entry.phaseTitle } : {}),
      ...(entry.tokens !== undefined ? { tokens: entry.tokens } : {}),
      ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.lastToolName !== undefined ? { lastToolName: entry.lastToolName } : {}),
    });
  }
  return {
    phases: [...phasesByIndex.values()].sort((a, b) => a.index - b.index),
    agents,
    queuedCount,
    runningCount,
    doneCount,
    failedCount,
  };
}

/**
 * One-line rollup for the parent workflow row's summary when the SDK didn't
 * send its own `summary` string.
 */
export function summarizeClaudeWorkflowRun(snapshot: ClaudeWorkflowProgressSnapshot): string {
  const currentPhase = [...snapshot.agents]
    .reverse()
    .find((agent) => agent.status === "running" && agent.phaseTitle !== undefined)?.phaseTitle
    ?? snapshot.phases.at(-1)?.title;
  const counts: string[] = [];
  if (snapshot.runningCount > 0) counts.push(`${snapshot.runningCount} running`);
  if (snapshot.doneCount > 0) counts.push(`${snapshot.doneCount} done`);
  if (snapshot.failedCount > 0) counts.push(`${snapshot.failedCount} failed`);
  if (snapshot.queuedCount > 0) counts.push(`${snapshot.queuedCount} queued`);
  const parts: string[] = [];
  if (currentPhase !== undefined) parts.push(currentPhase);
  if (counts.length > 0) parts.push(counts.join(" · "));
  return parts.join(" — ");
}

export type ClaudeWorkflowAgentEmitState = {
  signature: string;
  terminal: boolean;
  agent: ClaudeWorkflowAgent;
  /**
   * The identity emitted on the first event for this agent, latched so a
   * real SDK agentId arriving on a LATER tick can't re-key the row (the
   * snapshot folds treat a changed agentId as a brand-new subagent).
   */
  agentId: string;
};

export type ClaudeWorkflowAgentTransition = {
  kind: "started" | "progress" | "result";
  agent: ClaudeWorkflowAgent;
  /** Latched emit identity — use this (not agent.key) in the event. */
  agentId: string;
};

function agentSignature(agent: ClaudeWorkflowAgent): string {
  return [
    agent.status,
    agent.summary,
    agent.tokens ?? "",
    agent.toolCalls ?? "",
    agent.durationMs ?? "",
    agent.lastToolName ?? "",
  ].join("|");
}

/**
 * Diff a cumulative snapshot against the per-task emit state and return the
 * `subagent_*` transitions to emit. Mutates `tracked` in place. Terminal
 * agents are frozen — later snapshot re-emissions of a finished agent never
 * produce another event, so reconnect replays stay one row per agent.
 */
export function planClaudeWorkflowAgentTransitions(
  tracked: Map<string, ClaudeWorkflowAgentEmitState>,
  agents: ClaudeWorkflowAgent[],
): ClaudeWorkflowAgentTransition[] {
  const transitions: ClaudeWorkflowAgentTransition[] = [];
  for (const agent of agents) {
    const signature = agentSignature(agent);
    const trackKey = `i${agent.index}`;
    const previous = tracked.get(trackKey);
    if (!previous) {
      const agentId = agent.key;
      tracked.set(trackKey, { signature, terminal: agent.status !== "running", agent, agentId });
      transitions.push({ kind: "started", agent, agentId });
      if (agent.status !== "running") transitions.push({ kind: "result", agent, agentId });
      continue;
    }
    if (previous.terminal) continue;
    const agentId = previous.agentId;
    if (agent.status !== "running") {
      tracked.set(trackKey, { signature, terminal: true, agent, agentId });
      transitions.push({ kind: "result", agent, agentId });
      continue;
    }
    if (previous.signature !== signature) {
      tracked.set(trackKey, { signature, terminal: false, agent, agentId });
      transitions.push({ kind: "progress", agent, agentId });
    }
  }
  return transitions;
}

/**
 * Remove and return the agents that never reached a terminal state — the
 * caller emits `stopped` results for them when the workflow task ends or the
 * turn is interrupted.
 */
export function drainRunningClaudeWorkflowAgents(
  tracked: Map<string, ClaudeWorkflowAgentEmitState> | undefined,
): Array<{ agent: ClaudeWorkflowAgent; agentId: string }> {
  if (!tracked) return [];
  const running: Array<{ agent: ClaudeWorkflowAgent; agentId: string }> = [];
  for (const state of tracked.values()) {
    if (!state.terminal) running.push({ agent: state.agent, agentId: state.agentId });
  }
  tracked.clear();
  return running;
}
