// The third action table: what the plugin's own HTML page invokes.
//
// `actions.js` answers the MANIFEST — tools, steps, the search provider, the
// CLI word. `panelActions.js` answers a PANEL press, and what it returns is
// vocabulary: `{navigate}`, `{prompt}`, `{resetState}`, a panel id. This file
// answers a PAGE, and a page wants neither of those things. It wants DATA —
// the same shapes `window.ade.cto.*` handed the compiled Linear browser — and,
// for a form, `{ok, message}` it can draw beside the field the reader touched.
//
// `page/src/host/actions.ts` is the contract, one exported function per id.
// Every id it names is defined here, and the shapes it imports from
// `page/src/types.ts` are what these handlers build.
//
// ## Why a page handler does not throw
//
// A press on a panel that fails renders as a banner because the host turns
// `{message, ok: false}` into one. A page's `invoke` has no such chrome: a
// rejected promise reaches the page as an exception beside a form the reader
// has already filled in, and the page has to invent the banner itself. So
// every MUTATION here answers `{ok: false, message}` for anything Linear or
// ADE refused, and throws only when the plugin itself is wrong.
//
// The reads are the one exception, and only where a failure has somewhere
// honest to live. `pageQuickView`, `pageConnection`, `pageCatalog`,
// `pageProjects`, `pageAutolinks`, `pageLanes` and `pageModels` all degrade —
// the connection carries the `message`, the collections come back empty — so a
// browser opened on a machine that cannot reach Linear draws its own empty
// state rather than a crash. `pageSearchIssues` and `pageIssueComments` do not
// degrade: an empty page of issues is indistinguishable from "nothing matches
// your filter", and a lie the page cannot detect is worse than a rejection it
// can retry.
//
// ## Why the credentials are not here, in any field
//
// The webview bridge deliberately exposes no `secrets` verb. A page that could
// read the access token would be a page that could exfiltrate it, and a plugin
// page is ordinary web content. So nothing this file returns carries a token, a
// refresh token, a client secret or any part of one — including inside an error
// message. `pageConnection` answers `tokenStored: true`, which is the whole of
// what a connection card needs to know. `test/pageActions.test.js` walks every
// handler's result and fails on a credential-shaped field.
//
// ## Why `deps` is read through getters
//
// The same reason `actions.js` gives: `index.js` holds its collaborators in
// bindings that are null until `activate` runs, and this table is built at LOAD
// so a page that opens before `activate` resolves gets a real handler rather
// than "no such action". A table that captured `data` by value would capture
// the null; a handler that runs before the bindings exist answers its empty
// shape instead.

"use strict";

const { normalizeIssue } = require("./issueFormat");
const { expiry, isMissingTokenError } = require("./linearApi");

/**
 * Linear's priority scale, in the page's own vocabulary.
 *
 * NOT `panels/contract.js:priorityLabel`, which answers "No priority" /
 * "Urgent" / "High" / "Medium" / "Low" — words a panel draws. `types.ts` and
 * the compiled `NormalizedLinearIssue` both declare a five-value union of
 * lowercase tokens the page branches on, so the two tables are genuinely
 * different things that happen to be indexed by the same integer.
 */
const PAGE_PRIORITY_LABELS = Object.freeze(["none", "urgent", "high", "normal", "low"]);

/** Linear caps `issues(first:)` at 100, so the page's infinite scroll pages. */
const SEARCH_PAGE_MAX = 100;
const SEARCH_PAGE_DEFAULT = 50;

/** The quick view's two issue lists. The compiled view showed the same handful. */
const QUICK_VIEW_ISSUES = 50;

/** Ceilings on the near-static catalogs, so one read cannot page forever. */
const MAX_PROJECTS = 100;
const MAX_USERS = 250;
const MAX_MODELS = 100;

