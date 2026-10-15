/** `ade jira …`: issue operations routed through the brain's Jira connection. */
import fs from "node:fs";
import {
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  asString,
  derivedActionStep,
  firstPositional,
  isRecord,
  readFlag,
  readIntOption,
  readRepeatedValues,
  readTextOrFileOption,
  readValue,
  renderTable,
  requireValue,
  topLevelHelpText,
  unwrapActionEnvelope,
  type CliPlan,
  type InvocationStep,
  type JsonObject,
} from "./cli";

const JIRA_DOMAIN = "jira";

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function jiraStatusText(result: unknown): string {
  const status = record(result);
  const account = isRecord(status.account) ? asString(status.account.displayName) : null;
  const error = isRecord(status.error) ? asString(status.error.message) : null;
  return status.connected === true
    ? `Connected to ${asString(status.siteUrl) ?? "Jira"}${account ? ` as ${account}` : ""}.`
    : `Jira is not connected.${error ? ` ${error}` : ""}`;
}

function jiraIssueText(result: unknown): string {
  const issue = record(result);
  const status = isRecord(issue.status) ? asString(issue.status.name) : null;
  const type = isRecord(issue.issueType) ? asString(issue.issueType.name) : null;
  const priority = isRecord(issue.priority) ? asString(issue.priority.name) : null;
  const assignee = isRecord(issue.assignee) ? asString(issue.assignee.displayName) : null;
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  return [
    `${asString(issue.key) ?? "?"} ${asString(issue.title) ?? ""}`.trimEnd(),
    [status, type, priority, assignee ? `assigned to ${assignee}` : "unassigned"].filter(Boolean).join(" · "),
    asString(issue.url),
    "",
    asString(issue.description) || "(no description)",
    ...(comments.length ? ["", `Comments (${comments.length})`, ...comments.flatMap((value) => {
      const comment = record(value);
      const author = isRecord(comment.author) ? asString(comment.author.displayName) : null;
      return [`— ${author ?? "unknown"}, ${asString(comment.createdAt) ?? ""}`.trimEnd(), asString(comment.body) ?? ""];
    })] : []),
  ].filter((line) => line !== null).join("\n");
}

function jiraIssueListText(result: unknown): string {
  const page = record(result);
  const issues = Array.isArray(page.issues) ? page.issues.filter(isRecord) : [];
  const table = renderTable(
    ["key", "status", "type", "priority", "assignee", "title"],
    issues.map((issue) => [
      asString(issue.key),
      isRecord(issue.status) ? asString(issue.status.name) : null,
      isRecord(issue.issueType) ? asString(issue.issueType.name) : null,
      isRecord(issue.priority) ? asString(issue.priority.name) : null,
      isRecord(issue.assignee) ? asString(issue.assignee.displayName) : "unassigned",
      asString(issue.title),
    ]),
    "No Jira issues match.",
    { fullColumns: ["key"] },
  );
  const cursor = asString(page.nextCursor);
  return cursor ? `${table}\nNext cursor: ${cursor}` : table;
}

function issueReceipt(verb: string): (result: unknown) => string {
  return (result) => {
    const issue = record(result);
    const key = asString(issue.key);
    return [key ? `${verb} ${key}: ${asString(issue.title) ?? ""}`.trimEnd() : `${verb}.`, asString(issue.url)]
      .filter(Boolean).join("\n");
  };
}

function jiraKeyStep(key: string): InvocationStep {
  return actionStep("current", JIRA_DOMAIN, "getIssue", { key });
}

function resolvedIssue(values: JsonObject, key: string): JsonObject {
  const issue = unwrapActionEnvelope(values.current);
  if (!isRecord(issue)) throw new CliUsageError(`Jira issue '${key}' was not found.`);
  return issue;
}

function lookupName<T extends JsonObject>(
  values: unknown,
  field: string,
  name: string,
  idField: string,
): string {
  const catalog = record(values);
  const items = Array.isArray(catalog[field]) ? (catalog[field] as unknown[]).filter(isRecord) : [];
  const normalized = name.trim().toLocaleLowerCase();
  const byId = items.find((item) => asString(item[idField]) === name);
  if (byId) return asString(byId[idField])!;
  const matches = items.filter((item) => asString(item.name)?.toLocaleLowerCase() === normalized);
  if (matches.length === 1) return asString(matches[0]![idField])!;
  if (matches.length > 1) throw new CliUsageError(`'${name}' matches more than one Jira ${field} value. Pass an id.`);
  throw new CliUsageError(`Jira ${field} '${name}' was not found.`);
}

