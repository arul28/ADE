// Fleet assembly: what the panel draws, computed here so four clients only draw.
//
// Ported from `apps/desktop/src/main/services/chat/cursorCloudFleetService.ts`.
// Two things move, and both are deliberate:
//
//   * Lane matching used to read the chat service's session links. A plugin
//     owns its own sessions, so the link comes from this plugin's `sessions`
//     collection plus an exact branch match against `lane.list`.
//   * Rows are written to a synced collection instead of returned over IPC, so
//     the phone and the web client render the same fleet the Mac assembled.
//
// Everything else — the enrich rule, the concurrency, the origin cache, the
// grouping order — is core's, unchanged.

"use strict";

const { repoLabel, repoMatchKey, clampFleetBudget } = require("./repoMatch");
const {
  agentWebUrl,
  fleetDisplayStatus,
  formatAge,
  formatCost,
  isFleetEntryActive,
  normalizeRunStatus,
  shortId,
  statusTone,
} = require("./format");

/** Enrich reads run in parallel, four at a time, exactly as core did. */
const ENRICH_CONCURRENCY = 4;
/** How long an `origin` probe is believed. */
const ORIGIN_CACHE_TTL_MS = 60_000;

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isLiveAgentListStatus(status) {
  const lower = typeof status === "string" ? status.trim().toLowerCase() : "";
  return lower === "running" || lower === "active" || lower === "creating" || status == null || status === "";
}

function readEpoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * One agent, as Cursor's list gives it, reduced to what a row needs.
 *
 * Every field is optional-tolerant: an older or newer Cursor answer must
 * degrade to a thinner row, never to a thrown fleet.
 */
function agentSummary(raw) {
  const agentId = readString(raw?.id);
  if (!agentId) return null;
  const repos = Array.isArray(raw?.repos)
    ? raw.repos.map((repo) => readString(repo?.url)).filter(Boolean)
    : [];
  const status = readString(raw?.status)?.toLowerCase();
  return {
    agentId,
    name: readString(raw?.name) ?? agentId,
    summary: readString(raw?.summary) ?? readString(raw?.name) ?? "",
    // The agent list says ACTIVE or ARCHIVED; the run says what it is doing.
    archived: status === "archived",
    status: status === "archived" ? undefined : status,
    createdAt: readEpoch(raw?.createdAt),
    lastModified: readEpoch(raw?.updatedAt) ?? readEpoch(raw?.createdAt),
    repos,
    webUrl: readString(raw?.url) ?? agentWebUrl(agentId),
    latestRunId: readString(raw?.latestRunId),
  };
}

/**
 * The branches one run pushed, attributed to the repo each landed in.
 *
 * A branch attributed to ANOTHER repo is never shown: it is real work, and it
 * is not work this project can pull.
 */
function readRunPushedBranches(run) {
  const branches = Array.isArray(run?.git?.branches) ? run.git.branches : [];
  const rows = [];
  for (const entry of branches) {
    const branch = readString(entry?.branch);
    const prUrl = readString(entry?.prUrl);
    if (!branch && !prUrl) continue;
    rows.push({ repoKey: repoMatchKey(entry?.repoUrl) || null, branch, prUrl });
  }
  if (rows.length) return rows;
  const flatBranch = readString(run?.git?.branch);
  const flatPr = readString(run?.git?.prUrl);
  if (flatBranch || flatPr) return [{ repoKey: null, branch: flatBranch, prUrl: flatPr }];
  return [];
}

function pickBranch(run, originKey) {
  const rows = readRunPushedBranches(run);
  const ours = originKey ? rows.filter((row) => row.repoKey === originKey) : [];
  const unattributed = rows.filter((row) => row.repoKey == null);
  return ours[0] ?? unattributed[0] ?? null;
}

