/**
 * What ADE knows about one Claude tool call before it decides anything.
 *
 * Four questions, all pure, all answerable from the tool's name and input
 * alone: what is this tool called in a comparable form, is it one of Claude's
 * own read-only built-ins, which paths does the call name, and — with no host
 * policy in play — does ADE's own heuristic want to prompt for it.
 *
 * `claudeBuiltInIsReadOnly` is the exemption that decides whether an embedder
 * on `fallback: "ask"` gets an approval card for every single file read — the
 * difference between cards a user reads and cards a user learns to click
 * through.
 *
 * `claudeToolNeedsApproval` is the pre-policy heuristic and is deliberately
 * left as it was, substring tests included. It is the thing a structured
 * permission policy REPLACES; a policy session never calls it. Rewriting it
 * here would change behavior for every session that has no policy, which is
 * every ADE chat.
 */

/**
 * Claude's own read-only built-ins, in normalized form.
 *
 * A literal set. Membership is never inferred from a substring, so `Read`
 * matches and `ReadTheDatabase` does not, and an MCP tool — which normalizes
 * with its `mcp_<server>_` prefix intact — can never match by accident. That is
 * the point: a host tool's risk is never guessed from its name.
 */
export const CLAUDE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "glob", "grep", "toolsearch", "tasklist", "taskget",
  "webfetch", "websearch",
]);

/**
 * One tool name in comparable form: lowercased, every run of non-alphanumeric
 * characters collapsed to a single underscore.
 *
 * So `NotebookEdit`, `notebook-edit`, and `notebook edit` are one key, and
 * `mcp__srv__read` becomes `mcp_srv_read` — still prefixed, still not `read`.
 */
export function normalizeToolNameForApproval(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Whether a tool is one of Claude's own read-only built-ins.
 *
 * The one exemption from prompting when a permission policy's verdict is
 * "ask", so that a host asking about writes is not also asked about every file
 * read.
 */
export function claudeBuiltInIsReadOnly(toolName: string): boolean {
  return CLAUDE_READ_ONLY_TOOLS.has(normalizeToolNameForApproval(toolName));
}

/**
 * Input keys a Claude tool uses to name a file.
 *
 * A fixed list, and strings only. It feeds `sandboxRoot` containment, and a
 * check that guessed at unknown keys would either wave through a write it never
 * saw or refuse a tool that touches no file at all.
 */
export const CLAUDE_TOOL_PATH_INPUT_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
] as const;

/**
 * Every path a Claude tool call names in its own input, de-duplicated.
 *
 * Empty for a tool that names none — `Bash` carries a `command` and no path —
 * and an empty result means containment cannot judge the call, so the policy's
 * tool rules and fallback decide it instead.
 */
export function claudeToolInputPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length > 0 && !paths.includes(trimmed)) paths.push(trimmed);
  };
  for (const key of CLAUDE_TOOL_PATH_INPUT_KEYS) push(input[key]);
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === "object" && !Array.isArray(edit)) {
        push((edit as Record<string, unknown>).file_path);
      }
    }
  }
  return paths;
}

/**
 * ADE's own pre-policy prompting heuristic.
 *
 * Substring tests on a normalized name, which is exactly as coarse as it looks:
 * it prompts for a read-only `list_agents` because the name contains "agent",
 * and stays silent for a destructive `delete_project` because it does not.
 * That imprecision is the reason structured permission policies exist.
 *
 * It is kept verbatim because it is the behavior of every chat that supplies no
 * policy, which is every ADE chat outside the SDK surface. A session WITH a
 * policy never reaches it — `canUseTool` answers from the policy instead.
 */
export function claudeToolNeedsApproval(
  toolName: string,
  _input: Record<string, unknown>,
  permissionMode: string,
): boolean {
  const normalized = normalizeToolNameForApproval(toolName);
  // bypassPermissions → never prompt
  if (permissionMode === "bypassPermissions") return false;
  // plan mode → handled elsewhere (deny writes entirely)
  if (permissionMode === "plan") return false;
  // Read-only tools never need approval
  if (CLAUDE_READ_ONLY_TOOLS.has(normalized)) return false;
  // acceptEdits → only prompt for Bash
  if (permissionMode === "acceptEdits") {
    return normalized.includes("bash");
  }
  // default → prompt for mutating tools (Bash, Write, Edit, NotebookEdit, Agent, etc.)
  if (normalized.includes("bash") || normalized.includes("write") || normalized.includes("edit")
    || normalized.includes("agent") || normalized.includes("notebookedit")) {
    return true;
  }
  return false;
}