function resolveAssignee(values: JsonObject, source: string, projectKey: string): string | null {
  const account = isRecord(values.connection) && isRecord(values.connection.account) ? values.connection.account : null;
  if (/^(?:none|unassigned)$/i.test(source)) return null;
  if (source.toLocaleLowerCase() === "me") {
    const accountId = account ? asString(account.accountId) : null;
    if (accountId) return accountId;
    throw new CliUsageError("Jira did not return the connected account. Recheck the Jira connection.");
  }
  const candidates = Array.isArray(values.users) ? values.users.filter(isRecord) : [];
  const direct = candidates.find((user) => asString(user.accountId) === source);
  if (direct) return asString(direct.accountId);
  const matches = candidates.filter((user) => asString(user.displayName)?.toLocaleLowerCase() === source.toLocaleLowerCase());
  if (matches.length === 1) return asString(matches[0]!.accountId);
  if (matches.length > 1) throw new CliUsageError(`'${source}' matches more than one Jira user. Pass an account id.`);
  throw new CliUsageError(`Jira assignee '${source}' was not found in ${projectKey}.`);
}

function buildCreatePlan(args: string[]): CliPlan {
  const projectKey = requireValue(readValue(args, ["--project", "--project-key"]), "--project").toUpperCase();
  const issueType = requireValue(readValue(args, ["--type", "--issue-type"]), "--type");
  const title = requireValue(readValue(args, ["--title", "-t"]), "--title");
  const description = readTextOrFileOption(args, ["--description", "--body", "-d"], ["--description-file", "--body-file"]);
  const labels = readRepeatedValues(args, ["--label"]);
  const assignee = readValue(args, ["--assignee"]);
  const priority = readValue(args, ["--priority"]);
  const parentKey = readValue(args, ["--parent"]);
  const dueDate = readValue(args, ["--due", "--due-date"]);
  const steps: InvocationStep[] = [
    actionStep("meta", JIRA_DOMAIN, "getCreateMeta", { projectKey }),
  ];
  if (assignee && !/^(?:none|unassigned|me)$/i.test(assignee)) {
    steps.push(actionStep("users", JIRA_DOMAIN, "listAssignableUsers", { projectKey, query: assignee }));
  }
  if (assignee?.toLocaleLowerCase() === "me") steps.push(actionStep("connection", JIRA_DOMAIN, "getConnectionStatus"));
  steps.push(derivedActionStep("result", JIRA_DOMAIN, "createIssue", (values) => {
    const meta = unwrapActionEnvelope(values.meta);
    const issueTypes = isRecord(meta) && Array.isArray(meta.issueTypes) ? meta.issueTypes.filter(isRecord) : [];
    const typeMatches = issueTypes.filter((entry) =>
      asString(entry.id) === issueType || asString(entry.name)?.toLocaleLowerCase() === issueType.toLocaleLowerCase(),
    );
    if (typeMatches.length !== 1) throw new CliUsageError(typeMatches.length ? `Jira issue type '${issueType}' is ambiguous.` : `Jira issue type '${issueType}' is not available in ${projectKey}.`);
    const args: JsonObject = { projectKey, issueTypeId: asString(typeMatches[0]!.id)!, title };
    if (description !== undefined) args.description = description;
    if (labels.length) args.labels = labels;
    if (parentKey) args.parentKey = parentKey;
    if (dueDate && !/^(?:none|clear)$/i.test(dueDate)) args.dueDate = dueDate;
    if (assignee) {
      const accountId = resolveAssignee(values, assignee, projectKey);
      if (accountId) args.assigneeAccountId = accountId;
    }
    if (priority) args.priorityId = lookupName(meta, "priorities", priority, "id");
    return { args };
  }));
  return {
    kind: "execute",
    label: "jira create",
    steps,
    shapeResult: (values) => unwrapActionEnvelope(values.result),
    formatText: issueReceipt("Created"),
  };
}