/**
 * A one-minute memo of this project's `origin`.
 *
 * A negative answer is cached too: a probe that failed must not be retried on
 * every row of every read, and a minute of no repo matching is a smaller wrong
 * than a fleet that spawns a git process per agent.
 */
function createOriginCache(getOriginRemote, ttlMs = ORIGIN_CACHE_TTL_MS) {
  let cached = null;
  return {
    async key(now = Date.now()) {
      if (cached && now - cached.at < ttlMs) return cached.key;
      let key = "";
      try {
        key = repoMatchKey(await getOriginRemote());
      } catch {
        key = "";
      }
      cached = { key, at: now };
      return key;
    },
    reset() {
      cached = null;
    },
  };
}

/** Run `worker` over `items`, `limit` at a time, swallowing per-item failures. */
async function mapWithConcurrency(items, limit, worker) {
  let cursor = 0;
  const width = Math.min(Math.max(limit, 1), Math.max(items.length, 1));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          await worker(items[index], index);
        } catch {
          // One agent whose latest run could not be read is one thinner row.
        }
      }
    }),
  );
}

/**
 * Build the fleet.
 *
 * `deps` is everything that talks to something: the API, the lane list, the
 * origin probe and this plugin's own session index. Every one is injected, so
 * the whole assembly is testable with no network and no host.
 */
async function assembleFleet(deps, args = {}) {
  const { api, listLanes, originCache, listSessionLinks } = deps;
  const includeArchived = args.includeArchived === true;
  const budget = clampFleetBudget(args.limit);
  const now = args.now ?? Date.now();

  const [agentsRaw, originKey, lanes, sessionLinks] = await Promise.all([
    api.listAgentsPaged({ budget }),
    originCache.key(now),
    Promise.resolve().then(listLanes).catch(() => []),
    Promise.resolve().then(listSessionLinks).catch(() => []),
  ]);

  const linkByAgentId = new Map();
  for (const link of sessionLinks) {
    if (link?.agentId && !linkByAgentId.has(link.agentId)) linkByAgentId.set(link.agentId, link);
  }
  const laneById = new Map();
  const laneByBranch = new Map();
  for (const lane of lanes) {
    if (!lane?.id) continue;
    laneById.set(lane.id, lane);
    const branch = readString(lane.branchRef);
    if (branch && !laneByBranch.has(branch)) laneByBranch.set(branch, lane);
  }

  // An agent belongs to this project when a chat here owns it, or when one of
  // its repos IS this project's origin. Everything else is somebody else's.
  const scoped = [];
  for (const raw of agentsRaw) {
    const agent = agentSummary(raw);
    if (!agent) continue;
    const link = linkByAgentId.get(agent.agentId) ?? null;
    const repoHit = Boolean(originKey) && agent.repos.some((repo) => repoMatchKey(repo) === originKey);
    if (!link && !repoHit) continue;
    scoped.push({
      agent,
      link,
      matchedBy: link && repoHit ? "both" : link ? "session" : "repo",
      runStatus: undefined,
      latestRunId: agent.latestRunId,
      branch: null,
      prUrl: null,
      modelId: null,
    });
  }

  // Only live rows are enriched. A finished agent's run adds nothing the list
  // did not already say, and it would cost one request per row.
  const activeOnly = scoped.filter(({ agent }) => !agent.archived && isLiveAgentListStatus(agent.status));

  await mapWithConcurrency(activeOnly, ENRICH_CONCURRENCY, async (entry) => {
    const page = await api.listRuns(entry.agent.agentId, { limit: 1 });
    const run = Array.isArray(page?.items) ? page.items[0] : null;
    if (!run) return;
    entry.runStatus = normalizeRunStatus(run.status);
    entry.latestRunId = readString(run.id) ?? entry.latestRunId;
    entry.modelId = readString(run.model?.id) ?? readString(run.modelId);
    const picked = pickBranch(run, originKey);
    if (picked) {
      entry.branch = picked.branch;
      entry.prUrl = picked.prUrl;
    }
  });

  const items = scoped.map((entry) => {
    // The lane comes from the owning chat first, then from an exact branch
    // match — the same ladder `resolveLaneForAgent` walks.
    const lane = entry.link?.laneId
      ? laneById.get(entry.link.laneId) ?? null
      : entry.branch ? laneByBranch.get(entry.branch) ?? null : null;
    return {
      agent: entry.agent,
      ...(entry.runStatus ? { runStatus: entry.runStatus } : {}),
      latestRunId: entry.latestRunId,
      branch: entry.branch,
      prUrl: entry.prUrl,
      modelId: entry.modelId,
      matchedBy: entry.matchedBy,
      ownership: {
        sessionId: entry.link?.sessionId ?? null,
        sessionTitle: entry.link?.title ?? null,
        laneId: lane?.id ?? entry.link?.laneId ?? null,
        laneName: lane?.name ?? entry.link?.laneName ?? null,
        linearIssueId: lane?.linearIssue?.identifier ?? null,
      },
    };
  });

  const visible = includeArchived ? items : items.filter((entry) => !entry.agent.archived);
  return {
    items: visible,
    archivedCount: items.filter((entry) => entry.agent.archived).length,
    fetchedAt: new Date(now).toISOString(),
  };
}

