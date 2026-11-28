import type { IssueTracker } from "./issueTracker";
import { parseLinearIssueCreateInput } from "../../../shared/linearIssueCreateInput";
import type {
  CtoGetLinearViewPreferencesArgs,
  CtoLinearRailData,
  CtoUpdateLinearViewPreferencesArgs,
  CtoUpdateLinearViewPreferencesResult,
  LinearDisplayPreferences,
  LinearIssueViewType,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { LinearClient } from "./linearClient";
import { getErrorMessage, isRecord } from "../shared/utils";
import { budgetIsLow, OPEN_ISSUE_STATE_TYPES } from "./linearClientShared";
import {
  defaultLinearDisplayPreferences,
  linearDisplayPreferencesFromValues,
  mergeLinearViewValues,
  type LinearViewPreferencesRead,
} from "./linearViewData";

/** The project's key-value store (the ADE-only `adeStatus` column choice lives here). */
export type LinearDisplayStore = {
  getJson: <T = unknown>(key: string) => T | null;
  setJson: (key: string, value: unknown) => void;
};

type ViewPreferencesPatch = CtoUpdateLinearViewPreferencesArgs["patch"];

const VIEW_TYPES: ReadonlySet<LinearIssueViewType> = new Set(["allIssues", "activeIssues", "backlog", "myIssues", "cycle", "project"]);
const VIEW_PREFERENCES_TTL_MS = 60_000;
const RAIL_TTL_MS = 60_000;
const BRANCH_LOOKUP_TTL_MS = 5 * 60_000;
const BRANCH_CACHE_MAX = 200;
const ADE_STATUS_KEY = "linear:display:ade-status:v1";
/** Display changes Linear would not store, per view: kept in the project database across reloads. */
const ADE_PREFERENCES_KEY = "linear:display:ade-preferences:v1";

function viewTypeOf(value: unknown): LinearIssueViewType {
  return typeof value === "string" && VIEW_TYPES.has(value as LinearIssueViewType) ? value as LinearIssueViewType : "allIssues";
}

function viewKey(args: { viewType: LinearIssueViewType; customViewId?: string | null }): string {
  return `${args.viewType}|${args.customViewId?.trim() ?? ""}`;
}

/** Two patches as one: the later wins key by key, display fields merge. */
function mergePatches(left: ViewPreferencesPatch, right: ViewPreferencesPatch): ViewPreferencesPatch {
  return { ...left, ...right, ...(left.fields || right.fields ? { fields: { ...left.fields, ...right.fields } } : {}) };
}

function applyPatch(preferences: LinearDisplayPreferences, patch: ViewPreferencesPatch): LinearDisplayPreferences {
  const { fields, ...rest } = patch;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  return { ...preferences, ...clean, fields: { ...preferences.fields, ...(fields ?? {}) } } as LinearDisplayPreferences;
}

function withoutAdeStatus(patch: ViewPreferencesPatch): ViewPreferencesPatch {
  if (!patch.fields || !("adeStatus" in patch.fields)) return patch;
  const { adeStatus: _ade, ...fields } = patch.fields;
  return { ...patch, fields };
}

function patchTouchesLinear(patch: ViewPreferencesPatch): boolean {
  const { fields, ...rest } = withoutAdeStatus(patch);
  return Object.values(rest).some((value) => value !== undefined) || Object.keys(fields ?? {}).length > 0;
}

/** The patch as sent over IPC or sync, keeping only known keys of the right type. */
function parsePatch(value: unknown): ViewPreferencesPatch {
  if (!isRecord(value)) return {};
  const patch: Record<string, unknown> = {};
  for (const key of ["grouping", "subGrouping", "ordering", "orderingDirection", "nesting"] as const) {
    if (typeof value[key] === "string") patch[key] = value[key];
  }
  for (const key of ["showEmptyGroups", "showCompletedIssues"] as const) {
    if (typeof value[key] === "boolean") patch[key] = value[key];
  }
  if (Array.isArray(value.hiddenGroups)) {
    patch.hiddenGroups = value.hiddenGroups.filter((entry): entry is string => typeof entry === "string").slice(0, 200);
  }
  if (isRecord(value.fields)) {
    patch.fields = Object.fromEntries(Object.entries(value.fields).filter(([, flag]) => typeof flag === "boolean"));
  }
  return patch as ViewPreferencesPatch;
}

// Titles this close (word overlap) to an open issue in the same team count as a
// duplicate follow-up.
const FOLLOW_UP_DUPLICATE_THRESHOLD = 0.8;

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

function titleSimilarity(left: string, right: string): number {
  const a = titleWords(left);
  const b = titleWords(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export function createLinearIssueTracker(args: {
  client: LinearClient;
  /** Where the ADE-only "ADE status" column choice is kept (per project). */
  displayStore?: LinearDisplayStore | null;
  logger?: Logger | null;
}): IssueTracker {
  // ---- Display settings (Linear view preferences) ----
  // What Linear holds, per view (60 s), and what Linear refused: those changes
  // stay in ADE for this session and ride along with the next write.
  const viewReads = new Map<string, { read: LinearViewPreferencesRead; at: number }>();
  const unsavedPatches = new Map<string, ViewPreferencesPatch>();
  const writeChains = new Map<string, Promise<CtoUpdateLinearViewPreferencesResult>>();
  // Views Linear will not store for this session (a team-scoped tab with no
  // team): later changes skip the round trip and stay in ADE.
  const refusedViews = new Map<string, string>();

  const readAdeStatus = (key: string): boolean => {
    try {
      const stored = args.displayStore?.getJson<Record<string, boolean>>(ADE_STATUS_KEY);
      const value = stored && typeof stored === "object" ? stored[key] : undefined;
      return typeof value === "boolean" ? value : true;
    } catch {
      return true;
    }
  };

  const writeAdeStatus = (key: string, value: boolean): void => {
    try {
      const stored = args.displayStore?.getJson<Record<string, boolean>>(ADE_STATUS_KEY);
      args.displayStore?.setJson(ADE_STATUS_KEY, { ...(stored && typeof stored === "object" ? stored : {}), [key]: value });
    } catch (error) {
      args.logger?.warn("linear.ade_status_save_failed", { error: getErrorMessage(error) });
    }
  };

  // Display changes Linear refused (a team-scoped tab with no team), per view.
  // Used when Linear has nothing saved for the view; Linear's own values win.
  const readAdePatches = (): Record<string, ViewPreferencesPatch> => {
    try {
      const stored = args.displayStore?.getJson<Record<string, ViewPreferencesPatch>>(ADE_PREFERENCES_KEY);
      return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    } catch {
      return {};
    }
  };

  const writeAdePatch = (key: string, patch: ViewPreferencesPatch | null): void => {
    try {
      const next = { ...readAdePatches() };
      if (patch) next[key] = patch;
      else if (key in next) delete next[key];
      else return;
      args.displayStore?.setJson(ADE_PREFERENCES_KEY, next);
    } catch (error) {
      args.logger?.warn("linear.ade_preferences_save_failed", { error: getErrorMessage(error) });
    }
  };

  const defaultsRead = (): LinearViewPreferencesRead => ({ preferences: defaultLinearDisplayPreferences(), recordId: null, stored: {} });

  /** Linear's record for a view: cached 60 s; Linear's defaults when Linear is unreachable or the budget is low. */
  const loadViewRead = async (
    view: { viewType: LinearIssueViewType; customViewId: string | null },
    opts: { fresh?: boolean } = {},
  ): Promise<LinearViewPreferencesRead> => {
    const key = viewKey(view);
    const cached = viewReads.get(key);
    if (cached && !opts.fresh && Date.now() - cached.at < VIEW_PREFERENCES_TTL_MS) return cached.read;
    if (!args.client.isConnected()) return defaultsRead();
    // Display settings are an extra: never spend the last of Linear's budget on them.
    if (budgetIsLow(args.client.getRateBudget())) return cached?.read ?? defaultsRead();
    try {
      const read = await args.client.readViewPreferences(view);
      viewReads.set(key, { read, at: Date.now() });
      while (viewReads.size > 50) viewReads.delete(viewReads.keys().next().value as string);
      return read;
    } catch (error) {
      args.logger?.warn("linear.view_preferences_read_failed", { viewType: view.viewType, error: getErrorMessage(error) });
      return cached?.read ?? defaultsRead();
    }
  };

  /**
   * Linear's saved values when it has any (plus this session's refused
   * changes on top); otherwise the changes ADE saved for this view; otherwise
   * Linear's defaults.
   */
  const effectivePreferences = (key: string, read: LinearViewPreferencesRead): LinearDisplayPreferences => {
    let preferences = read.preferences;
    if (read.preferences.source === "default") {
      const saved = unsavedPatches.get(key) ?? readAdePatches()[key];
      if (saved && patchTouchesLinear(saved)) preferences = { ...applyPatch(read.preferences, withoutAdeStatus(saved)), source: "ade" };
    } else {
      const unsaved = unsavedPatches.get(key);
      if (unsaved) preferences = applyPatch(read.preferences, withoutAdeStatus(unsaved));
    }
    return { ...preferences, fields: { ...preferences.fields, adeStatus: readAdeStatus(key) } };
  };

  const viewOf = (raw: unknown) => {
    const record = isRecord(raw) ? raw : {};
    const customViewId = typeof record.customViewId === "string" && record.customViewId.trim() ? record.customViewId.trim() : null;
    return { viewType: viewTypeOf(record.viewType), customViewId };
  };

  const getViewPreferences = async (raw: CtoGetLinearViewPreferencesArgs): Promise<LinearDisplayPreferences> => {
    const view = viewOf(raw);
    return effectivePreferences(viewKey(view), await loadViewRead(view));
  };

  const updateViewPreferences = (raw: CtoUpdateLinearViewPreferencesArgs): Promise<CtoUpdateLinearViewPreferencesResult> => {
    const view = viewOf(raw);
    const key = viewKey(view);
    const patch = parsePatch(isRecord(raw) ? raw.patch : null);
    // One write per view at a time, each on top of the last: the last write
    // wins and no key of an earlier change is lost.
    const run = async (): Promise<CtoUpdateLinearViewPreferencesResult> => {
      if (typeof patch.fields?.adeStatus === "boolean") writeAdeStatus(key, patch.fields.adeStatus);
      const refused = refusedViews.get(key) ?? null;
      const read = await loadViewRead(view, { fresh: patchTouchesLinear(withoutAdeStatus(patch)) && !refused });
      // Changes not in Linear yet: this session's, else (when Linear has
      // nothing for the view) the ones ADE saved earlier.
      const base = unsavedPatches.get(key) ?? (read.preferences.source === "default" ? readAdePatches()[key] : undefined) ?? {};
      const pending = mergePatches(base, withoutAdeStatus(patch));
      if (!patchTouchesLinear(pending)) {
        return { preferences: effectivePreferences(key, read), savedToLinear: true, reason: null };
      }
      const keepInAde = (reason: string): CtoUpdateLinearViewPreferencesResult => {
        unsavedPatches.set(key, pending);
        writeAdePatch(key, pending);
        return { preferences: effectivePreferences(key, read), savedToLinear: false, reason };
      };
      if (refused) return keepInAde(refused);
      if (!args.client.isConnected()) return keepInAde("Linear isn't connected, so ADE kept the change here only.");
      if (budgetIsLow(args.client.getRateBudget())) {
        return keepInAde("Linear's rate limit is running low, so ADE kept the change here only for now.");
      }
      const values = mergeLinearViewValues(read.stored, pending);
      try {
        const { recordId } = await args.client.writeViewPreferences({ ...view, recordId: read.recordId, values });
        const saved: LinearViewPreferencesRead = {
          preferences: linearDisplayPreferencesFromValues(values, view.customViewId ? "linear-view" : "linear-user"),
          recordId,
          stored: values,
        };
        viewReads.set(key, { read: saved, at: Date.now() });
        unsavedPatches.delete(key);
        writeAdePatch(key, null);
        return { preferences: effectivePreferences(key, saved), savedToLinear: true, reason: null };
      } catch (error) {
        const reason = getErrorMessage(error);
        if (/per team/.test(reason)) refusedViews.set(key, reason);
        return keepInAde(reason);
      }
    };
    const next = (writeChains.get(key) ?? Promise.resolve(null)).catch(() => null).then(run);
    writeChains.set(key, next);
    void next.catch(() => null).then(() => {
      if (writeChains.get(key) === next) writeChains.delete(key);
    });
    return next;
  };

  // ---- Rail extras and lookups ----
  const railCache = new Map<string, { value: CtoLinearRailData; at: number }>();
  const railInFlight = new Map<string, Promise<CtoLinearRailData>>();
  const emptyRail = (): CtoLinearRailData => ({ cycles: [], initiatives: [], favorites: [], documents: [] });

  const getRailData = async (raw?: { teamKey?: string | null } | null): Promise<CtoLinearRailData> => {
    const teamKey = isRecord(raw) && typeof raw.teamKey === "string" ? raw.teamKey.trim() : "";
    const cached = railCache.get(teamKey);
    if (cached && Date.now() - cached.at < RAIL_TTL_MS) return cached.value;
    if (!args.client.isConnected()) return emptyRail();
    // The rail is an extra: keep the budget for the list and edits.
    if (budgetIsLow(args.client.getRateBudget())) return cached?.value ?? emptyRail();
    const inFlight = railInFlight.get(teamKey);
    if (inFlight) return inFlight;
    const run = args.client.getRailData({ teamKey: teamKey || null })
      .then((value) => {
        railCache.set(teamKey, { value, at: Date.now() });
        while (railCache.size > 20) railCache.delete(railCache.keys().next().value as string);
        return value;
      })
      .catch((error) => {
        args.logger?.warn("linear.rail_read_failed", { error: getErrorMessage(error) });
        return cached?.value ?? emptyRail();
      })
      .finally(() => railInFlight.delete(teamKey));
    railInFlight.set(teamKey, run);
    return run;
  };

  // Called only on an explicit link or adopt (never on a hot path), and cached.
  const branchCache = new Map<string, { value: NormalizedLinearIssue | null; at: number }>();
  const findIssueByBranch = async (raw: { branch: string }): Promise<NormalizedLinearIssue | null> => {
    const branch = (isRecord(raw) && typeof raw.branch === "string" ? raw.branch : "").trim().replace(/^refs\/heads\//, "");
    if (!branch || branch.length > 500) return null;
    const cached = branchCache.get(branch);
    if (cached && Date.now() - cached.at < BRANCH_LOOKUP_TTL_MS) return cached.value;
    if (!args.client.isConnected()) return null;
    try {
      const value = await args.client.findIssueByBranch(branch);
      branchCache.set(branch, { value, at: Date.now() });
      while (branchCache.size > BRANCH_CACHE_MAX) branchCache.delete(branchCache.keys().next().value as string);
      return value;
    } catch (error) {
      args.logger?.warn("linear.branch_lookup_failed", { error: getErrorMessage(error) });
      return null;
    }
  };

  return {
    getViewPreferences,
    updateViewPreferences,
    getRailData,
    findIssueByBranch,

    async getDocument(raw: { documentId: string }) {
      const documentId = isRecord(raw) && typeof raw.documentId === "string" ? raw.documentId.trim() : "";
      if (!documentId || !args.client.isConnected()) return null;
      return args.client.getDocument(documentId);
    },

    runGraphQL(params) {
      return args.client.runGraphQL(params);
    },

    listProjects() {
      return args.client.listProjects();
    },

    getQuickView(connection) {
      return args.client.getQuickView(connection);
    },

    listUsers() {
      return args.client.listUsers();
    },

    listLabels(teamKey) {
      return args.client.listLabels(teamKey);
    },

    searchIssues(query) {
      return args.client.searchIssues(query);
    },

    countIssues(query) {
      return args.client.countIssues(query);
    },

    listCustomViews() {
      return args.client.listCustomViews();
    },

    fetchCandidateIssues(query) {
      return args.client.fetchCandidateIssues(query);
    },

    fetchIssueById(issueId) {
      return args.client.fetchIssueById(issueId);
    },

    fetchIssuesByIds(issueIds) {
      return args.client.fetchIssuesByIds(issueIds);
    },

    fetchWorkflowStates(teamKey) {
      return args.client.fetchWorkflowStates(teamKey);
    },

    listWorkflowStates(teamKey) {
      return args.client.listWorkflowStates(teamKey);
    },

    updateIssueState(issueId, stateId) {
      return args.client.updateIssueState(issueId, stateId);
    },

    updateIssueAssignee(issueId, assigneeId) {
      return args.client.updateIssueAssignee(issueId, assigneeId);
    },

    updateIssuePriority(issueId, priority) {
      return args.client.updateIssuePriority(issueId, priority);
    },

    async updateIssue(issueId, patch) {
      await args.client.updateIssue(issueId, patch);
      return args.client.fetchIssueById(issueId);
    },

    createComment(issueId, body) {
      return args.client.createComment(issueId, body);
    },

    updateComment(commentId, body) {
      return args.client.updateComment(commentId, body);
    },

    addLabel(issueId, labelName) {
      return args.client.addLabel(issueId, labelName);
    },

    addIssueLabel(issueId, labelId) {
      return args.client.addIssueLabel(issueId, labelId);
    },

    removeIssueLabel(issueId, labelId) {
      return args.client.removeIssueLabel(issueId, labelId);
    },

    uploadAttachment(params) {
      return args.client.uploadAttachment(params);
    },

    createIssueAttachment(params) {
      return args.client.createIssueAttachment(params);
    },

    fetchIssueComments(issueId) {
      return args.client.fetchIssueComments(issueId);
    },

    createIssue(input) {
      return args.client.createIssue(parseLinearIssueCreateInput(input));
    },
    getIssueCreateOptions(teamKeyOrId) {
      return args.client.getIssueCreateOptions(teamKeyOrId);
    },
    listProjectMilestones(projectId) {
      return args.client.listProjectMilestones(projectId);
    },
    uploadFile({ filename, contentType, dataBase64 }) {
      const name = filename.trim().replace(/[\\/]/g, "_").slice(0, 200) || "upload";
      return args.client.uploadFileBytes({
        filename: name,
        contentType: contentType.trim() || "application/octet-stream",
        bytes: new Uint8Array(Buffer.from(dataBase64, "base64")),
      });
    },

    createIssueRelation(params) {
      return args.client.createIssueRelation(params);
    },

    async createFollowUpIssue(input) {
      // Resolve the source first: callers pass identifiers ("VER-404"),
      // parent/relation inputs want the issue's id, and a follow-up with no
      // team takes the source's team (the duplicate check needs it too).
      const sourceRef = input.sourceIssueId?.trim() || null;
      const source = sourceRef ? await args.client.fetchIssueById(sourceRef) : null;
      if (sourceRef && !source) throw new Error(`Linear issue ${sourceRef} was not found.`);
      const teamKey = input.teamKey?.trim() || source?.teamKey || "";
      if (!input.allowDuplicate) {
        // Two reads: full-text search ranks similar titles, and a direct title
        // filter sees issues filed seconds ago (the search index lags).
        const [ranked, direct] = await Promise.all([
          args.client.searchIssues({ query: input.title, teamKey, stateTypes: OPEN_ISSUE_STATE_TYPES, first: 10 }).catch(() => null),
          args.client.findOpenIssuesByTitle(input.title, teamKey).catch(() => []),
        ]);
        const duplicate = [...direct, ...(ranked?.issues ?? [])]
          .find((issue) => titleSimilarity(issue.title, input.title) >= FOLLOW_UP_DUPLICATE_THRESHOLD);
        if (duplicate) {
          return {
            created: false,
            reason: "duplicate",
            duplicateOf: {
              id: duplicate.id,
              identifier: duplicate.identifier,
              title: duplicate.title,
              url: duplicate.url,
              stateName: duplicate.stateName,
            },
          };
        }
      }
      const sourceIssueId = source?.id ?? null;
      const relation = input.relation ?? (sourceIssueId ? "related" : null);
      const issue = await args.client.createIssue({
        ...input,
        teamKey,
        projectId: input.projectId ?? (source?.projectId || null),
        parentId: relation === "sub_issue" && sourceIssueId ? sourceIssueId : input.parentId,
      });
      if (sourceIssueId && relation && relation !== "sub_issue") {
        // The new issue is the subject: "blocks" = the new issue blocks the source.
        await args.client.createIssueRelation({ issueId: issue.id, relatedIssueId: sourceIssueId, type: relation });
      }
      return { created: true, issue, relation };
    },

    async getIssuePickerData() {
      const [projects, users, states, labels] = await Promise.all([
        args.client.listProjects().catch(() => []),
        args.client.listUsers().catch(() => []),
        args.client.listWorkflowStates().catch(() => []),
        args.client.listLabels().catch(() => []),
      ]);
      return { projects, users, states, labels };
    },

    async cancelIssue(issueId) {
      const issue = await args.client.fetchIssueById(issueId);
      if (!issue) throw new Error(`Linear issue ${issueId} was not found.`);
      if (issue.stateType === "completed" || issue.stateType === "canceled") return { canceled: false, issue };
      const states = await args.client.listWorkflowStates(issue.teamKey);
      const canceled = states.find((state) => state.type === "canceled" && state.teamKey === issue.teamKey);
      if (!canceled) throw new Error(`Team ${issue.teamKey} has no Canceled state.`);
      await args.client.updateIssueState(issue.id, canceled.id);
      return { canceled: true, issue: await args.client.fetchIssueById(issue.id) };
    },

    listNotifications(params) {
      return args.client.listNotifications(params);
    },

    markNotification(params) {
      return args.client.markNotification(params.notificationId, params.action);
    },

    createProjectUpdate(params) {
      return args.client.createProjectUpdate(params);
    },

    async getConnectionStatus() {
      try {
        const identity = await args.client.getConnectionIdentity();
        return {
          connected: Boolean(identity.viewerId),
          viewerId: identity.viewerId,
          viewerName: identity.viewerName,
          organizationId: identity.organizationId,
          organizationName: identity.organizationName,
          organizationUrlKey: identity.organizationUrlKey,
          organizationLogoUrl: identity.organizationLogoUrl,
          message: identity.viewerId ? null : "Linear API token is valid but viewer lookup returned no id.",
        };
      } catch (error) {
        return {
          connected: false,
          viewerId: null,
          viewerName: null,
          organizationId: null,
          organizationName: null,
          organizationUrlKey: null,
          organizationLogoUrl: null,
          message: getErrorMessage(error),
        };
      }
    },
  };
}

export type LinearIssueTracker = ReturnType<typeof createLinearIssueTracker>;
