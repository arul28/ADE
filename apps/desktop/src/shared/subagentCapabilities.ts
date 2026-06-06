import type { AgentChatProvider } from "./types/chat";

/**
 * Per-runtime subagent capability descriptor.
 *
 * ADE's Work-tab subagent system is built on a shared event vocabulary
 * (`subagent_started/progress/result`, `teammate.idle`, `task.completed`) and a
 * shared snapshot builder, but each chat runtime exposes a *different* amount of
 * subagent detail. Codex (app-server) can hand back a full child-thread
 * transcript; OpenCode child sessions are real sessions so their messages are
 * fetchable; Claude persists per-subagent JSONL the SDK can read; Cursor only
 * surfaces a delegation lifecycle with no child transcript; Droid only spawns
 * workers in AGI orchestrator mode.
 *
 * Rather than scattering `provider === "codex"` checks across the service and
 * the renderer, every runtime declares what it can do here, and both the
 * transcript dispatch and the UI branch on this single source of truth. The key
 * rule: only runtimes with `canViewFullTranscript` get Codex's
 * "click a subagent → its transcript replaces the main chat" takeover; everyone
 * else shows whatever they *do* emit in the inline details drawer.
 */
export type SubagentStatField =
  | "tokens"
  | "toolUses"
  | "durationMs"
  | "model"
  | "reasoningEffort"
  | "role"
  | "cost"
  | "diffSummary"
  | "exitCode";

export type SubagentKind =
  | "subagent"
  | "background"
  | "local_workflow"
  | "cron"
  | "teammate"
  | "other";

export type SubagentCapability = {
  /** Runtime emits subagent lifecycle events we can list in the panel. */
  canList: boolean;
  /**
   * A real per-subagent transcript can be pulled → enable the click-to-takeover
   * that replaces the main chat with the subagent's own transcript. When false,
   * clicking a subagent opens the inline details drawer instead.
   */
  canViewFullTranscript: boolean;
  /** Which drawer stat fields this runtime can realistically populate. */
  statsFields: SubagentStatField[];
  /** Distinct subagent kinds this runtime emits (drives consolidation + badges). */
  kinds: SubagentKind[];
  /** Runtime exposes rich per-agent metadata (model / reasoning effort / role). */
  hasRichMetadata: boolean;
};

/** Runtime keys we have a subagent story for. Mirrors `runtime.kind` + provider. */
export type SubagentRuntimeKey =
  | "codex"
  | "claude"
  | "opencode"
  | "cursor"
  | "droid"
  | "lmstudio";

export const NO_SUBAGENT_CAPABILITY: SubagentCapability = {
  canList: false,
  canViewFullTranscript: false,
  statsFields: [],
  kinds: [],
  hasRichMetadata: false,
};

export const SUBAGENT_CAPABILITIES: Record<SubagentRuntimeKey, SubagentCapability> = {
  // Reference implementation. App-server exposes full child threads + rich
  // per-agent metadata (model, reasoning effort, role) via `thread/turns/list`.
  codex: {
    canList: true,
    canViewFullTranscript: true,
    statsFields: ["tokens", "toolUses", "durationMs", "model", "reasoningEffort", "role"],
    kinds: ["subagent"],
    hasRichMetadata: true,
  },
  // Five task kinds (Task tool / background / local workflow / cron / other) all
  // consolidate into one list with badges. Full transcript via the SDK's
  // getSubagentMessages (reads per-subagent JSONL from the session store).
  // (ADE "teammates" are a separate teams concept on their own surface, so they
  // are intentionally not listed here.)
  claude: {
    canList: true,
    canViewFullTranscript: true,
    statsFields: ["tokens", "toolUses", "durationMs"],
    kinds: ["subagent", "background", "local_workflow", "cron", "other"],
    hasRichMetadata: false,
  },
  // Each child session is a real session, so session.messages returns the full
  // child transcript. Per-child usage/cost is aggregated from its messages.
  opencode: {
    canList: true,
    canViewFullTranscript: true,
    statsFields: ["diffSummary", "tokens", "cost", "durationMs"],
    kinds: ["subagent"],
    hasRichMetadata: false,
  },
  // Cursor's SDK (1.0.13) surfaces only a delegation lifecycle — the subagent's
  // interior is encapsulated in one parent `Agent` tool call, so there is no
  // child transcript to pull. List + inline drawer only, never takeover.
  cursor: {
    canList: true,
    canViewFullTranscript: false,
    statsFields: ["durationMs"],
    kinds: ["subagent"],
    hasRichMetadata: false,
  },
  // Workers only spawn in AGI orchestrator mode (DroidInteractionMode.AGI). Their
  // lifecycle (mission_worker_started/completed) maps to subagent events, but
  // Droid exposes no inline per-worker transcript (would need an out-of-band
  // resumeSession), so takeover stays off — the drawer shows status + exit code.
  droid: {
    canList: true,
    canViewFullTranscript: false,
    statsFields: ["durationMs", "exitCode"],
    kinds: ["subagent"],
    hasRichMetadata: false,
  },
  lmstudio: NO_SUBAGENT_CAPABILITY,
};

/**
 * Resolve the subagent capability for a session. Prefers the live runtime kind;
 * falls back to the persisted provider when a chat is opened from history and
 * the runtime is idle (mirrors the provider-fallback the transcript dispatch
 * already uses). Unknown runtimes get the no-op descriptor.
 */
export function resolveSubagentCapability(
  provider: AgentChatProvider | null | undefined,
  runtimeKind?: string | null,
): SubagentCapability {
  const key = (runtimeKind ?? provider ?? "").toString();
  if (Object.prototype.hasOwnProperty.call(SUBAGENT_CAPABILITIES, key)) {
    return SUBAGENT_CAPABILITIES[key as SubagentRuntimeKey];
  }
  return NO_SUBAGENT_CAPABILITY;
}
