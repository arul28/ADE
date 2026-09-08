// ---------------------------------------------------------------------------
// Workflow tool NAMES.
//
// This module used to build executable `createLane` / `createPrFromLane` /
// `captureScreenshot` / `pr*` / `reportCompletion` tools. None of them were
// reachable: `createWorkflowTools` had exactly one non-test caller,
// `agentChatService.previewSessionToolNames`, which read `Object.keys(...)` and
// threw the object away. No live tool registry — the Claude SDK MCP server, the
// Codex dynamic tool list, the HTTP MCP lease — ever received them, so an agent
// that called one got "tool not found" while the system prompt advertised it.
//
// The names are the only part that was ever used, so the names are all that is
// left. Of them, exactly two are backed by something that runs:
//
//   createLane, createPrFromLane  -> live, in `ctoOperatorTools.ts`
//   reportCompletion, captureScreenshot, and every pr* name
//                                 -> no implementation in any registry
//
// The system prompt therefore only ever describes the first two; a bullet for
// the others earned the model a tool-not-found error. The remaining consumer of
// this list is `agentChatService.previewSessionToolNames`, which itself has no
// non-test caller today, so treat the list as descriptive rather than load-
// bearing and verify against a live registry before relying on it.
//
// If a workflow tool should become callable, wire it into one of the runtime
// tool maps in `agentChatService` (see `createCtoRuntimeToolMap`) rather than
// re-adding a builder nothing executes.
// ---------------------------------------------------------------------------

/** Available whenever the session profile is not `light`. */
const CORE_WORKFLOW_TOOL_NAMES = ["createLane", "reportCompletion"] as const;

/** Available only when a PR service is configured for the project. */
const PR_WORKFLOW_TOOL_NAMES = [
  "createPrFromLane",
  "prGetReviewComments",
  "prReplyToComment",
  "prGetChecks",
  "prGetCheckLog",
  "prRefreshIssueInventory",
  "prRerunFailedChecks",
  "prReplyToReviewThread",
  "prResolveReviewThread",
] as const;

/** Available only when the computer-use artifact broker is configured. */
const COMPUTER_USE_WORKFLOW_TOOL_NAMES = ["captureScreenshot"] as const;

/**
 * The workflow tool names a session would advertise, gated the same way the
 * builder gated them.
 */
export function workflowToolNames(args: {
  hasPrService: boolean;
  hasComputerUseArtifactBroker: boolean;
}): string[] {
  return [
    ...CORE_WORKFLOW_TOOL_NAMES,
    ...(args.hasPrService ? PR_WORKFLOW_TOOL_NAMES : []),
    ...(args.hasComputerUseArtifactBroker ? COMPUTER_USE_WORKFLOW_TOOL_NAMES : []),
  ];
}