function buildEditPlan(args: string[]): CliPlan {
  const key = requireValue(firstPositional(args), "Jira issue key").toUpperCase();
  const title = readValue(args, ["--title", "-t"]);
  const description = readTextOrFileOption(args, ["--description", "--body", "-d"], ["--description-file", "--body-file"]);
  const newLabels = readRepeatedValues(args, ["--label", "--add-label"]);
  const removeLabels = readRepeatedValues(args, ["--remove-label", "--unlabel"]);
  const assignee = readValue(args, ["--assignee"]);
  const priority = readValue(args, ["--priority"]);
  const dueDate = readValue(args, ["--due", "--due-date"]);
  if (title == null && description == null && !newLabels.length && !removeLabels.length && assignee == null && priority == null && dueDate == null) {
    throw new CliUsageError("jira edit needs at least one field, such as --title, --description, --assignee, --priority, --label, or --due.");
  }
  const steps: InvocationStep[] = [jiraKeyStep(key)];
  if (priority) steps.push(derivedActionStep("meta", JIRA_DOMAIN, "getCreateMeta", (values) => {
    const issue = resolvedIssue(values, key);
    return { args: { projectKey: asString(issue.projectKey) ?? key.split("-")[0] ?? "" } };
  }));
  if (assignee && !/^(?:none|unassigned|me)$/i.test(assignee)) steps.push(derivedActionStep("users", JIRA_DOMAIN, "listAssignableUsers", (values) => {
    const issue = resolvedIssue(values, key);
    return { args: { key, projectKey: asString(issue.projectKey) ?? key.split("-")[0] ?? "", query: assignee } };
  }));
  if (assignee?.toLocaleLowerCase() === "me") steps.push(actionStep("connection", JIRA_DOMAIN, "getConnectionStatus"));
  steps.push(derivedActionStep("result", JIRA_DOMAIN, "updateIssue", (values) => {
    const issue = resolvedIssue(values, key);
    const patch: JsonObject = { key };
    if (title != null) patch.title = title;
    if (description != null) patch.description = description;
    if (newLabels.length || removeLabels.length) {
      const current = Array.isArray(issue.labels) ? issue.labels.filter((value): value is string => typeof value === "string") : [];
      patch.labels = [...new Set([...current.filter((label) => !removeLabels.includes(label)), ...newLabels])];
    }
    if (assignee != null) patch.assigneeAccountId = resolveAssignee(values, assignee, asString(issue.projectKey) ?? key.split("-")[0] ?? "");
    if (priority) patch.priorityId = lookupName(values.meta, "priorities", priority, "id");
    if (dueDate != null) patch.dueDate = /^(?:none|clear)$/i.test(dueDate) ? null : dueDate;
    return { args: patch };
  }));
  return {
    kind: "execute",
    label: "jira edit",
    steps,
    shapeResult: (values) => {
      const issue = resolvedIssue(values, key);
      return { key, title: title ?? asString(issue.title), url: asString(issue.url), updated: true };
    },
    formatText: (result) => issueReceipt("Updated")({ ...record(result), key, title: title ?? record(result).title }),
  };
}

function buildAssignPlan(args: string[]): CliPlan {
  const key = requireValue(firstPositional(args), "Jira issue key").toUpperCase();
  const assignee = requireValue(readValue(args, ["--assignee"]) ?? firstPositional(args), "assignee");
  const steps: InvocationStep[] = [jiraKeyStep(key)];
  if (!/^(?:none|unassigned|me)$/i.test(assignee)) steps.push(derivedActionStep("users", JIRA_DOMAIN, "listAssignableUsers", (values) => {
    const issue = resolvedIssue(values, key);
    return { args: { key, projectKey: asString(issue.projectKey) ?? key.split("-")[0] ?? "", query: assignee } };
  }));
  if (assignee.toLocaleLowerCase() === "me") steps.push(actionStep("connection", JIRA_DOMAIN, "getConnectionStatus"));
  steps.push(derivedActionStep("result", JIRA_DOMAIN, "updateIssue", (values) => {
    const issue = resolvedIssue(values, key);
    return { args: { key, assigneeAccountId: resolveAssignee(values, assignee, asString(issue.projectKey) ?? key.split("-")[0] ?? "") } };
  }));
  return {
    kind: "execute", label: "jira assign", steps,
    shapeResult: (values) => {
      const issue = resolvedIssue(values, key);
      return { key, title: asString(issue.title), url: asString(issue.url), assignedTo: assignee };
    },
    formatText: (result) => `${asString(record(result).key) ?? key}: assigned to ${asString(record(result).assignedTo) ?? "unassigned"}.`,
  };
}

