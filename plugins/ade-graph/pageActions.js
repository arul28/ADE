// The second action table: what the plugin's own HTML page invokes.
//
// `index.js` answers the MANIFEST — the two tools, the palette action, the panel
// refreshes — and what those return is vocabulary: `{navigate}`, a panel id, a
// `{message}` the host draws as a banner. This file answers a PAGE, and a page
// wants neither. It wants DATA — the same shapes `window.ade.*` handed the
// compiled `WorkspaceGraphPage` — and, for a button, `{ok, message}` it can draw
// beside the canvas the reader is looking at.
//
// `page/src/host/actions.ts` is the contract, one exported function per id.
// Every id it names is defined here, and the shapes it declares in
// `page/src/lib/types.ts` are what these handlers pass through.
//
// ## Why a page handler does not throw
//
// A press on a panel that fails renders as a banner because the host turns
// `{message, ok:false}` into one. A page's `invoke` has no such chrome: a
// rejected promise reaches the page as an exception over the canvas, and the
// page has to invent the banner itself. So every MUTATION here answers
// `{ok:false, message}` for anything git, GitHub or the lane service refused,
// and rejects only when the plugin itself is wrong.
//
// The READS are the exception, and deliberately so. `pageLanes`, `pagePrs`,
// `pageProposals`, `pageSyncStatuses`, `pageAutoRebaseStatuses`,
// `pageConflictAssessment`, `pageOperations` and `pageProjectConfig` all degrade
// to an empty shape, because a canvas that drew "no lanes" on a transient
// failure would be a lie the reader cannot detect — and the page's own error
// banner is fed by the mutations, which do not degrade.
//
// ## The two fan-outs, and why they are here
//
// `pageSyncStatuses` was one `git.getSyncStatus` per lane, issued from the
// RENDERER. `pagePrDetail` was four PR reads. Inside the app those were free —
// same process, one IPC hop each. From a guest each is a bridge round trip
// through the child, and a fifty-lane workspace would pay fifty of them on
// first paint. Both fan out HERE, with a bounded concurrency, and answer one
// shape once.
//
// ## Why `deps` is read through getters
//
// `index.js` holds its SDK handle in a binding that is null until `activate`
// runs, and this table is built at LOAD so a page that opens before `activate`
// resolves gets a real handler rather than "no such action". A table that
// captured `sdk` by value would capture the null.

"use strict";

/** Lanes read concurrently when fanning out per-lane git status. */
const SYNC_FANOUT_CHUNK = 4;

/** The operation ledger page the activity score reads. */
const DEFAULT_OPERATION_LIMIT = 150;

/** The one sentence for a call that arrived before `activate` finished. */
const STARTING_UP = "Graph is still starting up on this machine.";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value, fallback) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
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

/**
 * Build the page's action table over one live `sdk` getter.
 *
 * Exported as a factory rather than a bare object for the same reason
 * ade-linear's is: `index.js` passes its own bindings through getters, and a
 * table built at load must read them at CALL time.
 */
