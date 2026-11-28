// Linear's own display settings (view preferences), the rail's extra lists
// (cycles, initiatives, favorites, documents), one document, and the exact
// branch -> issue lookup. Response shapes are typed from @linear/sdk's
// generated GraphQL types (`import type`: erased at build, so the CJS main
// and CLI bundles never load the ESM-only SDK).

import type { LinearDocument as L } from "@linear/sdk";
import type { Logger } from "../logging/logger";
import type {
  CtoLinearCycle,
  CtoLinearDocument,
  CtoLinearFavorite,
  CtoLinearInitiative,
  CtoLinearRailData,
  CtoUpdateLinearViewPreferencesArgs,
  LinearDisplayPreferences,
  LinearIssueDisplayFields,
  LinearIssueGrouping,
  LinearIssueNesting,
  LinearIssueOrdering,
  LinearIssueViewType,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { LINEAR_ORDERING_NATURAL_DIRECTION } from "../../../shared/linearIssueNormalize";
import { asArray, getErrorMessage, isRecord, toOptionalString as asString } from "../shared/utils";
import { ISSUE_FIELDS_FRAGMENT, type LinearRequest, normalizeIssueNodes } from "./linearClientShared";

/** An SDK type as it arrives over the wire: DateTime scalars are ISO strings, not Dates. */
type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null | undefined ? string | null | undefined : T[K] };

/**
 * The ViewPreferencesValues keys an issue view uses. ADE reads them all so a
 * write-back (Linear replaces the stored JSON on update) keeps the person's
 * other issue settings. `satisfies` fails the typecheck if Linear drops one.
 */
const ISSUE_VIEW_PREFERENCE_KEYS = [
  "closedIssuesOrderedByRecency", "columnOrderBoard", "columnOrderList",
  "fieldAssignee", "fieldCustomerCount", "fieldCustomerRevenue", "fieldCycle", "fieldDateArchived",
  "fieldDateCreated", "fieldDateMyActivity", "fieldDateUpdated", "fieldDueDate", "fieldEstimate", "fieldId",
  "fieldLabels", "fieldLinkCount", "fieldMilestone", "fieldPreviewLinks", "fieldPriority", "fieldProject",
  "fieldPullRequests", "fieldRelease", "fieldSentryIssues", "fieldSla", "fieldStatus", "fieldTimeInCurrentStatus",
  "fieldUserPresence", "groupOrderingMode", "hiddenColumns", "hiddenGroupsList", "hiddenRows",
  "issueGrouping", "issueGroupingLabelGroupId", "issueNesting", "issueSubGrouping", "issueSubGroupingLabelGroupId",
  "layout", "showArchivedItems", "showCompletedIssues", "showEmptyGroups", "showEmptyGroupsBoard",
  "showEmptyGroupsList", "showEmptySubGroups", "showEmptySubGroupsBoard", "showEmptySubGroupsList", "showParents",
  "showSubIssues", "showSubTeamIssues", "showSupervisedIssues", "showTriageIssues", "viewOrdering",
  "viewOrderingDirection",
] as const satisfies ReadonlyArray<keyof L.ViewPreferencesValues>;

type IssueViewPreferenceKey = (typeof ISSUE_VIEW_PREFERENCE_KEYS)[number];
/** The stored issue-view values (only keys Linear had set). */
export type LinearIssueViewValues = Partial<Pick<L.ViewPreferencesValues, IssueViewPreferenceKey>>;

const PREFERENCE_FIELDS = ISSUE_VIEW_PREFERENCE_KEYS.join(" ");

const GROUPINGS: ReadonlySet<LinearIssueGrouping> = new Set([
  "workflowState", "assignee", "project", "priority", "cycle", "label", "projectMilestone", "team", "none",
]);
const NESTINGS: ReadonlySet<LinearIssueNesting> = new Set(["none", "showAll", "showMatching"]);

/** ADE ordering <-> Linear `viewOrdering` (Linear calls the dates dateCreated / dateUpdated). */
const ORDERING_TO_LINEAR: Readonly<Record<LinearIssueOrdering, string>> = {
  manual: "manual",
  priority: "priority",
  updatedAt: "dateUpdated",
  createdAt: "dateCreated",
  dueDate: "dueDate",
  estimate: "estimate",
  title: "title",
};
const ORDERING_FROM_LINEAR = new Map<string, LinearIssueOrdering>(
  Object.entries(ORDERING_TO_LINEAR).map(([ade, linear]) => [linear, ade as LinearIssueOrdering]),
);

