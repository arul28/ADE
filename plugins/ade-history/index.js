// ade-history — ADE's History product as a plugin, built out of public parts.
//
// The compiled History tab is a desktop page over `git.*` and `operation.*`.
// This package is the same product twice:
//
//   * desktop draws the page (`dist/index.html`) — commit DAG + operations
//     timeline, React inside the guest;
//   * phone, TUI and any host that cannot draw a page keep the vocabulary
//     panels (`commits` / `commit` / `activity` / `event`).
//
// The host brain stays. This child only shapes rows and invokes verbs ADE
// already answers. `official: true` marks the bundled package; it buys no
// extra SDK.

"use strict";

const {
  COLLECTION_COMMITS,
  COLLECTION_FILES,
  COLLECTION_LANES,
  COLLECTION_OPERATIONS,
  PANEL_ACTIVITY,
  PANEL_COMMIT,
  PANEL_COMMITS,
  PANEL_EVENT,
  commitRow,
  commitRowKey,
  defaultBranchNameForCommit,
  fileRow,
  fileRowKey,
  githubCommitUrl,
  laneRow,
  operationRow,
  operationRowKey,
  readString,
  validateBranchName,
} = require("./format");
const { build } = require("./panels");
const { createPageActions } = require("./pageActions");

const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;
const COMMIT_LIMIT = 120;
const LANE_CAP = 8;
/**
 * How far the sweep reads before deciding what to delete.
 *
 * Derived from the widest write this plugin makes rather than typed as a
 * number, because the two have to agree: commits are written for every lane, so
 * one refresh writes up to `LANE_CAP * COMMIT_LIMIT` rows. A fixed 800 read less
 * than the 960 it could write, and the surplus was invisible to the sweep — a
 * commit that left a lane's recent history stayed on the panel forever. Capped
 * at the platform's own list ceiling (1000), which this stays under.
 */
const SWEEP_LIMIT = LANE_CAP * COMMIT_LIMIT;

let sdk = null;
let disposed = false;
const subscriptions = [];
let cache = {
  lanes: [],
  commitsByLane: {},
  operations: [],
  currentCommit: null,
  currentMessage: null,
  currentFiles: [],
  currentOperation: null,
};
let currentSha = null;
let currentLaneId = null;
let currentOperationId = null;

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

function failureMessage(error, fallback) {
  return error?.message ?? (typeof error === "string" ? error : fallback);
}

async function invokeGit(action, args = {}) {
  return sdk.actions.invoke("git", action, args);
}

async function invokeOperation(action, args = {}) {
  return sdk.actions.invoke("operation", action, args);
}

async function invokeLanes(action, args = {}) {
  return sdk.actions.invoke("lane", action, args);
}

