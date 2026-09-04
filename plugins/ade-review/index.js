// ade-review — ADE's AI review product as a plugin, built out of public parts.
//
// The compiled Review tab is a desktop page over the `review.*` action domain.
// From 2.0.0 this package IS that page: `page/` builds a React app the host
// draws in a `webview` surface, and it draws the compiled runs browser, the
// findings, the learnings and the launch form unchanged.
//
// The vocabulary panels stay beside it, and they are not a leftover. A
// `webview` surface is desktop-and-web only — `parseSurfaces` refuses
// `mobile: true` on one — so the phone and the terminal render the `runs` and
// `run` panels this file publishes, which is the only Review UI those clients
// have ever had.
//
//   * the run list is a `webview` surface — the rail tab — drawing the page,
//     with the `runs` panel behind it for every other client;
//   * launch is a second `webview` surface (an anchored popover) plus the
//     `launch` panel, and both call `review.startRun` with the same
//     target/config the compiled dialog sent;
//   * findings and learnings are bound rows over this plugin's collections;
//   * the PR "ADE review" button is a `toolbar-action` on `prs` that opens the
//     launch page.
//
// The host brain stays. This child only shapes rows, answers the page's reads
// and invokes verbs ADE already answers. `official: true` marks the bundled
// package; it buys no extra SDK.

"use strict";

const {
  COLLECTION_FINDINGS,
  COLLECTION_RUNS,
  COLLECTION_SUPPRESSIONS,
  PANEL_LAUNCH,
  PANEL_LEARNINGS,
  PANEL_RUN,
  PANEL_RUNS,
  findingRow,
  findingRowKey,
  readString,
  runRow,
  runRowKey,
  suppressionRow,
  suppressionRowKey,
} = require("./format");
const { build } = require("./panels");
const { buildTargetConfig, readLaunchForm, readRunId, validationMessage } = require("./launch");
const { createPageActions } = require("./pageActions");

const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;
const RUN_CACHE_MS = 8_000;
const LIVE_POLL_MS = 2_500;
const SNOOZE_SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let sdk = null;
let disposed = false;
const subscriptions = [];
let cache = { at: 0, runs: [], launchContext: null };
let currentRunId = null;
let currentFindingId = null;
let launchDraft = null;
let pollTimer = null;

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

function failureMessage(error, fallback) {
  return error?.message ?? (typeof error === "string" ? error : fallback);
}

async function invokeReview(action, args = {}) {
  return sdk.actions.invoke("review", action, args);
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
  if (panelId === PANEL_RUNS) {
    const runs = cache.runs;
    const lanes = new Map();
    let active = 0;
    for (const run of runs) {
      if (run.status === "queued" || run.status === "running") active += 1;
      const laneId = readString(run.laneId);
      if (laneId && !lanes.has(laneId)) {
        lanes.set(laneId, { id: laneId, name: readString(run.targetLabel) ?? laneId });
      }
    }
    return {
      hasRuns: runs.length > 0,
      counts: { active },
      laneOptions: [...lanes.values()],
    };
  }
  if (panelId === PANEL_RUN) {
    const run = cache.runs.find((row) => row.id === currentRunId) ?? null;
    const finding = Array.isArray(run?.findings)
      ? run.findings.find((row) => row.id === currentFindingId) ?? null
      : null;
    return { run, finding };
  }
  if (panelId === PANEL_LAUNCH) {
    return {
      lanes: cache.launchContext?.lanes ?? [],
      commits: launchDraft?.laneId
        ? cache.launchContext?.recentCommitsByLane?.[launchDraft.laneId] ?? []
        : [],
      form: launchDraft,
    };
  }
  if (panelId === PANEL_LEARNINGS) {
    return { report: cache.qualityReport ?? null };
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
  const existing = await sdk.collections.list(collection, { limit: 400 }).catch(() => []);
  for (const row of existing) {
    if (wanted.has(row.key)) continue;
    await sdk.collections.delete(collection, row.key).catch(() => {});
  }
}

function stopPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll() {
  stopPoll();
  const live = cache.runs.some((run) => run.status === "queued" || run.status === "running");
  if (!live || disposed) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshRuns({ force: true }).catch((error) => {
      log("debug", `Live review poll failed: ${error?.message ?? error}`);
    });
  }, LIVE_POLL_MS);
}

