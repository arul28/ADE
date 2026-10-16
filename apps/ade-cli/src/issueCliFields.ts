/**
 * Field parsing and name matching for `ade linear` and `ade github issue`.
 *
 * The CLI lets a person or an agent type names ("In Progress", "me", "bug",
 * "current") where the backend wants ids. These helpers turn what was typed
 * into the ids and values the existing daemon actions take. They are pure: the
 * CLI reads the catalogs (states, users, labels, cycles, milestones) through
 * the daemon first and hands them in. Every failure is a plain `Error` with a
 * message a caller can act on; the CLI turns it into a usage error.
 */

type Row = Record<string, unknown>;

const LINEAR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONE_WORDS = new Set(["none", "null", "clear", "unset", "no", "unassigned", "nobody"]);

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(record).filter((entry): entry is Row => entry != null) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** A Linear id (UUID). Typed ids skip the catalog read. */
export function looksLikeLinearId(value: string): boolean {
  return LINEAR_UUID.test(value.trim());
}

/** `none`, `null`, `clear`, ... — the words that clear a field. */
export function isNoneValue(value: string | null | undefined): boolean {
  return typeof value === "string" && NONE_WORDS.has(value.trim().toLowerCase());
}

/* ── Matching ─────────────────────────────────────────────────────────── */

type MatchSpec<T> = {
  noun: string;
  /** Appended to "not found" errors, e.g. ` in team ADE`. */
  scope?: string;
  id: (item: T) => string | null;
  names: (item: T) => Array<string | null | undefined>;
  label: (item: T) => string;
};

function listHint<T>(items: T[], label: (item: T) => string): string {
  if (items.length === 0) return "";
  const names = [...new Set(items.map(label))];
  const shown = names.slice(0, 12);
  const more = names.length > shown.length ? `, and ${names.length - shown.length} more` : "";
  return ` Try: ${shown.join(", ")}${more}.`;
}

/**
 * One item by id, then by exact name (any case), then by a unique name
 * prefix. Two or more matches is an error, never a guess.
 */
export function matchOne<T>(items: T[], value: string, spec: MatchSpec<T>): T {
  const needle = value.trim();
  const lower = needle.toLowerCase();
  if (!needle) throw new Error(`A ${spec.noun} is required.`);
  const byId = items.find((item) => spec.id(item) === needle);
  if (byId) return byId;
  const nameMatches = (test: (name: string) => boolean) =>
    items.filter((item) => spec.names(item).some((name) => typeof name === "string" && test(name.toLowerCase())));
  for (const matches of [nameMatches((name) => name === lower), nameMatches((name) => name.startsWith(lower))]) {
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `"${needle}" matches more than one ${spec.noun}: ${matches.slice(0, 8).map(spec.label).join(", ")}. Use the full name or the id.`,
      );
    }
  }
  throw new Error(`No ${spec.noun} named "${needle}"${spec.scope ?? ""}.${listHint(items, spec.label)}`);
}

/* ── Linear values ────────────────────────────────────────────────────── */

const LINEAR_PRIORITY_WORDS: Record<string, number> = {
  none: 0,
  "no-priority": 0,
  urgent: 1,
  high: 2,
  normal: 3,
  medium: 3,
  low: 4,
};

/** `urgent|high|normal|low|none` or `0`-`4` (0 none, 1 urgent, 2 high, 3 normal, 4 low). */
export function parseLinearPriority(value: string): number {
  const key = value.trim().toLowerCase();
  if (key in LINEAR_PRIORITY_WORDS) return LINEAR_PRIORITY_WORDS[key]!;
  if (/^[0-4]$/.test(key)) return Number(key);
  throw new Error(`Priority must be urgent, high, normal, low, none, or 0-4. Got "${value}".`);
}

