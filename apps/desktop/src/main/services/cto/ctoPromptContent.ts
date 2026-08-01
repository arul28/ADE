import { createCtoOperatorTools, type CtoOperatorToolDeps } from "../ai/tools/ctoOperatorTools";

type ToolPreviewDeps = CtoOperatorToolDeps & {
  previewSessionToolNames: (args: { provider?: string; model?: string; identityKey?: string }) => string[];
};

const previewDeps = {
  currentSessionId: "preview-cto-session",
  defaultLaneId: "preview-lane",
  defaultModelId: null,
  defaultReasoningEffort: null,
  resolveExecutionLane: async () => "preview-lane",
  laneService: null,
  prService: null,
  fileService: null,
  testService: null,
  ptyService: null,
  automationService: null,
  gitService: null,
  conflictService: null,
  steerChat: undefined,
  cancelSteer: undefined,
  handoffChat: undefined,
  listSubagents: undefined,
  approveToolUse: undefined,
  issueTracker: null,
  ctoStateService: null,
  listChats: async () => [],
  getChatStatus: async () => null,
  getChatTranscript: async () => null,
  createChat: async () => ({ id: "preview-chat" }),
  updateChatSession: async () => undefined,
  sendChatMessage: async () => undefined,
  interruptChat: async () => undefined,
  sessionService: { updateMeta: async () => undefined },
  ensureCtoSession: async () => ({ id: "preview-cto-session", laneId: "preview-lane" }),
  previewSessionToolNames: () => [],
} as unknown as ToolPreviewDeps;

/**
 * Onboarding step id that records the CTO's opening turn. Not a user-facing
 * setup step — it lives in the same list so it is persisted and so
 * `resetOnboarding` clears it alongside the rest.
 */
export const CTO_INTRO_ONBOARDING_STEP = "intro";

/**
 * The first message in a brand-new CTO thread, sent as a real, visible user
 * turn. It is deliberately not hidden: ADE has no hidden-turn mechanism, and a
 * canned assistant message would be a fabricated transcript entry that then
 * feeds back into the model's context on every later turn. A visible prompt is
 * honest about what happened and costs nothing extra.
 */
export const CTO_INTRO_PROMPT = [
  "Introduce yourself: who you are, what you can do for me in this project, and how your memory works across model switches.",
  "Then scan the project and tell me what you actually see — lanes, open PRs, anything blocked — and what you would look at first.",
  "Keep it short.",
].join(" ");

function compactDescription(description: string): string {
  return description
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

export function buildCtoCapabilityManifest(): string {
  const tools = createCtoOperatorTools(previewDeps);
  const lines = Object.entries(tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => `  ${name} — ${compactDescription(definition.description)}`);
  return [
    "# ADE Operator Tools (generated reference)",
    "",
    "Generated from ctoOperatorTools.ts so prompt capability docs stay aligned with the registered tool surface.",
    "",
    ...lines,
    "",
    "# Operating Rules",
    "",
    "- Internal ADE actions run through service-backed tools even when no renderer click occurs.",
    "- UI navigation is suggestion-only. When an action should open in ADE, return an explicit navigation suggestion instead of silently switching tabs.",
    "- Treat ADE as your operating environment. Do not describe yourself as blocked on renderer button clicks when an internal tool can do the work.",
    "- When multiple tools exist for similar purposes, prefer the higher-level one (e.g., createPrFromLane over manual git commands).",
    "- Never launch implementation work on your own lane. Your session is pinned to the project's primary lane, and agents working there would write straight to the primary worktree.",
    "- When the user does not name a lane, let the work get a dedicated lane: call spawnChat without laneId (it creates one), or createLane first and pass that id. Only pass laneId when the user named an existing lane.",
    "- Read-only inspection (status, listing chats, reading files, git status) may target any lane, including your own.",
    "- For model-specific requests, always resolve the user's model name to the full modelId before calling spawnChat.",
  ].join("\n");
}
