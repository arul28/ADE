// The second action table: what the plugin's own HTML page invokes.
//
// `index.js` answers the MANIFEST and the PANELS — the four tools, the CLI
// words, and every press on a vocabulary row, whose answers are vocabulary:
// `{navigate}`, a panel id, a `{message}` the host turns into a banner. This
// file answers a PAGE, and a page wants neither of those things. It wants DATA
// — the same shapes `window.ade.review.*` handed the compiled Review tab — and,
// for the launch form, `{ok, message}` it can draw beside the field the reader
// touched.
//
// `page/src/host/actions.ts` is the contract, one exported function per id.
// Every id it names is defined here, and the shapes it imports from
// `page/src/types.ts` are what these handlers pass through.
//
// ## Why a page handler does not throw
//
// A press on a panel that fails renders as a banner because the host turns
// `{message, ok: false}` into one. A page's `invoke` has no such chrome: a
// rejected promise reaches the page as an exception beside a form the reader
// has already filled in, and the page has to invent the banner itself. So every
// MUTATION here answers `{ok: false, message}` for anything the review engine
// refused, and throws only when the plugin itself is wrong.
//
// ## Which reads degrade and which reject
//
// A read DEGRADES only where the degraded answer has an honest place to live:
//
//   * `pageLaunchContext` answers an empty context carrying `message`, which
//     the launch form prints above the lane field. "No lanes, and here is why"
//     is a true sentence a reader can act on.
//   * `pageQualityReport` answers `null`, which the learnings panel already
//     draws as an em-dash in every metric. "Not measured" is a true reading.
//
// The other three REJECT, because an empty answer would be a lie the page
// cannot detect. `pageRuns` returning `[]` is indistinguishable from "No review
// runs yet in this workspace"; `pageRunDetail` returning an empty `findings`
// from "The review passes found nothing actionable in this diff";
// `pageSuppressions` returning `[]` from "No suppressions yet". All three of
// those are sentences the product actually prints, and a reader who saw one
// after a failed read would conclude the opposite of the truth.
//
// ## Why the page never sees a path it did not ask for
//
// `pageLaunchContext` is the one handler that reaches outside the `review`
// domain: it joins `sdk.lanes.list()` onto the engine's launch context so each
// lane carries its worktree `path`. That field is what makes
// `ui.openPathInEditor` possible from a guest — the compiled page read the same
// value from the app store. Nothing else here adds a filesystem path, and no
// handler returns a credential, a token or an environment value of any kind;
// `test/pageActions.test.js` walks every answer and fails on a
// credential-shaped field.
//
// ## Why `deps` is read through getters
//
// `index.js` holds `sdk` in a binding that is null until `activate` runs, and
// this table is built at LOAD so a page that opens before `activate` resolves
// gets a real handler rather than "no such action". A table that captured `sdk`
// by value would capture the null; a handler that runs before the binding
// exists answers its degraded shape, or rejects with the sentence below.

"use strict";

/** The one sentence for a call that arrived before `activate` finished. */
const STARTING_UP = "Review is still starting up on this machine.";

/** What `listRuns` will page at most, matching the compiled tab's own 120. */
const MAX_RUNS = 120;

/** What `listSuppressions` will page at most, matching the compiled panel's 100. */
const MAX_SUPPRESSIONS = 100;

const RUN_STATUSES = ["queued", "running", "completed", "failed", "cancelled", "all"];

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A positive integer that may have arrived as a string, clamped to `max`. */
function count(value, fallback, max) {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number.parseInt(value.trim(), 10)
      : null;
  if (parsed === null || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * The rows out of a verb that has answered two shapes.
 *
 * `review.listRuns` and `review.listSuppressions` have each answered a bare
 * array and a `{runs}` / `{suppressions}` envelope across versions, and
 * `index.js` already reads both. A page that read one would show an empty list
 * against the other.
 */
function rows(result, key) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result[key])) return result[key];
  return [];
}

/** The run id out of whatever `startRun` / `rerun` answered. */
function runIdOf(result) {
  if (typeof result === "string") return text(result);
  if (result && typeof result === "object") return text(result.runId) ?? text(result.id);
  return null;
}