async function publishRunRows(runs) {
  const wanted = new Map();
  runs.forEach((run, index) => {
    const row = runRow(run, index);
    if (row) wanted.set(runRowKey(index, run.id), row);
  });
  await replaceCollection(COLLECTION_RUNS, wanted);
}

async function publishFindingRows(detail) {
  const wanted = new Map();
  const findings = Array.isArray(detail?.findings) ? detail.findings : [];
  for (const finding of findings) {
    const row = findingRow(finding);
    if (!row) continue;
    wanted.set(findingRowKey(detail.id, finding.id), row);
  }
  const existing = await sdk.collections.list(COLLECTION_FINDINGS, {
    keyPrefix: `finding:${detail.id}:`,
    limit: 400,
  }).catch(() => []);
  for (const [key, value] of wanted) {
    try {
      await sdk.collections.put(COLLECTION_FINDINGS, key, value, { ifFull: "evictOldest" });
    } catch (error) {
      log("warn", `Could not store finding ${key}: ${error?.message ?? error}`);
    }
  }
  for (const row of existing) {
    if (wanted.has(row.key)) continue;
    await sdk.collections.delete(COLLECTION_FINDINGS, row.key).catch(() => {});
  }
}

async function refreshRuns(options = {}) {
  if (!sdk || disposed) return { runs: [] };
  const now = Date.now();
  if (!options.force && cache.runs.length && now - cache.at < RUN_CACHE_MS) {
    await publish(PANEL_RUNS);
    return { runs: cache.runs };
  }
  try {
    const listed = await invokeReview("listRuns", { limit: 100, status: "all" });
    const runs = Array.isArray(listed) ? listed : Array.isArray(listed?.runs) ? listed.runs : [];
    cache = { ...cache, at: now, runs };
    await publishRunRows(runs);
    await publish(PANEL_RUNS);
    if (currentRunId) {
      const still = runs.find((run) => run.id === currentRunId);
      if (still && (still.status === "queued" || still.status === "running" || options.detail)) {
        await refreshRun({ runId: currentRunId, silent: true });
      }
    }
    schedulePoll();
    return { runs };
  } catch (error) {
    await publishSchema(PANEL_RUNS, build(PANEL_RUNS, {
      state: "error",
      error: failureMessage(error, "Could not load review runs."),
    }));
    return { runs: [], error: failureMessage(error, "Could not load review runs.") };
  }
}

async function refreshRun(args = {}) {
  const runId = readString(args.runId) ?? readString(args.context?.runId) ?? currentRunId;
  if (!runId) return { navigate: { panelId: PANEL_RUNS } };
  currentRunId = runId;
  try {
    const detail = await invokeReview("getRunDetail", { runId });
    if (!detail) {
      await publishSchema(PANEL_RUN, build(PANEL_RUN, { error: "That run is not in this project." }));
      return { navigate: { panelId: PANEL_RUN, context: { runId } } };
    }
    cache.runs = cache.runs.map((run) => (run.id === runId ? { ...run, ...detail } : run));
    if (!cache.runs.some((run) => run.id === runId)) cache.runs.unshift(detail);
    await publishFindingRows(detail);
    await publish(PANEL_RUN);
    return { navigate: { panelId: PANEL_RUN, context: { runId } } };
  } catch (error) {
    await publishSchema(PANEL_RUN, build(PANEL_RUN, {
      error: failureMessage(error, "Could not load this run."),
    }));
    return { navigate: { panelId: PANEL_RUN, context: { runId } }, ok: false };
  }
}

async function loadLaunchContext() {
  try {
    cache.launchContext = await invokeReview("listLaunchContext", {});
  } catch (error) {
    log("warn", `Could not load review launch context: ${error?.message ?? error}`);
    cache.launchContext = cache.launchContext ?? { lanes: [], recentCommitsByLane: {} };
  }
  return cache.launchContext;
}

