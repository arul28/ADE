#!/usr/bin/env node
import http from "node:http";
import { URL } from "node:url";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const port = Number(option("--port", process.env.PORT || "4318"));
const rateLimited = argv.includes("--rate-limit");

const users = [
  { accountId: "jira-user-1", displayName: "Morgan Lee", emailAddress: "morgan@example.com" },
  { accountId: "jira-user-2", displayName: "Taylor Kim", emailAddress: "taylor@example.com" },
  { accountId: "jira-user-3", displayName: "Casey Rivera", emailAddress: "casey@example.com" },
];
const projects = [
  { id: "10000", key: "ADE", name: "ADE Platform", avatarUrls: {} },
  { id: "10001", key: "PAY", name: "Payments", avatarUrls: {} },
];
const statuses = {
  todo: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new", name: "To Do" } },
  progress: { id: "3", name: "In Progress", statusCategory: { id: 4, key: "indeterminate", name: "In Progress" } },
  done: { id: "6", name: "Done", statusCategory: { id: 3, key: "done", name: "Done" } },
};
const issueTypes = [
  { id: "10000", name: "Bug", iconUrl: null, subtask: false },
  { id: "10001", name: "Task", iconUrl: null, subtask: false },
  { id: "10002", name: "Story", iconUrl: null, subtask: false },
  { id: "10003", name: "Sub-task", iconUrl: null, subtask: true },
];
const priorities = [
  { id: "1", name: "Highest", iconUrl: null },
  { id: "2", name: "High", iconUrl: null },
  { id: "3", name: "Medium", iconUrl: null },
  { id: "4", name: "Low", iconUrl: null },
  { id: "5", name: "Lowest", iconUrl: null },
];
const labels = new Set(["api", "bug", "docs", "issues", "performance", "ui"]);
const toAdf = (value) => ({ type: "doc", version: 1, content: value ? [{ type: "paragraph", content: [{ type: "text", text: value }] }] : [] });
const adf = (paragraphs) => ({
  type: "doc", version: 1,
  content: paragraphs.map((value) => ({ type: "paragraph", content: [{ type: "text", text: value }] })),
});

let nextIssueNumber = 126;
let nextIssueId = 20126;
let nextCommentId = 9001;
const issues = new Map();

function makeIssue(projectKey, number, summary, statusKey, typeId, priorityId, options = {}) {
  const key = `${projectKey}-${number}`;
  const issue = {
    id: String(20000 + number),
    key,
    projectKey,
    summary,
    statusKey,
    issueTypeId: typeId,
    priorityId,
    assigneeAccountId: options.assigneeAccountId ?? null,
    reporterAccountId: options.reporterAccountId ?? users[0].accountId,
    labels: [...(options.labels ?? [])],
    parentKey: options.parentKey ?? null,
    description: options.description ?? `Details for ${key}.`,
    dueDate: options.dueDate ?? null,
    created: options.created ?? new Date(Date.now() - number * 3_600_000).toISOString(),
    updated: options.updated ?? new Date(Date.now() - (126 - number) * 3_600_000).toISOString(),
    comments: [],
  };
  for (const label of issue.labels) labels.add(label);
  issues.set(key, issue);
  return issue;
}