/** An empty launch context, for a read that could not be made. */
function emptyLaunchContext(message) {
  return {
    defaultLaneId: null,
    defaultBranchName: null,
    lanes: [],
    recentCommitsByLane: {},
    recommendedModelId: null,
    message: message ?? null,
  };
}

/**
 * One lane the launch form may target.
 *
 * The engine's `ReviewLaunchLane` fields plus `path`. Built as an explicit
 * allowlist rather than a spread: `sdk.lanes.list()` answers a
 * `PluginLaneSummary` carrying issue links and tags the launch form has no use
 * for, and a spread would put all of them on the wire and into the page's
 * memory every time the form opened.
 */
function launchLane(lane, path) {
  const id = text(lane?.id);
  if (!id) return null;
  return {
    id,
    name: text(lane.name) ?? id,
    laneType: text(lane.laneType) ?? "work",
    branchRef: text(lane.branchRef) ?? "",
    baseRef: text(lane.baseRef) ?? "",
    color: text(lane.color),
    path: path ?? null,
  };
}

function createPageActions(deps) {
  /** Are the lifecycle's bindings there yet? See the header. */
  function ready() {
    return Boolean(deps.sdk);
  }

  async function review(action, args) {
    return deps.sdk.actions.invoke("review", action, args ?? {});
  }

  /** One sentence for whatever refused, worded for a form. */
  function failure(error, fallback) {
    return { ok: false, message: text(error?.message) ?? fallback };
  }

  /**
   * The lane worktree paths this machine has, by lane id.
   *
   * Guarded on every level: an older host has no `sdk.lanes`, a remote binding
   * has no worktree, and neither is a reason to fail the whole launch context.
   * A lane with no path answers `null`, which the page reads as "no local
   * checkout" and falls back to the project root for.
   */
  async function lanePaths() {
    const list = deps.sdk?.lanes?.list;
    if (typeof list !== "function") return new Map();
    try {
      const lanes = await deps.sdk.lanes.list();
      const paths = new Map();
      for (const lane of Array.isArray(lanes) ? lanes : []) {
        const id = text(lane?.id);
        if (id) paths.set(id, text(lane.path));
      }
      return paths;
    } catch {
      return new Map();
    }
  }

  /**
   * The capabilities read, cached as a PROMISE rather than as a value.
   *
   * The launch form asks once per mount and both halves of the answer — the id
   * list and the fast-tier flags — come from the same call, so two mounts that
   * arrive together share one read instead of racing two.
   *
   * Held against the SDK binding that answered it, not against the process: a
   * second `activate` is a new host, and a catalogue read from the previous one
   * is not this one's answer.
   */
  let chatModelsPromise = null;
  let chatModelsSdk = null;

  const pageActions = {
    /* ── Reads ──────────────────────────────────────────────────────────── */

    /**
     * Every run in this project, newest first.
     *
     * REJECTS. See the header: an empty list is what the browser prints as "No
     * review runs yet in this workspace", so answering one for a failed read
     * would tell the reader their reviews are gone.
     */
    async pageRuns(args) {
      if (!ready()) throw new Error(STARTING_UP);
      const status = text(args?.status);
      const listed = await review("listRuns", {
        laneId: text(args?.laneId) ?? undefined,
        status: RUN_STATUSES.includes(status) ? status : "all",
        limit: count(args?.limit, MAX_RUNS, MAX_RUNS),
      });
      return rows(listed, "runs");
    },

    /**
     * One run with its findings, artifacts, reviewer runs and publications.
     *
     * REJECTS, for the same reason: a `null` here is drawn as "Findings are
     * still loading or unavailable", which is honest, but a run that exists and
     * a read that failed must not look identical — so only the engine's own
     * `null` reaches the page, and a failure rejects.
     */
    async pageRunDetail(args) {
      if (!ready()) throw new Error(STARTING_UP);
      const runId = text(args?.runId);
      // The plugin's own bug, not the engine's: the page asked for a run and
      // named none. A throw is right here.
      if (!runId) throw new Error("pageRunDetail needs a runId.");
      return (await review("getRunDetail", { runId })) ?? null;
    },

    /**
     * The lanes, their recent commits, the default branch and the recommended
     * model — plus each lane's worktree path.
     *
     * DEGRADES. The form prints `message` above the lane field.
     */
    async pageLaunchContext() {
      if (!ready()) return emptyLaunchContext(STARTING_UP);
      let context = null;
      try {
        context = await review("listLaunchContext", {});
      } catch (error) {
        return emptyLaunchContext(text(error?.message) ?? "Could not read this project's lanes.");
      }
      const paths = await lanePaths();
      const lanes = [];
      for (const lane of Array.isArray(context?.lanes) ? context.lanes : []) {
        const row = launchLane(lane, paths.get(text(lane?.id)) ?? null);
        if (row) lanes.push(row);
      }
      return {
        defaultLaneId: text(context?.defaultLaneId),
        defaultBranchName: text(context?.defaultBranchName),
        lanes,
        recentCommitsByLane: context?.recentCommitsByLane && typeof context.recentCommitsByLane === "object"
          ? context.recentCommitsByLane
          : {},
        recommendedModelId: text(context?.recommendedModelId),
        message: null,
      };
    },

    /**
     * The active suppressions.
     *
     * REJECTS: an empty list is "No suppressions yet", which is the opposite of
     * "we could not read them".
     */
    async pageSuppressions(args) {
      if (!ready()) throw new Error(STARTING_UP);
      const listed = await review("listSuppressions", {
        limit: count(args?.limit, MAX_SUPPRESSIONS, MAX_SUPPRESSIONS),
      });
      return rows(listed, "suppressions");
    },

    /**
     * The models a launch may use, with each model's own fast-tier fact.
     *
     * `sdk.chat.capabilities()` and nothing else — the same read ADE's own
     * launch form is built from. Two fields of it matter to this page and both
     * are per MODEL rather than per provider: the id list narrows ADE's picker
     * to what a review can actually run (`ui.pickModel({availableModelIds})`,
     * which is what the compiled control derived from
     * `window.ade.ai.getStatus()`), and `fastMode` says whether the chosen
     * model has a `fast` service tier at all. A model without one REFUSES
     * `fastMode: true`, so a form that drew the toggle over it would be
     * offering a switch that fails the launch.
     *
     * DEGRADES to `[]`, and the empty answer is the honest one: the page then
     * passes no `availableModelIds` and the reader gets ADE's whole catalogue,
     * which is exactly the behaviour of a host too old to answer at all. The
     * cache is per process because the registry cannot change without a new
     * build; it is dropped on failure so a later open tries again.
     */
    async pageChatModels() {
      if (!ready()) return [];
      if (chatModelsSdk !== deps.sdk) {
        chatModelsSdk = deps.sdk;
        chatModelsPromise = null;
      }
      if (chatModelsPromise) return chatModelsPromise;
      const capabilities = deps.sdk?.chat?.capabilities;
      if (typeof capabilities !== "function") return [];
      chatModelsPromise = (async () => {
        let answer;
        try {
          answer = await deps.sdk.chat.capabilities();
        } catch (error) {
          deps.sdk?.log?.("debug", `Could not read the chat capabilities: ${error?.message ?? error}`);
          chatModelsPromise = null;
          return [];
        }
        const models = Array.isArray(answer?.models) ? answer.models : [];
        const rows = [];
        for (const model of models) {
          const id = text(model?.id);
          if (!id) continue;
          // Deprecated models are KEPT. The list narrows ADE's own picker, and
          // a model ADE is retiring still launches — dropping it here would
          // hide the reader's current selection from the picker that is
          // supposed to show it.
          rows.push({ id, label: text(model.label) ?? id, fastMode: model.fastMode === true });
        }
        return rows;
      })();
      return chatModelsPromise;
    },

    /**
     * The learning loop's numbers.
     *
     * DEGRADES to `null`, which the panel draws as an em-dash in every metric.
     * "Not measured" and "measured as zero" look different on screen, so the
     * degraded answer is not a lie.
     */
    async pageQualityReport() {
      if (!ready()) return null;
      try {
        return (await review("qualityReport", {})) ?? null;
      } catch (error) {
        deps.sdk?.log?.("debug", `Could not read the review quality report: ${error?.message ?? error}`);
        return null;
      }
    },

    /* ── Mutations ──────────────────────────────────────────────────────── */

    /**
     * Start a review.
     *
     * `{target, config}` arrives exactly as `review.startRun` takes it — the
     * page builds the compiled pair, so there is no translation here to drift.
     * The lane is checked because it is the one field whose absence the engine
     * reports as an opaque failure rather than as a sentence a form can print.
     */
    async pageStartRun(args) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const target = args?.target && typeof args.target === "object" ? args.target : null;
      const config = args?.config && typeof args.config === "object" ? args.config : null;
      if (!target || !text(target.laneId)) {
        return { ok: false, message: "Choose a lane before launching a review." };
      }
      if (target.mode === "pr" && !text(target.prId)) {
        return { ok: false, message: "This pull request is not linked in ADE yet." };
      }
      try {
        const result = await review("startRun", { target, config: config ?? undefined });
        const runId = runIdOf(result);
        if (!runId) return { ok: false, message: "Review launch did not return a run id." };
        // The page and the panels are two views of the same runs, so the child's
        // own cache and its published rows follow the launch immediately rather
        // than waiting for the next poll.
        deps.setCurrentRunId?.(runId);
        await deps.refreshRuns?.({ force: true, detail: true });
        return { ok: true, message: "Review started.", runId };
      } catch (error) {
        return failure(error, "Could not start that review.");
      }
    },

    async pageRerun(args) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const runId = text(args?.runId);
      if (!runId) return { ok: false, message: "Pick a run to rerun." };
      try {
        const result = await review("rerun", { runId });
        const nextId = runIdOf(result);
        if (!nextId) return { ok: false, message: "Review rerun did not return a run id." };
        deps.setCurrentRunId?.(nextId);
        await deps.refreshRuns?.({ force: true, detail: true });
        return { ok: true, message: "Rerun started.", runId: nextId };
      } catch (error) {
        return failure(error, "Could not rerun that review.");
      }
    },

    async pageCancelRun(args) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const runId = text(args?.runId);
      if (!runId) return { ok: false, message: "Pick a run to cancel." };
      try {
        await review("cancelRun", { runId });
        await deps.refreshRuns?.({ force: true, detail: true });
        return { ok: true, message: "Cancelled." };
      } catch (error) {
        return failure(error, "Could not cancel that run.");
      }
    },

    /**
     * Acknowledge, dismiss, snooze or suppress one finding.
     *
     * The suppression scope goes through `index.js`'s own reader, which is what
     * the agent tool and the panel button already use — an unrecognised scope is
     * REFUSED rather than widened to the repo, because silencing more than the
     * caller asked is the one wrong answer that leaves no trace.
     */
    async pageRecordFeedback(args) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const findingId = text(args?.findingId);
      if (!findingId) return { ok: false, message: "Pick a finding." };
      const kind = text(args?.kind) ?? "acknowledge";
      const suppression = deps.readSuppression ? deps.readSuppression(args) : args?.suppression ?? null;
      if (suppression?.invalid) {
        return {
          ok: false,
          message: `“${suppression.invalid}” is not a suppression scope. Use repo, path, or global.`,
        };
      }
      try {
        await review("recordFeedback", {
          findingId,
          kind,
          reason: text(args?.reason),
          note: text(args?.note),
          snoozeDurationMs: Number.isFinite(args?.snoozeDurationMs) ? args.snoozeDurationMs : undefined,
          suppression,
        });
        // The panel's copy of this run has to change too: a dismissed finding
        // that stays bold on the phone is the drift the page tier exists to
        // avoid.
        const runId = text(args?.runId) ?? deps.currentRunId?.();
        if (runId) await deps.refreshRun?.({ runId, silent: true });
        return { ok: true, message: "Saved." };
      } catch (error) {
        return failure(error, "Could not record that feedback.");
      }
    },

    async pageDeleteSuppression(args) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const suppressionId = text(args?.suppressionId);
      if (!suppressionId) return { ok: false, message: "Pick a suppression to remove." };
      try {
        await review("deleteSuppression", { suppressionId });
        return { ok: true, message: "Removed." };
      } catch (error) {
        return failure(error, "Could not remove that suppression.");
      }
    },
  };

  return pageActions;
}

module.exports = {
  MAX_RUNS,
  MAX_SUPPRESSIONS,
  STARTING_UP,
  createPageActions,
  launchLane,
  rows,
  runIdOf,
};
