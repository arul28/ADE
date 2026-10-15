/** `ade issue …`: tracker-neutral issue operations routed through the brain. */
import {
  CliToolError,
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  asString,
  derivedActionStep,
  firstPositional,
  isRecord,
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
import { openUrlViaOs } from "./commands/deeplinks";

const DOMAIN = "issues";

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function issueRefText(value: unknown): string {
  const reference = record(value);
  if (reference.provider === "linear") return asString(reference.identifier) ?? "Linear issue";
  if (reference.provider === "github") {
    const owner = asString(reference.owner);
    const repo = asString(reference.repo);
    const number = typeof reference.number === "number" ? reference.number : null;
    return owner && repo && number ? `${owner}/${repo}#${number}` : "GitHub issue";
  }
  return asString(reference.key) ?? "Jira issue";
}

function issueDetailText(result: unknown): string {
  const issue = record(result);
  const state = isRecord(issue.state) ? asString(issue.state.name) : null;
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.filter((entry): entry is string => typeof entry === "string")
    : [];
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((entry): entry is string => typeof entry === "string")
    : [];
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  return [
    `${issueRefText(issue.reference)} ${asString(issue.title) ?? ""}`.trimEnd(),
    [state, assignees.length ? `assigned to ${assignees.join(", ")}` : null, labels.length ? `labels: ${labels.join(", ")}` : null].filter(Boolean).join(" · "),
    asString(issue.url),
    "",
    asString(issue.body) || "(no description)",
    ...(comments.length ? ["", `Comments (${comments.length})`, ...comments.flatMap((entry) => {
      const comment = record(entry);
      return [`— ${asString(comment.author) ?? "unknown"}, ${asString(comment.createdAt) ?? ""}`.trimEnd(), asString(comment.body) ?? ""];
    })] : []),
  ].filter((line) => line !== null).join("\n");
}

function issueListText(result: unknown): string {
  const page = record(result);
  const issues = Array.isArray(page.issues) ? page.issues.filter(isRecord) : [];
  const table = renderTable(
    ["issue", "state", "assignee", "title"],
    issues.map((issue) => [
      issueRefText(issue.reference),
      isRecord(issue.state) ? asString(issue.state.name) : null,
      Array.isArray(issue.assignees) ? issue.assignees.filter((entry): entry is string => typeof entry === "string").join(", ") || "unassigned" : "unassigned",
      asString(issue.title),
    ]),
    "No issues match.",
    { fullColumns: ["issue"] },
  );
  const cursor = asString(page.nextCursor);
  return cursor ? `${table}\nNext cursor: ${cursor}` : table;
}

function issueReceipt(verb: string): (result: unknown) => string {
  return (result) => {
    const issue = record(result);
    return [
      `${verb} ${issueRefText(issue.reference)}: ${asString(issue.title) ?? ""}`.trimEnd(),
      asString(issue.url),
    ].filter(Boolean).join("\n");
  };
}

function issueStep(reference: string): InvocationStep {
  return actionStep("result", DOMAIN, "get", { reference });
}

function buildCreatePlan(args: string[]): CliPlan {
  const tracker = requireValue(readValue(args, ["--tracker"]), "--tracker").toLocaleLowerCase();
  if (tracker !== "linear" && tracker !== "github" && tracker !== "jira") {
    throw new CliUsageError("--tracker must be linear, github, or jira.");
  }
  const scope = requireValue(readValue(args, ["--scope", "--team", "--project", "--repo"]), "--scope (team, project, or repo)");
  const title = requireValue(readValue(args, ["--title", "-t"]), "--title");
  const body = readTextOrFileOption(args, ["--body", "--description", "-d"], ["--body-file", "--description-file"]);
  const labels = readRepeatedValues(args, ["--label"]);
  const assignees = readRepeatedValues(args, ["--assignee"]);
  const state = readValue(args, ["--state"]);
  const template = readValue(args, ["--template"]);
  const issueType = readValue(args, ["--type", "--issue-type"]);
  const input: JsonObject = { tracker, scope, title };
  if (body !== undefined) input.body = body;
  if (labels.length) input.labels = labels;
  if (assignees.length) input.assignees = assignees;
  if (state) input.state = state;
  if (template) input.template = template;
  if (issueType) input.issueType = issueType;
  return {
    kind: "execute",
    label: "issue create",
    steps: [actionStep("result", DOMAIN, "create", input)],
    formatText: issueReceipt("Created"),
  };
}

export function buildIssuePlan(args: string[]): CliPlan {
  const argv = [...args];
  const command = firstPositional(argv);
  if (!command || command === "help" || argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help", text: HELP_BY_COMMAND.issue ?? topLevelHelpText() };
  }
  if (command === "list" || command === "ls") {
    const tracker = readValue(argv, ["--tracker"]);
    if (tracker && tracker !== "linear" && tracker !== "github" && tracker !== "jira") {
      throw new CliUsageError("--tracker must be linear, github, or jira.");
    }
    const scope = readValue(argv, ["--scope", "--team", "--project", "--repo"]);
    const state = readValue(argv, ["--state"]);
    const query = readValue(argv, ["--query", "-q"]);
    const cursor = readValue(argv, ["--cursor"]);
    const limit = readIntOption(argv, ["--limit"]);
    const input: JsonObject = {};
    if (tracker) input.tracker = tracker;
    if (scope) input.scope = scope;
    if (state) input.state = state;
    if (query) input.query = query;
    if (cursor) input.cursor = cursor;
    if (limit !== null) input.limit = limit;
    return { kind: "execute", label: "issue list", steps: [actionStep("result", DOMAIN, "list", input)], formatText: issueListText };
  }
  if (command === "view" || command === "get" || command === "show") {
    const reference = requireValue(firstPositional(argv), "issue reference");
    return { kind: "execute", label: "issue view", steps: [issueStep(reference)], formatText: issueDetailText };
  }
  if (command === "resolve") {
    const reference = requireValue(firstPositional(argv), "issue reference");
    return {
      kind: "execute",
      label: "issue resolve",
      steps: [actionStep("result", DOMAIN, "resolve", { reference })],
      formatText: (result) => {
        const resolved = record(result);
        return `${asString(resolved.kind) ?? "tracker"} ${issueRefText(resolved.reference)}`;
      },
    };
  }
  if (command === "comment") {
    const reference = requireValue(firstPositional(argv), "issue reference");
    const body = readTextOrFileOption(argv, ["--body", "--text", "-m"], ["--body-file"])
      ?? firstPositional(argv);
    if (!body?.trim()) throw new CliUsageError("Pass comment text or --body-file.");
    return {
      kind: "execute",
      label: "issue comment",
      steps: [actionStep("result", DOMAIN, "comment", { reference, body })],
      shapeResult: () => ({ reference, commented: true }),
      formatText: () => `Commented on ${reference}.`,
    };
  }
  if (command === "state" || command === "set-state") {
    const reference = requireValue(firstPositional(argv), "issue reference");
    const state = requireValue(readValue(argv, ["--to", "--state"]) ?? firstPositional(argv), "--to <state>");
    return {
      kind: "execute",
      label: "issue state",
      steps: [actionStep("result", DOMAIN, "setState", { reference, state })],
      shapeResult: () => ({ reference, state }),
      formatText: () => `${reference}: moved to ${state}.`,
    };
  }
  if (command === "create") return buildCreatePlan(argv);
  if (command === "open-url" || command === "open") {
    const reference = requireValue(firstPositional(argv), "issue reference");
    return {
      kind: "execute",
      label: "issue open-url",
      steps: [
        actionStep("resolved", DOMAIN, "resolve", { reference }),
        derivedActionStep("issue", DOMAIN, "get", (values) => {
          const resolved = record(unwrapActionEnvelope(values.resolved));
          if (!resolved.reference) throw new CliUsageError(`Issue '${reference}' could not be resolved.`);
          return { args: { reference: resolved.reference } };
        }),
      ],
      shapeResult: (values) => {
        const issue = record(unwrapActionEnvelope(values.issue));
        const url = asString(issue.url);
        if (!url) throw new CliUsageError(`Issue '${reference}' has no URL.`);
        const opened = openUrlViaOs(url);
        if (opened.failed) throw new CliToolError(`Could not open ${url}: ${opened.message}`, {});
        return { reference: issue.reference, title: issue.title, url, opened: true };
      },
      formatText: (result) => `Opened ${asString(record(result).url) ?? "issue URL"}.`,
    };
  }
  throw new CliUsageError("issue supports list, view, resolve, comment, state, create, and open-url.");
}
