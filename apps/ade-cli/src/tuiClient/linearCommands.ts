import { parseLinearGraphQLInput } from "../../../desktop/src/main/services/cto/linearGraphQLInput";

export type LinearToolRequest =
  | {
      kind: "tool";
      title: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      // run_ade_action with object args (domain.action). Used by attach/detach
      // and the issue write-bridge, which live on the lane/linear_issue_tracker
      // domains rather than the flat Linear tool names.
      kind: "action";
      title: string;
      domain: string;
      action: string;
      args: Record<string, unknown>;
    }
  | {
      // run_ade_action with positional args (argsList). The Linear issue tracker
      // write methods (createComment, updateIssueState, ...) take positionals.
      kind: "actionList";
      title: string;
      domain: string;
      action: string;
      argsList: unknown[];
    }
  | {
      kind: "usage";
      title: string;
      body: string;
    };

/**
 * Sentinel the dispatcher replaces with the active chat session id. Session-scoped
 * Linear commands default to the active session when one is not named explicitly;
 * linearCommands.ts has no access to UI state, so it emits this placeholder and
 * the /linear dispatcher in app.tsx substitutes the live id.
 */
export const ACTIVE_SESSION_PLACEHOLDER = "__ACTIVE_SESSION__";

type ParsedArgs = {
  positionals: string[];
  options: Record<string, unknown>;
};

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) != null) {
    tokens.push(match[1]?.replace(/\\"/g, "\"") ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

export function parseLinearArgs(input: string): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, unknown> = {};
  const tokens = tokenize(input);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.startsWith("--")) {
      const key = toCamelCase(token.slice(2));
      const next = tokens[index + 1];
      if (next && !next.startsWith("--")) {
        options[key] = parseScalar(next);
        index += 1;
      } else {
        options[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, options };
}

function optionString(options: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = options[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function optionBoolean(options: Record<string, unknown>, name: string): boolean | undefined {
  const value = options[name];
  return typeof value === "boolean" ? value : undefined;
}

function usage(title: string, body: string): LinearToolRequest {
  return { kind: "usage", title, body };
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function tool(title: string, toolName: string, args: Record<string, unknown> = {}): LinearToolRequest {
  return { kind: "tool", title, toolName, args: compactArgs(args) };
}

function action(title: string, domain: string, name: string, args: Record<string, unknown> = {}): LinearToolRequest {
  return { kind: "action", title, domain, action: name, args: compactArgs(args) };
}

function actionList(title: string, domain: string, name: string, argsList: unknown[]): LinearToolRequest {
  return { kind: "actionList", title, domain, action: name, argsList };
}

/**
 * Resolve issue objects for attach from `--issue-id <id>` or `--linear-issue-json`
 * (object or array). Returns null when neither is present.
 */
function parseIssuesOption(options: Record<string, unknown>): Record<string, unknown>[] | null {
  const json = options.linearIssueJson ?? options.issueJson ?? options.linearIssuesJson;
  if (typeof json === "string") {
    try {
      const parsed = JSON.parse(json) as unknown;
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const issues = candidates.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      );
      if (issues.length) return issues;
    } catch {
      return null;
    }
  }
  const id = optionString(options, "issueId", "issue", "linearIssueId");
  if (id) return [{ id, identifier: id }];
  return null;
}

/** Issue id for the write-bridge commands: `--issue-id`/`--issue` flag, else the leading positional. */
function writeCommandIssueId(options: Record<string, unknown>, modeArg: string | undefined): string | null {
  return optionString(options, "issueId", "issue") ?? modeArg ?? null;
}

/** Shared attachment flags (source, includeInPr, closeOnMerge, role). */
function attachmentFlags(options: Record<string, unknown>): Record<string, unknown> {
  return compactArgs({
    role: optionString(options, "role") ?? undefined,
    source: optionString(options, "source") ?? undefined,
    includeInPr:
      optionBoolean(options, "noIncludeInPr") === true
        ? false
        : optionBoolean(options, "includeInPr"),
    closeOnMerge: optionBoolean(options, "closeOnMerge"),
  });
}

type GraphQLVariablesParseResult =
  | { ok: true; variables?: Record<string, unknown> }
  | { ok: false; message: string };

function parseGraphQLVariables(options: Record<string, unknown>): GraphQLVariablesParseResult {
  const value = optionString(options, "variablesJson", "varsJson");
  if (!value) return { ok: true };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, variables: parsed as Record<string, unknown> };
    }
    return { ok: false, message: "--variables-json must be a JSON object." };
  } catch {
    return { ok: false, message: "--variables-json must be valid JSON." };
  }
}

export function buildLinearToolRequest(input: string): LinearToolRequest {
  const parsed = parseLinearArgs(input);
  const [group, modeArg, ...rest] = parsed.positionals;
  const options = parsed.options;

  if (!group) {
    return usage(
      "Linear",
      "Usage: /linear <attach|detach|issues|comment|set-state|assign|label|issue|graphql|create-from|workflows|run|route|sync|ingress> ...",
    );
  }

  if (group === "workflows") {
    return tool("Linear workflows", "listLinearWorkflows");
  }

  if (group === "attach" || group === "attach-issue" || group === "attach-linear-issue") {
    // Attach an issue to a session (default: the active chat) or a lane.
    const issues = parseIssuesOption(options);
    if (!issues) {
      return usage(
        "Linear attach",
        "Usage: /linear attach --issue-id <id> [--session <id>] [--lane <id>]  (defaults to the active chat session)",
      );
    }
    const laneId = optionString(options, "laneId", "lane");
    const sessionId = optionString(options, "session", "sessionId", "chatSession", "chatSessionId");
    if (laneId && !sessionId) {
      return action("Linear attach (lane)", "lane", "linkLinearIssues", {
        laneId,
        issues,
        ...attachmentFlags(options),
      });
    }
    // attachLinearIssueToSession takes an issues array keyed by chatSessionId. A
    // missing chatSessionId is filled with the active session by the dispatcher.
    return action("Linear attach", "lane", "attachLinearIssueToSession", {
      chatSessionId: sessionId ?? ACTIVE_SESSION_PLACEHOLDER,
      issues,
      ...attachmentFlags(options),
    });
  }

  if (group === "detach" || group === "detach-issue" || group === "detach-linear-issue") {
    const laneId = optionString(options, "laneId", "lane");
    const sessionId = optionString(options, "session", "sessionId", "chatSession", "chatSessionId");
    // Omitting an issue id detaches all (non-primary for a lane; every issue for a session).
    const issueId = optionString(options, "issueId", "issue", "linearIssueId") ?? modeArg ?? rest[0] ?? null;
    if (laneId && !sessionId) {
      return action("Linear detach (lane)", "lane", "unlinkLinearIssues", {
        laneId,
        issueId: issueId ?? undefined,
      });
    }
    return action("Linear detach", "lane", "detachLinearIssueFromSession", {
      chatSessionId: sessionId ?? ACTIVE_SESSION_PLACEHOLDER,
      issueId: issueId ?? undefined,
    });
  }

  if (group === "issues" || group === "attached") {
    const sessionId = optionString(options, "session", "sessionId", "chatSession", "chatSessionId");
    return action("Linear attached issues", "lane", "listLinearIssuesForSession", {
      chatSessionId: sessionId ?? ACTIVE_SESSION_PLACEHOLDER,
    });
  }

  if (group === "comment") {
    const issueId = writeCommandIssueId(options, modeArg);
    const body = optionString(options, "body", "text", "message") ?? rest.join(" ").trim();
    if (!issueId || !body) {
      return usage("Linear comment", "Usage: /linear comment <issue-id> <text...>");
    }
    return actionList("Linear comment", "linear_issue_tracker", "createComment", [issueId, body]);
  }

  if (group === "set-state" || group === "status" || group === "state" || group === "move") {
    const issueId = writeCommandIssueId(options, modeArg);
    const stateId = optionString(options, "stateId", "state", "status") ?? rest[0] ?? null;
    if (!issueId || !stateId) {
      return usage("Linear set-state", "Usage: /linear set-state <issue-id> <state-id>");
    }
    return actionList("Linear set-state", "linear_issue_tracker", "updateIssueState", [issueId, stateId]);
  }

  if (group === "assign") {
    const issueId = writeCommandIssueId(options, modeArg);
    if (!issueId) return usage("Linear assign", "Usage: /linear assign <issue-id> <assignee-id|none>");
    const rawAssignee = optionString(options, "assignee", "assigneeId", "user") ?? rest[0] ?? null;
    const normalized = (rawAssignee ?? "").toLowerCase();
    const assigneeId =
      !rawAssignee || normalized === "none" || normalized === "null" || normalized === "unassigned"
        ? null
        : rawAssignee;
    return actionList("Linear assign", "linear_issue_tracker", "updateIssueAssignee", [issueId, assigneeId]);
  }

  if (group === "label" || group === "add-label") {
    const issueId = writeCommandIssueId(options, modeArg);
    const labelName = optionString(options, "label", "labelName", "name") ?? rest[0] ?? null;
    if (!issueId || !labelName) {
      return usage("Linear label", "Usage: /linear label <issue-id> <label-name>");
    }
    return actionList("Linear add-label", "linear_issue_tracker", "addLabel", [issueId, labelName]);
  }

  if (group === "issue" || group === "show-issue" || group === "get-issue") {
    const issueId = writeCommandIssueId(options, modeArg);
    if (!issueId) return usage("Linear issue", "Usage: /linear issue <issue-id>");
    return actionList("Linear issue", "linear_issue_tracker", "fetchIssueById", [issueId]);
  }

  if (group === "graphql" || group === "gql") {
    const query =
      optionString(options, "query", "graphql", "gql") ??
      [modeArg, ...rest].filter(Boolean).join(" ").trim();
    if (!query) {
      return usage(
        "Linear GraphQL",
        "Usage: /linear graphql --query 'query { viewer { id name } }' [--variables-json '{\"id\":\"...\"}']",
      );
    }
    const variables = parseGraphQLVariables(options);
    if (!variables.ok) {
      return usage(
        "Linear GraphQL",
        `${variables.message}\nUsage: /linear graphql --query 'query { viewer { id name } }' [--variables-json '{\"id\":\"...\"}']`,
      );
    }
    try {
      return action("Linear GraphQL", "linear_issue_tracker", "graphql", parseLinearGraphQLInput({
        query,
        variables: variables.variables,
        operationName: optionString(options, "operationName", "operation") ?? undefined,
        maxRetries: options.maxRetries,
      }));
    } catch (error) {
      return usage(
        "Linear GraphQL",
        `${error instanceof Error ? error.message : String(error)}\nUsage: /linear graphql --query 'query { viewer { id name } }' [--variables-json '{\"id\":\"...\"}']`,
      );
    }
  }

  if (group === "create-from" || group === "create-from-linear" || group === "create-lane-from") {
    // Create a lane from an issue. Auto-launching an agent from the TUI is out of
    // scope here (the desktop launch modal owns that); the CLI offers --start-chat.
    const issues = parseIssuesOption(options);
    if (!issues || issues.length !== 1) {
      return usage(
        "Linear create-from",
        "Usage: /linear create-from --issue-id <id> [--name <name>] [--base <branch>]",
      );
    }
    const issue = issues[0]!;
    const name =
      optionString(options, "name") ??
      (typeof issue.title === "string" ? issue.title : null) ??
      (typeof issue.identifier === "string" ? issue.identifier : null) ??
      (typeof issue.id === "string" ? issue.id : null) ??
      "Linear lane";
    return tool("Linear create lane", "create_lane", compactArgs({
      name,
      linearIssue: issue,
      baseBranch: optionString(options, "base", "baseBranch") ?? undefined,
      branchName: optionString(options, "branchName") ?? undefined,
    }));
  }

  if (group === "run") {
    const mode = modeArg ?? "status";
    const runId = optionString(options, "runId", "run") ?? rest[0] ?? null;
    if (mode === "status") {
      if (!runId) return usage("Linear run", "Usage: /linear run status <run-id>");
      return tool("Linear run status", "getLinearRunStatus", { runId });
    }
    if (mode === "resolve") {
      const action = optionString(options, "action") ?? rest[1] ?? null;
      if (!runId || !action) return usage("Linear run resolve", "Usage: /linear run resolve <run-id> <approve|reject|retry|resume|complete>");
      return tool("Linear run resolve", "resolveLinearRunAction", {
        runId,
        action,
        note: optionString(options, "note") ?? undefined,
      });
    }
    if (mode === "cancel") {
      const reason = optionString(options, "reason") ?? rest.slice(1).join(" ");
      if (!runId || !reason) return usage("Linear run cancel", "Usage: /linear run cancel <run-id> --reason <reason>");
      return tool("Linear run cancel", "cancelLinearRun", { runId, reason });
    }
    if (mode === "reroute") {
      const target = optionString(options, "target") ?? rest[1] ?? null;
      const reason = optionString(options, "reason") ?? rest.slice(2).join(" ");
      if (!runId || !target || !reason) return usage("Linear run reroute", "Usage: /linear run reroute <run-id> <cto|worker> --reason <reason>");
      return tool("Linear run reroute", "rerouteLinearRun", {
        runId,
        target,
        reason,
        laneId: optionString(options, "laneId", "lane") ?? undefined,
        reuseExisting: optionBoolean(options, "reuseExisting"),
        launch: optionBoolean(options, "launch"),
        runMode: optionString(options, "runMode") ?? undefined,
        agentId: optionString(options, "agentId", "agent") ?? undefined,
        taskKey: optionString(options, "taskKey") ?? undefined,
      });
    }
    return usage("Linear run", "Usage: /linear run <status|resolve|cancel|reroute> ...");
  }

  if (group === "route") {
    const mode = modeArg ?? "cto";
    const issueId = optionString(options, "issueId", "issue") ?? rest[0] ?? null;
    if (!issueId) return usage("Linear route", "Usage: /linear route <cto|worker> <issue-id>");
    if (mode === "cto") {
      return tool("Linear route cto", "routeLinearIssueToCto", {
        issueId,
        laneId: optionString(options, "laneId", "lane") ?? undefined,
        reuseExisting: optionBoolean(options, "reuseExisting"),
      });
    }
    if (mode === "worker") {
      const agentId = optionString(options, "agentId", "agent") ?? rest[1] ?? null;
      if (!agentId) return usage("Linear route worker", "Usage: /linear route worker <issue-id> <agent-id>");
      return tool("Linear route worker", "routeLinearIssueToWorker", {
        issueId,
        agentId,
        taskKey: optionString(options, "taskKey") ?? undefined,
      });
    }
    return usage("Linear route", "Usage: /linear route <cto|worker> ...");
  }

  if (group === "sync") {
    const mode = modeArg ?? "dashboard";
    if (mode === "dashboard") return tool("Linear sync dashboard", "getLinearSyncDashboard");
    if (mode === "run") return tool("Linear sync run", "runLinearSyncNow");
    if (mode === "queue") return tool("Linear sync queue", "listLinearSyncQueue");
    if (mode === "detail") {
      const runId = optionString(options, "runId", "run") ?? rest[0] ?? null;
      if (!runId) return usage("Linear sync detail", "Usage: /linear sync detail <run-id>");
      return tool("Linear sync detail", "getLinearWorkflowRunDetail", { runId });
    }
    if (mode === "resolve") {
      const queueItemId = optionString(options, "queueItemId", "queueItem") ?? rest[0] ?? null;
      const action = optionString(options, "action") ?? rest[1] ?? null;
      if (!queueItemId || !action) return usage("Linear sync resolve", "Usage: /linear sync resolve <queue-item-id> <approve|reject|retry|resume|complete>");
      return tool("Linear sync resolve", "resolveLinearSyncQueueItem", {
        queueItemId,
        action,
        note: optionString(options, "note") ?? undefined,
        employeeOverride: optionString(options, "employeeOverride") ?? undefined,
        laneId: optionString(options, "laneId", "lane") ?? undefined,
      });
    }
    return usage("Linear sync", "Usage: /linear sync <dashboard|run|queue|resolve|detail> ...");
  }

  if (group === "ingress") {
    const mode = modeArg ?? "status";
    if (mode === "status") return tool("Linear ingress status", "getLinearIngressStatus");
    if (mode === "events") return tool("Linear ingress events", "listLinearIngressEvents", { limit: options.limit ?? undefined });
    if (mode === "webhook") return tool("Linear ingress webhook", "ensureLinearWebhook", { force: optionBoolean(options, "force") });
    return usage("Linear ingress", "Usage: /linear ingress <status|events|webhook>");
  }

  return usage(
    "Linear",
    "Usage: /linear <attach|detach|issues|comment|set-state|assign|label|issue|graphql|create-from|workflows|run|route|sync|ingress> ...",
  );
}