/** A non-negative number, or `none` to clear. */
export function parseLinearEstimate(value: string): number | null {
  if (isNoneValue(value)) return null;
  const parsed = Number(value.trim());
  if (!value.trim() || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Estimate must be a number of points or none. Got "${value}".`);
  }
  return parsed;
}

/** `YYYY-MM-DD` that names a real day, or `none` to clear. */
export function parseDueDate(value: string): string | null {
  if (isNoneValue(value)) return null;
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.toISOString().slice(0, 10) === trimmed) return trimmed;
  }
  throw new Error(`Due date must be YYYY-MM-DD or none. Got "${value}".`);
}

/** The team part of an identifier like `ADE-123`, upper-cased. */
export function teamKeyFromIdentifier(value: string | null | undefined): string | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec((value ?? "").trim());
  return match ? match[1]!.toUpperCase() : null;
}

/** What a Linear create or edit asked for, exactly as typed. */
export type LinearFieldInput = {
  title?: string;
  description?: string;
  state?: string;
  assignee?: string;
  priority?: string;
  labels?: string[];
  removeLabels?: string[];
  project?: string;
  milestone?: string;
  cycle?: string;
  estimate?: string;
  due?: string;
  parent?: string;
  template?: string;
};

/** Which catalogs the CLI must read before it can send the write. */
export type LinearLookupNeeds = {
  issue: boolean;
  picker: boolean;
  viewer: boolean;
  options: boolean;
  milestones: boolean;
  parent: boolean;
};

const named = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0 && !isNoneValue(value) && !looksLikeLinearId(value);

export function linearLookupNeeds(input: LinearFieldInput, mode: "create" | "update"): LinearLookupNeeds {
  const assigneeNamed = named(input.assignee) && input.assignee.trim().toLowerCase() !== "me";
  const labelNames = [...(input.labels ?? []), ...(input.removeLabels ?? [])].filter(named);
  const projectNamed = named(input.project);
  const milestoneNamed = named(input.milestone);
  const cycleNamed = named(input.cycle);
  const stateNamed = named(input.state);
  const needsTeam = stateNamed || cycleNamed || labelNames.length > 0;
  return {
    issue: mode === "update" && (needsTeam || (milestoneNamed && input.project === undefined)),
    picker: stateNamed || assigneeNamed || labelNames.length > 0 || projectNamed,
    viewer: input.assignee?.trim().toLowerCase() === "me",
    options: cycleNamed || named(input.template),
    milestones: milestoneNamed,
    parent: named(input.parent),
  };
}

/** The catalogs the CLI read, unwrapped. */
export type LinearLookupContext = {
  /** The issue being edited (update only). */
  issue?: Row | null;
  /** Team key or id the write is scoped to (create: `--team`; update: the issue's team). */
  teamKey?: string | null;
  picker?: Row | null;
  viewerId?: string | null;
  options?: Row | null;
  milestones?: Row[] | null;
  parentIssue?: Row | null;
};

function sameTeam(item: Row, team: string): boolean {
  const lower = team.toLowerCase();
  return text(item.teamKey)?.toLowerCase() === lower || text(item.teamId) === team;
}

function teamOf(ctx: LinearLookupContext): string | null {
  return text(ctx.teamKey) ?? text(ctx.issue?.teamKey) ?? null;
}

export function resolveLinearStateId(ctx: LinearLookupContext, value: string): string {
  if (looksLikeLinearId(value)) return value.trim();
  const team = teamOf(ctx);
  const all = rows(ctx.picker?.states);
  const states = team ? all.filter((state) => sameTeam(state, team)) : all;
  return text(
    matchOne(states, value, {
      noun: "state",
      scope: team ? ` in team ${team}` : "",
      id: (state) => text(state.id),
      names: (state) => [text(state.name)],
      label: (state) => (team ? String(state.name) : `${String(state.name)} (${String(state.teamKey)})`),
    }).id,
  )!;
}

/** `me`, `none`, or a user's id, email, name, or display name. `null` unassigns. */
export function resolveLinearUserId(ctx: LinearLookupContext, value: string): string | null {
  const trimmed = value.trim();
  if (isNoneValue(trimmed)) return null;
  if (trimmed.toLowerCase() === "me") {
    if (!ctx.viewerId) throw new Error("ADE could not read your Linear user. Pass a name, email, or id instead of me.");
    return ctx.viewerId;
  }
  if (looksLikeLinearId(trimmed)) return trimmed;
  const users = rows(ctx.picker?.users);
  return text(
    matchOne(users, trimmed, {
      noun: "Linear user",
      id: (user) => text(user.id),
      names: (user) => [text(user.email), text(user.name), text(user.displayName)],
      label: (user) => String(user.displayName ?? user.name),
    }).id,
  )!;
}

export function resolveLinearLabelIds(ctx: LinearLookupContext, values: string[]): string[] {
  if (values.length === 0) return [];
  if (ctx.picker && !Array.isArray(ctx.picker.labels) && values.some((value) => !looksLikeLinearId(value))) {
    throw new Error("This ADE brain does not send Linear labels. Update ADE, or pass label ids.");
  }
  const team = teamOf(ctx);
  const all = rows(ctx.picker?.labels);
  const inScope = team
    ? all.filter((label) => sameTeam(label, team) || (!text(label.teamKey) && !text(label.teamId)))
    : all;
  return values.map((value) => {
    if (looksLikeLinearId(value)) return value.trim();
    // A team label wins over a workspace label with the same name.
    const teamOnly = team ? inScope.filter((label) => sameTeam(label, team)) : [];
    const exactTeam = teamOnly.filter((label) => text(label.name)?.toLowerCase() === value.trim().toLowerCase());
    if (exactTeam.length === 1) return text(exactTeam[0]!.id)!;
    return text(
      matchOne(inScope, value, {
        noun: "label",
        scope: team ? ` in team ${team}` : "",
        id: (label) => text(label.id),
        names: (label) => [text(label.name)],
        label: (label) => String(label.name),
      }).id,
    )!;
  });
}

/** The project a write points at: the typed one, else the issue's own. `null` when none. */
export function resolveLinearProjectId(ctx: LinearLookupContext, value: string | undefined): string | null {
  if (value === undefined) return text(ctx.issue?.projectId);
  if (isNoneValue(value)) return null;
  if (looksLikeLinearId(value)) return value.trim();
  return text(
    matchOne(rows(ctx.picker?.projects), value, {
      noun: "Linear project",
      id: (project) => text(project.id),
      names: (project) => [text(project.name), text(project.slug)],
      label: (project) => String(project.name),
    }).id,
  )!;
}

/** `current`, `next`, a cycle number, name, or id. */
export function resolveLinearCycleId(ctx: LinearLookupContext, value: string): string {
  if (looksLikeLinearId(value)) return value.trim();
  const options = ctx.options ?? {};
  const team = text(options.teamKey) ?? teamOf(ctx) ?? "this team";
  if (options.cyclesEnabled === false) throw new Error(`Team ${team} does not use cycles.`);
  const cycles = rows(options.cycles);
  const key = value.trim().toLowerCase();
  const describe = (cycle: Row) => `${String(cycle.number)}${text(cycle.name) ? ` (${String(cycle.name)})` : ""}`;
  if (key === "current" || key === "active") {
    const active = cycles.find((cycle) => cycle.active === true);
    if (!active) throw new Error(`Team ${team} has no active cycle.`);
    return text(active.id)!;
  }
  if (key === "next" || key === "upcoming") {
    const upcoming = cycles
      .filter((cycle) => cycle.active !== true)
      .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
    if (!upcoming[0]) throw new Error(`Team ${team} has no upcoming cycle.`);
    return text(upcoming[0].id)!;
  }
  if (/^\d+$/.test(key)) {
    const byNumber = cycles.find((cycle) => cycle.number === Number(key));
    if (!byNumber) {
      throw new Error(`Team ${team} has no current or upcoming cycle ${key}.${listHint(cycles, describe)}`);
    }
    return text(byNumber.id)!;
  }
  return text(
    matchOne(cycles, value, {
      noun: "cycle",
      scope: ` in team ${team}`,
      id: (cycle) => text(cycle.id),
      names: (cycle) => [text(cycle.name)],
      label: describe,
    }).id,
  )!;
}

export function resolveLinearMilestoneId(ctx: LinearLookupContext, value: string): string {
  if (looksLikeLinearId(value)) return value.trim();
  return text(
    matchOne(rows(ctx.milestones), value, {
      noun: "milestone",
      scope: " in this project",
      id: (milestone) => text(milestone.id),
      names: (milestone) => [text(milestone.name)],
      label: (milestone) => String(milestone.name),
    }).id,
  )!;
}

export function resolveLinearTemplateId(ctx: LinearLookupContext, value: string): string {
  if (looksLikeLinearId(value)) return value.trim();
  return text(
    matchOne(rows(ctx.options?.templates), value, {
      noun: "template",
      scope: text(ctx.options?.teamKey) ? ` in team ${String(ctx.options?.teamKey)}` : "",
      id: (template) => text(template.id),
      names: (template) => [text(template.name)],
      label: (template) => String(template.name),
    }).id,
  )!;
}

/**
 * The create input (`mode: "create"`) or the update patch (`mode: "update"`)
 * for what was typed. Create leaves cleared fields out; update sends `null`.
 */
export function resolveLinearFields(
  input: LinearFieldInput,
  ctx: LinearLookupContext,
  mode: "create" | "update",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (value === null && mode === "create") return;
    out[key] = value;
  };
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new Error("Title cannot be empty.");
    put("title", input.title.trim());
  }
  if (input.description !== undefined) put("description", input.description);
  if (input.state !== undefined) put("stateId", resolveLinearStateId(ctx, input.state));
  if (input.assignee !== undefined) put("assigneeId", resolveLinearUserId(ctx, input.assignee));
  if (input.priority !== undefined) put("priority", parseLinearPriority(input.priority));
  const added = resolveLinearLabelIds(ctx, input.labels ?? []);
  const removed = resolveLinearLabelIds(ctx, input.removeLabels ?? []);
  if (mode === "create") {
    if (added.length) put("labelIds", added);
  } else {
    if (added.length) put("addedLabelIds", added);
    if (removed.length) put("removedLabelIds", removed);
  }
  if (input.project !== undefined) put("projectId", resolveLinearProjectId(ctx, input.project));
  if (input.milestone !== undefined) {
    put("projectMilestoneId", isNoneValue(input.milestone) ? null : resolveLinearMilestoneId(ctx, input.milestone));
  }
  if (input.cycle !== undefined) {
    put("cycleId", isNoneValue(input.cycle) ? null : resolveLinearCycleId(ctx, input.cycle));
  }
  if (input.estimate !== undefined) put("estimate", parseLinearEstimate(input.estimate));
  if (input.due !== undefined) put("dueDate", parseDueDate(input.due));
  if (input.parent !== undefined) {
    if (isNoneValue(input.parent)) put("parentId", null);
    else if (looksLikeLinearId(input.parent)) put("parentId", input.parent.trim());
    else {
      const parentId = text(ctx.parentIssue?.id);
      if (!parentId) throw new Error(`Linear issue ${input.parent.trim()} was not found.`);
      put("parentId", parentId);
    }
  }
  if (input.template !== undefined && mode === "create") put("templateId", resolveLinearTemplateId(ctx, input.template));
  return out;
}

/** The project a milestone lookup reads, or an error when there is none. */
export function milestoneProjectId(input: LinearFieldInput, ctx: LinearLookupContext): string {
  const projectId = resolveLinearProjectId(ctx, input.project);
  if (!projectId) {
    throw new Error("Milestones belong to a project. Set a project first, or pass --project.");
  }
  return projectId;
}

/* ── GitHub values ────────────────────────────────────────────────────── */

export type GithubRepoRef = { owner: string; name: string };

/** `owner/name`, or a GitHub repository URL. */
export function parseGithubRepo(value: string): GithubRepoRef {
  const trimmed = value.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const fromUrl = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(trimmed);
  const plain = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  const match = fromUrl ?? plain;
  if (!match) throw new Error(`--repo must look like owner/name. Got "${value}".`);
  return { owner: match[1]!, name: match[2]! };
}

/** `12`, `#12`, `owner/name#12`, or an issue URL. The repo is set when the value names one. */
export function parseGithubIssueRef(value: string): { number: number; repo: GithubRepoRef | null } {
  const trimmed = value.trim();
  const url = /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i.exec(trimmed);
  if (url) return { number: Number(url[3]), repo: { owner: url[1]!, name: url[2]! } };
  const qualified = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(trimmed);
  if (qualified) return { number: Number(qualified[3]), repo: { owner: qualified[1]!, name: qualified[2]! } };
  const bare = /^#?(\d+)$/.exec(trimmed);
  if (bare && Number(bare[1]) > 0) return { number: Number(bare[1]), repo: null };
  throw new Error(`Expected an issue number like 12 or #12. Got "${value}".`);
}

export type GithubCloseReason = "completed" | "not_planned" | "duplicate";

export function parseGithubCloseReason(value: string): GithubCloseReason {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "completed" || key === "done" || key === "fixed") return "completed";
  if (key === "not_planned" || key === "wontfix" || key === "won't_fix") return "not_planned";
  if (key === "duplicate") return "duplicate";
  throw new Error(`--reason must be completed, not-planned, or duplicate. Got "${value}".`);
}

/** A milestone number, or a milestone title matched against the repo's open milestones. */
export function resolveGithubMilestone(milestones: unknown, value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = matchOne(rows(milestones), trimmed, {
    noun: "open milestone",
    id: () => null,
    names: (milestone) => [text(milestone.title)],
    label: (milestone) => String(milestone.title),
  });
  return Number(match.number);
}

/** Label names on a REST or GraphQL-shaped issue. */
export function githubIssueLabelNames(issue: unknown): string[] {
  const labels = record(issue)?.labels;
  return (Array.isArray(labels) ? labels : [])
    .map((label) => (typeof label === "string" ? label : text(record(label)?.name)))
    .filter((name): name is string => Boolean(name));
}

export function githubIssueAssigneeLogins(issue: unknown): string[] {
  return rows(record(issue)?.assignees)
    .map((assignee) => text(assignee.login))
    .filter((login): login is string => Boolean(login));
}

/** `current` plus `add`, minus `remove`. Names compare without case; first spelling wins. */
export function editNameSet(current: string[], add: string[], remove: string[]): string[] {
  const removeKeys = new Set(remove.map((name) => name.trim().toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of [...current, ...add]) {
    const trimmed = name.trim().replace(/^@/, "");
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key) || removeKeys.has(key) || removeKeys.has(`@${key}`)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

const ATTACHMENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".zip": "application/zip",
};

/** A content type from a file extension (`application/octet-stream` when unknown). */
export function contentTypeForFile(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return (dot >= 0 && ATTACHMENT_TYPES[fileName.slice(dot).toLowerCase()]) || "application/octet-stream";
}
