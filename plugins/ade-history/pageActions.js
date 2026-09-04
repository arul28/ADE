// The second action table: what the plugin's own HTML page invokes.
//
// `index.js` answers the MANIFEST — the four tools, the palette actions, the
// panel refreshes — and what those return is vocabulary: `{navigate}`, a panel
// id, a `{message}` the host draws as a banner. This file answers a PAGE, and a
// page wants neither. It wants DATA — the same shapes `window.ade.*` handed the
// compiled `HistoryPage` — and, for a button, `{ok, message}` it can draw
// beside the timeline the reader is looking at.
//
// `page/src/host/actions.ts` is the contract, one exported function per id.
//
// ## Why a page handler does not throw
//
// A press on a panel that fails renders as a banner because the host turns
// `{message, ok:false}` into one. A page's `invoke` has no such chrome. So every
// MUTATION here answers `{ok:false, message}` for anything git or the lane
// service refused, and rejects only when the plugin itself is wrong.
//
// Reads whose empty answer is a product sentence (no commits yet, no events yet)
// REJECT on failure, so the page can draw the error rather than a lie. Reads
// that are decorations (activity supplement, origin remote, stashes) degrade.

"use strict";

const STARTING_UP = "History is still starting up on this machine.";
const DEFAULT_COMMIT_LIMIT = 120;
const DEFAULT_OPERATION_LIMIT = 500;

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value, fallback) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : fallback;
  }
  return fallback;
}

function failureMessage(error, fallback) {
  if (error && typeof error.message === "string" && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function asList(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value[key])) return value[key];
  return [];
}