async function publishSchema(panelId, schema, attempt = 1) {
  if (!sdk || disposed) return;
  try {
    await sdk.panels.update(panelId, schema);
  } catch (error) {
    if (attempt >= PUBLISH_ATTEMPTS) {
      log("warn", `Could not publish the ${panelId} panel: ${error?.message ?? error}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    await publishSchema(panelId, schema, attempt + 1);
  }
}

function viewFor(panelId) {
  if (panelId === PANEL_COMMITS) {
    return { lanes: cache.lanes };
  }
  if (panelId === PANEL_COMMIT) {
    return {
      commit: cache.currentCommit,
      message: cache.currentMessage,
      laneId: currentLaneId,
    };
  }
  if (panelId === PANEL_ACTIVITY) {
    return { lanes: cache.lanes };
  }
  if (panelId === PANEL_EVENT) {
    return { operation: cache.currentOperation };
  }
  return {};
}

async function publish(panelId) {
  const schema = build(panelId, viewFor(panelId));
  if (!schema) return;
  await publishSchema(panelId, schema);
}

async function replaceCollection(collection, wanted) {
  for (const [key, value] of wanted) {
    try {
      await sdk.collections.put(collection, key, value, { ifFull: "evictOldest" });
    } catch (error) {
      log("warn", `Could not store ${collection} row ${key}: ${error?.message ?? error}`);
    }
  }
  const existing = await sdk.collections.list(collection, { limit: SWEEP_LIMIT }).catch(() => []);
  for (const row of existing) {
    if (wanted.has(row.key)) continue;
    await sdk.collections.delete(collection, row.key).catch(() => {});
  }
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const key of ["lanes", "commits", "operations", "files", "sessions"]) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

function promptAnswer(args) {
  const prompt = args?.prompt;
  if (!prompt || typeof prompt !== "object") return null;
  return readString(prompt.value) ?? readString(prompt.text) ?? readString(args?.value);
}

async function refreshLanes() {
  try {
    const listed = await invokeLanes("list", {});
    cache.lanes = asList(listed).slice(0, LANE_CAP).map((lane) => ({
      id: readString(lane.id),
      name: readString(lane.name) ?? readString(lane.id),
    })).filter((lane) => lane.id);
  } catch (error) {
    log("warn", `Could not list lanes: ${error?.message ?? error}`);
    cache.lanes = cache.lanes ?? [];
  }
  const wanted = new Map();
  for (const lane of cache.lanes) {
    const row = laneRow(lane);
    if (row) wanted.set(lane.id, row);
  }
  await replaceCollection(COLLECTION_LANES, wanted);
  if (!currentLaneId && cache.lanes[0]) currentLaneId = cache.lanes[0].id;
  return cache.lanes;
}

function refsBySha(branches) {
  const map = new Map();
  for (const branch of asList(branches)) {
    const sha = readString(branch.lastCommitSha);
    const name = readString(branch.name);
    if (!sha || !name) continue;
    const list = map.get(sha) ?? [];
    list.push(name);
    map.set(sha, list);
  }
  return map;
}

async function refreshCommits() {
  if (!sdk || disposed) return { commits: [] };
  try {
    await refreshLanes();
    const wanted = new Map();
    const byLane = {};
    for (const lane of cache.lanes) {
      const [commits, branches] = await Promise.all([
        invokeGit("listRecentCommits", { laneId: lane.id, limit: COMMIT_LIMIT }),
        invokeGit("listBranches", { laneId: lane.id }).catch(() => []),
      ]);
      const refs = refsBySha(branches);
      const rows = asList(commits).map((commit) => {
        const sha = readString(commit.sha);
        return {
          ...commit,
          laneId: lane.id,
          refs: sha ? (refs.get(sha) ?? []) : [],
        };
      });
      byLane[lane.id] = rows;
      rows.forEach((commit) => {
        const row = commitRow(commit, lane.id);
        if (!row) return;
        wanted.set(commitRowKey(lane.id, row.sha), row);
      });
    }
    cache.commitsByLane = byLane;
    await replaceCollection(COLLECTION_COMMITS, wanted);
    await publish(PANEL_COMMITS);
    return { commits: [...wanted.values()] };
  } catch (error) {
    await publishSchema(PANEL_COMMITS, build(PANEL_COMMITS, {
      state: "error",
      error: failureMessage(error, "Could not load commits."),
    }));
    return { commits: [], error: failureMessage(error, "Could not load commits.") };
  }
}

async function refreshActivity() {
  if (!sdk || disposed) return { operations: [] };
  try {
    await refreshLanes();
    const listed = await invokeOperation("list", { limit: 300 });
    const operations = asList(listed);
    cache.operations = operations;
    const wanted = new Map();
    for (const operation of operations) {
      const row = operationRow(operation);
      if (row) wanted.set(operationRowKey(operation.id), row);
    }
    try {
      const sessions = asList(await sdk.actions.invoke("chat", "listSessions", { includeArchived: false }));
      for (const session of sessions.slice(0, 80)) {
        const id = readString(session.id);
        if (!id) continue;
        const synthetic = {
          id: `chat:${id}`,
          laneId: readString(session.laneId) ?? "none",
          laneName: readString(session.laneName),
          kind: "chat.session",
          status: "succeeded",
          startedAt: readString(session.updatedAt) ?? readString(session.createdAt),
          endedAt: readString(session.updatedAt),
        };
        const row = operationRow(synthetic);
        if (row) {
          row.title = readString(session.title) ?? readString(session.goal) ?? "Chat";
          wanted.set(operationRowKey(synthetic.id), row);
        }
      }
    } catch (error) {
      log("debug", `Chat activity supplement skipped: ${error?.message ?? error}`);
    }
    await replaceCollection(COLLECTION_OPERATIONS, wanted);
    await publish(PANEL_ACTIVITY);
    return { operations };
  } catch (error) {
    await publishSchema(PANEL_ACTIVITY, build(PANEL_ACTIVITY, {
      state: "error",
      error: failureMessage(error, "Could not load activity."),
    }));
    return { operations: [], error: failureMessage(error, "Could not load activity.") };
  }
}

async function refreshCommit(args = {}) {
  const sha = readString(args.sha) ?? readString(args.id) ?? currentSha;
  const laneId = readString(args.laneId) ?? currentLaneId ?? cache.lanes[0]?.id;
  if (!sha || !laneId) return { navigate: { panelId: PANEL_COMMITS } };
  currentSha = sha;
  currentLaneId = laneId;
  try {
    const [commit, message, files] = await Promise.all([
      invokeGit("getCommit", { laneId, commitSha: sha }),
      invokeGit("getCommitMessage", { laneId, commitSha: sha }).catch(() => null),
      invokeGit("listCommitFiles", { laneId, commitSha: sha }).catch(() => []),
    ]);
    if (!commit) {
      cache.currentCommit = null;
      await publishSchema(PANEL_COMMIT, build(PANEL_COMMIT, { error: "That commit is not in this lane." }));
      return { navigate: { panelId: PANEL_COMMIT, context: { sha, laneId } } };
    }
    const branches = await invokeGit("listBranches", { laneId }).catch(() => []);
    const refs = refsBySha(branches).get(sha) ?? [];
    cache.currentCommit = { ...commit, laneId, refs };
    cache.currentMessage = typeof message === "string" ? message : readString(commit.subject);
    cache.currentFiles = asList(files);
    const wanted = new Map();
    for (const path of cache.currentFiles) {
      const row = fileRow(path, sha);
      if (row) wanted.set(fileRowKey(sha, path), row);
    }
    await replaceCollection(COLLECTION_FILES, wanted);
    await publish(PANEL_COMMIT);
    return { navigate: { panelId: PANEL_COMMIT, context: { sha, laneId } } };
  } catch (error) {
    await publishSchema(PANEL_COMMIT, build(PANEL_COMMIT, {
      error: failureMessage(error, "Could not load this commit."),
    }));
    return { navigate: { panelId: PANEL_COMMIT, context: { sha, laneId } }, ok: false };
  }
}

async function refreshEvent(args = {}) {
  const operationId = readString(args.operationId) ?? readString(args.id) ?? currentOperationId;
  if (!operationId) return { navigate: { panelId: PANEL_ACTIVITY } };
  currentOperationId = operationId;
  try {
    const detail = await invokeOperation("get", { operationId });
    cache.currentOperation = detail ?? cache.operations.find((row) => row.id === operationId) ?? null;
    if (!cache.currentOperation) {
      await publishSchema(PANEL_EVENT, build(PANEL_EVENT, { error: "That operation is not in this project." }));
      return { navigate: { panelId: PANEL_EVENT, context: { operationId } } };
    }
    await publish(PANEL_EVENT);
    return { navigate: { panelId: PANEL_EVENT, context: { operationId } } };
  } catch (error) {
    await publishSchema(PANEL_EVENT, build(PANEL_EVENT, {
      error: failureMessage(error, "Could not load this operation."),
    }));
    return { navigate: { panelId: PANEL_EVENT, context: { operationId } }, ok: false };
  }
}

function commitArgs(args = {}) {
  return {
    sha: readString(args.sha) ?? readString(args.id) ?? currentSha,
    laneId: readString(args.laneId) ?? currentLaneId,
  };
}

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;
  subscriptions.push(sdk.events.on("lane.changed", () => {
    void refreshCommits().catch((error) => {
      log("debug", `Lane-change history refresh failed: ${error?.message ?? error}`);
    });
  }));
  await publishSchema(PANEL_COMMITS, build(PANEL_COMMITS, { lanes: [] }));
  await refreshCommits().catch((error) => {
    log("warn", `The first history read failed: ${error?.message ?? error}`);
  });
};

exports.deactivate = async () => {
  disposed = true;
  while (subscriptions.length) {
    try {
      subscriptions.pop()?.();
    } catch { /* unsubscribe on the way out is not worth a crash */ }
  }
  sdk = null;
};

/**
 * The handlers the plugin's own HTML PAGE invokes over the webview bridge.
 *
 * Built at LOAD, with `deps` reading this module's live `sdk` binding through a
 * getter: it is null until `activate` runs, and a table that captured it by
 * value would capture the null. A page is a webview the reader can open the
 * instant the tab is drawn, which is well before `activate`'s first commit
 * read has settled — a page that got "no such action" there would draw its
 * empty state and stay there.
 */
const pageActions = createPageActions({
  get sdk() { return sdk; },
});

/**
 * The action table the host dispatches into.
 *
 * The two halves are DISJOINT — no id is defined by both — so the merge order
 * decides nothing. Every panel action the manifest names still resolves,
 * because the vocabulary panels are the fallback for every client that cannot
 * draw the page.
 */
exports.actions = {
  ...pageActions,

  async refreshCommits() {
    const result = await refreshCommits();
    if (result.error) return { message: result.error, ok: false };
    return { message: `${result.commits.length} commit${result.commits.length === 1 ? "" : "s"}.` };
  },

  async openCommits() {
    void refreshCommits();
    return { navigate: { panelId: PANEL_COMMITS } };
  },

  async openCommit(args) {
    return await refreshCommit(args);
  },

  async refreshCommit(args) {
    return await refreshCommit(args);
  },

  async openActivity() {
    const result = await refreshActivity();
    if (result.error) return { message: result.error, ok: false, navigate: { panelId: PANEL_ACTIVITY } };
    return { navigate: { panelId: PANEL_ACTIVITY } };
  },

  async refreshActivity() {
    return await exports.actions.openActivity();
  },

  async activity() {
    return await exports.actions.openActivity();
  },

  async openEvent(args) {
    return await refreshEvent(args);
  },

  async copySha(args) {
    const sha = readString(args?.sha) ?? currentSha;
    if (!sha) return { message: "Pick a commit first.", ok: false };
    try {
      await sdk.clipboard.write(sha);
      return { message: "SHA copied." };
    } catch (error) {
      return { message: failureMessage(error, "Could not copy that SHA."), ok: false };
    }
  },

  async copySubject(args) {
    const { sha, laneId } = commitArgs(args);
    const commit = cache.currentCommit?.sha === sha
      ? cache.currentCommit
      : (cache.commitsByLane[laneId] ?? []).find((row) => row.sha === sha);
    const subject = readString(commit?.subject);
    if (!subject) return { message: "That commit has no subject.", ok: false };
    try {
      await sdk.clipboard.write(subject);
      return { message: "Subject copied." };
    } catch (error) {
      return { message: failureMessage(error, "Could not copy that subject."), ok: false };
    }
  },

  async cherryPick(args) {
    const { sha, laneId } = commitArgs(args);
    if (!sha || !laneId) return { message: "Pick a commit and a lane.", ok: false };
    try {
      await invokeGit("cherryPickCommit", { laneId, commitSha: sha });
      await refreshCommits();
      return { message: "Cherry-picked." };
    } catch (error) {
      return { message: failureMessage(error, "Could not cherry-pick that commit."), ok: false };
    }
  },

  async revertCommit(args) {
    const { sha, laneId } = commitArgs(args);
    if (!sha || !laneId) return { message: "Pick a commit and a lane.", ok: false };
    try {
      await invokeGit("revertCommit", { laneId, commitSha: sha });
      await refreshCommits();
      return { message: "Reverted." };
    } catch (error) {
      return { message: failureMessage(error, "Could not revert that commit."), ok: false };
    }
  },

  async resetToCommit(args) {
    const { sha, laneId } = commitArgs(args);
    const mode = readString(args?.mode) ?? "mixed";
    if (!sha || !laneId) return { message: "Pick a commit and a lane.", ok: false };
    try {
      await invokeGit("resetToCommit", { laneId, commitSha: sha, mode });
      await refreshCommits();
      return { message: `Reset (${mode}).` };
    } catch (error) {
      return { message: failureMessage(error, "Could not reset to that commit."), ok: false };
    }
  },

  async createBranch(args) {
    const { sha, laneId } = commitArgs(args);
    if (!sha || !laneId) return { message: "Pick a commit and a lane.", ok: false };
    const named = promptAnswer(args);
    if (!named) {
      return {
        prompt: {
          id: "branchName",
          title: "Create a branch here",
          placeholder: defaultBranchNameForCommit(cache.currentCommit ?? { sha, shortSha: sha.slice(0, 7) }),
          submitLabel: "Create branch",
        },
      };
    }
    const invalid = validateBranchName(named);
    if (invalid) return { message: invalid, ok: false };
    try {
      await invokeGit("checkoutBranch", {
        laneId,
        branchName: named,
        mode: "create",
        startPoint: sha,
      });
      await refreshCommits();
      return { message: `Created ${named}.` };
    } catch (error) {
      return { message: failureMessage(error, "Could not create that branch."), ok: false };
    }
  },

  async createLane(args) {
    const { sha, laneId } = commitArgs(args);
    if (!sha || !laneId) return { message: "Pick a commit and a lane.", ok: false };
    const named = promptAnswer(args);
    if (!named) {
      return {
        prompt: {
          id: "laneName",
          title: "Create a lane here",
          placeholder: defaultBranchNameForCommit(cache.currentCommit ?? { sha, shortSha: sha.slice(0, 7) }),
          submitLabel: "Create lane",
        },
      };
    }
    const invalid = validateBranchName(named);
    if (invalid) return { message: invalid, ok: false };
    try {
      const remote = await invokeGit("getOriginRemote", { laneId }).catch(() => null);
      const created = await invokeLanes("create", {
        name: named,
        parentLaneId: laneId,
        branchName: named,
        startPoint: sha,
        ...(readString(remote?.branch) ? { baseBranch: remote.branch } : {}),
      });
      await refreshCommits();
      return { message: `Created lane ${readString(created?.name) ?? named}.` };
    } catch (error) {
      return { message: failureMessage(error, "Could not create that lane."), ok: false };
    }
  },

  async createTag(args) {
    const { sha, laneId } = commitArgs(args);
    if (!sha || !laneId) return { message: "Pick a commit and a lane.", ok: false };
    const named = promptAnswer(args);
    if (!named) {
      return {
        prompt: {
          id: "tagName",
          title: "Create a tag here",
          placeholder: readString(cache.currentCommit?.shortSha) ?? sha.slice(0, 7),
          submitLabel: "Create tag",
        },
      };
    }
    try {
      await invokeGit("createTag", { laneId, tagName: named, commitSha: sha });
      return { message: `Tagged ${named}.` };
    } catch (error) {
      return { message: failureMessage(error, "Could not create that tag."), ok: false };
    }
  },

  async openOnGitHub(args) {
    const { sha, laneId } = commitArgs(args);
    if (!sha || !laneId) return { message: "Pick a commit and a lane.", ok: false };
    try {
      const remote = await invokeGit("getOriginRemote", { laneId });
      const url = githubCommitUrl(remote?.remoteUrl ?? remote, sha);
      if (!url) return { message: "No GitHub remote found for this commit.", ok: false };
      return { openUrl: url };
    } catch (error) {
      return { message: failureMessage(error, "Could not open that commit."), ok: false };
    }
  },

  async copyCommitLink(args) {
    const { sha, laneId } = commitArgs(args);
    if (!sha || !laneId) return { message: "Pick a commit and a lane.", ok: false };
    try {
      const remote = await invokeGit("getOriginRemote", { laneId });
      const url = githubCommitUrl(remote?.remoteUrl ?? remote, sha);
      if (!url) return { message: "No GitHub remote found for this commit.", ok: false };
      await sdk.clipboard.write(url);
      return { message: "Commit link copied." };
    } catch (error) {
      return { message: failureMessage(error, "Could not copy that link."), ok: false };
    }
  },

  async listCommitsTool(args) {
    const laneId = readString(args?.laneId) ?? cache.lanes[0]?.id;
    if (!laneId) return { message: "Name a lane id.", ok: false };
    const listed = await invokeGit("listRecentCommits", {
      laneId,
      limit: Number(args?.limit) || 50,
    });
    return { commits: asList(listed) };
  },

  async listOperationsTool(args) {
    const status = readString(args?.status);
    const listed = await invokeOperation("list", {
      ...(readString(args?.laneId) ? { laneId: args.laneId } : {}),
      ...(readString(args?.kind) ? { kind: args.kind } : {}),
      ...(status && status !== "all" ? { status } : {}),
      limit: Number(args?.limit) || 50,
    });
    return { operations: asList(listed) };
  },

  async getCommitTool(args) {
    const sha = readString(args?.sha) ?? readString(args?.commitSha);
    const laneId = readString(args?.laneId);
    if (!sha || !laneId) return { message: "Name a lane id and a commit SHA.", ok: false };
    return await invokeGit("getCommit", { laneId, commitSha: sha });
  },

  async getOperationTool(args) {
    const operationId = readString(args?.operationId) ?? readString(args?.id);
    if (!operationId) return { message: "Name an operation id.", ok: false };
    return await invokeOperation("get", { operationId });
  },
};

exports.__internals = {
  pageActions,
  viewFor,
  publish,
  refreshCommits,
  refreshActivity,
  cacheRef: () => cache,
  setCache(next) {
    cache = { ...cache, ...next };
  },
};
