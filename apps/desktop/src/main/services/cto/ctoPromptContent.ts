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
  workerAgentService: null,
  workerHeartbeatService: null,
  linearDispatcherService: null,
  flowPolicyService: null,
  prService: null,
  issueInventoryService: null,
  fileService: null,
  processService: null,
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
    "- Always default laneId to the CTO's current lane if the user doesn't specify one.",
    "- For model-specific requests, always resolve the user's model name to the full modelId before calling spawnChat.",
  ].join("\n");
}