/** ADE display field <-> Linear `field*` key. `adeStatus` is ADE-only and never sent. */
const FIELD_KEYS: Readonly<Record<Exclude<keyof LinearIssueDisplayFields, "adeStatus">, IssueViewPreferenceKey>> = {
  id: "fieldId",
  status: "fieldStatus",
  priority: "fieldPriority",
  assignee: "fieldAssignee",
  labels: "fieldLabels",
  project: "fieldProject",
  cycle: "fieldCycle",
  milestone: "fieldMilestone",
  estimate: "fieldEstimate",
  dueDate: "fieldDueDate",
  pullRequests: "fieldPullRequests",
  createdAt: "fieldDateCreated",
  updatedAt: "fieldDateUpdated",
};

/**
 * Linear's defaults when nothing is saved: group by status, nesting on, manual
 * order, and Linear's own quiet default row (no updated date, estimate, cycle
 * or milestone).
 */
export function defaultLinearDisplayPreferences(): LinearDisplayPreferences {
  return {
    grouping: "workflowState",
    subGrouping: "none",
    ordering: "manual",
    orderingDirection: "asc",
    nesting: "showAll",
    showEmptyGroups: false,
    showCompletedIssues: true,
    hiddenGroups: [],
    fields: {
      id: true,
      status: true,
      priority: true,
      assignee: true,
      labels: true,
      project: true,
      cycle: false,
      milestone: false,
      estimate: false,
      dueDate: true,
      pullRequests: true,
      createdAt: true,
      updatedAt: false,
      adeStatus: true,
    },
    source: "default",
  };
}