/** Newest first, by whatever timestamp the agent actually carried. */
function recency(entry) {
  return entry.agent.lastModified ?? entry.agent.createdAt ?? 0;
}

/**
 * Three groups, in the order core drew them: active runs, then one per lane,
 * then everything unlinked, sub-keyed by repo and branch.
 */
function groupFleet(entries) {
  const active = [];
  const laneGroups = new Map();
  const unlinkedGroups = new Map();

  for (const entry of entries) {
    if (isFleetEntryActive(entry)) {
      active.push(entry);
      continue;
    }
    const laneId = entry.ownership.laneId;
    if (laneId) {
      const group = laneGroups.get(laneId)
        ?? { laneId, laneName: entry.ownership.laneName ?? "Lane", entries: [] };
      group.entries.push(entry);
      laneGroups.set(laneId, group);
      continue;
    }
    const key = `${repoMatchKey(entry.agent.repos[0])}|${entry.branch ?? ""}`;
    const group = unlinkedGroups.get(key) ?? { key, label: "", entries: [] };
    group.entries.push(entry);
    unlinkedGroups.set(key, group);
  }

  const byRecency = (a, b) => recency(b) - recency(a);
  active.sort(byRecency);
  const lanes = [...laneGroups.values()];
  for (const group of lanes) group.entries.sort(byRecency);
  lanes.sort((a, b) => recency(b.entries[0]) - recency(a.entries[0]));
  const unlinked = [...unlinkedGroups.values()];
  for (const group of unlinked) {
    group.entries.sort(byRecency);
    const first = group.entries[0];
    group.label = first?.agent.repos[0]
      ? `${repoLabel(first.agent.repos[0])}${first.branch ? ` · ${first.branch}` : ""}`
      : "Unknown repo";
  }
  unlinked.sort((a, b) => recency(b.entries[0]) - recency(a.entries[0]));

  return { active, lanes, unlinked };
}

/**
 * One fleet row, in the vocabulary's `VocabListItem` shape.
 *
 * A row is ONE list item, not seven nodes: title, a status chip, a mono id
 * line, two buttons and an overflow. That is what keeps a hundred rows inside
 * `maxNodes: 200` — the whole reason the rich row exists.
 *
 * The trailing fields (`status`, `laneId`, `archivedFlag`) are the filter keys
 * a client-evaluated `where` compares. They cost nothing when nothing reads
 * them.
 */
