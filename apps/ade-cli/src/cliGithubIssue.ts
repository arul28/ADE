/**
 * `ade github issue …`: the plan builder and its text output.
 *
 * cli.ts keeps the dispatch case. The argv primitives still live there, so
 * this module imports them back. That import cycle is safe under the same rule
 * as cliMacDesktop.ts:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CliToolError,
  CliUsageError,
  HELP_BY_COMMAND,
  actionStep,
  asString,
  asUsage,
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
import {
  contentTypeForFile,
  editNameSet,
  githubIssueAssigneeLogins,
  githubIssueLabelNames,
  isNoneValue,
  parseGithubCloseReason,
  parseGithubIssueRef,
  parseGithubRepo,
  resolveGithubMilestone,
  type GithubRepoRef,
} from "./issueCliFields";
/**
 * The repo a `github issue` command works on: `--repo`, a repo named in the
 * issue reference (`owner/name#12` or a URL), else the project's origin read
 * through `github.detectRepo` as the first step.
 */
function githubRepoTarget(explicit: GithubRepoRef | null): {
  steps: InvocationStep[];
  repo: (values: JsonObject) => GithubRepoRef;
} {
  if (explicit) return { steps: [], repo: () => explicit };
  return {
    steps: [actionStep("repo", "github", "detectRepo")],
    repo: (values) => {
      const detected = unwrapActionEnvelope(values.repo);
      const owner = isRecord(detected) ? asString(detected.owner) : null;
      const name = isRecord(detected) ? asString(detected.name) : null;
      if (!owner || !name) {
        throw new CliUsageError("This project has no GitHub origin remote. Pass --repo owner/name.");
      }
      return { owner, name };
    },
  };
}

function githubIssueReceipt(verb: string): (result: unknown) => string {
  return (result) => {
    const value = isRecord(result) ? result : {};
    const issue = isRecord(value.issue) ? value.issue : value;
    const number = typeof issue.number === "number" ? issue.number : null;
    const warnings = Array.isArray(value.warnings) ? value.warnings.filter((entry) => typeof entry === "string") : [];
    return [
      number != null ? `${verb} #${number}: ${asString(issue.title) ?? ""}`.trimEnd() : `${verb}.`,
      asString(issue.html_url),
      ...warnings.map((warning) => `Warning: ${warning}`),
    ].filter(Boolean).join("\n");
  };
}

function githubIssueFacts(issue: JsonObject): string {
  const milestone = isRecord(issue.milestone) ? asString(issue.milestone.title) : null;
  const type = isRecord(issue.type) ? asString(issue.type.name) : asString(issue.type);
  const labels = githubIssueLabelNames(issue);
  const assignees = githubIssueAssigneeLogins(issue);
  const state = asString(issue.state_reason) && issue.state === "closed"
    ? `${asString(issue.state)} (${String(issue.state_reason).replace("_", " ")})`
    : asString(issue.state);
  return [
    state,
    labels.length ? `labels: ${labels.join(", ")}` : null,
    assignees.length ? `assignees: ${assignees.join(", ")}` : null,
    milestone ? `milestone: ${milestone}` : null,
    type ? `type: ${type}` : null,
  ].filter(Boolean).join(" · ");
}

function formatGithubIssueDetail(result: unknown): string {
  const issue = isRecord(result) ? result : {};
  const lines = [
    `#${String(issue.number ?? "?")} ${asString(issue.title) ?? ""}`.trimEnd(),
    githubIssueFacts(issue),
    asString(issue.html_url),
    "",
    asString(issue.body) ?? "(no description)",
  ];
  if (Array.isArray(issue.comments)) {
    const comments = issue.comments.filter(isRecord);
    lines.push("", `Comments (${comments.length})`);
    for (const comment of comments) {
      const login = isRecord(comment.user) ? asString(comment.user.login) : null;
      lines.push("", `— ${login ?? "unknown"}, ${asString(comment.created_at) ?? ""}`.trimEnd(), asString(comment.body) ?? "");
    }
  }
  return lines.filter((line) => line !== null).join("\n");
}

function formatGithubIssueList(result: unknown): string {
  const issues = Array.isArray(result) ? result.filter(isRecord) : [];
  return renderTable(
    ["#", "state", "title", "labels", "assignees"],
    issues.map((issue) => [
      issue.number,
      issue.state,
      issue.title,
      githubIssueLabelNames(issue).join(", "),
      githubIssueAssigneeLogins(issue).join(", "),
    ]),
    "No issues match.",
    { fullColumns: ["#"] },
  );
}

