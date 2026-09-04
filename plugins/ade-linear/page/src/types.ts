/**
 * The Linear shapes the page draws.
 *
 * A copy of the desktop's `shared/types` Linear declarations, cut down to what
 * the ported components read. A copy rather than an import because a plugin page
 * is built outside the app: it may be installed on an older ADE than the one it
 * was compiled against, so its idea of an issue has to be its own.
 *
 * The plugin's page actions answer exactly these shapes — `pageActions.js` builds
 * them from Linear's own GraphQL, and `test/pageActions.test.js` pins the fields.
 */

export type LinearPriorityLabel = "urgent" | "high" | "normal" | "low" | "none";

export type NormalizedLinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string | null;
  projectId: string;
  projectSlug: string;
  projectName?: string | null;
  teamId: string;
  teamKey: string;
  teamName?: string | null;
  stateId: string;
  stateName: string;
  stateType: string;
  priority: number;
  priorityLabel: LinearPriorityLabel;
  labels: string[];
  labelColors?: Array<{ name: string; color: string | null }>;
  cycleId?: string | null;
  cycleName?: string | null;
  childIssues?: Array<{
    id: string;
    identifier: string;
    title: string;
    stateId: string;
    stateName: string;
    stateType: string;
  }>;
  assigneeId: string | null;
  assigneeName: string | null;
  ownerId: string | null;
  creatorId?: string | null;
  creatorName?: string | null;
  blockerIssueIds: string[];
  hasOpenBlockers: boolean;
  dueDate?: string | null;
  estimate?: number | null;
  archivedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  startedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  raw?: Record<string, unknown>;
};

export type LaneLinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string | null;
  projectId: string;
  projectSlug: string;
  projectName?: string | null;
  teamId: string;
  teamKey: string;
  teamName?: string | null;
  stateId: string;
  stateName: string;
  stateType: string;
  priority: number;
  priorityLabel: LinearPriorityLabel;
  labels: string[];
  assigneeId: string | null;
  assigneeName: string | null;
  creatorId?: string | null;
  creatorName?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  branchName?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearConnectionStatus = {
  tokenStored: boolean;
  connected: boolean;
  viewerId: string | null;
  viewerName: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
  organizationUrlKey?: string | null;
  organizationLogoUrl?: string | null;
  projectCount?: number;
  projectPreview?: string[];
  checkedAt: string | null;
  message: string | null;
  authMode?: "manual" | "oauth" | null;
  oauthAvailable?: boolean;
  tokenExpiresAt?: string | null;
  /**
   * The token's remaining life as a sentence — "expires in 6 days", "expired" —
   * pre-formatted by the child from `tokenExpiresAt`, which is the same string
   * the settings PANEL prints. Null for an API key and for a token with no
   * expiry, which says nothing rather than "never".
   */
  expiresIn?: string | null;
  expired?: boolean;
};

export type LinearCatalogUser = {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  active: boolean;
};

export type LinearCatalogState = {
  id: string;
  name: string;
  type: string;
  teamId: string;
  teamKey: string;
};

export type CtoLinearProject = {
  id: string;
  name: string;
  slug: string;
  teamName: string;
  teamKey?: string | null;
  icon?: string | null;
  color?: string | null;
};

export type CtoLinearQuickViewProject = CtoLinearProject & {
  url: string | null;
  color: string | null;
  icon: string | null;
  description: string | null;
  statusName: string | null;
  statusType: string | null;
  health: string | null;
  progress: number | null;
  scope: number | null;
  priority: number | null;
  priorityLabel: string | null;
  issueCount: number | null;
  completedIssueCount: number | null;
  startDate: string | null;
  targetDate: string | null;
  leadName: string | null;
  teamKeys: string[];
};

export type CtoLinearQuickViewTeam = {
  id: string;
  key: string;
  name: string;
  displayName: string;
  color: string | null;
  issueCount: number | null;
  cyclesEnabled: boolean | null;
  private: boolean | null;
};

export type CtoLinearQuickView = {
  connection: LinearConnectionStatus;
  organization: {
    id: string;
    name: string;
    urlKey: string | null;
    logoUrl: string | null;
    gitBranchFormat: string | null;
    createdIssueCount: number | null;
  } | null;
  viewer: {
    id: string;
    name: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    admin: boolean | null;
    guest: boolean | null;
    url: string | null;
  } | null;
  projects: CtoLinearQuickViewProject[];
  teams: CtoLinearQuickViewTeam[];
  assignedIssues: NormalizedLinearIssue[];
  recentIssues: NormalizedLinearIssue[];
  fetchedAt: string;
};

export type CtoSearchLinearIssuesArgs = {
  projectId?: string | null;
  projectSlug?: string | null;
  teamKey?: string | null;
  stateTypes?: string[];
  assigneeId?: string | null;
  priority?: number | null;
  query?: string | null;
  first?: number;
  after?: string | null;
  includeArchived?: boolean;
};

