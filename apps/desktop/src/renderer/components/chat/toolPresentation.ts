type ToolDisplay = {
  label: string;
  secondaryLabel: string | null;
};

const TOOL_LABEL_OVERRIDES: Record<string, string> = {
  Read: "Read",
  Grep: "Search",
  Glob: "Find files",
  LS: "List files",
  Write: "Write",
  Edit: "Edit",
  MultiEdit: "Edit",
  NotebookEdit: "Notebook",
  Bash: "Shell",
  BashOutput: "Command output",
  KillBash: "Stop command",
  WebSearch: "Web search",
  WebFetch: "Fetch page",
  TodoWrite: "Plan",
  TodoRead: "Plan",
  Task: "Task",
  ExitPlanMode: "Plan approval",
  exitPlanMode: "Plan approval",
  exec_command: "Shell",
  apply_patch: "Patch",
  update_plan: "Plan",
  readFile: "Read",
  grep: "Search",
  glob: "Find files",
  listDir: "List files",
  gitStatus: "Git status",
  gitDiff: "Git diff",
  gitLog: "Git log",
  editFile: "Edit",
  writeFile: "Write",
  bash: "Shell",
  // OpenCode 2.0 built-in tool names.
  read: "Read",
  edit: "Edit",
  write: "Write",
  shell: "Shell",
  subagent: "Subagent",
  question: "Ask user",
  askUser: "Ask user",
  spawn_worker: "Spawn worker",
  request_specialist: "Request specialist",
  delegate_to_subagent: "Delegate",
  delegate_parallel: "Delegate batch",
  get_worker_output: "Worker output",
  revise_plan: "Revise plan",
  retry_step: "Retry step",
  skip_step: "Skip step",
  mark_step_complete: "Mark complete",
  mark_step_failed: "Mark failed",
  message_worker: "Message worker",
  send_message: "Send message",
  broadcast: "Broadcast",
  report_status: "Status update",
  report_result: "Result",
  report_validation: "Validation",
};

const TOOL_NAMESPACE_LABELS: Record<string, string> = {
  context7: "Docs",
  functions: "Workspace",
  linear: "Linear",
  multi_tool_use: "Parallel",
  pencil: "Canvas",
  playwright: "Browser",
  posthog: "PostHog",
  sentry: "Sentry",
  shadcn: "shadcn/ui",
  web: "Web",
};

const TOKEN_LABELS: Record<string, string> = {
  ade: "ADE",
  api: "API",
  cli: "CLI",
  cto: "CTO",
  gh: "GitHub",
  html: "HTML",
  ipc: "IPC",
  llm: "LLM",
  pr: "PR",
  sql: "SQL",
  ui: "UI",
  url: "URL",
};

function humanizeToolPart(value: string): string {
  return value
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((token) => {
      const lowered = token.toLowerCase();
      if (TOKEN_LABELS[lowered]) return TOKEN_LABELS[lowered];
      return `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`;
    })
    .join(" ")
    .trim();
}

function splitToolIdentifier(toolName: string): {
  namespace: string | null;
  action: string | null;
} {
  if (toolName.includes(".")) {
    const parts = toolName.split(".").filter(Boolean);
    return {
      namespace: parts.slice(0, -1).join(".") || null,
      action: parts.at(-1) ?? null,
    };
  }

  return {
    namespace: null,
    action: null,
  };
}

export function describeToolIdentifier(toolName: string): ToolDisplay {
  const trimmed = toolName.trim();
  if (!trimmed.length) {
    return {
      label: "Tool",
      secondaryLabel: null,
    };
  }

  if (TOOL_LABEL_OVERRIDES[trimmed]) {
    return {
      label: TOOL_LABEL_OVERRIDES[trimmed],
      secondaryLabel: null,
    };
  }

  const { namespace, action } = splitToolIdentifier(trimmed);
  if (action && TOOL_LABEL_OVERRIDES[action]) {
    return {
      label: TOOL_LABEL_OVERRIDES[action],
      secondaryLabel: namespace ? (TOOL_NAMESPACE_LABELS[namespace] ?? humanizeToolPart(namespace)) : null,
    };
  }

  if (namespace) {
    return {
      label: TOOL_NAMESPACE_LABELS[namespace] ?? humanizeToolPart(namespace),
      secondaryLabel: action ? humanizeToolPart(action) : null,
    };
  }

  return {
    label: humanizeToolPart(trimmed),
    secondaryLabel: null,
  };
}

function normalizeToolMention(match: string): string {
  const display = describeToolIdentifier(match);
  const { namespace } = splitToolIdentifier(match);
  const namespaceLabel = namespace ? (TOOL_NAMESPACE_LABELS[namespace] ?? humanizeToolPart(namespace)) : null;
  if (namespaceLabel && display.secondaryLabel === namespaceLabel) {
    return [namespaceLabel, display.label].filter(Boolean).join(" ");
  }
  return [display.label, display.secondaryLabel].filter(Boolean).join(" ");
}

const NAMESPACED_TOOL_MENTION_PATTERN =
  /\b(?:(?:context7|functions|linear|multi_tool_use|pencil|playwright|posthog|sentry|shadcn|web)\.[A-Za-z0-9_]+(?:[\._-][A-Za-z0-9_]+)*)\b/g;

export function replaceInternalToolNames(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.length) return text;

  if (TOOL_LABEL_OVERRIDES[trimmed]) {
    return TOOL_LABEL_OVERRIDES[trimmed];
  }

  return text.replace(NAMESPACED_TOOL_MENTION_PATTERN, normalizeToolMention);
}

/** The shell tools: Claude `Bash`, Codex `exec_command`, OpenCode `shell`, ADE `bash`. */
const SHELL_TOOL_NAMES = new Set(["Bash", "bash", "shell", "exec_command"]);

/**
 * True for a tool that runs a shell command, including namespaced spellings
 * (`functions.exec_command`). It imports nothing, so the transcript row
 * modules stay free of icon and UI packages. The iOS app mirrors this rule in
 * `WorkComputerUseActions.swift` (`workIsShellToolName`).
 */
export function isShellToolName(toolName: string): boolean {
  if (SHELL_TOOL_NAMES.has(toolName)) return true;
  const candidates = [toolName.split(".").at(-1) ?? "", toolName.split("__").at(-1) ?? ""];
  return candidates.some((candidate) => SHELL_TOOL_NAMES.has(candidate));
}