function fleetRow(entry, options = {}) {
  const now = options.now ?? Date.now();
  const status = fleetDisplayStatus(entry);
  const active = isFleetEntryActive(entry);
  const age = formatAge(entry.agent.lastModified ?? entry.agent.createdAt, now);
  const cost = formatCost(options.costCents);
  const agentId = entry.agent.agentId;

  const secondLine = [
    entry.branch ?? (entry.agent.repos[0] ? repoLabel(entry.agent.repos[0]) : null),
    entry.modelId,
    entry.ownership.linearIssueId && entry.ownership.laneName
      ? `${entry.ownership.linearIssueId} · ${entry.ownership.laneName}`
      : entry.ownership.linearIssueId ?? entry.ownership.laneName,
  ].filter(Boolean).join(" · ");

  const mono = [`agent ${shortId(agentId)}`, age, cost].filter(Boolean).join("  ·  ");

  const actions = [];
  if (!entry.agent.archived) {
    actions.push({
      action: "openInAde",
      label: "Open",
      args: { agentId },
    });
  }
  if (active) {
    actions.push({ action: "stopRun", label: "Stop", kind: "quiet", args: { agentId } });
  }

  const overflow = [];
  if (status === "finished" && !entry.agent.archived) {
    overflow.push({ action: "pullIntoLane", label: "Pull into lane…", args: { agentId } });
  }
  overflow.push({
    action: entry.agent.archived ? "unarchiveAgent" : "archiveAgent",
    label: entry.agent.archived ? "Unarchive agent" : "Archive agent",
    args: { agentId },
  });
  if (entry.prUrl) overflow.push({ action: "openPr", label: "Open PR", args: { agentId } });
  overflow.push({ action: "openAgentWeb", label: "Open on cursor.com", args: { agentId } });
  overflow.push({
    action: "deleteAgent",
    label: "Delete agent…",
    confirm: "Delete this agent on Cursor forever?",
    args: { agentId },
  });

  return {
    title: entry.agent.name,
    badge: { text: status.toUpperCase(), tone: statusTone(status) },
    ...(secondLine ? { subtitle: secondLine } : {}),
    mono,
    tone: statusTone(status),
    onPress: { action: "openAgentDetail", args: { agentId } },
    actions: actions.slice(0, 3),
    overflow: overflow.slice(0, 6),
    // Filter keys, compared client-side. Strings only: the vocabulary has no
    // expressions and this is data, not code. `archivedFlag` is `hide` on a
    // LIVE agent, because the control's live position is "Hide archived" and
    // its other option is the empty value that turns the clause off entirely.
    status: active ? "active" : status === "finished" ? "finished" : status === "error" || status === "expired" ? "failed" : "other",
    laneId: entry.ownership.laneId ?? "none",
    archivedFlag: entry.agent.archived ? "archived" : "hide",
    agentId,
  };
}

/** The collection key a row lives at, so a group can bind by prefix. */
function fleetRowKey(group, index, agentId) {
  return `${group}:${String(index).padStart(4, "0")}:${agentId}`;
}

/**
 * The lanes the filter row offers, newest agent first.
 *
 * Built from the rows that are actually on screen rather than from `lane.list`:
 * a control offering a lane with no cloud agent in it is a filter that can only
 * ever empty the list, and the vocabulary caps a control at eight options — so
 * the ones worth spending are the lanes a reader can actually land on.
 */
function laneOptions(entries, max = 7) {
  const byId = new Map();
  for (const entry of entries) {
    const laneId = entry.ownership?.laneId;
    if (!laneId || byId.has(laneId)) continue;
    byId.set(laneId, { id: laneId, name: entry.ownership.laneName ?? "Lane" });
    if (byId.size >= max) break;
  }
  return [...byId.values()];
}

module.exports = {
  ENRICH_CONCURRENCY,
  laneOptions,
  ORIGIN_CACHE_TTL_MS,
  agentSummary,
  assembleFleet,
  createOriginCache,
  fleetRow,
  fleetRowKey,
  groupFleet,
  mapWithConcurrency,
  pickBranch,
  readRunPushedBranches,
};
