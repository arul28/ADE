/**
 * Five host MCP tool names whose spellings used to decide their own approval.
 *
 * Under ADE's old substring approval gate, `edit_clip`, `write_note`, and
 * `list_agents` prompted because their names contain "edit", "write", and
 * "agent", while `set_tempo` and `search_projects` did not — a read-only tool
 * asked for permission and a destructive one did not, purely on spelling. A
 * structured permission policy must decide all five identically, from the
 * policy and nothing else.
 *
 * Reported as part C of ADE issue 1208
 * (https://github.com/arul28/ADE/issues/1208).
 *
 * Shared by `permissionPolicy.test.ts`, which asserts it against the policy
 * evaluator, `claudeToolGate.test.ts`, and `agentChatService.test.ts`, which
 * asserts it end to end through Claude's `canUseTool`. One list, so the layers
 * cannot be tested against different cases.
 */
export const HOST_TOOL_APPROVAL_NAMES = [
  "mcp__srv__search_projects",
  "mcp__srv__set_tempo",
  "mcp__srv__edit_clip",
  "mcp__srv__write_note",
  "mcp__srv__list_agents",
] as const;