function createPageActions(deps) {
  const invoke = (domain, action, args) => {
    const sdk = deps.sdk;
    if (!sdk) throw new Error(STARTING_UP);
    return sdk.actions.invoke(domain, action, args ?? {});
  };

  const mutate = async (fallback, run) => {
    try {
      const value = await run();
      return { ok: true, ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}) };
    } catch (error) {
      return { ok: false, message: failureMessage(error, fallback) };
    }
  };

  const read = async (empty, run) => {
    try {
      const value = await run();
      return value === undefined || value === null ? empty : value;
    } catch {
      return empty;
    }
  };

  return {
    async pageLanes() {
      const listed = await invoke("lane", "list", { includeArchived: false, includeStatus: true });
      return list(listed).map((lane) => ({
        id: text(lane && lane.id),
        name: text(lane && lane.name) ?? text(lane && lane.id),
        color: text(lane && lane.color),
        worktreePath: text(lane && lane.worktreePath) ?? text(lane && lane.path),
        laneType: text(lane && lane.laneType) ?? "worktree",
      })).filter((lane) => lane.id);
    },

    async pageCommitGraph(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { commits: [], branches: [] };
      const limit = integer(args && args.limit, DEFAULT_COMMIT_LIMIT);
      const [commits, branches] = await Promise.all([
        invoke("git", "listRecentCommits", { laneId, limit }),
        invoke("git", "listBranches", { laneId }).catch(() => []),
      ]);
      return { commits: list(commits), branches: list(branches) };
    },

    async pageCommitLookup(args) {
      const laneId = text(args && args.laneId);
      const sha = text(args && args.sha) ?? text(args && args.commitSha);
      if (!laneId || !sha) return { commit: null, inLaneHistory: false };
      const commit = await invoke("git", "getCommit", { laneId, commitSha: sha }).catch(() => null);
      if (!commit) return { commit: null, inLaneHistory: false };
      const inLaneHistory = await invoke("git", "isCommitInLaneHistory", { laneId, commitSha: sha }).catch(() => false);
      return { commit, inLaneHistory: inLaneHistory === true };
    },

    async pageCommitDetail(args) {
      const laneId = text(args && args.laneId);
      const sha = text(args && args.sha) ?? text(args && args.commitSha);
      if (!laneId || !sha) return { commit: null, message: null, files: [] };
      const [commit, message, files] = await Promise.all([
        invoke("git", "getCommit", { laneId, commitSha: sha }).catch(() => null),
        invoke("git", "getCommitMessage", { laneId, commitSha: sha }).catch(() => null),
        invoke("git", "listCommitFiles", { laneId, commitSha: sha }).catch(() => []),
      ]);
      const filePaths = list(files).map((entry) => (typeof entry === "string" ? entry : text(entry && entry.path))).filter(Boolean);
      return {
        commit: commit ?? null,
        message: typeof message === "string" ? message : null,
        files: filePaths,
      };
    },

    async pageOperations(args) {
      const limit = integer(args && args.limit, DEFAULT_OPERATION_LIMIT);
      const laneId = text(args && args.laneId);
      const kind = text(args && args.kind);
      const listed = await invoke("operation", "list", {
        limit,
        ...(laneId ? { laneId } : {}),
        ...(kind ? { kind } : {}),
      });
      return asList(listed, "operations");
    },

    async pageActivitySupplement(args) {
      return await read({ chats: [], ctoSnapshot: null }, async () => {
        const limit = integer(args && args.limit, DEFAULT_OPERATION_LIMIT);
        const [chats, ctoSnapshot] = await Promise.all([
          invoke("chat", "listSessions", { includeArchived: false, includeAutomation: true }).catch(() => []),
          invoke("cto", "getState", { recentLimit: Math.min(100, limit) }).catch(() => null),
        ]);
        return {
          chats: asList(chats, "sessions").slice(0, 80),
          ctoSnapshot: ctoSnapshot && typeof ctoSnapshot === "object" ? ctoSnapshot : null,
        };
      });
    },

    async pageConflictState(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return null;
      return await read(null, () => invoke("git", "getConflictState", { laneId }));
    },

    async pageOriginRemote(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { remoteUrl: null, branch: null };
      return await read({ remoteUrl: null, branch: null }, async () => {
        const remote = await invoke("git", "getOriginRemote", { laneId });
        if (!remote || typeof remote !== "object") return { remoteUrl: null, branch: null };
        return {
          remoteUrl: text(remote.remoteUrl) ?? text(remote.url),
          branch: text(remote.branch),
        };
      });
    },

    async pageOpenPrForBranch(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { prUrl: null, prNumber: null };
      return await read({ prUrl: null, prNumber: null }, async () => {
        const pr = await invoke("git", "getOpenPrForBranch", { laneId });
        if (!pr || typeof pr !== "object") return { prUrl: null, prNumber: null };
        const number = Number.isInteger(pr.prNumber) ? pr.prNumber : null;
        return { prUrl: text(pr.prUrl), prNumber: number };
      });
    },

    async pageStashList(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return [];
      return await read([], async () => list(await invoke("git", "stashList", { laneId })));
    },

    async pageFilePatch(args) {
      const laneId = text(args && args.laneId);
      const filePath = text(args && args.path);
      if (!laneId || !filePath) return null;
      return await read(null, async () => {
        const patch = await invoke("diff", "getFilePatch", {
          laneId,
          path: filePath,
          mode: text(args.mode) ?? "commit",
          compareRef: text(args.compareRef),
          compareTo: text(args.compareTo) ?? "parent",
        });
        return typeof patch === "string" ? patch : (patch && text(patch.patch));
      });
    },

    async pageExportOperations(args) {
      return await mutate("Could not export operations.", async () => {
        const result = await invoke("history", "exportOperations", args ?? {});
        return result && typeof result === "object" ? result : { cancelled: true };
      });
    },

    async pageCherryPick(args) {
      const laneId = text(args && args.laneId);
      const commitSha = text(args && args.commitSha) ?? text(args && args.sha);
      if (!laneId || !commitSha) return { ok: false, message: "Pick a commit and a lane." };
      return await mutate("Could not cherry-pick that commit.", () =>
        invoke("git", "cherryPickCommit", { laneId, commitSha }));
    },

    async pageRevertCommit(args) {
      const laneId = text(args && args.laneId);
      const commitSha = text(args && args.commitSha) ?? text(args && args.sha);
      if (!laneId || !commitSha) return { ok: false, message: "Pick a commit and a lane." };
      return await mutate("Could not revert that commit.", () =>
        invoke("git", "revertCommit", { laneId, commitSha }));
    },

    async pageResetToCommit(args) {
      const laneId = text(args && args.laneId);
      const commitSha = text(args && args.commitSha) ?? text(args && args.sha);
      const mode = text(args && args.mode) ?? "mixed";
      if (!laneId || !commitSha) return { ok: false, message: "Pick a commit and a lane." };
      return await mutate("Could not reset to that commit.", () =>
        invoke("git", "resetToCommit", { laneId, commitSha, mode }));
    },

    async pageCheckoutBranch(args) {
      const laneId = text(args && args.laneId);
      const branchName = text(args && args.branchName);
      const startPoint = text(args && args.startPoint);
      if (!laneId || !branchName || !startPoint) {
        return { ok: false, message: "Name the branch and the commit to start from." };
      }
      return await mutate("Could not create that branch.", () =>
        invoke("git", "checkoutBranch", {
          laneId,
          branchName,
          mode: text(args.mode) ?? "create",
          startPoint,
        }));
    },

    async pageCreateTag(args) {
      const laneId = text(args && args.laneId);
      const tagName = text(args && args.tagName);
      const commitSha = text(args && args.commitSha) ?? text(args && args.sha);
      if (!laneId || !tagName || !commitSha) return { ok: false, message: "Name the tag and the commit." };
      const message = text(args && args.message);
      return await mutate("Could not create that tag.", () =>
        invoke("git", "createTag", { laneId, tagName, commitSha, ...(message ? { message } : {}) }));
    },

    async pageCreateLane(args) {
      const name = text(args && args.name);
      const parentLaneId = text(args && args.parentLaneId);
      const branchName = text(args && args.branchName);
      const startPoint = text(args && args.startPoint);
      if (!name || !parentLaneId || !branchName || !startPoint) {
        return { ok: false, message: "Name the lane, its parent, its branch and the start commit." };
      }
      const baseBranch = text(args && args.baseBranch);
      return await mutate("Could not create that lane.", async () => {
        const created = await invoke("lane", "create", {
          name,
          parentLaneId,
          branchName,
          startPoint,
          ...(baseBranch ? { baseBranch } : {}),
        });
        return { laneId: text(created && created.id), laneName: text(created && created.name) ?? name };
      });
    },

    async pageGitFetch(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to fetch." };
      return await mutate("Could not fetch that lane.", () => invoke("git", "fetch", { laneId }));
    },

    async pageGitPull(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to pull." };
      return await mutate("Could not pull that lane.", () =>
        invoke("git", "pull", { laneId, mode: text(args.mode) ?? "ff-only" }));
    },

    async pageGitPush(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to push." };
      return await mutate("Could not push that lane.", () =>
        invoke("git", "push", { laneId, ...(args.forceWithLease === true ? { forceWithLease: true } : {}) }));
    },

    async pageUndoHead(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not undo that head change.", () =>
        invoke("git", "undoLastHeadChange", { laneId }));
    },

    async pageRedoHead(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not redo that head change.", () =>
        invoke("git", "redoLastHeadChange", { laneId }));
    },

    async pageGitSync(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to sync." };
      return await mutate("Could not sync that lane.", () =>
        invoke("git", "sync", { laneId, mode: text(args.mode) ?? "rebase" }));
    },

    async pageStashPush(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not stash.", () =>
        invoke("git", "stashPush", {
          laneId,
          ...(text(args.message) ? { message: text(args.message) } : {}),
          ...(args.includeUntracked === true ? { includeUntracked: true } : {}),
        }));
    },

    async pageStashApply(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not apply that stash.", () =>
        invoke("git", "stashApply", {
          laneId,
          stashRef: text(args.stashRef),
          stashOid: text(args.stashOid),
        }));
    },

    async pageStashPop(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not pop that stash.", () =>
        invoke("git", "stashPop", {
          laneId,
          stashRef: text(args.stashRef),
          stashOid: text(args.stashOid),
        }));
    },

    async pageStashDrop(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not drop that stash.", () =>
        invoke("git", "stashDrop", {
          laneId,
          stashRef: text(args.stashRef),
          stashOid: text(args.stashOid),
        }));
    },

    async pageStashClear(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not clear stashes.", () => invoke("git", "stashClear", { laneId }));
    },

    async pageRebaseContinue(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not continue the rebase.", () => invoke("git", "rebaseContinue", { laneId }));
    },

    async pageRebaseAbort(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not abort the rebase.", () => invoke("git", "rebaseAbort", { laneId }));
    },

    async pageMergeContinue(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not continue the merge.", () => invoke("git", "mergeContinue", { laneId }));
    },

    async pageMergeAbort(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane." };
      return await mutate("Could not abort the merge.", () => invoke("git", "mergeAbort", { laneId }));
    },

    async pageRenameLane(args) {
      const laneId = text(args && args.laneId);
      const name = text(args && args.name);
      if (!laneId || !name) return { ok: false, message: "Name the lane and its new name." };
      return await mutate("Could not rename that lane.", () => invoke("lane", "rename", { laneId, name }));
    },

    async pageArchiveLane(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to archive." };
      return await mutate("Could not archive that lane.", () => invoke("lane", "archive", { laneId }));
    },

    async pageDeleteLane(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to delete." };
      return await mutate("Could not delete that lane.", () =>
        invoke("lane", "delete", {
          laneId,
          deleteBranch: args.deleteBranch === true,
          force: args.force === true,
        }));
    },
  };
}

module.exports = { createPageActions, STARTING_UP, DEFAULT_COMMIT_LIMIT, DEFAULT_OPERATION_LIMIT };
