/**
 * The provider-neutral issue link.
 *
 * ADE's lane and session records carried Linear-shaped and GitHub-shaped issue
 * fields. The PR body writer, the branch namer, the deeplink envelope and the
 * sync projections all read those fields directly. `IssueRef` is the one shape
 * they read instead, so a plugin can fill it for any tracker.
 *
 * # Where an `IssueRef` lives
 *
 * It lives INSIDE the existing `issue_json` column of `lane_linear_issues`,
 * `lane_linear_issue_links`, `session_linear_issues` and `session_github_issues`,
 * under the reserved key `__issueRef`. It does NOT get its own column and it
 * does NOT get its own table. That is deliberate, and the reason is
 * compatibility with peers on older builds:
 *
 * - A new table wedges an old desktop peer for good. `applyChanges` in
 *   `kvDb.ts` throws `unknown_sync_table` and rolls back the whole batch.
 * - A new column is supported but unproven. No peer exchanges a schema
 *   version, and nothing filters an unknown column out of an inbound
 *   changeset.
 * - An unknown JSON key is inert everywhere. An old peer stores the column
 *   verbatim and its parser reads only the fields it knows.
 *
 * `kvDb.ts` and the iOS `DatabaseBootstrap.sql` already state this rule for the
 * plugin tables: version inside the JSON, never in SQL. This follows it.
 *
 * # The two directions
 *
 * - A new build reading an old row finds no `__issueRef` and derives one from
 *   the legacy fields. No migration and no backfill run.
 * - An old build reading a new row drops the unknown key and reads the legacy
 *   fields, which every writer keeps filling. See `embedIssueRef`.
 */

import type { LaneGitHubIssue, LaneLinearIssue } from "./types";
import type { LinearPriorityLabel } from "./types/linearSync";

/**
 * The reserved key that carries an `IssueRef` inside a legacy issue object.
 *
 * DO NOT "FIX" THIS INTO A COLUMN OR A TABLE. It looks like schema hiding in a
 * TEXT column, and it is, deliberately. Read this before changing it.
 *
 * A NEW TABLE is the worst of the three options, not the safest. A peer on an
 * older build has no such table, and `applyChanges` in `kvDb.ts` throws
 * `unknown_sync_table` and rolls the WHOLE batch back inside one
 * `BEGIN IMMEDIATE`. That peer's replication then stops, permanently, for every
 * table at once. The plugin tables were only shippable because they added a
 * hello-capability gate to go with them; there is no such gate here.
 *
 * A NEW COLUMN is supported — `safeAddColumn` wraps the `ALTER` in
 * `crsql_begin_alter` / `crsql_commit_alter` — but no peer exchanges a schema
 * version, and nothing anywhere filters an unknown column out of an inbound
 * changeset. It would work only if every peer upgraded first, which is not a
 * property this system has.
 *
 * An unknown JSON KEY is inert on every build that does not know it. So the
 * generic ref rides here, beside a full legacy Linear projection of itself that
 * an older parser still reads.
 *
 * The cost, stated plainly so nobody discovers it as a bug: on a build that
 * predates this key, an issue from a tracker that is not Linear renders under
 * the Linear badge, with the right key, title, URL and state. It is mislabelled
 * there, and it works. That trade was taken knowingly, because the only build
 * that can show the wrong label is one too old to have a plugin that could
 * create such a link in the first place, which makes the degradation
 * transitional. A gated table would show nothing at all and risk the wedge
 * above.
 *
 * `kvDb.ts` and `apps/ios/ADE/Resources/DatabaseBootstrap.sql` state the same
 * rule for the plugin tables: version inside the JSON, never in SQL.
 */
export const ISSUE_REF_KEY = "__issueRef";

/**
 * The `pluginId` stamped on a link that ADE itself created. No plugin owns it,
 * so no plugin may unlink it. Only the user can.
 */
export const CORE_ISSUE_PLUGIN_ID = "core";

export const ISSUE_PROVIDER_LINEAR = "linear";
export const ISSUE_PROVIDER_GITHUB = "github";

/**
 * The tracker-neutral lifecycle position of an issue. The vocabulary is
 * Linear's `stateType`, because it is the widest of the trackers ADE reads and
 * every other tracker maps into it without loss of meaning.
 */
