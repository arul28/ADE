export type LinearToolRequest =
  | {
      kind: "tool";
      title: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      kind: "usage";
      title: string;
      body: string;
    };

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

export function buildLinearToolRequest(input: string): LinearToolRequest {
  const parsed = parseLinearArgs(input);
  const [group, modeArg, ...rest] = parsed.positionals;
  const options = parsed.options;

  if (!group) {
    return usage("Linear", "Usage: /linear <workflows|run|route|sync|ingress> ...");
  }

  if (group === "workflows") {
    return tool("Linear workflows", "listLinearWorkflows");
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
      if (!runId || !target || !reason) return usage("Linear run reroute", "Usage: /linear run reroute <run-id> <cto|mission|worker> --reason <reason>");
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
    if (!issueId) return usage("Linear route", "Usage: /linear route <cto|mission|worker> <issue-id>");
    if (mode === "cto") {
      return tool("Linear route cto", "routeLinearIssueToCto", {
        issueId,
        laneId: optionString(options, "laneId", "lane") ?? undefined,
        reuseExisting: optionBoolean(options, "reuseExisting"),
      });
    }
    if (mode === "mission") {
      return tool("Linear route mission", "routeLinearIssueToMission", {
        issueId,
        laneId: optionString(options, "laneId", "lane") ?? undefined,
        launch: optionBoolean(options, "launch"),
        runMode: optionString(options, "runMode") ?? undefined,
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
    return usage("Linear route", "Usage: /linear route <cto|mission|worker> ...");
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

  return usage("Linear", "Usage: /linear <workflows|run|route|sync|ingress> ...");
}