function buildLabelPlan(args: string[], add: boolean): CliPlan {
  const key = requireValue(firstPositional(args), "Jira issue key").toUpperCase();
  const label = requireValue(readValue(args, ["--label"]) ?? firstPositional(args), "label");
  return {
    kind: "execute",
    label: add ? "jira label" : "jira unlabel",
    steps: [
      jiraKeyStep(key),
      derivedActionStep("result", JIRA_DOMAIN, "updateIssue", (values) => {
        const issue = resolvedIssue(values, key);
        const current = Array.isArray(issue.labels) ? issue.labels.filter((value): value is string => typeof value === "string") : [];
        const labels = add ? [...new Set([...current, label])] : current.filter((value) => value !== label);
        return { args: { key, labels } };
      }),
    ],
    shapeResult: (values) => {
      const issue = resolvedIssue(values, key);
      return { key, title: asString(issue.title), url: asString(issue.url), label, added: add };
    },
    formatText: (result) => `${asString(record(result).key) ?? key}: ${add ? "added" : "removed"} label '${asString(record(result).label) ?? label}'.`,
  };
}

export function buildJiraPlan(args: string[]): CliPlan {
  const subcommand = firstPositional(args)?.toLowerCase();
  if (!subcommand || subcommand === "help" || args.includes("--help") || args.includes("-h")) {
    return { kind: "help", text: HELP_BY_COMMAND.jira ?? topLevelHelpText() };
  }
  if (args.some((arg) => arg === "--token" || arg.startsWith("--token=") || arg === "--api-token" || arg.startsWith("--api-token="))) {
    throw new CliUsageError("Do not pass a Jira API token as an argument. Pipe it through stdin and use --token-stdin.");
  }
  if (subcommand === "status") {
    return { kind: "execute", label: "jira status", steps: [actionStep("result", JIRA_DOMAIN, "getConnectionStatus")], formatText: jiraStatusText };
  }
  if (subcommand === "connect") {
    const siteUrl = requireValue(readValue(args, ["--site", "--site-url"]), "--site");
    const email = requireValue(readValue(args, ["--email"]), "--email");
    const tokenFromStdin = readFlag(args, ["--token-stdin", "--api-token-stdin"]);
    if (!tokenFromStdin) throw new CliUsageError("Connect requires --token-stdin; pipe the API token on stdin.");
    const apiToken = fs.readFileSync(0, "utf8").trim();
    if (!apiToken) throw new CliUsageError("No Jira API token was read from stdin.");
    return {
      kind: "execute", label: "jira connect", connectRole: "cto",
      steps: [actionStep("result", JIRA_DOMAIN, "connect", { siteUrl, email, apiToken })],
      formatText: jiraStatusText,
    };
  }
  if (subcommand === "disconnect") {
    return { kind: "execute", label: "jira disconnect", connectRole: "cto", steps: [actionStep("result", JIRA_DOMAIN, "disconnect")], formatText: jiraStatusText };
  }
  if (subcommand === "projects") {
    const query = readValue(args, ["--query", "-q"]);
    return {
      kind: "execute", label: "jira projects", steps: [actionStep("result", JIRA_DOMAIN, "listProjects", query ? { query } : {})],
      formatText: (result) => renderTable(["key", "name"], Array.isArray(result) ? result.filter(isRecord).map((project) => [project.key, project.name]) : [], "No Jira projects found.", { fullColumns: ["key"] }),
    };
  }
  if (subcommand === "list" || subcommand === "issues") {
    const projectKeys = readRepeatedValues(args, ["--project", "--project-key"]).map((key) => key.toUpperCase());
    const rawState = (readValue(args, ["--state"]) ?? "open").trim().toLowerCase();
    const state = rawState === "all" ? "all" : rawState === "done" || rawState === "closed" ? "done" : rawState === "open" || rawState === "todo" || rawState === "in progress" ? "open" : null;
    if (!state) throw new CliUsageError("--state must be open, done, or all.");
    const mine = readFlag(args, ["--mine"]);
    const assignee = readValue(args, ["--assignee"]);
    const query = readValue(args, ["--query", "-q"]);
    const jql = readValue(args, ["--jql"]);
    const limit = readIntOption(args, ["--limit"], 50);
    const cursor = readValue(args, ["--cursor"]);
    const input: JsonObject = {
      projectKeys,
      state,
      ...(mine || assignee?.toLowerCase() === "me" ? { assignee: "me" } : {}),
      ...(query ? { query } : {}),
      ...(jql ? { jql } : {}),
      ...(limit != null ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
    };
    return { kind: "execute", label: "jira list", steps: [actionStep("result", JIRA_DOMAIN, "listIssues", input)], formatText: jiraIssueListText };
  }
  if (subcommand === "issue" || subcommand === "view" || subcommand === "show") {
    const key = requireValue(readValue(args, ["--key"]) ?? firstPositional(args), "Jira issue key").toUpperCase();
    return { kind: "execute", label: "jira issue", steps: [actionStep("result", JIRA_DOMAIN, "getIssue", { key })], formatText: jiraIssueText };
  }
  if (subcommand === "create") return buildCreatePlan(args);
  if (subcommand === "edit") return buildEditPlan(args);
  if (subcommand === "assign") return buildAssignPlan(args);
  if (subcommand === "label") return buildLabelPlan(args, true);
  if (subcommand === "unlabel") return buildLabelPlan(args, false);
  if (subcommand === "comment") {
    const bodyOption = readTextOrFileOption(args, ["--body", "-b"], ["--body-file"]);
    const key = requireValue(firstPositional(args), "Jira issue key").toUpperCase();
    const body = bodyOption ?? args.filter((arg) => arg !== "--" && !arg.startsWith("-")).join(" ").trim();
    if (!body) throw new CliUsageError("jira comment needs a body or --body-file.");
    return {
      kind: "execute", label: "jira comment",
      steps: [actionStep("result", JIRA_DOMAIN, "addComment", { key, body })],
      formatText: (result) => {
        const comment = record(result);
        return `Commented on ${key}${asString(comment.id) ? ` (${asString(comment.id)})` : ""}.`;
      },
    };
  }
  if (subcommand === "transition") {
    const key = requireValue(firstPositional(args), "Jira issue key").toUpperCase();
    const target = requireValue(readValue(args, ["--to", "--status"]) ?? firstPositional(args), "transition or status");
    return {
      kind: "execute", label: "jira transition",
      steps: [
        actionStep("transitions", JIRA_DOMAIN, "listTransitions", { key }),
        derivedActionStep("result", JIRA_DOMAIN, "transitionIssue", (values) => {
          const result = unwrapActionEnvelope(values.transitions);
          const transitions = Array.isArray(result) ? result.filter(isRecord) : [];
          const matches = transitions.filter((transition) =>
            asString(transition.name)?.toLocaleLowerCase() === target.toLocaleLowerCase()
            || (isRecord(transition.to) && asString(transition.to.name)?.toLocaleLowerCase() === target.toLocaleLowerCase()),
          );
          if (!matches.length) {
            const names = transitions.map((transition) => `${asString(transition.name)} → ${isRecord(transition.to) ? asString(transition.to.name) : "Unknown"}`);
            throw new CliUsageError(`Jira has no transition '${target}' for ${key}. Available: ${names.join(", ") || "none"}.`);
          }
          return { args: { key, transitionId: asString(matches[0]!.id)! } };
        }),
      ],
      shapeResult: () => ({ key, target, transitioned: true }),
      formatText: () => `${key}: moved through '${target}'.`,
    };
  }
  throw new CliUsageError("jira supports status, connect, disconnect, projects, list, issue, create, edit, comment, transition, assign, label, and unlabel.");
}