export type CtoSearchLinearIssuesResult = {
  issues: NormalizedLinearIssue[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export type CtoLinearIssueComment = {
  id: string;
  body: string;
  createdAt: string;
  userName: string;
  userDisplayName: string;
};

export type CtoGetLinearIssuePickerDataResult = {
  projects: CtoLinearProject[];
  users: LinearCatalogUser[];
  states: LinearCatalogState[];
};

export type GitHubAutolink = {
  id: number;
  keyPrefix: string;
  urlTemplate: string;
  isAlphanumeric: boolean;
};

/**
 * One lane, as the page needs it.
 *
 * `linearIssueLinks` and `laneType` are here because the launch flow needs both
 * facts the compiled quick view read off the app store: whether a lane already
 * has an AGENT on this issue (a different warning from "already has a lane"),
 * and whether a lane is the project's primary one (which the lane picker hides).
 */
export type PageLane = {
  id: string;
  name: string;
  branch: string | null;
  /**
   * The lane's worktree on disk, when the host's lane summary answers one.
   * Still null on a host that withholds it, and the page hides the row rather
   * than drawing an empty one.
   */
  path: string | null;
  status?: string | null;
  laneType?: "primary" | "worktree" | string | null;
  /** The lane's own Linear issue, when one is linked to the lane itself. */
  linearIssueId?: string | null;
  linearIssueKey?: string | null;
  /** Every Linear issue linked to a SESSION in this lane, with the session id. */
  linearIssueLinks?: { issueId: string; issueKey?: string | null; sessionId?: string | null }[];
};

/** One chat model the launch form offers. */
export type PageChatModel = {
  id: string;
  label: string;
  /**
   * The provider GROUP the model belongs to — `claude`, `codex`, `cursor`,
   * `droid`, `opencode` and the rest — as reported by the read that fetched it,
   * never guessed from the id's prefix. It is what selects the permission
   * vocabulary the launch form draws.
   */
  provider: string;
  /**
   * Whether this model has a `fast` service tier.
   *
   * A model without one REFUSES `fastMode: true` rather than ignoring it, so
   * the form must not draw the toggle at all.
   */
  fastMode: boolean;
  /**
   * The model's OWN reasoning ladder. An empty list is a real answer — the
   * model has no reasoning control — and the form draws no picker rather than
   * falling back to a none/low/medium/high ladder the provider would ignore.
   */
  reasoningEfforts: { effort: string; label: string }[];
  defaultReasoningEffort: string | null;
};

/** One choice on a provider's permission control. */
export type PageProviderPermissionMode = {
  /**
   * The provider's NATIVE value — Claude's `acceptEdits`, Droid's `auto-low`,
   * Cursor's `plan`. It is not ADE's unified `AgentChatPermissionMode`, and
   * sending it as one would be refused; it belongs in the field its provider's
   * `permissionField` names.
   */
  value: string;
  label: string;
  /** One sentence, the same one ADE's own control shows. */
  detail: string | null;
};

/** What one provider group lets the launch form offer. */
export type PageProviderCapability = {
  provider: string;
  /**
   * The launch argument a chosen `value` belongs in —
   * `claudePermissionMode`, `droidPermissionMode`, `cursorModeId`,
   * `opencodePermissionMode`, or the unified `permissionMode` for Codex, whose
   * options are presets. The page copies it rather than keeping its own
   * provider→field table, which is the table that goes stale when a sixth
   * provider arrives.
   */
  permissionField: string;
  permissionModes: PageProviderPermissionMode[];
  /** The mode ADE itself starts on. Always one of `permissionModes`. */
  defaultPermissionMode: string | null;
};

/**
 * What the launch form OPENS on, before the reader touches anything.
 *
 * Not derivable from the model or the provider lists: ADE's own launch form
 * opens on the model the user launched LAST, which is per-user state in the
 * project database. A page rebuilding that form without this opened on whatever
 * its own author hard-coded — the ported Linear modal opened on a fixed Claude
 * id while the composer beside it opened on the user's actual last model.
 *
 * The five fields are only correct together: `effort` is the default rung of
 * THIS model, and `permissionMode` the default mode of THIS model's provider.
 */
export type PageDefaultModel = {
  modelId: string;
  /** The provider group the model belongs to. Null when the host named none. */
  provider: string | null;
  /** The rung to preselect. Null when this model has no reasoning ladder. */
  effort: string | null;
  /** The provider's own default mode, in the provider's NATIVE vocabulary. */
  permissionMode: string | null;
  fastMode: boolean;
};

/** What the launch form may offer, per provider. Joined to a model on `provider`. */
export type PageCapabilities = {
  providers: PageProviderCapability[];
  /**
   * The seed. `null` rather than absent when there is nothing to seed, so a
   * page can tell "no default" from a host too old to compute one.
   */
  defaultModel: PageDefaultModel | null;
};