function createPageActions(deps) {
  const invoke = (domain, action, args) => {
    const sdk = deps.sdk;
    if (!sdk) throw new Error(STARTING_UP);
    return sdk.actions.invoke(domain, action, args ?? {});
  };

  /** A mutation, wrapped: never a throw for a refusal. */
  const mutate = async (fallback, run) => {
    try {
      const value = await run();
      return { ok: true, ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}) };
    } catch (error) {
      return { ok: false, message: failureMessage(error, fallback) };
    }
  };

  /** A read that degrades to `empty` rather than rejecting into the canvas. */
  const read = async (empty, run) => {
    try {
      const value = await run();
      return value === undefined || value === null ? empty : value;
    } catch {
      return empty;
    }
  };

  return {
    /* ── Reads ───────────────────────────────────────────────────────────── */

    /**
     * Every lane, archived ones included.
     *
     * The canvas FILTERS archived lanes (`hideArchived`, on by default) rather
     * than never seeing them: a reader who turns the filter off must get rows.
     */
    async pageLanes() {
      return await read([], async () => list(await invoke("lane", "list", { includeArchived: true, includeStatus: true })));
    },

    async pageProjectConfig() {
      return await read({ environments: [] }, async () => {
        const snapshot = await invoke("project_config", "get", {});
        const effective = snapshot && typeof snapshot === "object" ? snapshot.effective : null;
        return { environments: list(effective && effective.environments) };
      });
    },

    async pagePrs() {
      return await read([], async () =>
        list(await invoke("pr", "listWithConflicts", { includeConflictAnalysis: false })));
    },

    async pageProposals() {
      return await read([], async () => list(await invoke("pr", "listIntegrationProposals", {})));
    },

    /**
     * Upstream sync for every lane, as one map.
     *
     * The compiled page issued one `git.getSyncStatus` per lane from the
     * renderer, four at a time. The fan-out is the same; it just happens on this
     * side of the bridge, so the page pays one round trip instead of N. A lane
     * whose status cannot be read is `null` rather than absent, so the canvas
     * can tell "no upstream information" from "not asked yet".
     */
    async pageSyncStatuses(args) {
      return await read({}, async () => {
        const laneIds = list(args && args.laneIds).map((id) => text(id)).filter(Boolean);
        const lanes = laneIds.length > 0
          ? laneIds.map((id) => ({ id }))
          : list(await invoke("lane", "list", { includeArchived: false, includeStatus: false }));
        const out = {};
        for (let index = 0; index < lanes.length; index += SYNC_FANOUT_CHUNK) {
          const chunk = lanes.slice(index, index + SYNC_FANOUT_CHUNK);
          const results = await Promise.all(chunk.map(async (lane) => {
            const laneId = text(lane && lane.id);
            if (!laneId) return null;
            try {
              return [laneId, await invoke("git", "getSyncStatus", { laneId })];
            } catch {
              return [laneId, null];
            }
          }));
          for (const entry of results) {
            if (entry) out[entry[0]] = entry[1] ?? null;
          }
        }
        return out;
      });
    },

    async pageAutoRebaseStatuses() {
      return await read([], async () => list(await invoke("lane", "listAutoRebaseStatuses", {})));
    },

    async pageConflictAssessment() {
      return await read(
        { lanes: [], matrix: [], overlaps: [], computedAt: new Date().toISOString() },
        async () => await invoke("conflicts", "getBatchAssessment", {}),
      );
    },

    async pageConflictOverlaps(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return [];
      return await read([], async () => list(await invoke("conflicts", "listOverlaps", { laneId })));
    },

    async pageRiskMatrix() {
      return await read([], async () => list(await invoke("conflicts", "getRiskMatrix", {})));
    },

    async pageOperations(args) {
      const limit = integer(args && args.limit, DEFAULT_OPERATION_LIMIT);
      return await read([], async () => list(await invoke("operation", "list", { limit })));
    },

    async pageGraphState() {
      return await read(null, async () => await invoke("graph_state", "get", {}));
    },

    /**
     * One PR's status, checks, reviews and comments, in one round trip.
     *
     * Four reads, each independently caught: a PR whose comments GitHub refuses
     * should still show its checks. The compiled page made the same four calls
     * with the same per-call `.catch`, from the renderer.
     */
    async pagePrDetail(args) {
      const prId = text(args && args.prId);
      if (!prId) return { status: null, checks: [], reviews: [], comments: [] };
      const [status, checks, reviews, comments] = await Promise.all([
        invoke("pr", "getStatus", { prId }).catch(() => null),
        invoke("pr", "getChecks", { prId }).catch(() => []),
        invoke("pr", "getReviews", { prId }).catch(() => []),
        invoke("pr", "getComments", { prId }).catch(() => []),
      ]);
      return { status: status ?? null, checks: list(checks), reviews: list(reviews), comments: list(comments) };
    },

    /* ── Graph state ─────────────────────────────────────────────────────── */

    async pageSaveGraphState(args) {
      const state = args && typeof args.state === "object" && !Array.isArray(args.state) ? args.state : null;
      if (!state) return { ok: false, message: "Graph state must be an object." };
      return await mutate("Could not save the graph view.", () => invoke("graph_state", "set", { state }));
    },

    /* ── Conflicts ───────────────────────────────────────────────────────── */

    async pageSimulateMerge(args) {
      const laneAId = text(args && args.laneAId);
      const laneBId = text(args && args.laneBId);
      if (!laneAId || !laneBId) return { ok: false, message: "Name both lanes to simulate." };
      return await mutate("Could not simulate this merge.", async () => ({
        result: await invoke("conflicts", "simulateMerge", { laneAId, laneBId }),
      }));
    },

    async pagePrepareProposal(args) {
      const laneId = text(args && args.laneId);
      const peerLaneId = text(args && args.peerLaneId);
      if (!laneId || !peerLaneId) return { ok: false, message: "Name both lanes." };
      return await mutate("Could not prepare the conflict context.", async () => ({
        preview: await invoke("conflicts", "prepareProposal", { laneId, peerLaneId }),
      }));
    },

    async pageRequestProposal(args) {
      const laneId = text(args && args.laneId);
      const peerLaneId = text(args && args.peerLaneId);
      const contextDigest = text(args && args.contextDigest);
      if (!laneId || !peerLaneId || !contextDigest) {
        return { ok: false, message: "Prepare the conflict context first." };
      }
      return await mutate("Could not resolve this conflict.", async () => ({
        proposal: await invoke("conflicts", "requestProposal", { laneId, peerLaneId, contextDigest }),
      }));
    },

    async pageApplyProposal(args) {
      const laneId = text(args && args.laneId);
      const proposalId = text(args && args.proposalId);
      const applyMode = text(args && args.applyMode) ?? "unstaged";
      const commitMessage = text(args && args.commitMessage);
      if (!laneId || !proposalId) return { ok: false, message: "Name the proposal to apply." };
      if (applyMode === "commit" && !commitMessage) {
        return { ok: false, message: "Commit message is required for commit mode." };
      }
      return await mutate("Could not apply this proposal.", async () => ({
        proposal: await invoke("conflicts", "applyProposal", {
          laneId,
          proposalId,
          applyMode,
          ...(commitMessage ? { commitMessage } : {}),
        }),
      }));
    },

    async pageUndoProposal(args) {
      const laneId = text(args && args.laneId);
      const proposalId = text(args && args.proposalId);
      if (!laneId || !proposalId) return { ok: false, message: "Name the proposal to undo." };
      return await mutate("Could not undo this proposal.", async () => ({
        proposal: await invoke("conflicts", "undoProposal", { laneId, proposalId }),
      }));
    },

    /* ── PRs ─────────────────────────────────────────────────────────────── */

    async pageSubmitReview(args) {
      const prId = text(args && args.prId);
      const event = text(args && args.event);
      const body = text(args && args.body);
      if (!prId || !event) return { ok: false, message: "Name the PR and the review." };
      return await mutate("Could not submit that review.", () =>
        invoke("pr", "submitReview", { prId, event, ...(body ? { body } : {}) }));
    },

    async pageLandPr(args) {
      const prId = text(args && args.prId);
      const method = text(args && args.method) ?? "squash";
      if (!prId) return { ok: false, message: "Name the PR to land." };
      return await mutate("Merge failed.", async () => {
        const result = await invoke("pr", "land", { prId, method });
        // `pr.land` resolves with `{success:false, error}` for a GitHub refusal
        // rather than rejecting, so the page's one error path has to read it.
        if (result && result.success === false) {
          throw new Error(text(result.error) ?? "Merge failed.");
        }
        return { result };
      });
    },

    async pageCreatePr(args) {
      const laneId = text(args && args.laneId);
      const title = text(args && args.title);
      const body = text(args && args.body);
      const baseBranch = text(args && args.baseBranch);
      if (!laneId || !title || !body) return { ok: false, message: "A PR needs a lane, a title and a body." };
      return await mutate("Could not open the pull request.", async () => {
        const created = await invoke("pr", "createFromLane", {
          laneId,
          title,
          body,
          draft: args.draft === true,
          ...(baseBranch ? { baseBranch } : {}),
        });
        return { prId: text(created && created.id) ?? null };
      });
    },

    /* ── Git ─────────────────────────────────────────────────────────────── */

    async pageGitSync(args) {
      const laneId = text(args && args.laneId);
      const mode = text(args && args.mode) ?? "rebase";
      const baseRef = text(args && args.baseRef);
      if (!laneId) return { ok: false, message: "Name the lane to sync." };
      return await mutate("Could not sync that lane.", () =>
        invoke("git", "sync", { laneId, mode, ...(baseRef ? { baseRef } : {}) }));
    },

    async pageGitFetch(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to fetch." };
      return await mutate("Could not fetch that lane.", () => invoke("git", "fetch", { laneId }));
    },

    async pageGitPush(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to push." };
      return await mutate("Could not push that lane.", () =>
        invoke("git", "push", { laneId, ...(args.forceWithLease === true ? { forceWithLease: true } : {}) }));
    },

    /* ── Lanes ───────────────────────────────────────────────────────────── */

    async pageReparentLane(args) {
      const laneId = text(args && args.laneId);
      const newParentLaneId = text(args && args.newParentLaneId);
      if (!laneId || !newParentLaneId) return { ok: false, message: "Name the lane and its new parent." };
      return await mutate("Could not reparent that lane.", async () => {
        const result = await invoke("lane", "reparent", { laneId, newParentLaneId });
        // Carried back so the page can offer Undo, which is the whole reason the
        // compiled handler read this field.
        return { previousParentLaneId: text(result && result.previousParentLaneId) ?? null };
      });
    },

    async pageRebaseStart(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to rebase." };
      return await mutate("Rebase failed.", async () => {
        const result = await invoke("lane", "rebaseStart", {
          laneId,
          scope: args.recursive === true ? "lane_and_descendants" : "lane_only",
          pushMode: "none",
          actor: "user",
        });
        const run = result && result.run;
        if (run && (run.state === "failed" || run.error)) {
          throw new Error(text(run.error) ?? "Rebase failed.");
        }
        return { run: run ?? null };
      });
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
          force: args.force !== false,
          deleteBranch: args.deleteBranch === true,
        }));
    },

    async pageCreateChildLane(args) {
      const parentLaneId = text(args && args.parentLaneId);
      const name = text(args && args.name);
      if (!parentLaneId || !name) return { ok: false, message: "Name the parent lane and the new lane." };
      return await mutate("Could not create that lane.", async () => {
        const created = await invoke("lane", "createChild", { parentLaneId, name });
        return { laneId: text(created && created.id) ?? null, laneName: text(created && created.name) ?? name };
      });
    },

    async pageUpdateLaneAppearance(args) {
      const laneId = text(args && args.laneId);
      if (!laneId) return { ok: false, message: "Name the lane to restyle." };
      return await mutate("Could not save that appearance.", () =>
        invoke("lane", "updateAppearance", {
          laneId,
          color: text(args.color),
          icon: text(args.icon),
          tags: list(args.tags).map((tag) => text(tag)).filter(Boolean),
        }));
    },
  };
}

module.exports = { createPageActions, SYNC_FANOUT_CHUNK, DEFAULT_OPERATION_LIMIT };
