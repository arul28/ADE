import type { CtoSearchLinearIssuesArgs, LinearIssueViewType } from "../../../../shared/types";
import type { LinearIssuePrefill } from "../../../lib/issueCreateRequests";

/**
 * The Linear window's left-rail entry, as one value. Stored and passed around
 * as a string (`all`, `mine`, `ready`, `inbox`, `cycle` for the active cycle,
 * or `<kind>:<id>`), parsed here once so nothing else matches on prefixes.
 */
export type LinearScope =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "ready" }
  | { kind: "inbox" }
  /** Each team's active cycle ("Current cycle"). */
  | { kind: "activeCycle" }
  | { kind: "view"; id: string }
  | { kind: "cycle"; id: string }
  | { kind: "initiative"; id: string }
  | { kind: "label"; id: string }
  | { kind: "project"; id: string }
  | { kind: "document"; id: string };

type LinearEntityScopeKind = Extract<LinearScope, { id: string }>["kind"];

export const LINEAR_SCOPE_ALL = "all";
export const LINEAR_SCOPE_MINE = "mine";
export const LINEAR_SCOPE_READY = "ready";
export const LINEAR_SCOPE_INBOX = "inbox";
export const LINEAR_SCOPE_ACTIVE_CYCLE = "cycle";

export const LINEAR_SCOPE_PREFIX: Readonly<Record<LinearEntityScopeKind, string>> = Object.freeze({
  view: "view:",
  cycle: "cycle:",
  initiative: "initiative:",
  label: "label:",
  project: "project:",
  document: "document:",
});

const SIMPLE_SCOPES: Readonly<Record<string, LinearScope>> = Object.freeze({
  [LINEAR_SCOPE_ALL]: { kind: "all" },
  [LINEAR_SCOPE_MINE]: { kind: "mine" },
  [LINEAR_SCOPE_READY]: { kind: "ready" },
  [LINEAR_SCOPE_INBOX]: { kind: "inbox" },
  [LINEAR_SCOPE_ACTIVE_CYCLE]: { kind: "activeCycle" },
});

const ENTITY_KINDS = Object.keys(LINEAR_SCOPE_PREFIX) as LinearEntityScopeKind[];

/** Ready = not started yet; open blockers are removed in the pane. */
export const READY_STATE_TYPES = ["unstarted", "backlog"];

/** Unknown or empty-id strings read as "all". */
export function parseLinearScope(value: string | null | undefined): LinearScope {
  const raw = value ?? "";
  if (Object.hasOwn(SIMPLE_SCOPES, raw)) return SIMPLE_SCOPES[raw]!;
  for (const kind of ENTITY_KINDS) {
    const prefix = LINEAR_SCOPE_PREFIX[kind];
    if (raw.startsWith(prefix) && raw.length > prefix.length) return { kind, id: raw.slice(prefix.length) };
  }
  return { kind: "all" };
}

export function linearScopeKey(scope: LinearScope): string {
  switch (scope.kind) {
    case "all": return LINEAR_SCOPE_ALL;
    case "mine": return LINEAR_SCOPE_MINE;
    case "ready": return LINEAR_SCOPE_READY;
    case "inbox": return LINEAR_SCOPE_INBOX;
    case "activeCycle": return LINEAR_SCOPE_ACTIVE_CYCLE;
    default: return `${LINEAR_SCOPE_PREFIX[scope.kind]}${scope.id}`;
  }
}

type LinearScopeSearchArgs = Pick<
  CtoSearchLinearIssuesArgs,
  "projectId" | "assignedToViewer" | "activeCycle" | "customViewId" | "stateTypes" | "cycleId" | "initiativeId" | "labelId"
>;

/** The search filter a scope adds. Documents and the inbox add none (they are not issue lists). */
export function linearScopeSearchArgs(scope: LinearScope): LinearScopeSearchArgs {
  switch (scope.kind) {
    case "ready": return { stateTypes: READY_STATE_TYPES };
    case "mine": return { assignedToViewer: true };
    case "activeCycle": return { activeCycle: true };
    case "view": return { customViewId: scope.id };
    case "cycle": return { cycleId: scope.id };
    case "initiative": return { initiativeId: scope.id };
    case "label": return { labelId: scope.id };
    case "project": return { projectId: scope.id };
    default: return {};
  }
}

/** Linear's view type whose display settings this scope (and state tab) uses. */
export function linearScopeViewType(scope: LinearScope, statePreset: string): LinearIssueViewType {
  if (scope.kind === "project") return "project";
  if (scope.kind === "mine") return "myIssues";
  if (scope.kind === "activeCycle" || scope.kind === "cycle") return "cycle";
  if (statePreset === "active") return "activeIssues";
  if (statePreset === "backlog") return "backlog";
  return "allIssues";
}

/** What a scope fills in on a new issue (a group's "+"): its project, cycle, label or "mine". */
export function linearScopePrefill(
  scope: LinearScope,
  viewerId: string | null,
): Pick<LinearIssuePrefill, "projectId" | "cycleId" | "labelIds" | "assigneeId"> {
  switch (scope.kind) {
    case "project": return { projectId: scope.id };
    case "cycle": return { cycleId: scope.id };
    case "label": return { labelIds: [scope.id] };
    case "mine": return viewerId ? { assigneeId: viewerId } : {};
    default: return {};
  }
}

/** The breadcrumb's name for a scope; `nameOf` looks the entity up where it is known. */
export function linearScopeTitle(scope: LinearScope, nameOf: (kind: LinearEntityScopeKind, id: string) => string | null | undefined): string {
  switch (scope.kind) {
    case "all": return "Issues";
    case "mine": return "My issues";
    case "ready": return "Ready";
    case "inbox": return "Inbox";
    case "activeCycle": return "Current cycle";
    case "project": return nameOf("project", scope.id) || "Project";
    case "view": return nameOf("view", scope.id) || "View";
    case "label": return nameOf("label", scope.id) || "Label";
    case "cycle": return nameOf("cycle", scope.id) || "Cycle";
    case "initiative": return nameOf("initiative", scope.id) || "Initiative";
    case "document": return nameOf("document", scope.id) || "Document";
  }
}