/** Only the keys Linear actually set (null means unset, so the default shows). */
function storedValues(raw: unknown): LinearIssueViewValues {
  if (!isRecord(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ISSUE_VIEW_PREFERENCE_KEYS) {
    const value = raw[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as LinearIssueViewValues;
}

/** Linear values -> ADE display settings. Unknown strings fall back to Linear's defaults. */
export function linearDisplayPreferencesFromValues(
  values: LinearIssueViewValues,
  source: LinearDisplayPreferences["source"],
): LinearDisplayPreferences {
  const defaults = defaultLinearDisplayPreferences();
  const grouping = values.issueGrouping && GROUPINGS.has(values.issueGrouping as LinearIssueGrouping)
    ? values.issueGrouping as LinearIssueGrouping
    : defaults.grouping;
  const subGrouping = values.issueSubGrouping && GROUPINGS.has(values.issueSubGrouping as LinearIssueGrouping)
    ? values.issueSubGrouping as LinearIssueGrouping
    : "none";
  const ordering = (values.viewOrdering && ORDERING_FROM_LINEAR.get(values.viewOrdering)) || defaults.ordering;
  const orderingDirection = values.viewOrderingDirection === "asc" || values.viewOrderingDirection === "desc"
    ? values.viewOrderingDirection
    : LINEAR_ORDERING_NATURAL_DIRECTION[ordering];
  const nesting = values.issueNesting && NESTINGS.has(values.issueNesting as LinearIssueNesting)
    ? values.issueNesting as LinearIssueNesting
    : defaults.nesting;
  const fields = { ...defaults.fields };
  for (const [adeKey, linearKey] of Object.entries(FIELD_KEYS) as Array<[keyof typeof FIELD_KEYS, IssueViewPreferenceKey]>) {
    const value = values[linearKey];
    if (typeof value === "boolean") fields[adeKey] = value;
  }
  const showEmpty = values.showEmptyGroupsList ?? values.showEmptyGroups;
  return {
    grouping,
    subGrouping,
    ordering,
    orderingDirection,
    nesting,
    showEmptyGroups: typeof showEmpty === "boolean" ? showEmpty : defaults.showEmptyGroups,
    // Linear stores all | none | day | week | month | currentCycle.
    showCompletedIssues: typeof values.showCompletedIssues === "string" ? values.showCompletedIssues !== "none" : true,
    hiddenGroups: Array.isArray(values.hiddenGroupsList) ? values.hiddenGroupsList.filter((entry): entry is string => typeof entry === "string") : [],
    fields,
    source,
  };
}

/**
 * The stored values with an ADE patch applied: only the keys ADE understands
 * change, every other stored key is kept (Linear replaces the JSON on update).
 */
export function mergeLinearViewValues(
  stored: LinearIssueViewValues,
  patch: CtoUpdateLinearViewPreferencesArgs["patch"],
): LinearIssueViewValues {
  const next: Record<string, unknown> = { ...stored };
  if (patch.grouping && GROUPINGS.has(patch.grouping)) next.issueGrouping = patch.grouping;
  if (patch.subGrouping && GROUPINGS.has(patch.subGrouping)) next.issueSubGrouping = patch.subGrouping;
  if (patch.ordering && ORDERING_TO_LINEAR[patch.ordering]) next.viewOrdering = ORDERING_TO_LINEAR[patch.ordering];
  if (patch.orderingDirection === "asc" || patch.orderingDirection === "desc") next.viewOrderingDirection = patch.orderingDirection;
  if (patch.nesting && NESTINGS.has(patch.nesting)) next.issueNesting = patch.nesting;
  if (typeof patch.showEmptyGroups === "boolean") next.showEmptyGroupsList = patch.showEmptyGroups;
  if (typeof patch.showCompletedIssues === "boolean") {
    const current = typeof stored.showCompletedIssues === "string" ? stored.showCompletedIssues : null;
    // Turning it back on keeps a stored window (week, month) when there was one.
    next.showCompletedIssues = patch.showCompletedIssues ? (current && current !== "none" ? current : "all") : "none";
  }
  if (Array.isArray(patch.hiddenGroups)) next.hiddenGroupsList = patch.hiddenGroups.filter((entry) => typeof entry === "string");
  for (const [adeKey, value] of Object.entries(patch.fields ?? {})) {
    if (adeKey === "adeStatus" || typeof value !== "boolean") continue;
    const linearKey = FIELD_KEYS[adeKey as keyof typeof FIELD_KEYS];
    if (linearKey) next[linearKey] = value;
  }
  return next as LinearIssueViewValues;
}

/** What ADE read for one view: the settings, and the Linear record a write updates. */
export type LinearViewPreferencesRead = {
  preferences: LinearDisplayPreferences;
  /** The person's own Linear record for this view (updated in place), or null. */
  recordId: string | null;
  /** The record's stored values (the base of a write-back). */
  stored: LinearIssueViewValues;
};

type ViewPreferencesNode = { id: string; preferences: LinearIssueViewValues | null } | null;

/** A Linear refusal, in words a person can read. */
function refusalReason(error: unknown): string {
  const message = getErrorMessage(error);
  if (/invalid combination/i.test(message)) {
    return "Linear keeps this tab's display settings per team, so ADE kept the change here only.";
  }
  if (/scope|permission|forbidden|not authorized/i.test(message)) {
    return "Linear's connection doesn't allow saving display settings, so ADE kept the change here only.";
  }
  return `Linear didn't save the change (${message}), so ADE kept it here only.`;
}

export function createLinearViewData(args: { request: LinearRequest; logger?: Logger | null }) {
  const { request } = args;

  const readViewPreferences = async (params: {
    viewType: LinearIssueViewType;
    customViewId?: string | null;
  }): Promise<LinearViewPreferencesRead> => {
    const customViewId = params.customViewId?.trim() || null;
    if (customViewId) {
      const data = await request<{
        customView?: {
          id: string;
          userViewPreferences?: ViewPreferencesNode;
          viewPreferencesValues?: LinearIssueViewValues | null;
        } | null;
      }>({
        query: `
          query AdeLinearCustomViewPreferences($id: String!) {
            customView(id: $id) {
              id
              userViewPreferences { id preferences { ${PREFERENCE_FIELDS} } }
              viewPreferencesValues { ${PREFERENCE_FIELDS} }
            }
          }
        `,
        variables: { id: customViewId },
        maxRetries: 1,
      });
      const own = data.customView?.userViewPreferences ?? null;
      const ownValues = storedValues(own?.preferences);
      if (own && Object.keys(ownValues).length > 0) {
        return { preferences: linearDisplayPreferencesFromValues(ownValues, "linear-view"), recordId: own.id, stored: ownValues };
      }
      const viewValues = storedValues(data.customView?.viewPreferencesValues);
      if (Object.keys(viewValues).length > 0) {
        return { preferences: linearDisplayPreferencesFromValues(viewValues, "linear-view"), recordId: own?.id ?? null, stored: viewValues };
      }
      // A view with no display of its own shows like its tab.
    }
    const data = await request<{ userViewPreferences?: ViewPreferencesNode }>({
      query: `
        query AdeLinearViewPreferences($viewType: ViewType!) {
          userViewPreferences(viewType: $viewType) { id preferences { ${PREFERENCE_FIELDS} } }
        }
      `,
      variables: { viewType: params.viewType },
      maxRetries: 1,
    });
    const record = data.userViewPreferences ?? null;
    const values = storedValues(record?.preferences);
    if (record && Object.keys(values).length > 0) {
      return {
        preferences: linearDisplayPreferencesFromValues(values, "linear-user"),
        // A custom view's write goes to its own record, never the tab's.
        recordId: customViewId ? null : record.id,
        stored: customViewId ? {} : values,
      };
    }
    return { preferences: defaultLinearDisplayPreferences(), recordId: customViewId ? null : record?.id ?? null, stored: {} };
  };

  /** Saves values to Linear: updates the person's record or creates one. Throws a readable reason. */
  const writeViewPreferences = async (params: {
    viewType: LinearIssueViewType;
    customViewId?: string | null;
    recordId: string | null;
    values: LinearIssueViewValues;
  }): Promise<{ recordId: string }> => {
    type Payload = { success: boolean; viewPreferences?: { id: string } | null };
    try {
      if (params.recordId) {
        const data = await request<{ viewPreferencesUpdate?: Payload }>({
          query: `
            mutation AdeLinearViewPreferencesUpdate($id: String!, $input: ViewPreferencesUpdateInput!) {
              viewPreferencesUpdate(id: $id, input: $input) { success viewPreferences { id } }
            }
          `,
          variables: { id: params.recordId, input: { preferences: params.values } satisfies Partial<L.ViewPreferencesUpdateInput> },
          maxRetries: 1,
        });
        if (!data.viewPreferencesUpdate?.success) throw new Error("Linear did not confirm the change");
        return { recordId: data.viewPreferencesUpdate.viewPreferences?.id ?? params.recordId };
      }
      const customViewId = params.customViewId?.trim() || null;
      const data = await request<{ viewPreferencesCreate?: Payload }>({
        query: `
          mutation AdeLinearViewPreferencesCreate($input: ViewPreferencesCreateInput!) {
            viewPreferencesCreate(input: $input) { success viewPreferences { id } }
          }
        `,
        variables: {
          input: {
            type: "user",
            viewType: customViewId ? "customView" : params.viewType,
            ...(customViewId ? { customViewId } : {}),
            preferences: params.values,
          },
        },
        maxRetries: 1,
      });
      const id = data.viewPreferencesCreate?.viewPreferences?.id;
      if (!data.viewPreferencesCreate?.success || !id) throw new Error("Linear did not confirm the change");
      return { recordId: id };
    } catch (error) {
      args.logger?.warn("linear.view_preferences_write_failed", { viewType: params.viewType, error: getErrorMessage(error) });
      throw new Error(refusalReason(error));
    }
  };

  type CycleNode = Wire<Pick<L.Cycle, "id" | "number" | "name" | "startsAt" | "endsAt" | "progress" | "isActive" | "isNext" | "isPrevious" | "issueCountHistory">>;
  type InitiativeNode = Wire<Pick<L.Initiative, "id" | "name" | "icon" | "color" | "targetDate" | "url">> & {
    status?: string | null;
    projects?: { nodes?: Array<{ id: string }> } | null;
  };
  // title / icon / color are served by the API (checked) but missing from the SDK type.
  type FavoriteNode = Wire<Pick<L.Favorite, "id" | "type" | "sortOrder" | "url" | "folderName">> & {
    title?: string | null;
    icon?: string | null;
    color?: string | null;
  } & Partial<
    Record<"issue" | "project" | "customView" | "cycle" | "label" | "projectLabel" | "initiative" | "document", { id: string } | null>
  >;
  type DocumentNode = Wire<Pick<L.Document, "id" | "title" | "icon" | "color" | "url" | "updatedAt">> & {
    content?: string | null;
    project?: { name?: string | null } | null;
  };
  type RailData = {
    viewer?: { teams?: { nodes?: Array<{ id: string; key: string; cycles?: { nodes?: CycleNode[] } | null }> } | null } | null;
    initiatives?: { nodes?: InitiativeNode[] } | null;
    favorites?: { nodes?: FavoriteNode[] } | null;
    documents?: { nodes?: DocumentNode[] } | null;
  };

  const RAIL_SECTIONS = {
    cycles: `viewer { teams(first: 50, filter: $teamFilter) { nodes { id key cycles(first: 3, filter: { or: [{ isActive: { eq: true } }, { isNext: { eq: true } }, { isPrevious: { eq: true } }] }) { nodes { id number name startsAt endsAt progress isActive isNext isPrevious issueCountHistory } } } } }`,
    initiatives: `initiatives(first: 20, filter: { status: { neq: "Completed" } }) { nodes { id name icon color status targetDate url projects(first: 50) { nodes { id } } } }`,
    favorites: `favorites(first: 50) { nodes { id type title sortOrder url icon color folderName issue { id } project { id } customView { id } cycle { id } label { id } projectLabel { id } initiative { id } document { id } } }`,
    documents: `documents(first: 20, orderBy: updatedAt) { nodes { id title icon color url updatedAt project { name } } }`,
  } as const;
  type RailSection = keyof typeof RAIL_SECTIONS;

  const railQuery = (sections: RailSection[]) => {
    const usesTeams = sections.includes("cycles");
    return `query AdeLinearRail${usesTeams ? "($teamFilter: TeamFilter)" : ""} { ${sections.map((section) => RAIL_SECTIONS[section]).join("\n")} }`;
  };

  const mapCycles = (data: RailData): CtoLinearCycle[] => {
    const out: CtoLinearCycle[] = [];
    for (const team of asArray(data.viewer?.teams?.nodes)) {
      if (!isRecord(team)) continue;
      const teamId = asString(team.id);
      const teamKey = asString(team.key);
      if (!teamId || !teamKey) continue;
      const cycles = asArray(isRecord(team.cycles) ? team.cycles.nodes : []).filter(isRecord) as CycleNode[];
      const rank = (cycle: CycleNode) => (cycle.isActive ? 0 : cycle.isNext ? 1 : 2);
      for (const cycle of [...cycles].sort((a, b) => rank(a) - rank(b))) {
        const id = asString(cycle.id);
        const startsAt = asString(cycle.startsAt);
        const endsAt = asString(cycle.endsAt);
        if (!id || !startsAt || !endsAt || typeof cycle.number !== "number") continue;
        const history = Array.isArray(cycle.issueCountHistory) ? cycle.issueCountHistory : [];
        const last = history.length > 0 ? Number(history[history.length - 1]) : Number.NaN;
        out.push({
          id,
          number: cycle.number,
          name: asString(cycle.name),
          teamId,
          teamKey,
          startsAt,
          endsAt,
          isActive: cycle.isActive === true,
          isNext: cycle.isNext === true,
          isPrevious: cycle.isPrevious === true,
          progress: typeof cycle.progress === "number" && Number.isFinite(cycle.progress) ? cycle.progress : null,
          issueCount: Number.isFinite(last) ? last : null,
        });
      }
    }
    return out;
  };

  const mapInitiatives = (data: RailData): CtoLinearInitiative[] =>
    asArray(data.initiatives?.nodes).filter(isRecord).flatMap((node) => {
      const id = asString(node.id);
      const name = asString(node.name);
      if (!id || !name) return [];
      return [{
        id,
        name,
        icon: asString(node.icon),
        color: asString(node.color),
        status: asString(node.status),
        targetDate: asString(node.targetDate),
        url: asString(node.url),
        projectCount: asArray(isRecord(node.projects) ? node.projects.nodes : []).length,
      }];
    });

  const FAVORITE_TARGETS = ["issue", "project", "customView", "cycle", "label", "projectLabel", "initiative", "document"] as const;
  const mapFavorites = (data: RailData): CtoLinearFavorite[] =>
    (asArray(data.favorites?.nodes).filter(isRecord) as FavoriteNode[])
      // Folders are containers; their members come as their own favorites.
      .filter((node) => node.type !== "folder")
      .flatMap((node) => {
        const id = asString(node.id);
        const type = asString(node.type);
        if (!id || !type) return [];
        const target = FAVORITE_TARGETS.map((key) => node[key]).find((entry) => isRecord(entry) && asString(entry.id));
        return [{
          id,
          type,
          title: asString(node.title) ?? asString(node.folderName) ?? type,
          targetId: target ? asString(target.id) : null,
          url: asString(node.url),
          icon: asString(node.icon),
          color: asString(node.color),
          sortOrder: typeof node.sortOrder === "number" && Number.isFinite(node.sortOrder) ? node.sortOrder : 0,
        }];
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);

  const mapDocument = (node: unknown, withContent: boolean): CtoLinearDocument | null => {
    if (!isRecord(node)) return null;
    const id = asString(node.id);
    const updatedAt = asString(node.updatedAt);
    if (!id || !updatedAt) return null;
    const project = isRecord(node.project) ? node.project : null;
    return {
      id,
      title: asString(node.title) ?? "Untitled document",
      icon: asString(node.icon),
      color: asString(node.color),
      url: asString(node.url),
      projectName: project ? asString(project.name) : null,
      updatedAt,
      ...(withContent ? { content: typeof node.content === "string" ? node.content : null } : {}),
    };
  };

  /**
   * One request for every section. A section Linear refuses (a partial
   * GraphQL error, a missing scope) comes back empty; when the whole document
   * is rejected, each section is asked alone so one bad section cannot blank
   * the rest.
   */
  const getRailData = async (params: { teamKey?: string | null } = {}): Promise<CtoLinearRailData> => {
    const teamKey = params.teamKey?.trim() || null;
    const variables = { teamFilter: teamKey ? { key: { eq: teamKey } } : null };
    const failed = new Set<RailSection>();
    const sections = Object.keys(RAIL_SECTIONS) as RailSection[];
    const sectionOfPath = (path: Array<string | number> | undefined): RailSection | null => {
      const head = path?.[0];
      if (head === "viewer") return "cycles";
      return typeof head === "string" && head in RAIL_SECTIONS ? head as RailSection : null;
    };
    let data: RailData;
    try {
      data = await request<RailData>({
        query: railQuery(sections),
        variables,
        maxRetries: 1,
        onPartialErrors: (errors) => {
          for (const error of errors) {
            const section = sectionOfPath(error.path);
            if (section) failed.add(section);
          }
          args.logger?.warn("linear.rail_partial", { sections: [...failed], error: errors[0]?.message ?? null });
        },
      });
    } catch (error) {
      args.logger?.warn("linear.rail_failed", { error: getErrorMessage(error) });
      const parts = await Promise.all(sections.map(async (section) => {
        try {
          return await request<RailData>({
            query: railQuery([section]),
            variables: section === "cycles" ? variables : {},
            maxRetries: 0,
            onPartialErrors: () => failed.add(section),
          });
        } catch {
          failed.add(section);
          return {} as RailData;
        }
      }));
      data = Object.assign({}, ...parts) as RailData;
    }
    const safe = <T,>(section: RailSection, map: () => T[]): T[] => {
      if (failed.has(section)) return [];
      try {
        return map();
      } catch {
        return [];
      }
    };
    return {
      cycles: safe("cycles", () => mapCycles(data)),
      initiatives: safe("initiatives", () => mapInitiatives(data)),
      favorites: safe("favorites", () => mapFavorites(data)),
      documents: safe("documents", () => asArray(data.documents?.nodes).map((node) => mapDocument(node, false)).filter((doc): doc is CtoLinearDocument => doc != null)),
    };
  };

  const getDocument = async (documentId: string): Promise<CtoLinearDocument | null> => {
    const id = documentId.trim();
    if (!id) return null;
    try {
      const data = await request<{ document?: DocumentNode | null }>({
        query: `
          query AdeLinearDocument($id: String!) {
            document(id: $id) { id title icon color url updatedAt content project { name } }
          }
        `,
        variables: { id },
        maxRetries: 1,
      });
      return mapDocument(data.document, true);
    } catch (error) {
      if (/entity not found|not found/i.test(getErrorMessage(error))) return null;
      throw error;
    }
  };

  /** Linear's exact branch -> issue match (`issueVcsBranchSearch`), null when no issue owns the branch. */
  const findIssueByBranch = async (branch: string): Promise<NormalizedLinearIssue | null> => {
    const branchName = branch.trim().replace(/^refs\/heads\//, "");
    if (!branchName) return null;
    const data = await request<{ issueVcsBranchSearch?: Record<string, unknown> | null }>({
      query: `
        query AdeLinearIssueByBranch($branchName: String!) {
          issueVcsBranchSearch(branchName: $branchName) {
            ${ISSUE_FIELDS_FRAGMENT}
          }
        }
      `,
      variables: { branchName },
      maxRetries: 1,
    });
    return normalizeIssueNodes(data.issueVcsBranchSearch ? [data.issueVcsBranchSearch] : [])[0] ?? null;
  };

  return {
    readViewPreferences,
    writeViewPreferences,
    getRailData,
    getDocument,
    findIssueByBranch,
  };
}

export type LinearViewData = ReturnType<typeof createLinearViewData>;