function defaultLaunchForm(context) {
  const lanes = cache.launchContext?.lanes ?? [];
  const fromPr = context?.kind === "pr";
  const laneId = fromPr
    ? readString(context.laneId)
    : readString(context?.laneId) ?? readString(cache.launchContext?.defaultLaneId) ?? lanes[0]?.id ?? null;
  return {
    laneId,
    targetMode: fromPr ? "pr" : "lane_diff",
    compareKind: "default_branch",
    compareLaneId: null,
    baseCommit: null,
    headCommit: null,
    prId: fromPr ? readString(context.id) : null,
    modelId: readString(cache.launchContext?.recommendedModelId),
    reasoningEffort: "low",
    fastMode: false,
    publishBehavior: fromPr ? "auto_publish" : "local_only",
  };
}

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;
  subscriptions.push(sdk.events.on("lane.changed", () => {
    cache.at = 0;
    void refreshRuns({ force: true });
  }));
  await publishSchema(PANEL_RUNS, build(PANEL_RUNS, { hasRuns: false }));
  await refreshRuns({ force: true }).catch((error) => {
    log("warn", `The first review read failed: ${error?.message ?? error}`);
  });
};

exports.deactivate = async () => {
  disposed = true;
  stopPoll();
  while (subscriptions.length) {
    try {
      subscriptions.pop()?.();
    } catch { /* unsubscribe on the way out is not worth a crash */ }
  }
  sdk = null;
};