export type IssueStateCategory =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

const ISSUE_STATE_CATEGORIES = new Set<IssueStateCategory>([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

export type IssueRefState = {
  /** The tracker's own state id. A plugin needs it to move the issue back. */
  id?: string | null;
  /** The state as the tracker names it, for display. */
  name?: string | null;
  category: IssueStateCategory;
};

/**
 * The group the issue belongs to. A Linear team, a GitHub repository, a Jira
 * project. Core only displays it and never interprets it.
 */
export type IssueRefContainer = {
  id?: string | null;
  key?: string | null;
  name?: string | null;
};

export type IssueRefActor = {
  id?: string | null;
  name?: string | null;
};

export type IssueRefPriority = {
  /** Lower sorts first, matching Linear's own ordering. */
  rank?: number | null;
  label?: string | null;
};

export type IssueRef = {
  /** The plugin that owns this link, or `CORE_ISSUE_PLUGIN_ID`. */
  pluginId: string;
  /** The tracker vocabulary, such as `linear`, `github` or `jira`. */
  provider: string;
  /** The tracker's stable id for the issue. */
  issueId: string;
  /** The human key, such as `ADE-123` or `owner/repo#42`. */
  key: string;
  title: string;
  url: string | null;
  state?: IssueRefState | null;
  container?: IssueRefContainer | null;
  /**
   * The branch ADE derives for this issue. It is the only field ADE writes
   * back into the issue, so it needs a provider-neutral slot.
   */
  branchName?: string | null;
  assignee?: IssueRefActor | null;
  priority?: IssueRefPriority | null;
  labels?: string[];
  description?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Tracker-specific residue. Core stores it and never reads it. */
  extra?: Record<string, unknown> | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function issueStateCategory(value: unknown): IssueStateCategory | null {
  const raw = readString(value)?.toLowerCase() ?? null;
  return raw && ISSUE_STATE_CATEGORIES.has(raw as IssueStateCategory)
    ? raw as IssueStateCategory
    : null;
}

function parseIssueRefState(value: unknown): IssueRefState | null {
  const record = readRecord(value);
  if (!record) return null;
  const category = issueStateCategory(record.category);
  if (!category) return null;
  return {
    id: readNullableString(record.id),
    name: readNullableString(record.name),
    category,
  };
}

function parseIssueRefContainer(value: unknown): IssueRefContainer | null {
  const record = readRecord(value);
  if (!record) return null;
  const id = readNullableString(record.id);
  const key = readNullableString(record.key);
  const name = readNullableString(record.name);
  if (id == null && key == null && name == null) return null;
  return { id, key, name };
}

function parseIssueRefActor(value: unknown): IssueRefActor | null {
  const record = readRecord(value);
  if (!record) return null;
  const id = readNullableString(record.id);
  const name = readNullableString(record.name);
  if (id == null && name == null) return null;
  return { id, name };
}

function parseIssueRefPriority(value: unknown): IssueRefPriority | null {
  const record = readRecord(value);
  if (!record) return null;
  const rank = readNumber(record.rank);
  const label = readNullableString(record.label);
  if (rank == null && label == null) return null;
  return { rank, label };
}

/**
 * Parse an `IssueRef` from untrusted input. A ref without a provider, an issue
 * id, a key and a title is not usable by any reader, so it is rejected whole
 * rather than repaired.
 */
export function parseIssueRefValue(value: unknown): IssueRef | null {
  const record = readRecord(value);
  if (!record) return null;
  const provider = readString(record.provider)?.toLowerCase() ?? null;
  const issueId = readString(record.issueId);
  const key = readString(record.key);
  const title = readString(record.title);
  if (!provider || !issueId || !key || !title) return null;
  const extra = readRecord(record.extra);
  return {
    pluginId: readString(record.pluginId) ?? CORE_ISSUE_PLUGIN_ID,
    provider,
    issueId,
    key,
    title,
    url: readNullableString(record.url),
    state: parseIssueRefState(record.state),
    container: parseIssueRefContainer(record.container),
    branchName: readNullableString(record.branchName),
    assignee: parseIssueRefActor(record.assignee),
    priority: parseIssueRefPriority(record.priority),
    labels: readStringArray(record.labels),
    description: readNullableString(record.description),
    createdAt: readNullableString(record.createdAt),
    updatedAt: readNullableString(record.updatedAt),
    extra,
  };
}

/** Derive an `IssueRef` from a legacy Linear issue. This is the read fallback. */
export function issueRefFromLinearIssue(
  issue: LaneLinearIssue,
  pluginId: string = CORE_ISSUE_PLUGIN_ID,
): IssueRef {
  return {
    pluginId,
    provider: ISSUE_PROVIDER_LINEAR,
    issueId: issue.id,
    key: issue.identifier,
    title: issue.title,
    url: issue.url ?? null,
    state: {
      id: issue.stateId || null,
      name: issue.stateName || null,
      category: issueStateCategory(issue.stateType) ?? "unstarted",
    },
    container: {
      id: issue.teamId || null,
      key: issue.teamKey || null,
      name: issue.teamName ?? null,
    },
    branchName: issue.branchName ?? null,
    assignee: issue.assigneeId || issue.assigneeName
      ? { id: issue.assigneeId, name: issue.assigneeName }
      : null,
    priority: { rank: issue.priority, label: issue.priorityLabel },
    labels: issue.labels ?? [],
    description: issue.description ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    extra: {
      projectId: issue.projectId,
      projectSlug: issue.projectSlug,
      projectName: issue.projectName ?? null,
      creatorId: issue.creatorId ?? null,
      creatorName: issue.creatorName ?? null,
      dueDate: issue.dueDate ?? null,
      estimate: issue.estimate ?? null,
    },
  };
}

/** Derive an `IssueRef` from a legacy GitHub issue. */
export function issueRefFromGitHubIssue(
  issue: LaneGitHubIssue,
  pluginId: string = CORE_ISSUE_PLUGIN_ID,
): IssueRef {
  const closedAsNotPlanned = issue.state === "closed" && issue.stateReason === "not_planned";
  return {
    pluginId,
    provider: ISSUE_PROVIDER_GITHUB,
    issueId: issue.id,
    key: `${issue.owner}/${issue.repo}#${issue.number}`,
    title: issue.title,
    url: issue.url,
    state: {
      id: null,
      name: issue.state,
      category: issue.state === "open"
        ? "started"
        : closedAsNotPlanned ? "canceled" : "completed",
    },
    container: { id: null, key: `${issue.owner}/${issue.repo}`, name: issue.repo },
    branchName: null,
    assignee: issue.assignees.length ? { id: null, name: issue.assignees[0] } : null,
    priority: null,
    labels: issue.labels ?? [],
    description: issue.body ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    extra: {
      number: issue.number,
      owner: issue.owner,
      repo: issue.repo,
      stateReason: issue.stateReason ?? null,
      assignees: issue.assignees,
      authorLogin: issue.authorLogin ?? null,
    },
  };
}

/**
 * Read the `IssueRef` a legacy Linear issue carries, or derive one from its
 * legacy fields when it carries none. Every reader calls this instead of
 * reading `issue.identifier` and friends directly.
 */
export function readLinearIssueRef(issue: LaneLinearIssue): IssueRef {
  const embedded = parseIssueRefValue((issue as Record<string, unknown>)[ISSUE_REF_KEY]);
  if (!embedded) return issueRefFromLinearIssue(issue);
  // The legacy `branchName` is the live one. ADE rewrites it on every attach
  // through `finalizeLaneLinearIssue`, which does not reach inside the ref.
  return { ...embedded, branchName: issue.branchName ?? embedded.branchName ?? null };
}

/** Read the `IssueRef` a legacy GitHub issue carries, or derive one. */
export function readGitHubIssueRef(issue: LaneGitHubIssue): IssueRef {
  return parseIssueRefValue((issue as Record<string, unknown>)[ISSUE_REF_KEY])
    ?? issueRefFromGitHubIssue(issue);
}

const LINEAR_PRIORITY_LABELS = new Set<LinearPriorityLabel>([
  "urgent",
  "high",
  "normal",
  "low",
  "none",
]);

function linearPriorityLabel(value: string | null | undefined): LinearPriorityLabel {
  return value && LINEAR_PRIORITY_LABELS.has(value as LinearPriorityLabel)
    ? value as LinearPriorityLabel
    : "none";
}

/**
 * Project an `IssueRef` down to the legacy Linear shape.
 *
 * This is what keeps a peer on an older build working. That peer parses
 * `issue_json` with `parseLaneLinearIssueValue`, which drops the `__issueRef`
 * key and REQUIRES ten non-empty fields. So every write fills all ten, even for
 * a tracker that has no such concept. A Jira link then renders on an old peer
 * with the right key, title, URL and state name, under a Linear-labelled badge.
 * That is a mislabel, not a break, and it is the price of never altering a
 * replicated table.
 */
export function issueRefToLinearIssue(ref: IssueRef): LaneLinearIssue {
  const containerKey = ref.container?.key?.trim() || ref.provider.toUpperCase();
  const stamp = ref.updatedAt || ref.createdAt || new Date().toISOString();
  const extra = ref.extra ?? {};
  return {
    id: ref.issueId,
    identifier: ref.key,
    title: ref.title,
    description: ref.description ?? null,
    url: ref.url ?? null,
    projectId: readString(extra.projectId) ?? "",
    projectSlug: readString(extra.projectSlug) ?? "",
    projectName: readNullableString(extra.projectName),
    teamId: ref.container?.id?.trim() || containerKey,
    teamKey: containerKey,
    teamName: ref.container?.name ?? null,
    stateId: ref.state?.id?.trim() || ref.state?.category || "unstarted",
    stateName: ref.state?.name?.trim() || ref.state?.category || "unstarted",
    stateType: ref.state?.category ?? "unstarted",
    priority: ref.priority?.rank ?? 0,
    priorityLabel: linearPriorityLabel(ref.priority?.label ?? null),
    labels: ref.labels ?? [],
    assigneeId: ref.assignee?.id ?? null,
    assigneeName: ref.assignee?.name ?? null,
    creatorId: readNullableString(extra.creatorId),
    creatorName: readNullableString(extra.creatorName),
    dueDate: readNullableString(extra.dueDate),
    estimate: readNumber(extra.estimate),
    branchName: ref.branchName ?? null,
    createdAt: ref.createdAt || stamp,
    updatedAt: ref.updatedAt || stamp,
  };
}

/**
 * Write `ref` into a legacy Linear issue object under the reserved key, and
 * keep every legacy field filled so an old peer still parses the row.
 */
export function embedIssueRef<T extends object>(issue: T, ref: IssueRef): T {
  return { ...issue, [ISSUE_REF_KEY]: ref };
}

/**
 * Build the row a writer stores for `ref`: the legacy projection with the ref
 * embedded.
 */
export function issueRefToStoredLinearIssue(ref: IssueRef): LaneLinearIssue {
  return embedIssueRef(issueRefToLinearIssue(ref), ref);
}

/**
 * The value a writer puts in the `issue_id` COLUMN.
 *
 * The app-layer uniqueness tuple is `(project_id, lane_id, issue_id, role)`, so
 * two trackers that happen to mint the same id must not collide. A Linear ref
 * keeps the bare id, which leaves every existing row and every older peer
 * untouched. Any other tracker is namespaced.
 */
export function issueRefRowKey(ref: IssueRef): string {
  return ref.provider === ISSUE_PROVIDER_LINEAR ? ref.issueId : `${ref.provider}:${ref.issueId}`;
}

/** True when `ref` carries enough to link, display and reference in a PR. */
export function isLinkableIssueRef(ref: IssueRef): boolean {
  return Boolean(ref.provider.trim() && ref.issueId.trim() && ref.key.trim() && ref.title.trim());
}

/** True when `pluginId` may unlink `ref`. A plugin owns only what it created. */
export function canPluginUnlinkIssueRef(ref: IssueRef, pluginId: string): boolean {
  return ref.pluginId === pluginId;
}

/**
 * Identify a ref across providers. Two refs match when they name the same issue
 * on the same tracker.
 */
export function issueRefIdentity(ref: IssueRef): string {
  return `${ref.provider}:${ref.issueId || ref.key.toUpperCase()}`;
}

export function issueRefsMatch(a: IssueRef, b: IssueRef): boolean {
  return issueRefIdentity(a) === issueRefIdentity(b);
}