const seeds = [
  ["ADE", "Prevent stale issue tabs after reconnect", "progress", "10000", "2", ["bug", "issues"]],
  ["ADE", "Add keyboard navigation to the issue browser", "todo", "10001", "3", ["ui"]],
  ["ADE", "Map workflow transitions to status categories", "done", "10001", "3", ["api"]],
  ["ADE", "Keep project filters across lane changes", "progress", "10002", "2", ["ui", "issues"]],
  ["ADE", "Support Jira comment pagination", "todo", "10001", "3", ["api"]],
  ["ADE", "Handle deleted issue types in create metadata", "todo", "10000", "2", ["bug"]],
  ["ADE", "Polish issue summary rows", "done", "10001", "4", ["ui"]],
  ["ADE", "Add due date support to issue editing", "progress", "10001", "3", ["api"]],
  ["ADE", "Show assignee avatars in issue details", "todo", "10001", "4", ["ui"]],
  ["ADE", "Respect issue permissions before writes", "done", "10000", "2", ["api", "bug"]],
  ["ADE", "Write ADF tables as readable markdown", "progress", "10002", "3", ["docs"]],
  ["ADE", "Improve linked issue search", "todo", "10001", "3", ["issues"]],
  ["ADE", "Keep issue comments readable offline", "done", "10001", "4", ["docs"]],
  ["ADE", "Cache Jira project metadata briefly", "todo", "10001", "3", ["performance"]],
  ["ADE", "Explain unsupported required create fields", "progress", "10000", "2", ["api", "bug"]],
  ["ADE", "Add child task support", "todo", "10003", "3", ["issues"]],
  ["ADE", "Render workflow status category colors", "done", "10002", "4", ["ui"]],
  ["ADE", "Retry after Jira throttling", "todo", "10000", "2", ["api", "bug"]],
  ["ADE", "Clarify Jira credential state", "progress", "10001", "3", ["ui"]],
  ["PAY", "Document refund state transitions", "todo", "10002", "3", ["docs"]],
  ["PAY", "Prevent duplicate refund requests", "progress", "10000", "2", ["bug", "api"]],
  ["PAY", "Add payment event audit labels", "done", "10001", "4", ["api"]],
  ["PAY", "Improve retry queue visibility", "todo", "10001", "3", ["ui"]],
  ["PAY", "Add settlement reconciliation report", "progress", "10002", "2", ["docs"]],
  ["PAY", "Handle expired payment tokens", "done", "10000", "2", ["bug"]],
];
seeds.forEach(([projectKey, summary, status, type, priority, issueLabels], index) => {
  const number = projectKey === "ADE" ? 101 + index : 21 + (index - 19);
  const issue = makeIssue(projectKey, number, summary, status, type, priority, {
    assigneeAccountId: index % 3 === 0 ? users[0].accountId : index % 3 === 1 ? users[1].accountId : null,
    labels: issueLabels,
    description: `${summary}.\n\nThis seeded issue can be edited while the fake server is running.`,
  });
  if (index < 4) {
    issue.comments.push({
      id: String(8001 + index),
      author: users[(index + 1) % users.length],
      body: adf([`A comment on ${issue.key}.`, "The fake server keeps this comment in memory."]),
      created: new Date(Date.now() - index * 86_400_000).toISOString(),
      updated: new Date(Date.now() - index * 86_400_000).toISOString(),
    });
  }
});

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(value));
}