/** `--attach <path>` files as the base64 attachments `github.createIssue` takes. */
function readGithubAttachments(args: string[]): JsonObject[] {
  return readRepeatedValues(args, ["--attach", "--attachment"]).map((filePath) => {
    let data: Buffer;
    try {
      data = fs.readFileSync(path.resolve(filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliUsageError(`Could not read --attach file '${filePath}': ${message}`);
    }
    const filename = path.basename(filePath);
    return { filename, contentType: contentTypeForFile(filename), dataBase64: data.toString("base64") };
  });
}

export function buildGithubIssuePlan(args: string[]): CliPlan {
  const action = firstPositional(args);
  if (!action || action === "help") {
    return { kind: "help", text: HELP_BY_COMMAND["github issue"] ?? topLevelHelpText() };
  }
  const repoFlag = readValue(args, ["--repo", "-R"]);
  const explicitRepo = repoFlag != null ? asUsage(() => parseGithubRepo(repoFlag)) : null;
  /** The issue number from a positional; its repo counts when --repo is absent. */
  const readIssueRef = (label: string): { number: number; repo: GithubRepoRef | null } => {
    const raw = requireValue(firstPositional(args), label);
    const ref = asUsage(() => parseGithubIssueRef(raw));
    return { number: ref.number, repo: explicitRepo ?? ref.repo };
  };
  /**
   * The issue as it is now, read before every write: a full-set edit (labels,
   * assignees) starts from it, and it is how a pull request number is caught.
   */
  const currentIssueStep = (number: number, repo: (values: JsonObject) => GithubRepoRef): InvocationStep =>
    derivedActionStep("current", "github", "getIssue", (values) => ({ args: { ...repo(values), number } }));
  const currentIssue = (values: JsonObject, number: number): JsonObject => {
    const issue = unwrapActionEnvelope(values.current);
    if (!isRecord(issue)) throw new CliUsageError(`GitHub issue #${number} was not found, or ADE could not read it.`);
    return issue;
  };

  /**
   * GitHub numbers issues and pull requests from one sequence, and `/issues`
   * accepts both. These commands change issues only; a pull request keeps its
   * own write path (`ade prs`).
   */
  const writableIssue = (values: JsonObject, number: number): JsonObject => {
    const issue = currentIssue(values, number);
    if (issue.pull_request != null) {
      throw new CliUsageError(`#${number} is a pull request, not an issue. Use 'ade prs' for pull requests.`);
    }
    return issue;
  };
  const issuePatchPlan = (
    label: string,
    verb: string,
    number: number,
    repoRef: GithubRepoRef | null,
    patch: (values: JsonObject) => JsonObject,
    lookups: InvocationStep[] = [],
  ): CliPlan => {
    const target = githubRepoTarget(repoRef);
    const reads = lookups.some((step) => step.key === "current") ? lookups : [currentIssueStep(number, target.repo), ...lookups];
    return {
      kind: "execute",
      label,
      steps: [
        ...target.steps,
        ...reads,
        derivedActionStep("result", "github", "updateIssue", (values) => {
          writableIssue(values, number);
          return { args: { ...target.repo(values), number, patch: patch(values) } };
        }),
      ],
      formatText: githubIssueReceipt(verb),
    };
  };
  if (action === "view" || action === "show" || action === "get") {
    const withComments = readFlag(args, ["--comments", "-c"]);
    const ref = readIssueRef("issue number");
    const target = githubRepoTarget(ref.repo);
    const issueArgs = (values: JsonObject) => ({ args: { ...target.repo(values), number: ref.number } });
    return {
      kind: "execute",
      label: "github issue view",
      steps: [
        ...target.steps,
        derivedActionStep("result", "github", "getIssue", issueArgs),
        ...(withComments ? [derivedActionStep("comments", "github", "listIssueComments", issueArgs)] : []),
      ],
      shapeResult: (values) => {
        const issue = unwrapActionEnvelope(values.result);
        if (!isRecord(issue)) {
          throw new CliToolError(`GitHub issue #${ref.number} was not found, or ADE could not read it.`, {});
        }
        if (!withComments) return issue;
        const comments = unwrapActionEnvelope(values.comments);
        return { ...issue, comments: Array.isArray(comments) ? comments : [] };
      },
      formatText: formatGithubIssueDetail,
    };
  }

  if (action === "list" || action === "ls") {
    const state = (readValue(args, ["--state", "-s"]) ?? "open").trim().toLowerCase();
    if (state !== "open" && state !== "closed" && state !== "all") {
      throw new CliUsageError("--state must be open, closed, or all.");
    }
    const labels = readRepeatedValues(args, ["--label", "-l"]).map((label) => label.trim().toLowerCase());
    const assignee = readValue(args, ["--assignee", "-a"])?.trim().replace(/^@/, "").toLowerCase() ?? null;
    const limit = readIntOption(args, ["--limit", "-L", "--first"], 30) ?? 30;
    if (limit <= 0) throw new CliUsageError("--limit must be a positive number.");
    const target = githubRepoTarget(explicitRepo);
    return {
      kind: "execute",
      label: "github issue list",
      steps: [
        ...target.steps,
        derivedActionStep("result", "github", "listRepoIssueList", (values) => ({
          args: { ...target.repo(values), state },
        })),
      ],
      shapeResult: (values) => {
        const issues = unwrapActionEnvelope(values.result);
        return (Array.isArray(issues) ? issues.filter(isRecord) : [])
          .filter((issue) => {
            const issueLabels = githubIssueLabelNames(issue).map((label) => label.toLowerCase());
            if (!labels.every((label) => issueLabels.includes(label))) return false;
            if (assignee == null) return true;
            const logins = githubIssueAssigneeLogins(issue).map((login) => login.toLowerCase());
            return isNoneValue(assignee) ? logins.length === 0 : logins.includes(assignee);
          })
          .slice(0, limit);
      },
      formatText: formatGithubIssueList,
    };
  }

  if (action === "create" || action === "new") {
    const title = readValue(args, ["--title", "-t"]);
    const body = readTextOrFileOption(args, ["--body", "-b"], ["--body-file", "-F"]);
    const labels = readRepeatedValues(args, ["--label", "-l"]);
    const assignees = readRepeatedValues(args, ["--assignee", "-a"]).map((login) => login.trim().replace(/^@/, ""));
    const milestone = readValue(args, ["--milestone", "-m"]);
    const type = readValue(args, ["--type"]);
    const parent = readValue(args, ["--parent"]);
    const attachments = readGithubAttachments(args);
    const finalTitle = requireValue(title ?? firstPositional(args), "--title");
    const parentNumber = parent != null ? asUsage(() => parseGithubIssueRef(parent).number) : null;
    const target = githubRepoTarget(explicitRepo);
    const milestoneByName = milestone != null && !/^\d+$/.test(milestone.trim());
    return {
      kind: "execute",
      label: "github issue create",
      steps: [
        ...target.steps,
        ...(milestoneByName
          ? [derivedActionStep("milestones", "github", "listRepoMilestones", (values) => ({ args: target.repo(values) }))]
          : []),
        derivedActionStep("result", "github", "createIssue", (values) => {
          const input: JsonObject = { title: finalTitle, labels, assignees };
          if (body !== undefined) input.body = body;
          if (milestone != null) {
            input.milestone = resolveGithubMilestone(unwrapActionEnvelope(values.milestones), milestone);
          }
          if (type != null && type.trim()) input.type = type.trim();
          if (parentNumber != null) input.parentNumber = parentNumber;
          if (attachments.length) input.attachments = attachments;
          return { args: { ...target.repo(values), input } };
        }),
      ],
      formatText: githubIssueReceipt("Created"),
    };
  }

  if (action === "edit") {
    const title = readValue(args, ["--title", "-t"]);
    const body = readTextOrFileOption(args, ["--body", "-b"], ["--body-file", "-F"]);
    const ref = readIssueRef("issue number");
    const patch: JsonObject = {};
    if (title != null) {
      if (!title.trim()) throw new CliUsageError("Title cannot be empty.");
      patch.title = title.trim();
    }
    if (body !== undefined) patch.body = body;
    if (Object.keys(patch).length === 0) {
      throw new CliUsageError("github issue edit needs --title, --body, or --body-file.");
    }
    return issuePatchPlan("github issue edit", "Updated", ref.number, ref.repo, () => patch);
  }

  if (action === "comment") {
    const flagBody = readTextOrFileOption(args, ["--body", "-b"], ["--body-file", "-F"]);
    const ref = readIssueRef("issue number");
    const positionalParts: string[] = [];
    for (let next = firstPositional(args); next != null; next = firstPositional(args)) positionalParts.push(next);
    const body = flagBody ?? (positionalParts.length ? positionalParts.join(" ") : null);
    if (!body || !body.trim()) throw new CliUsageError("Comment text is required. Pass it after the issue number, or use --body-file.");
    const target = githubRepoTarget(ref.repo);
    return {
      kind: "execute",
      label: "github issue comment",
      steps: [
        ...target.steps,
        currentIssueStep(ref.number, target.repo),
        derivedActionStep("result", "github", "commentOnIssue", (values) => {
          writableIssue(values, ref.number);
          return { args: { ...target.repo(values), number: ref.number, body } };
        }),
      ],
      formatText: (result) => {
        const url = isRecord(result) ? asString(result.html_url) : null;
        return [`Commented on #${ref.number}.`, url].filter(Boolean).join("\n");
      },
    };
  }

  if (action === "close") {
    const reasonValue = readValue(args, ["--reason", "-r"]);
    const reason = reasonValue != null ? asUsage(() => parseGithubCloseReason(reasonValue)) : "completed";
    const ref = readIssueRef("issue number");
    return issuePatchPlan("github issue close", "Closed", ref.number, ref.repo, () => ({
      state: "closed",
      state_reason: reason,
    }));
  }

  if (action === "reopen") {
    const ref = readIssueRef("issue number");
    return issuePatchPlan("github issue reopen", "Reopened", ref.number, ref.repo, () => ({
      state: "open",
      state_reason: "reopened",
    }));
  }

  if (action === "label" || action === "labels") {
    const add = readRepeatedValues(args, ["--add", "--add-label"]);
    const remove = readRepeatedValues(args, ["--remove", "--remove-label"]);
    const ref = readIssueRef("issue number");
    for (let next = firstPositional(args); next != null; next = firstPositional(args)) add.push(next);
    if (add.length === 0 && remove.length === 0) {
      throw new CliUsageError("github issue label needs --add <label> or --remove <label>.");
    }
    const target = githubRepoTarget(ref.repo);
    return issuePatchPlan(
      "github issue label",
      "Updated",
      ref.number,
      ref.repo,
      (values) => ({ labels: editNameSet(githubIssueLabelNames(currentIssue(values, ref.number)), add, remove) }),
      [currentIssueStep(ref.number, target.repo)],
    );
  }

  if (action === "assign" || action === "assignees") {
    const add = readRepeatedValues(args, ["--add", "--assignee"]);
    const remove = readRepeatedValues(args, ["--remove"]);
    const clear = readFlag(args, ["--clear", "--none"]);
    const ref = readIssueRef("issue number");
    for (let next = firstPositional(args); next != null; next = firstPositional(args)) add.push(next);
    if (add.length === 0 && remove.length === 0 && !clear) {
      throw new CliUsageError("github issue assign needs --add <login>, --remove <login>, or --clear.");
    }
    const target = githubRepoTarget(ref.repo);
    return issuePatchPlan(
      "github issue assign",
      "Updated",
      ref.number,
      ref.repo,
      (values) => ({
        assignees: editNameSet(
          clear ? [] : githubIssueAssigneeLogins(currentIssue(values, ref.number)),
          add,
          remove,
        ),
      }),
      clear ? [] : [currentIssueStep(ref.number, target.repo)],
    );
  }

  if (action === "milestone") {
    const ref = readIssueRef("issue number");
    const value = requireValue(firstPositional(args), "milestone name, number, or none");
    const byName = !isNoneValue(value) && !/^\d+$/.test(value);
    const target = githubRepoTarget(ref.repo);
    return issuePatchPlan(
      "github issue milestone",
      "Updated",
      ref.number,
      ref.repo,
      (values) => ({
        milestone: isNoneValue(value)
          ? null
          : resolveGithubMilestone(unwrapActionEnvelope(values.milestones), value),
      }),
      byName
        ? [derivedActionStep("milestones", "github", "listRepoMilestones", (values) => ({ args: target.repo(values) }))]
        : [],
    );
  }

  if (action === "type") {
    const ref = readIssueRef("issue number");
    const value = requireValue(firstPositional(args), "issue type name or none");
    return issuePatchPlan("github issue type", "Updated", ref.number, ref.repo, () => ({
      type: isNoneValue(value) ? null : value,
    }));
  }

  if (action === "sub-issue" || action === "add-sub-issue" || action === "link-sub-issue") {
    const parent = readIssueRef("parent issue number");
    const childRaw = requireValue(firstPositional(args), "child issue number");
    const child = asUsage(() => parseGithubIssueRef(childRaw));
    const target = githubRepoTarget(parent.repo);
    return {
      kind: "execute",
      label: "github issue sub-issue",
      steps: [
        ...target.steps,
        derivedActionStep("result", "github", "linkSubIssue", (values) => ({
          args: { ...target.repo(values), parentNumber: parent.number, childNumber: child.number },
        })),
      ],
      formatText: () => `Linked #${child.number} under #${parent.number}.`,
    };
  }

  throw new CliUsageError(
    `Unknown github issue command '${action}'. Supported: view, list, create, edit, comment, close, reopen, `
      + "label, assign, milestone, type, sub-issue.",
  );
}