/** The one sentence for a call that arrived before `activate` finished. */
const STARTING_UP = "Linear is still starting up on this machine.";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** An integer that may have arrived as a string. `0` survives; nothing else does. */
function integer(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function priorityLabel(priority) {
  const index = Number.isInteger(priority) ? priority : 0;
  return PAGE_PRIORITY_LABELS[index] ?? PAGE_PRIORITY_LABELS[0];
}

/**
 * One row of the launch form's model picker.
 *
 * `entry` is an `AgentChatModelInfo`, or a bare id string on a host whose
 * action answers a list of names. `provider` is the group the read ASKED for —
 * the row itself carries no provider field, and guessing one from the id's
 * prefix is exactly the mistake this replaced.
 */
function pageModel(entry, provider) {
  if (typeof entry === "string") {
    const id = entry.trim();
    return id
      ? { id, label: id, provider, fastModeSupported: false, reasoningEfforts: [], defaultReasoningEffort: null }
      : null;
  }
  const id = firstString(entry?.id, entry?.modelId, entry?.value);
  if (!id) return null;
  const tiers = Array.isArray(entry?.serviceTiers) ? entry.serviceTiers : [];
  const efforts = Array.isArray(entry?.reasoningEfforts) ? entry.reasoningEfforts : [];
  return {
    id,
    label: firstString(entry?.displayName, entry?.label, entry?.name) ?? id,
    provider,
    // The FAST service tier is what the compiled picker's fast-mode toggle
    // asked about. A model whose descriptor names no tiers has no fast tier.
    fastModeSupported: tiers.includes("fast"),
    // The model's OWN ladder. An empty list draws no reasoning control at all,
    // which is what the compiled picker did for a model with no tiers — rather
    // than offering four choices the provider would ignore.
    reasoningEfforts: efforts
      .map((tier) => {
        const value = firstString(typeof tier === "string" ? tier : tier?.effort, tier?.value);
        if (!value) return null;
        return {
          value,
          label: firstString(tier?.label) ?? value,
          detail: text(typeof tier === "object" ? tier?.description : null),
        };
      })
      .filter(Boolean),
    defaultReasoningEffort: text(entry?.defaultReasoningEffort),
  };
}

/**
 * The current value of one of Linear's count HISTORIES.
 *
 * `issueCountHistory` and `completedIssueCountHistory` are arrays of one entry
 * per day, oldest first, so "how many now" is the last entry. Anything that is
 * not a finite number — an empty history, a selection the workspace refused —
 * is `null`, because a project with no count and a project with zero issues are
 * different things and a card that drew "0" for the first would be wrong.
 */
function lastCount(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const last = history[history.length - 1];
  return typeof last === "number" && Number.isFinite(last) ? Math.round(last) : null;
}

/**
 * A project slug, derived from its name.
 *
 * Linear's own is `slugId`, and `linearApi.js:ISSUE_FIELDS` selects
 * `project { id name }` — so an issue row carries no slug at all. The projects
 * read fills the real one when Linear answers it; every slug derived from an
 * issue is this, which is stable, matches what the page shows in a URL, and is
 * only ever compared against another slug built the same way.
 */
function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One stored issue row, as the page's `NormalizedLinearIssue`.
 *
 * The plugin's row and the page's shape overlap but are not the same: the row
 * stores labels as `{id, name, color}` because a vocabulary binding compares
 * fields, and names its children `subIssues` because that is what the detail
 * panel draws. The page reads `labels: string[]`, `labelColors` and
 * `childIssues`. One mapper, here, so neither side learns the other's names.
 *
 * Three fields are structurally absent rather than merely empty, and they are
 * empty on purpose rather than guessed: `blockerIssueIds` and `hasOpenBlockers`
 * need Linear's `relations`, and `cycleId` its cycle id — none of which the
 * shared issue selection fetches. A guess there would draw a blocker badge on
 * an issue that has none.
 */
function pageIssue(row) {
  if (!row || typeof row !== "object") return null;
  const labels = Array.isArray(row.labels) ? row.labels : [];
  const names = labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string" && name.trim());
  return {
    id: row.id ?? "",
    identifier: row.identifier ?? "",
    title: row.title ?? "",
    description: row.description ?? "",
    url: row.url ?? null,
    projectId: row.projectId ?? "",
    // Linear's own slug when the selection answered one, and only then the
    // name-derived fallback. Both are stable and both compare against a slug
    // built the same way; the real one is also the slug Linear puts in a URL.
    projectSlug: row.projectSlug ?? (row.projectName ? slugify(row.projectName) : ""),
    projectName: row.projectName ?? null,
    teamId: row.teamId ?? "",
    teamKey: row.teamKey ?? "",
    teamName: row.teamName ?? null,
    stateId: row.stateId ?? "",
    stateName: row.stateName ?? "",
    stateType: row.stateType ?? "",
    priority: Number.isInteger(row.priority) ? row.priority : 0,
    priorityLabel: priorityLabel(row.priority),
    labels: names,
    labelColors: labels
      .filter((label) => label && typeof label === "object")
      .map((label) => ({ name: label.name ?? "", color: label.color ?? null })),
    cycleId: row.cycleId ?? null,
    cycleName: row.cycleName ?? null,
    childIssues: (Array.isArray(row.subIssues) ? row.subIssues : []).map((child) => ({
      id: child?.id ?? "",
      identifier: child?.identifier ?? "",
      title: child?.title ?? "",
      stateId: child?.stateId ?? "",
      stateName: child?.stateName ?? "",
      stateType: child?.stateType ?? "",
    })),
    assigneeId: row.assigneeId ?? null,
    assigneeName: row.assigneeName ?? null,
    // The compiled shape's `ownerId` is the assignee: ADE has no second notion
    // of an issue's owner, and inventing one would put a name on a badge that
    // matches nobody in the workspace.
    ownerId: row.assigneeId ?? null,
    creatorId: row.creatorId ?? null,
    creatorName: row.creatorName ?? null,
    blockerIssueIds: Array.isArray(row.blockerIssueIds) ? row.blockerIssueIds : [],
    hasOpenBlockers: row.hasOpenBlockers === true,
    dueDate: row.dueDate ?? null,
    estimate: typeof row.estimate === "number" ? row.estimate : null,
    archivedAt: row.archivedAt ?? null,
    completedAt: row.completedAt ?? null,
    canceledAt: row.canceledAt ?? null,
    startedAt: row.startedAt ?? null,
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
    raw: {},
  };
}

/** The Linear issue a LANE itself carries, from either place a link can live. */
function laneIssue(lane) {
  const candidates = [
    lane?.primaryIssue ?? null,
    ...(Array.isArray(lane?.issueLinks) ? lane.issueLinks.map((link) => link?.issue ?? null) : []),
  ];
  return candidates.find((issue) => issue?.provider === "linear" && issue?.issueId) ?? null;
}

/**
 * Build the page's action table.
 *
 * `deps` is the same live-getter frame `actions.js` takes, plus `api` — this
 * table reads Linear directly for the four things the collections cannot hold:
 * the viewer's own profile, the workspace's projects and members, and a page of
 * search results the reader's stored filter has nothing to do with.
 */
function createPageActions(deps) {
  const { publish, refreshIssues, refreshCatalogAndIssues, issueIdFromRowKey } = deps;

  /** Are the lifecycle's bindings there yet? See the header. */
  function ready() {
    return Boolean(deps.sdk && deps.data && deps.flows && deps.connect && deps.automation && deps.api);
  }

  /**
   * One sentence for whatever refused, worded for a form.
   *
   * The message is Linear's own or ADE's own, never a token: `LinearApiError`
   * carries a code, a status and the sentence the API returned, and the
   * credential never reaches it.
   */
  function failure(error, fallback) {
    if (isMissingTokenError(error)) return { ok: false, message: "Connect Linear in Settings → Linear." };
    return { ok: false, message: text(error?.message) ?? fallback };
  }

  /** The issue id behind whatever the page sent, through the same fallbacks. */
  function readIssueId(args) {
    const frame = args && typeof args === "object" ? args : {};
    const context = frame.context && typeof frame.context === "object" ? frame.context : {};
    return issueIdFromRowKey(firstString(frame.issueId, frame.key, context.issueId));
  }

  /**
   * The stored row for an id or an identifier, fetched when it is neither.
   *
   * `findIssueRow` first, as the rules say: a page press names an issue the
   * reader can see, and the row already carries the team key and the state that
   * every write below compares against. The Linear fallback is what lets the
   * page act on an issue outside the stored filter — a deeplink, a search
   * result, an issue somebody else's filter excluded.
   */
  /**
   * ADE's launch-form capabilities, read once.
   *
   * `sdk.chat.capabilities()` is documented static for the life of an app
   * version — a new model or a new provider is a new build — so the launch
   * modal, which asks for the models and the providers a beat apart, should not
   * pay for two reads. The promise is cached rather than the value so two
   * callers that arrive together share one call.
   *
   * A refusal answers empty lists rather than throwing: a launch form with no
   * models still draws, and the reader gets the provider's own defaults. The
   * cache is dropped on failure so a later open tries again.
   */
  let capabilitiesPromise = null;
  function chatCapabilities() {
    if (capabilitiesPromise) return capabilitiesPromise;
    capabilitiesPromise = (async () => {
      if (!ready()) return { providers: [], models: [] };
      let answer;
      try {
        answer = await deps.sdk.chat.capabilities();
      } catch (error) {
        log("debug", `Could not read the chat capabilities: ${error?.message ?? error}`);
        capabilitiesPromise = null;
        return { providers: [], models: [] };
      }
      return {
        providers: (Array.isArray(answer?.providers) ? answer.providers : [])
          .filter((entry) => text(entry?.provider) && text(entry?.permissionField))
          .map((entry) => ({
            provider: entry.provider,
            permissionField: entry.permissionField,
            defaultPermissionMode: text(entry.defaultPermissionMode),
            permissionModes: (Array.isArray(entry.permissionModes) ? entry.permissionModes : [])
              .filter((mode) => text(mode?.value))
              .map((mode) => ({
                value: mode.value,
                label: text(mode.label) ?? mode.value,
                detail: text(mode.detail),
              })),
          })),
        models: (Array.isArray(answer?.models) ? answer.models : [])
          // A deprecated model still launches, but a picker that offers it is
          // pointing the reader at something ADE is retiring.
          .filter((model) => text(model?.id) && model.deprecated !== true)
          .map((model) => ({
            id: model.id,
            label: text(model.label) ?? model.id,
            provider: text(model.provider) ?? "",
            fastMode: model.fastMode === true,
            reasoningEfforts: (Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [])
              .filter((tier) => text(tier?.effort))
              .map((tier) => ({ effort: tier.effort, label: text(tier.label) ?? tier.effort })),
            defaultReasoningEffort: text(model.defaultReasoningEffort),
          }))
          .slice(0, MAX_MODELS),
      };
    })();
    return capabilitiesPromise;
  }

  async function resolveRow(value) {
    const id = issueIdFromRowKey(firstString(value));
    if (!id) return null;
    const stored = await deps.data.findIssueRow(id).catch(() => null);
    if (stored) return stored;
    const refreshed = await deps.data.refreshIssue(id, { comments: false }).catch(() => null);
    return refreshed?.ok ? refreshed.issue : null;
  }

  /** Redraw the vocabulary panels a page write also changed. */
  async function republish(panelIds) {
    for (const panelId of panelIds) {
      // Without a context: the page is a different surface from the panel, and
      // a page press must not repoint the detail panel at an issue the reader
      // on that surface never opened. See `index.js:currentIssueId`.
      await publish(panelId).catch(() => {});
    }
  }

  /* ── Linear reads the collections cannot answer ────────────────────────── */

  /**
   * The viewer's profile and the workspace, in one round trip.
   *
   * `api.getConnectionIdentity` answers four of these fields and is what the
   * connection row stores; the page's header draws an avatar, an email and the
   * admin flag beside them. A failure here is not a failure of the read — the
   * caller falls back to the connection row, which is the same four fields.
   */
  async function fetchIdentity() {
    try {
      const result = await deps.api.request(
        `query PageIdentity {
          viewer { id name displayName email avatarUrl admin guest url }
          organization { id name urlKey logoUrl gitBranchFormat createdIssueCount }
        }`,
        null,
        { maxRetries: 1, operationName: "PageIdentity" },
      );
      return { viewer: result?.viewer ?? null, organization: result?.organization ?? null };
    } catch (error) {
      log("debug", `Could not read the Linear identity: ${error?.message ?? error}`);
      return { viewer: null, organization: null };
    }
  }

  /**
   * The workspace's projects.
   *
   * Deliberately conservative about which fields it asks for. A single field
   * name Linear does not have fails the WHOLE query, and the fallback is the
   * projects derived from the issues on screen — which is a real answer, but a
   * much smaller one. So the selection is the set that has been stable across
   * Linear's API for years, and the four counts the compiled shape carries
   * (`priority`, `priorityLabel`, `issueCount`, `completedIssueCount`) come
   * back null rather than being bought at the price of the other fifteen.
   */
  async function fetchProjectNodes() {
    const COMMON = `
      id name slugId icon color description url progress scope startDate targetDate health
      status { name type }
      lead { id name displayName }
      teams(first: 10) { nodes { id key name } }
    `;
    // `priority` and the two count histories are the three fields the page's
    // project card draws and the panel half has no room for. They are asked for
    // in a wide selection with the original as the fallback, for the reason
    // `linearApi.js:listTeamsAndStates` gives: a workspace whose schema refuses
    // one of them must still get its projects, because the project filter is
    // half of the browser.
    const WIDE = `${COMMON} priority issueCountHistory completedIssueCountHistory`;

    async function read(fields) {
      const result = await deps.api.request(
        `query PageProjects($first: Int!) {
          projects(first: $first) { nodes { ${fields} } }
        }`,
        { first: MAX_PROJECTS },
        { maxRetries: 1, operationName: "PageProjects" },
      );
      const nodes = result?.projects?.nodes;
      return Array.isArray(nodes) ? nodes : [];
    }

    try {
      return await read(WIDE);
    } catch (error) {
      if (isMissingTokenError(error)) {
        log("debug", "Could not read the Linear projects: no credential is stored.");
        return [];
      }
      try {
        return await read(COMMON);
      } catch (narrowError) {
        log("debug", `Could not read the Linear projects: ${narrowError?.message ?? narrowError}`);
        return [];
      }
    }
  }

  /** The workspace's members, for the assignee picker. Same fallback rule. */
  async function fetchUserNodes() {
    try {
      const result = await deps.api.request(
        `query PageUsers($first: Int!) {
          users(first: $first) { nodes { id name displayName email active } }
        }`,
        { first: MAX_USERS },
        { maxRetries: 1, operationName: "PageUsers" },
      );
      const nodes = result?.users?.nodes;
      return Array.isArray(nodes) ? nodes : [];
    } catch (error) {
      log("debug", `Could not read the Linear users: ${error?.message ?? error}`);
      return [];
    }
  }

  function log(level, message) {
    deps.sdk?.log?.(level, message);
  }

  /** One Linear project node, as the quick view's project. */
  function projectFromNode(node) {
    const teams = Array.isArray(node?.teams?.nodes) ? node.teams.nodes : [];
    const name = text(node?.name) ?? "";
    return {
      id: text(node?.id) ?? "",
      name,
      slug: text(node?.slugId) ?? slugify(name),
      teamName: text(teams[0]?.name) ?? "",
      teamKey: text(teams[0]?.key),
      icon: text(node?.icon),
      color: text(node?.color),
      url: text(node?.url),
      description: text(node?.description),
      statusName: text(node?.status?.name),
      statusType: text(node?.status?.type),
      health: text(node?.health),
      progress: typeof node?.progress === "number" ? node.progress : null,
      scope: typeof node?.scope === "number" ? node.scope : null,
      priority: integer(node?.priority),
      priorityLabel: Number.isInteger(node?.priority) ? priorityLabel(node.priority) : null,
      // Linear reports these as HISTORIES — one entry per day, oldest first —
      // and the current count is the last entry. `null` when the wide selection
      // was refused, which the page draws as "no count" rather than as zero.
      issueCount: lastCount(node?.issueCountHistory),
      completedIssueCount: lastCount(node?.completedIssueCountHistory),
      startDate: text(node?.startDate),
      targetDate: text(node?.targetDate),
      leadName: text(node?.lead?.displayName) ?? text(node?.lead?.name),
      teamKeys: teams.map((team) => text(team?.key)).filter(Boolean),
    };
  }

  /** The same shape, from an issue that names a project and nothing else. */
  function projectFromIssue(row) {
    const name = text(row?.projectName) ?? text(row?.projectId) ?? "";
    return {
      id: row?.projectId ?? "",
      name,
      slug: slugify(name),
      teamName: text(row?.teamName) ?? "",
      teamKey: text(row?.teamKey),
      icon: null,
      color: null,
      url: null,
      description: null,
      statusName: null,
      statusType: null,
      health: null,
      progress: null,
      scope: null,
      priority: null,
      priorityLabel: null,
      issueCount: null,
      completedIssueCount: null,
      startDate: null,
      targetDate: null,
      leadName: null,
      teamKeys: text(row?.teamKey) ? [row.teamKey] : [],
    };
  }

  /**
   * Every project this machine can name, from Linear when it answers.
   *
   * `extra` is the issues a caller already has in hand — the quick view's two
   * lists — so a cold start whose collections are still empty and whose
   * projects query was refused still offers the projects its own issues belong
   * to. The union is by id, Linear's copy winning, because Linear's carries the
   * fifteen fields a derived one cannot.
   */
  async function projectRows(extra = []) {
    const byId = new Map();
    for (const row of [...(await deps.data.issueRows().catch(() => [])), ...extra]) {
      if (!row?.projectId || byId.has(row.projectId)) continue;
      byId.set(row.projectId, projectFromIssue(row));
    }
    for (const node of await fetchProjectNodes()) {
      const project = projectFromNode(node);
      if (project.id) byId.set(project.id, project);
    }
    return [...byId.values()];
  }

  /** `CtoLinearProject` — the seven fields the picker binds. */
  function baseProject(project) {
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      teamName: project.teamName,
      teamKey: project.teamKey ?? null,
      icon: project.icon ?? null,
      color: project.color ?? null,
    };
  }

  /** The stored teams, fetched once when the catalog has never been read. */
  async function teamRows() {
    let teams = await deps.data.teams().catch(() => []);
    if (teams.length === 0) {
      await deps.data.refreshCatalog(null).catch(() => {});
      teams = await deps.data.teams().catch(() => []);
    }
    return teams;
  }

  /**
   * The connection, in the page's own vocabulary.
   *
   * Carries no token and no expiry the token could be rebuilt from — only
   * `tokenStored`, which is the boolean a connection card actually branches on.
   * `tokenExpiresAt` is a timestamp the compiled shape declares and the settings
   * card prints ("expires in 6 days"); it names no credential.
   */
  async function connectionStatus() {
    let row = await deps.data.connection().catch(() => null);
    // The page can be the FIRST thing that asks. A browser opened before the
    // lifecycle's first read has finished must not be told "not connected" for
    // a credential that is sitting in the keychain.
    if (!row) row = await deps.data.refreshConnection().catch(() => null);
    const status = await deps.connect.connectStatus().catch(() => ({}));
    const projects = Array.isArray(row?.projectPreview) ? row.projectPreview : null;
    return {
      tokenStored: status.connected === true || Boolean(row?.authMode),
      connected: row?.connected === true,
      viewerId: row?.viewerId ?? null,
      viewerName: row?.viewerName ?? null,
      organizationId: row?.organizationId ?? null,
      organizationName: row?.organizationName ?? null,
      organizationUrlKey: row?.organizationUrlKey ?? null,
      organizationLogoUrl: row?.organizationLogoUrl ?? null,
      projectCount: projects?.length ?? 0,
      projectPreview: projects ?? [],
      checkedAt: row?.lastSyncAt ?? null,
      message: row?.lastError ?? null,
      authMode: row?.authMode ?? status.authMode ?? null,
      oauthAvailable: status.canOAuth === true,
      tokenExpiresAt: row?.tokenExpiresAt ?? null,
      // Pre-formatted here for the same reason the settings PANEL gets it
      // pre-formatted: "expires in 6 days" is a sentence, and the page must not
      // grow a second copy of the date arithmetic behind it. `expired` is what
      // decides the row's warning tone.
      ...expiry(row?.tokenExpiresAt ?? null),
    };
  }

  /** The empty connection, for a page that opened before `activate` finished. */
  function loadingConnection() {
    return {
      tokenStored: false,
      connected: false,
      viewerId: null,
      viewerName: null,
      organizationId: null,
      organizationName: null,
      organizationUrlKey: null,
      organizationLogoUrl: null,
      projectCount: 0,
      projectPreview: [],
      checkedAt: null,
      message: STARTING_UP,
      authMode: null,
      oauthAvailable: false,
      tokenExpiresAt: null,
      expiresIn: null,
      expired: false,
    };
  }

  function emptyQuickView(connection) {
    return {
      connection,
      organization: null,
      viewer: null,
      projects: [],
      teams: [],
      assignedIssues: [],
      recentIssues: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  /* ── The table ─────────────────────────────────────────────────────────── */

  const pageActions = {
    /* ── Reads ──────────────────────────────────────────────────────────── */

    /**
     * The browser's first read: everything a cold page needs to draw itself.
     *
     * Built from Linear rather than from the collections, because it has to
     * work before the first refresh has written a single row — and because the
     * two issue lists it carries are the WORKSPACE's ("assigned to me",
     * "recently updated"), not the reader's stored filter. A quick view drawn
     * out of somebody's saved filter would show a different workspace to every
     * device.
     */
    async pageQuickView() {
      if (!ready()) return emptyQuickView(loadingConnection());
      const connection = await connectionStatus();
      if (!connection.connected) return emptyQuickView(connection);

      const identity = await fetchIdentity();
      const assignedIssues = connection.viewerId
        ? await deps.api
          .searchAllIssues({ assigneeId: connection.viewerId }, QUICK_VIEW_ISSUES)
          .catch(() => [])
        : [];
      const recentNodes = await deps.api.searchAllIssues({}, QUICK_VIEW_ISSUES).catch(() => []);
      const assigned = assignedIssues.map((node) => normalizeIssue(node));
      const recent = recentNodes.map((node) => normalizeIssue(node));

      const viewer = identity.viewer
        ? {
          id: text(identity.viewer.id) ?? "",
          name: text(identity.viewer.name) ?? "",
          displayName: text(identity.viewer.displayName) ?? text(identity.viewer.name) ?? "",
          email: text(identity.viewer.email),
          avatarUrl: text(identity.viewer.avatarUrl),
          admin: typeof identity.viewer.admin === "boolean" ? identity.viewer.admin : null,
          guest: typeof identity.viewer.guest === "boolean" ? identity.viewer.guest : null,
          url: text(identity.viewer.url),
        }
        : connection.viewerId
          ? {
            id: connection.viewerId,
            name: connection.viewerName ?? "",
            displayName: connection.viewerName ?? "",
            email: null,
            avatarUrl: null,
            admin: null,
            guest: null,
            url: null,
          }
          : null;

      const organization = identity.organization
        ? {
          id: text(identity.organization.id) ?? "",
          name: text(identity.organization.name) ?? "",
          urlKey: text(identity.organization.urlKey),
          logoUrl: text(identity.organization.logoUrl),
          gitBranchFormat: text(identity.organization.gitBranchFormat),
          createdIssueCount: Number.isFinite(identity.organization.createdIssueCount)
            ? identity.organization.createdIssueCount
            : null,
        }
        : connection.organizationId
          ? {
            id: connection.organizationId,
            name: connection.organizationName ?? "",
            urlKey: connection.organizationUrlKey ?? null,
            logoUrl: connection.organizationLogoUrl ?? null,
            gitBranchFormat: null,
            createdIssueCount: null,
          }
          : null;

      const projects = await projectRows([...assigned, ...recent]);
      const teams = (await teamRows()).map((team) => ({
        id: team.id ?? "",
        key: team.key ?? "",
        name: team.name ?? "",
        displayName: team.name ?? team.key ?? "",
        // Real values now: `listTeamsAndStates` asks for them in its wide
        // selection. Still `null` on a workspace whose schema refused that
        // selection, which is the honest answer rather than a default.
        color: team.color ?? null,
        issueCount: Number.isInteger(team.issueCount) ? team.issueCount : null,
        cyclesEnabled: typeof team.cyclesEnabled === "boolean" ? team.cyclesEnabled : null,
        private: typeof team.private === "boolean" ? team.private : null,
      }));

      return {
        connection,
        organization,
        viewer,
        projects,
        teams,
        assignedIssues: assigned.map(pageIssue),
        recentIssues: recent.map(pageIssue),
        fetchedAt: new Date().toISOString(),
      };
    },

    /** The issue picker's three lists. */
    async pageCatalog() {
      if (!ready()) throw new Error(STARTING_UP);
      const projects = (await projectRows()).map(baseProject);

      const users = new Map();
      for (const node of await fetchUserNodes()) {
        const id = text(node?.id);
        if (!id) continue;
        users.set(id, {
          id,
          name: text(node?.name) ?? text(node?.displayName) ?? id,
          displayName: text(node?.displayName),
          email: text(node?.email),
          active: node?.active !== false,
        });
      }
      if (users.size === 0) {
        // Derived from the issues on screen, the same fallback the panel half's
        // assignee filter uses. Nobody's email and nobody's active flag is
        // known there, and both are declared nullable for exactly this case.
        for (const row of await deps.data.issueRows().catch(() => [])) {
          if (!row?.assigneeId || users.has(row.assigneeId)) continue;
          users.set(row.assigneeId, {
            id: row.assigneeId,
            name: row.assigneeName ?? row.assigneeId,
            displayName: row.assigneeName ?? null,
            email: null,
            active: true,
          });
        }
      }

      let states = await deps.data.states(null).catch(() => []);
      if (states.length === 0) {
        await deps.data.refreshCatalog(null).catch(() => {});
        states = await deps.data.states(null).catch(() => []);
      }

      return {
        projects,
        users: [...users.values()],
        states: states.map((state) => ({
          id: state.id ?? "",
          name: state.name ?? "",
          type: state.type ?? "",
          teamId: state.teamId ?? "",
          teamKey: state.teamKey ?? "",
        })),
      };
    },

    /**
     * One page of issues, straight at Linear.
     *
     * `after` is Linear's own cursor, passed through untouched, which is what
     * makes the page's infinite scroll work: the second call continues the
     * first rather than re-reading it. `first` is clamped to 100 because that
     * is Linear's ceiling — asking for 500 answers 100 without saying so, and a
     * page that believed it had asked for 500 would stop scrolling at the
     * fifth screen.
     *
     * A refusal REJECTS. An empty page and "Linear is rate limiting you" are
     * the same value in this shape, and the page cannot tell them apart.
     */
    async pageSearchIssues(args = {}) {
      if (!ready()) throw new Error(STARTING_UP);
      const frame = args && typeof args === "object" ? args : {};
      const first = Math.min(SEARCH_PAGE_MAX, Math.max(1, integer(frame.first) ?? SEARCH_PAGE_DEFAULT));
      const stateTypes = Array.isArray(frame.stateTypes)
        ? frame.stateTypes.filter((entry) => typeof entry === "string" && entry.trim())
        : [];

      let projectId = text(frame.projectId);
      const projectSlug = text(frame.projectSlug);
      if (!projectId && projectSlug) {
        // Linear's `IssueFilter` has no slug clause, so the slug is resolved to
        // an id here. An unknown slug filters on nothing rather than answering
        // an empty page — the page's own project chips are built from the same
        // list, so a slug it sends is one this read can name.
        const wanted = slugify(projectSlug);
        const match = (await projectRows()).find((project) => project.slug === wanted || project.id === projectSlug);
        if (match) projectId = match.id;
      }

      const priority = integer(frame.priority);
      const page = await deps.api.searchIssues({
        ...(projectId ? { projectId } : {}),
        ...(text(frame.teamKey) ? { teamKey: text(frame.teamKey).toUpperCase() } : {}),
        ...(stateTypes.length > 0 ? { stateTypes } : {}),
        ...(text(frame.assigneeId) ? { assigneeId: text(frame.assigneeId) } : {}),
        ...(priority !== null ? { priority } : {}),
        ...(text(frame.query) ? { query: text(frame.query) } : {}),
        first,
        after: text(frame.after),
        includeArchived: frame.includeArchived === true,
      });

      return {
        issues: (Array.isArray(page?.nodes) ? page.nodes : []).map((node) => pageIssue(normalizeIssue(node))),
        pageInfo: {
          hasNextPage: page?.hasNextPage === true,
          endCursor: page?.endCursor ?? null,
        },
      };
    },

    /**
     * One issue, by its id ALONE.
     *
     * The gap this closes: every other read the page has finds an issue by its
     * KEY, because `pageSearchIssues` is Linear's own search and Linear's search
     * does not match a raw uuid. A lane row badge carries an id and, when the
     * lane's own link is a session link rather than a lane link, no key anywhere
     * — so the card that opened over it could only say "No Linear issue on this
     * lane" about an issue that plainly exists.
     *
     * `resolveRow` is the answer and was already here: the stored row first,
     * then a single-issue fetch from Linear when nothing is stored. An id that
     * resolves to nothing answers `null` rather than throwing, because "that
     * issue is not in this workspace" is a sentence the card draws.
     */
    async pageIssueById(args = {}) {
      if (!ready()) throw new Error(STARTING_UP);
      const issueId = readIssueId(args);
      if (!issueId) return null;
      const row = await resolveRow(issueId);
      return row ? pageIssue(row) : null;
    },

    /** One issue's thread. Rejects on a refusal, for the search's reason. */
    async pageIssueComments(args = {}) {
      if (!ready()) throw new Error(STARTING_UP);
      const issueId = readIssueId(args);
      if (!issueId) return [];
      const row = await resolveRow(issueId);
      const nodes = await deps.api.fetchIssueComments(row?.id ?? issueId);
      return (Array.isArray(nodes) ? nodes : []).map((node) => ({
        id: text(node?.id) ?? "",
        body: typeof node?.body === "string" ? node.body : "",
        createdAt: text(node?.createdAt) ?? "",
        userName: text(node?.user?.name) ?? text(node?.user?.displayName) ?? "Someone",
        userDisplayName: text(node?.user?.displayName) ?? text(node?.user?.name) ?? "Someone",
      }));
    },

    /** The connection card's whole state. Never a credential. */
    async pageConnection() {
      if (!ready()) return loadingConnection();
      return await connectionStatus();
    },

    /** The project picker's list. */
    async pageProjects() {
      if (!ready()) return [];
      return (await projectRows()).map(baseProject);
    },

    /**
     * The GitHub autolink card.
     *
     * `autolinks` is what GitHub ALREADY has, read through
     * `github.listRepoAutolinks` — the panel half offers Create on every row
     * because nothing there reads them back, and a page with room for a table
     * can say which ones exist. `teams` is what could be created, from
     * `data.buildAutolinks`.
     *
     * It carries no webhook facts any more. The webhook moved OUT of the
     * settings section and into the Automations trigger tile, where the
     * `automation-trigger-tile`'s own `statusAction` (`webhookStatus`) answers
     * them — one owner for one subject, rather than a settings card and an
     * automations tile reporting the same endpoint in two vocabularies.
     */
    async pageAutolinks() {
      const empty = {
        autolinks: [],
        repo: null,
        teams: [],
      };
      if (!ready()) return empty;

      // Refreshed when nothing has read it yet, for the reason
      // `connectionStatus` gives: the page can be the first thing that asks,
      // and the workspace URL key is half of every autolink template.
      let connection = await deps.data.connection().catch(() => null);
      if (!connection) connection = await deps.data.refreshConnection().catch(() => null);
      const repo = await deps.flows.githubRepo().catch(() => null);
      let autolinks = [];
      if (repo) {
        try {
          const listed = await deps.sdk.actions.invoke("github", "listRepoAutolinks", {
            owner: repo.owner,
            name: repo.name,
          });
          const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.autolinks) ? listed.autolinks : [];
          autolinks = rows
            .filter((entry) => entry && typeof entry === "object")
            .map((entry) => ({
              id: Number(entry.id) || 0,
              keyPrefix: text(entry.keyPrefix) ?? "",
              urlTemplate: text(entry.urlTemplate) ?? "",
              isAlphanumeric: entry.isAlphanumeric === true,
            }));
        } catch (error) {
          log("debug", `Could not read the GitHub autolinks: ${error?.message ?? error}`);
        }
      }

      // Through `teamRows` first: `buildAutolinks` shapes one row per STORED
      // team, and a page opened before the catalog was ever read would be shown
      // a card offering nothing to create.
      await teamRows();
      const teams = (await deps.data.buildAutolinks(connection?.organizationUrlKey ?? null).catch(() => []))
        .map((entry) => ({
          teamKey: entry.teamKey ?? "",
          teamName: entry.teamName ?? "",
          keyPrefix: entry.keyPrefix ?? "",
          urlTemplate: entry.urlTemplate ?? null,
        }));

      return {
        autolinks,
        repo: repo ? { owner: repo.owner, name: repo.name } : null,
        teams,
      };
    },

    /**
     * Every lane, with the issues linked to it AND to the chats inside it.
     *
     * The second half is the point. A lane that merely exists on an issue and a
     * lane that has an agent working the issue are different warnings in the
     * launch flow, and the lane summary carries only the LANE's own links —
     * an issue somebody attached to one chat lives in another table entirely.
     * `flows.sessionIssues` is that table, and it already answers `[]` on a host
     * whose SDK predates the verb.
     *
     * `path` is the lane's worktree on disk. `PluginLaneSummary` was a fixed
     * allowlist that excluded it and now carries it. Null means the host has no
     * local worktree for the lane — a remote binding, or one not created yet —
     * which the page draws by hiding the row rather than printing an empty one.
     */
    async pageLanes() {
      if (!ready()) return [];
      let lanes = [];
      try {
        lanes = await deps.sdk.lanes.list();
      } catch (error) {
        log("warn", `Could not read the lanes: ${error?.message ?? error}`);
        return [];
      }

      const rows = [];
      for (const lane of Array.isArray(lanes) ? lanes : []) {
        if (!lane || typeof lane !== "object" || !lane.id) continue;
        const own = laneIssue(lane);
        const links = [];
        for (const group of await deps.flows.sessionIssues(lane.id)) {
          for (const link of Array.isArray(group?.issueLinks) ? group.issueLinks : []) {
            const issue = link?.issue;
            if (issue?.provider !== "linear" || !issue.issueId) continue;
            links.push({
              issueId: issue.issueId,
              issueKey: issue.key ?? null,
              sessionId: group?.sessionId ?? link?.sessionId ?? null,
            });
          }
        }
        rows.push({
          id: lane.id,
          name: lane.name ?? "",
          branch: lane.branchRef ?? null,
          path: text(lane.path),
          status: lane.status ?? null,
          laneType: lane.laneType ?? null,
          linearIssueId: own?.issueId ?? null,
          linearIssueKey: own?.key ?? null,
          linearIssueLinks: links,
        });
      }
      return rows;
    },

    /**
     * The launch form's model picker.
     *
     * `sdk.chat.capabilities()` and nothing else. It used to be
     * `chat.getAvailableModels`, whose rows carry no provider at all — so the
     * provider was guessed from the model id's prefix, and that guess is what
     * made a per-provider permission control impossible. The capabilities read
     * answers the tag, the fast tier and the model's own reasoning ladder in
     * one call.
     */
    async pageModels() {
      return (await chatCapabilities()).models;
    },

    /**
     * What the launch form may OFFER, per provider.
     *
     * ADE's own answer, not a table this plugin keeps. The compiled launch
     * modal drew a provider-native permission pill — Claude one vocabulary,
     * Codex another, Cursor a mode list, Droid an autonomy ladder, OpenCode a
     * fourth set — and every one of those lists is a literal in the RENDERER,
     * which a plugin child cannot import. `sdk.chat.capabilities()` restates
     * them for exactly this, with a test on ADE's side pinning the two together
     * so a mode added to the app's pill cannot leave this page a version
     * behind.
     *
     * `permissionField` is the load-bearing field and the reason this is not a
     * table here: a chosen value is the provider's NATIVE one, and it belongs
     * in the provider's own launch argument — `claudePermissionMode`,
     * `droidPermissionMode`, `cursorModeId`, `opencodePermissionMode`, and the
     * unified `permissionMode` only for Codex, whose four options are presets.
     * A page that kept its own provider→field map is the map that goes stale
     * when a sixth provider arrives.
     */
    async pageCapabilities() {
      return { providers: (await chatCapabilities()).providers };
    },

    /* ── Issue mutations ────────────────────────────────────────────────── */

    async pageSetIssueState(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const issueId = readIssueId(args);
      const stateId = text(args?.stateId);
      if (!issueId) return { ok: false, message: "Pick an issue first." };
      if (!stateId) return { ok: false, message: "Name the state to move it to." };
      try {
        await deps.automation.updateIssueState({ issueId, stateId });
      } catch (error) {
        return failure(error, "Could not change that issue's state.");
      }
      await republish(["issue", "issues"]);
      return { ok: true, message: "State updated." };
    },

    async pageSetIssuePriority(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const issueId = readIssueId(args);
      const priority = integer(args?.priority);
      if (!issueId) return { ok: false, message: "Pick an issue first." };
      // `0` is "no priority" and a real choice, so the guard is on `null` from
      // the coercion and never on falsiness.
      if (priority === null) return { ok: false, message: "A Linear priority is 0 (none) to 4 (low)." };
      try {
        const row = await deps.automation.resolveIssue(issueId);
        await deps.api.updateIssuePriority(row.id, priority);
        await deps.data.refreshIssue(row.id, { comments: false }).catch(() => {});
      } catch (error) {
        return failure(error, "Could not change that issue's priority.");
      }
      await republish(["issue", "issues"]);
      return { ok: true, message: "Priority updated." };
    },

    /** A null assignee CLEARS it, which is a thing the form can ask for. */
    async pageAssignIssue(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const issueId = readIssueId(args);
      if (!issueId) return { ok: false, message: "Pick an issue first." };
      const assigneeId = text(args?.assigneeId);
      try {
        await deps.automation.assignIssue({ issueId, assigneeId });
      } catch (error) {
        return failure(error, "Could not change that issue's assignee.");
      }
      await republish(["issue", "issues"]);
      return { ok: true, message: assigneeId ? "Assignee updated." : "Assignee cleared." };
    },

    async pageAddComment(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const issueId = readIssueId(args);
      const body = typeof args?.body === "string" ? args.body.trim() : "";
      if (!issueId) return { ok: false, message: "Pick an issue first." };
      if (!body) return { ok: false, message: "A comment needs a body." };
      try {
        await deps.automation.addComment({ issueId, body });
      } catch (error) {
        return failure(error, "Could not comment on that issue.");
      }
      await republish(["issue"]);
      return { ok: true, message: "Comment posted." };
    },

    async pageAddLabel(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const issueId = readIssueId(args);
      const labelName = text(args?.labelName);
      if (!issueId) return { ok: false, message: "Pick an issue first." };
      if (!labelName) return { ok: false, message: "Name the label." };
      try {
        await deps.automation.addLabel({ issueId, labelName });
      } catch (error) {
        return failure(error, "Could not add that label.");
      }
      await republish(["issue", "issues"]);
      return { ok: true, message: `Added ${labelName}.` };
    },

    /* ── The connection ─────────────────────────────────────────────────── */

    /**
     * Begin this plugin's own sign-in.
     *
     * The `{authSession}` is returned VERBATIM, because the bridge applies the
     * same control-flow answers a socket press gets: the host stamps the live
     * URL and whichever client the reader is on presents it. The page opens no
     * window and never sees the URL, which is the whole reason a plugin page can
     * do OAuth at all — and it never polls, because `auth.completed` reaches
     * `index.js` and republishes everything on its way through.
     */
    async pageConnectOAuth(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const origin = text(args?.origin);
      let result;
      try {
        result = await deps.connect.begin(origin ? { origin } : {});
      } catch (error) {
        return failure(error, "Could not start the Linear sign-in.");
      }
      if (!result?.ok) return { ok: false, message: result?.message ?? "Could not start the Linear sign-in." };
      return { ok: true, message: null, authSession: result.authSession };
    },

    /**
     * Store a pasted API key.
     *
     * The key is never echoed back — not in the message, not in the connection,
     * not in a field the page could read. `connect.saveApiKey` validates the
     * shape before it stores anything, so a pasted OAuth token fails here rather
     * than three screens later.
     */
    async pageSaveApiKey(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const token = typeof args?.token === "string" ? args.token : "";
      let result;
      try {
        result = await deps.connect.saveApiKey(token);
      } catch (error) {
        return failure(error, "Could not save that Linear API key.");
      }
      if (result?.ok) await refreshCatalogAndIssues().catch(() => {});
      await republish(["settings", "issues"]);
      return {
        ok: result?.ok === true,
        message: result?.message ?? null,
        connection: await connectionStatus(),
      };
    },

    async pageDisconnect() {
      if (!ready()) return { ok: false, message: STARTING_UP };
      let result;
      try {
        result = await deps.connect.disconnect();
      } catch (error) {
        return failure(error, "Could not disconnect from Linear.");
      }
      await republish(["settings", "issues"]);
      return {
        ok: result?.ok === true,
        message: result?.message ?? null,
        connection: await connectionStatus(),
      };
    },

    /**
     * One GitHub autolink, for a team key the page may spell either way.
     *
     * The compiled section draws a row per prefix — `ENG-`, and an `ADEPR` row
     * that belongs to no Linear team at all — so this takes a bare prefix, a
     * trailing dash, and any case, and then checks that what it has names a
     * team. A key that names none is refused BY NAME: `createAutolink` would
     * otherwise happily create a GitHub autolink pointing at a Linear URL that
     * 404s for everyone who clicks it.
     */
    async pageCreateAutolink(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const teamKey = String(args?.teamKey ?? args?.prefix ?? "")
        .trim()
        .replace(/-+$/, "")
        .toUpperCase();
      if (!teamKey) return { ok: false, message: "Name the team key, e.g. ENG." };

      const teams = await teamRows();
      if (teams.length > 0 && !teams.some((team) => String(team?.key ?? "").toUpperCase() === teamKey)) {
        return { ok: false, message: `No Linear team here uses the ${teamKey} prefix, so there is nothing to link to.` };
      }

      let result;
      try {
        result = await deps.flows.createAutolink({ teamKey });
      } catch (error) {
        return failure(error, `Could not create the ${teamKey} autolink.`);
      }
      await republish(["settings"]);
      return { ok: result?.ok === true, message: result?.message ?? null };
    },

    /* ── Lanes, chats and launches ──────────────────────────────────────── */

    /**
     * A lane for one issue.
     *
     * Through `flows.createLaneFromIssue`. The page may override the name or
     * branch; uniqueness suffixes stay in that flow so a branch that already
     * exists still opens a lane.
     */
    async pageCreateLane(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const row = await resolveRow(readIssueId(args));
      if (!row) return { ok: false, message: "That issue is not in this project's Linear view." };
      const baseRef = text(args?.baseRef);
      const name = text(args?.name);
      const branchName = text(args?.branchName);
      const result = await deps.flows.createLaneFromIssue({
        issue: row,
        ...(baseRef ? { baseRef } : {}),
        ...(name ? { name } : {}),
        ...(branchName ? { branchName } : {}),
      });
      if (!result.ok) return { ok: false, message: result.message };
      await refreshIssues().catch(() => {});
      return {
        ok: true,
        message: result.message,
        laneId: result.laneId,
        laneName: result.laneName,
        branch: result.branchName,
        linked: result.linked === true,
      };
    },

    async pageDeleteLane(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const laneId = text(args?.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to delete." };
      try {
        await deps.sdk.actions.invoke("lane", "delete", {
          laneId,
          ...(args?.deleteBranch === true ? { deleteBranch: true } : {}),
          ...(args?.force === true ? { force: true } : {}),
        });
      } catch (error) {
        return failure(error, "Could not delete that lane.");
      }
      // Every issue that carried this lane's badge now carries none.
      await refreshIssues().catch(() => {});
      return { ok: true, message: "Lane deleted.", laneId };
    },

    /** A lane, an agent chat, and the issue linked to both. */
    async pageLaunchAgent(args = {}) {
      return await runLaunch(args, "chat");
    },

    /** The same walk, into a tracked provider CLI instead of a chat. */
    async pageLaunchCli(args = {}) {
      return await runLaunch(args, "cli");
    },

    /**
     * A chat on the issue with the reader's prompt.
     *
     * The launch path with no provider, model or permission choices, which is
     * what "open a chat about this" means: whatever the project already
     * defaults to, started on the issue's own lane.
     */
    async pageOpenChat(args = {}) {
      return await runLaunch(
        {
          issueId: args?.issueId,
          laneId: args?.laneId,
          ...(args?.prompt ? { prompt: args.prompt } : {}),
        },
        "chat",
      );
    },

    async pageLinkIssue(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const issueId = readIssueId(args);
      const laneId = text(args?.laneId);
      if (!issueId) return { ok: false, message: "Pick an issue first." };
      if (!laneId) return { ok: false, message: "Name the lane to attach the issue to." };
      // Resolved here rather than inside the flow, which looks only in the
      // collections: a page can attach an issue it found through
      // `pageSearchIssues`, and that issue is in the workspace without being in
      // the reader's stored view.
      const row = await resolveRow(issueId);
      if (!row) return { ok: false, message: "That issue is not in this project's Linear view." };
      let result;
      try {
        result = await deps.flows.linkIssueToLane({ issue: row, laneId });
      } catch (error) {
        return failure(error, "Could not attach that issue to the lane.");
      }
      if (!result.ok) return { ok: false, message: result.message };
      await refreshIssues().catch(() => {});
      return { ok: true, message: result.message, laneId };
    },

    /**
     * Remove a link this plugin made.
     *
     * The host refuses a link somebody else created — the built-in's, another
     * plugin's — and says so, which is the honest answer rather than a silent
     * no-op. `false` means there was nothing to remove, which is not a failure:
     * the issue is not on the lane, which is what the reader asked for.
     */
    async pageUnlinkIssue(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const issueId = readIssueId(args);
      const laneId = text(args?.laneId);
      if (!issueId) return { ok: false, message: "Pick an issue first." };
      if (!laneId) return { ok: false, message: "Name the lane to detach the issue from." };
      const row = await resolveRow(issueId);
      let removed;
      try {
        removed = await deps.sdk.lanes.unlinkIssue({
          laneId,
          provider: "linear",
          issueId: row?.id ?? issueId,
        });
      } catch (error) {
        return failure(error, "Could not detach that issue from the lane.");
      }
      await refreshIssues().catch(() => {});
      return {
        ok: true,
        removed: removed === true,
        message: removed === true ? "Detached the issue." : "That issue was not linked to that lane.",
        laneId,
      };
    },
  };

  /**
   * The shared body of the three launch verbs.
   *
   * The lane comes first and is CREATED when the page named none, because an
   * agent with no lane has no branch to work on. `flows.spawnAgentOnIssue` is
   * what starts the agent and links the issue to the SESSION — the link the
   * chat header and the PR body read — and it is composed with rather than
   * copied, so a change to how a launch works reaches every surface at once.
   */
  /**
   * The reader's permission choice, in the argument it actually belongs in.
   *
   * The trap this exists to avoid: `permissionMode` is ADE's UNIFIED
   * vocabulary, and a value taken from a provider's `permissionModes` is that
   * provider's NATIVE one. Sending Claude's `acceptEdits` as `permissionMode`
   * is refused; sending the unified `edit` to Claude names a mode Claude does
   * not have. So the value goes in the field the CAPABILITY names —
   * `claudePermissionMode`, `droidPermissionMode`, `cursorModeId`,
   * `opencodePermissionMode`, and the unified `permissionMode` only for Codex,
   * whose four options are presets that happen to share the unified spelling.
   *
   * The field is looked up by the model's provider, so the page sends the value
   * and the model and never a field name of its own. A model the capabilities
   * read cannot name, or a provider it does not cover, falls back to
   * `permissionMode`: that is the one field every launch accepts, and a refusal
   * from ADE with ADE's own message beats a launch that silently drops the
   * reader's choice.
   */
  async function permissionArgument(args) {
    const chosen = text(args?.permissionMode);
    if (!chosen) return {};
    const { providers, models } = await chatCapabilities();
    const provider = text(args?.provider)
      ?? models.find((model) => model.id === text(args?.model))?.provider
      ?? null;
    const field = providers.find((entry) => entry.provider === provider)?.permissionField;
    return { [field || "permissionMode"]: chosen };
  }

  async function runLaunch(args, sessionType) {
    if (!ready()) return { ok: false, message: STARTING_UP };
    const row = await resolveRow(readIssueId(args));
    if (!row) return { ok: false, message: "That issue is not in this project's Linear view." };

    const baseRef = text(args?.baseRef);
    let laneId = text(args?.laneId);
    let laneName = null;
    let laneCreated = false;

    if (laneId) {
      // An existing lane still gets the issue attached to it: the reader picked
      // this lane FOR this issue, and a lane whose PR body never mentions the
      // ticket is the failure the link exists to prevent. A refusal is not
      // fatal — `spawnAgentOnIssue` links the session below, which is the half
      // the chat header reads.
      const linked = await deps.flows.linkIssueToLane({ issue: row, laneId, role: "primary", closeOnMerge: true });
      if (!linked.ok) log("warn", `Could not attach ${row.identifier} to ${laneId}: ${linked.message}`);
      const lane = await deps.sdk.lanes.get(laneId).catch(() => null);
      laneName = lane?.name ?? null;
    } else {
      const lane = await deps.flows.createLaneFromIssue({ issue: row, ...(baseRef ? { baseRef } : {}) });
      if (!lane.ok) return { ok: false, message: lane.message };
      laneId = lane.laneId;
      laneName = lane.laneName;
      laneCreated = true;
    }

    const reasoningEffort = deps.chosenReasoningEffort(args?.reasoningEffort);
    const agent = await deps.flows.spawnAgentOnIssue({
      issue: row,
      laneId,
      ...(sessionType === "cli" ? { sessionType: "cli" } : {}),
      ...(text(args?.provider) ? { provider: text(args.provider) } : {}),
      ...(text(args?.model) ? { model: text(args.model) } : {}),
      ...(await permissionArgument(args)),
      // Only when the form actually asked. `fastMode` is a service tier the
      // provider defaults on its own, so passing `false` for a reader who never
      // saw the toggle would be a choice they did not make.
      ...(typeof args?.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(text(args?.prompt) ? { prompt: text(args.prompt) } : {}),
    });

    if (!agent.ok) {
      // The LANE exists either way. Reporting only the agent's failure would
      // send the reader looking for work that has a branch waiting for it.
      return {
        ok: false,
        message: laneCreated ? `Opened the lane, but could not start the agent: ${agent.message}` : agent.message,
        laneId,
        laneName,
      };
    }
    await refreshIssues().catch(() => {});
    return { ok: true, message: agent.message, laneId, laneName, sessionId: agent.sessionId ?? null };
  }

  return pageActions;
}

module.exports = { PAGE_PRIORITY_LABELS, SEARCH_PAGE_MAX, createPageActions, pageIssue, priorityLabel, slugify };