function sendEmpty(response) {
  response.writeHead(204);
  response.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function getIssue(key) {
  const issue = issues.get(key.toUpperCase());
  return issue ?? null;
}

function userFor(accountId) {
  return users.find((user) => user.accountId === accountId) ?? null;
}

function issueTypeFor(id) {
  return issueTypes.find((type) => type.id === String(id)) ?? issueTypes[1];
}

function priorityFor(id) {
  return priorities.find((priority) => priority.id === String(id)) ?? null;
}

function toIssuePayload(issue, site) {
  const project = projects.find((entry) => entry.key === issue.projectKey);
  const comments = issue.comments.map((comment) => ({ ...comment, author: comment.author }));
  const subtasks = [...issues.values()].filter((entry) => entry.parentKey === issue.key).map((entry) => toIssuePayload(entry, site));
  return {
    id: issue.id,
    key: issue.key,
    self: `${site}/rest/api/3/issue/${encodeURIComponent(issue.key)}`,
    fields: {
      project,
      summary: issue.summary,
      description: toAdf(issue.description),
      status: statuses[issue.statusKey],
      issuetype: issueTypeFor(issue.issueTypeId),
      priority: priorityFor(issue.priorityId),
      assignee: userFor(issue.assigneeAccountId),
      reporter: userFor(issue.reporterAccountId),
      labels: [...issue.labels],
      parent: issue.parentKey ? { key: issue.parentKey } : null,
      created: issue.created,
      updated: issue.updated,
      duedate: issue.dueDate,
      subtasks,
      comment: { comments: comments.slice(0, 5), total: comments.length, maxResults: 5, startAt: 0 },
    },
  };
}

function decodeJqlValues(clause) {
  return [...clause.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1].replace(/\\([\\"])/g, "$1"));
}

function searchIssues(jql) {
  const source = String(jql ?? "");
  const projectClause = /project\s+(?:in|=)\s*(\([^)]*\)|"(?:\\.|[^"\\])*"|[^\s]+?)(?:\s+AND|\s+ORDER BY|$)/i.exec(source)?.[1] ?? "";
  const projectKeys = decodeJqlValues(projectClause);
  const textClause = /text\s*~\s*("(?:\\.|[^"\\])*")/i.exec(source)?.[1] ?? "";
  const search = decodeJqlValues(textClause)[0]?.toLowerCase() ?? "";
  const doneOnly = /statusCategory\s*=\s*Done/i.test(source);
  const openOnly = /statusCategory\s*!=\s*Done/i.test(source);
  const mine = /assignee\s*=\s*currentUser\(\)/i.test(source);
  return [...issues.values()]
    .filter((issue) => (!projectKeys.length || projectKeys.includes(issue.projectKey))
      && (!doneOnly || issue.statusKey === "done")
      && (!openOnly || issue.statusKey !== "done")
      && (!mine || issue.assigneeAccountId === users[0].accountId)
      && (!search || `${issue.key} ${issue.summary} ${issue.description} ${issue.labels.join(" ")}`.toLowerCase().includes(search)))
    .sort((left, right) => right.updated.localeCompare(left.updated));
}

function createMetaFields(issueType) {
  const common = {
    summary: { name: "Summary", required: true, schema: { type: "string" } },
    description: { name: "Description", required: false, schema: { type: "doc" } },
    labels: { name: "Labels", required: false, schema: { type: "array" } },
    assignee: { name: "Assignee", required: false, schema: { type: "user" } },
    priority: { name: "Priority", required: false, schema: { type: "priority" } },
    parent: { name: "Parent", required: false, schema: { type: "issue" } },
    duedate: { name: "Due date", required: false, schema: { type: "date" } },
  };
  if (issueType.id === "10003") {
    return { ...common, customfield_10011: { name: "Release train", required: true, schema: { type: "string" } } };
  }
  return common;
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
  const { pathname, searchParams } = url;
  if (pathname === "/health") return sendJson(response, 200, { ok: true, issues: issues.size });
  const authorization = request.headers.authorization ?? "";
  const decoded = authorization.startsWith("Basic ") ? Buffer.from(authorization.slice(6), "base64").toString("utf8") : "";
  if (!decoded.includes(":") || decoded.slice(decoded.indexOf(":") + 1) !== "fake-token") {
    return sendJson(response, 401, { errorMessages: ["The Jira API token is invalid."] });
  }
  if (rateLimited) return sendJson(response, 429, { errorMessages: ["Rate limit exceeded."] }, { "Retry-After": "30" });
  const site = `http://${request.headers.host ?? `127.0.0.1:${port}`}`;
  const method = request.method ?? "GET";

  if (pathname === "/rest/api/3/myself" && method === "GET") {
    const email = decoded.slice(0, decoded.indexOf(":"));
    return sendJson(response, 200, { ...users[0], emailAddress: email });
  }
  if (pathname === "/rest/api/3/project/search" && method === "GET") {
    const queryText = (searchParams.get("query") ?? "").toLowerCase();
    const values = projects.filter((project) => !queryText || `${project.key} ${project.name}`.toLowerCase().includes(queryText));
    const startAt = Number(searchParams.get("startAt") ?? 0);
    const maxResults = Number(searchParams.get("maxResults") ?? 50);
    const page = values.slice(startAt, startAt + maxResults);
    return sendJson(response, 200, { values: page, total: values.length, startAt, maxResults, isLast: startAt + page.length >= values.length });
  }
  if (pathname === "/rest/api/3/priority" && method === "GET") return sendJson(response, 200, priorities);
  if (pathname === "/rest/api/3/label" && method === "GET") {
    const search = (searchParams.get("query") ?? "").toLowerCase();
    const values = [...labels].filter((label) => !search || label.toLowerCase().includes(search));
    return sendJson(response, 200, { values, total: values.length, isLast: true });
  }
  if (pathname === "/rest/api/3/user/assignable/search" && method === "GET") {
    const search = (searchParams.get("query") ?? "").toLowerCase();
    const issue = searchParams.get("issueKey") ? getIssue(searchParams.get("issueKey")) : null;
    const projectKey = searchParams.get("projectKey");
    const available = users.filter((user) => !search || `${user.displayName} ${user.emailAddress}`.toLowerCase().includes(search));
    const scoped = issue || projectKey ? available : available;
    return sendJson(response, 200, scoped);
  }
  if (/^\/rest\/api\/3\/mypermissions$/.test(pathname) && method === "GET") {
    const names = (searchParams.get("permissions") ?? "").split(",").filter(Boolean);
    return sendJson(response, 200, { permissions: Object.fromEntries(names.map((name) => [name, { havePermission: true }])) });
  }
  if (pathname === "/rest/api/3/search/jql" && method === "POST") {
    const body = await readBody(request);
    const all = searchIssues(body.jql);
    const offset = Number(body.nextPageToken ?? 0) || 0;
    const maxResults = Math.min(100, Math.max(1, Number(body.maxResults ?? 50)));
    const page = all.slice(offset, offset + maxResults);
    const next = offset + page.length;
    return sendJson(response, 200, {
      issues: page.map((issue) => toIssuePayload(issue, site)),
      nextPageToken: next < all.length ? String(next) : null,
      isLast: next >= all.length,
    });
  }
  const createMetaTypeMatch = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes(?:\/([^/]+))?$/i.exec(pathname);
  if (createMetaTypeMatch && method === "GET") {
    const projectKey = decodeURIComponent(createMetaTypeMatch[1]).toUpperCase();
    if (!projects.some((project) => project.key === projectKey)) return sendJson(response, 404, { errorMessages: ["Project does not exist."] });
    const requestedType = createMetaTypeMatch[2];
    if (!requestedType) {
      return sendJson(response, 200, { issueTypes: issueTypes.map((type) => ({ ...type, self: `${site}/rest/api/3/issuetype/${type.id}` })) });
    }
    const issueType = issueTypes.find((type) => type.id === decodeURIComponent(requestedType));
    if (!issueType) return sendJson(response, 404, { errorMessages: ["Issue type does not exist."] });
    return sendJson(response, 200, { issueType, fields: createMetaFields(issueType) });
  }

  if (pathname === "/rest/api/3/issue" && method === "POST") {
    const body = await readBody(request);
    const fields = body.fields ?? {};
    const projectKey = String(fields.project?.key ?? "").toUpperCase();
    const type = issueTypes.find((item) => item.id === String(fields.issuetype?.id));
    if (!projects.some((project) => project.key === projectKey)) return sendJson(response, 400, { errorMessages: ["A valid project is required."] });
    if (!type) return sendJson(response, 400, { errorMessages: ["A valid issue type is required."] });
    if (type.id === "10003" && !fields.customfield_10011) return sendJson(response, 400, { errorMessages: ["Release train is required for Sub-task."] });
    const number = nextIssueNumber++;
    const issueId = nextIssueId++;
    const created = makeIssue(projectKey, number, String(fields.summary ?? "Untitled issue"), "todo", type.id, fields.priority?.id ?? "3", {
      description: fields.description ? fields.description.content?.map((node) => node.content?.map((child) => child.text ?? "").join("")).join("\n") ?? "" : "",
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      assigneeAccountId: fields.assignee?.accountId ?? null,
      parentKey: fields.parent?.key ?? null,
      dueDate: fields.duedate ?? null,
    });
    created.id = String(issueId);
    return sendJson(response, 201, { id: created.id, key: created.key, self: `${site}/rest/api/3/issue/${created.key}` });
  }

  const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)(?:\/(comment|transitions))?$/.exec(pathname);
  if (issueMatch) {
    const key = decodeURIComponent(issueMatch[1]);
    const issue = getIssue(key);
    if (!issue && !(method === "POST" && !issueMatch[2])) return sendJson(response, 404, { errorMessages: [`Issue ${key} does not exist.`] });
    const suffix = issueMatch[2];
    if (method === "GET" && !suffix) return sendJson(response, 200, toIssuePayload(issue, site));
    if (method === "PUT" && !suffix) {
      const body = await readBody(request);
      const fields = body.fields ?? {};
      if (typeof fields.summary === "string") issue.summary = fields.summary;
      if (Object.hasOwn(fields, "description")) issue.description = fields.description?.content?.map((node) => node.content?.map((child) => child.text ?? "").join("")).join("\n") ?? "";
      if (Array.isArray(fields.labels)) { issue.labels = fields.labels.filter((value) => typeof value === "string"); issue.labels.forEach((label) => labels.add(label)); }
      if (Object.hasOwn(fields, "assignee")) issue.assigneeAccountId = fields.assignee?.accountId ?? null;
      if (fields.priority?.id) issue.priorityId = String(fields.priority.id);
      if (Object.hasOwn(fields, "duedate")) issue.dueDate = fields.duedate ?? null;
      if (fields.parent?.key) issue.parentKey = String(fields.parent.key);
      issue.updated = new Date().toISOString();
      return sendEmpty(response);
    }
    if (method === "GET" && suffix === "comment") {
      const startAt = Number(searchParams.get("startAt") ?? 0);
      const maxResults = Number(searchParams.get("maxResults") ?? 50);
      const comments = issue.comments.slice(startAt, startAt + maxResults);
      return sendJson(response, 200, { comments, total: issue.comments.length, startAt, maxResults, isLast: startAt + comments.length >= issue.comments.length });
    }
    if (method === "POST" && suffix === "comment") {
      const body = await readBody(request);
      const comment = { id: String(nextCommentId++), author: users[0], body: body.body ?? toAdf(""), created: new Date().toISOString(), updated: new Date().toISOString() };
      issue.comments.push(comment);
      issue.updated = new Date().toISOString();
      return sendJson(response, 201, comment);
    }
    if (method === "GET" && suffix === "transitions") {
      const transitions = [
        { id: "11", name: "Start Progress", to: statuses.progress },
        { id: "21", name: "Resolve Issue", to: statuses.done },
        { id: "31", name: "Reopen Issue", to: statuses.todo },
      ];
      return sendJson(response, 200, { transitions });
    }
    if (method === "POST" && suffix === "transitions") {
      const body = await readBody(request);
      const transitionId = String(body.transition?.id ?? "");
      const statusKey = transitionId === "11" ? "progress" : transitionId === "21" ? "done" : transitionId === "31" ? "todo" : null;
      if (!statusKey) return sendJson(response, 400, { errorMessages: ["Unknown transition."] });
      issue.statusKey = statusKey;
      issue.updated = new Date().toISOString();
      return sendEmpty(response);
    }
  }

  return sendJson(response, 404, { errorMessages: [`No fake Jira route for ${method} ${pathname}.`] });
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    sendJson(response, 500, { errorMessages: [error instanceof Error ? error.message : String(error)] });
  });
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Fake Jira server: http://127.0.0.1:${port}${rateLimited ? " (--rate-limit)" : ""}\n`);
});
server.on("error", (error) => {
  process.stderr.write(`Fake Jira server failed: ${error.message}\n`);
  process.exitCode = 1;
});