const ownActions = {
  async refreshRuns() {
    const result = await refreshRuns({ force: true });
    if (result.error) return { message: result.error, ok: false };
    return { message: `${result.runs.length} review run${result.runs.length === 1 ? "" : "s"}.` };
  },

  async openRuns() {
    void refreshRuns();
    return { navigate: { panelId: PANEL_RUNS } };
  },

  async openRun(args) {
    return await refreshRun(args);
  },

  async refreshRun(args) {
    return await refreshRun(args);
  },

  async openLaunch(args) {
    await loadLaunchContext();
    launchDraft = { ...defaultLaunchForm(args?.context), ...readLaunchForm(args) };
    await publish(PANEL_LAUNCH);
    return { navigate: { panelId: PANEL_LAUNCH } };
  },

  async openLaunchFromPr(args) {
    return await exports.actions.openLaunch(args);
  },

  async redrawLaunch(args) {
    await loadLaunchContext();
    launchDraft = { ...(launchDraft ?? defaultLaunchForm(args?.context)), ...readLaunchForm(args) };
    await publish(PANEL_LAUNCH);
    return {};
  },

  async startRun(args) {
    await loadLaunchContext();
    const form = { ...(launchDraft ?? defaultLaunchForm(args?.context)), ...readLaunchForm(args) };
    const invalid = validationMessage(form);
    if (invalid) return { message: invalid, ok: false };
    try {
      const payload = buildTargetConfig(form);
      const result = await invokeReview("startRun", payload);
      const runId = readRunId(result);
      if (!runId) return { message: "Review launch did not return a run id.", ok: false };
      currentRunId = runId;
      await refreshRuns({ force: true, detail: true });
      await refreshRun({ runId });
      return {
        message: "Review started.",
        navigate: { panelId: PANEL_RUN, context: { runId } },
      };
    } catch (error) {
      return { message: failureMessage(error, "Could not start that review."), ok: false };
    }
  },

  async rerun(args) {
    const runId = readString(args?.runId) ?? currentRunId;
    if (!runId) return { message: "Pick a run to rerun.", ok: false };
    try {
      const result = await invokeReview("rerun", { runId });
      const nextId = readRunId(result);
      if (!nextId) return { message: "Review rerun did not return a run id.", ok: false };
      currentRunId = nextId;
      await refreshRuns({ force: true, detail: true });
      await refreshRun({ runId: nextId });
      return { message: "Rerun started.", navigate: { panelId: PANEL_RUN, context: { runId: nextId } } };
    } catch (error) {
      return { message: failureMessage(error, "Could not rerun that review."), ok: false };
    }
  },

  async cancelRun(args) {
    const runId = readString(args?.runId) ?? currentRunId;
    if (!runId) return { message: "Pick a run to cancel.", ok: false };
    try {
      await invokeReview("cancelRun", { runId });
      await refreshRuns({ force: true, detail: true });
      return { message: "Cancelled." };
    } catch (error) {
      return { message: failureMessage(error, "Could not cancel that run."), ok: false };
    }
  },

  async openChat(args) {
    const runId = readString(args?.runId) ?? currentRunId;
    const run = cache.runs.find((row) => row.id === runId) ?? null;
    const sessionId = readString(run?.chatSessionId);
    if (!sessionId) return { message: "This run has no transcript yet.", ok: false };
    return { message: `Transcript is session ${sessionId}.`, navigate: { target: "tools-pane" } };
  },

  async acknowledgeFinding(args) {
    return await recordFeedback({ findingId: args?.findingId, kind: "acknowledge" });
  },

  async dismissFinding(args) {
    return await recordFeedback({
      findingId: args?.findingId,
      kind: "dismiss",
      reason: readString(args?.reason) ?? "not_a_bug",
    });
  },

  async snoozeFinding(args) {
    return await recordFeedback({
      findingId: args?.findingId,
      kind: "snooze",
      snoozeDurationMs: SNOOZE_SEVEN_DAYS_MS,
    });
  },

  async suppressFinding(args) {
    return await recordFeedback({
      findingId: args?.findingId,
      kind: "suppress",
      suppression: { scope: readString(args?.scope) ?? "repo" },
    });
  },

  async recordFeedback(args) {
    return await recordFeedback(args);
  },

  async copyFinding(args) {
    const findingId = readString(args?.findingId);
    const run = cache.runs.find((row) => row.id === currentRunId);
    const finding = Array.isArray(run?.findings)
      ? run.findings.find((row) => row.id === findingId)
      : null;
    if (!finding) return { message: "That finding is not on this run.", ok: false };
    const text = [`${finding.severity?.toUpperCase() ?? "INFO"}: ${finding.title}`, finding.body]
      .filter(Boolean)
      .join("\n\n");
    try {
      await sdk.clipboard.write(text);
      return { message: "Copied." };
    } catch (error) {
      return { message: failureMessage(error, "Could not copy that finding."), ok: false };
    }
  },

  async openLearnings() {
    try {
      cache.qualityReport = await invokeReview("qualityReport", {});
      const listed = await invokeReview("listSuppressions", { limit: 100 });
      const items = Array.isArray(listed) ? listed : Array.isArray(listed?.suppressions) ? listed.suppressions : [];
      const wanted = new Map();
      for (const item of items) {
        const row = suppressionRow(item);
        if (row) wanted.set(suppressionRowKey(item.id), row);
      }
      await replaceCollection(COLLECTION_SUPPRESSIONS, wanted);
      await publish(PANEL_LEARNINGS);
      return { navigate: { panelId: PANEL_LEARNINGS } };
    } catch (error) {
      return { message: failureMessage(error, "Could not load learnings."), ok: false };
    }
  },

  async refreshLearnings() {
    return await exports.actions.openLearnings();
  },

  async deleteSuppression(args) {
    const suppressionId = readString(args?.suppressionId);
    if (!suppressionId) return { message: "Pick a suppression to remove.", ok: false };
    try {
      await invokeReview("deleteSuppression", { suppressionId });
      return await exports.actions.openLearnings();
    } catch (error) {
      return { message: failureMessage(error, "Could not remove that suppression."), ok: false };
    }
  },

  async listRunsTool(args) {
    const listed = await invokeReview("listRuns", {
      laneId: readString(args?.laneId),
      status: readString(args?.status) ?? "all",
      limit: Number(args?.limit) || 50,
    });
    return { runs: Array.isArray(listed) ? listed : listed?.runs ?? [] };
  },

  async getRunTool(args) {
    const runId = readString(args?.runId);
    if (!runId) return { message: "Name a run id.", ok: false };
    return await invokeReview("getRunDetail", { runId });
  },

  async runs() {
    return await exports.actions.listRunsTool({});
  },

  async launch(args) {
    if (Array.isArray(args?.argv) && args.argv.length > 1) {
      return await exports.actions.startRun(Object.fromEntries(
        args.argv.slice(1).flatMap((token, index, list) => {
          if (!token.startsWith("--")) return [];
          const key = token.slice(2);
          const next = list[index + 1];
          return [[key, next && !next.startsWith("--") ? next : true]];
        }),
      ));
    }
    return await exports.actions.openLaunch(args);
  },

  async learnings() {
    return await exports.actions.openLearnings();
  },
};

/**
 * What the plugin's own HTML page invokes. See `pageActions.js`.
 *
 * `deps` is read through getters because this table is built at LOAD and `sdk`
 * is null until `activate` runs: a page that opens before the first read
 * resolves must still find a real handler. `readSuppression` is passed rather
 * than reimplemented so the page, the panel button and the agent tool all
 * refuse an unknown scope with the same sentence.
 */
const pageActions = createPageActions({
  get sdk() { return sdk; },
  refreshRuns,
  refreshRun,
  readSuppression,
  currentRunId: () => currentRunId,
  setCurrentRunId(next) { currentRunId = next; },
});

/**
 * The action table the host dispatches into.
 *
 * Two DISJOINT halves: this file's own ids — the four tools, the three CLI
 * words, and every press a vocabulary row can make — and the page's `page*`
 * ids. No id is defined by both, and `test/pageActions.test.js` asserts it, so
 * a collision cannot silently pick a winner.
 */
exports.actions = { ...ownActions, ...pageActions };

/** The three scopes a suppression may claim. Anything else is a typo. */
const SUPPRESSION_SCOPES = ["repo", "path", "global"];

/**
 * The suppression the caller meant, from either shape it may arrive in.
 *
 * The panel's own button builds `{suppression: {scope}}`. The agent tool
 * declares a flat `suppressionScope` string, because a tool input is what a
 * model fills in and a one-level object is what it fills in reliably. Both are
 * the same request, so both resolve here rather than only the first: the tool's
 * field was declared and then never read, which made every model-driven
 * suppression a repo-wide one whatever the model asked for.
 */
function readSuppression(args) {
  if (args?.suppression && typeof args.suppression === "object") return args.suppression;
  const scope = readString(args?.suppressionScope);
  if (!scope) return null;
  // An unrecognised scope is refused rather than widened to the default: the
  // caller asked to silence a finding, and silencing MORE than they asked is
  // the one wrong answer that leaves no trace.
  if (!SUPPRESSION_SCOPES.includes(scope)) return { invalid: scope };
  return { scope };
}

async function recordFeedback(args) {
  const findingId = readString(args?.findingId);
  if (!findingId) return { message: "Pick a finding.", ok: false };
  const suppression = readSuppression(args);
  if (suppression?.invalid) {
    return {
      message: `“${suppression.invalid}” is not a suppression scope. Use repo, path, or global.`,
      ok: false,
    };
  }
  try {
    await invokeReview("recordFeedback", {
      findingId,
      kind: readString(args?.kind) ?? "acknowledge",
      reason: readString(args?.reason),
      note: readString(args?.note),
      snoozeDurationMs: Number.isFinite(args?.snoozeDurationMs) ? args.snoozeDurationMs : undefined,
      suppression,
    });
    if (currentRunId) await refreshRun({ runId: currentRunId });
    return { message: "Saved." };
  } catch (error) {
    return { message: failureMessage(error, "Could not record that feedback."), ok: false };
  }
}

exports.__internals = {
  viewFor,
  publish,
  refreshRuns,
  ownActions,
  pageActions,
  readSuppression,
  cacheRef: () => cache,
  setCache(next) {
    cache = { ...cache, ...next };
  },
};
