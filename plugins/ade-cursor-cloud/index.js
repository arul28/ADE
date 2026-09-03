// ade-cursor-cloud — Cursor Cloud as an ADE plugin, built out of public parts.
//
// The whole of Cursor Cloud used to be four features wired into ADE's core: a
// fleet panel in a modal, a chat runtime hard-switched inside
// `agentChatService`, a webhook drain with its own sqlite table, and a machine
// row in the composer's launch shelf. This package is the same four features
// with nothing privileged left in them:
//
//   * the fleet is a `tab` surface plus a `work-rail-pane`, drawn from a
//     vocabulary panel bound to this plugin's own `fleet` collection;
//   * the chat runtime is a declared `chatRuntimes` entry and the `ade.chat.*`
//     seam — the user's turns arrive as `chat.turn`, the replies stream back;
//   * the webhook is a declared `webhookIngress` channel at ADE's relay, and
//     the events arrive as `webhook.received` with an ack;
//   * the launch path is a `machine-entry` row in the composer's OWN machine
//     picker that claims Send (`ownsSend`) and opens an Advanced page for
//     secrets, model params, and the PR toggle — the same row the built-in
//     composer drew, now a public socket;
//   * the fleet, the agent and the launch form are also `webview` surfaces, and
//     `pageActions.js` is what those pages read.
//
// Nothing here needs `official: true`. A community author could write every
// line of it, which is the test the extraction was for.
//
// Where the work happens: everything expensive runs on the machine that holds
// the Cursor key, and every client draws rows this process already shaped. That
// is what makes the fleet appear on the phone, the web client and the TUI —
// none of which the built-in modal ever reached.

"use strict";

const { CursorApiError, createCursorApi, isMissingKeyError } = require("./cursorApi");
const {
  assembleFleet,
  createOriginCache,
  fleetRow,
  fleetRowKey,
  groupFleet,
  laneOptions,
} = require("./fleet");
const {
  ALL_AGENTS_URL,
  agentWebUrl,
  fleetDisplayStatus,
  formatAge,
  isFleetEntryActive,
} = require("./format");
const {
  buildAgentPanel,
  buildFleetPanel,
  buildLaunchPanel,
  fleetFooter,
  formatWebhookLastEvent,
} = require("./panels");
const {
  agentNameFromPrompt,
  buildCreateRequest,
  clearIdempotencyKey,
  collectSecretValues,
  ensureExistingLaneOriginReady,
  findConnectedRepo,
  idempotencyKeyFor,
  isInjectableSecretName,
  laneSecretsKey,
  launchUnavailableReason,
  MAX_ATTACHED_SECRETS,
  readComposerLaunch,
  readLaunchForm,
  resolvePrCreateFields,
} = require("./launch");
const { createPageActions } = require("./pageActions");
const { catalogControlOptions, readCatalog, verifyCreateModel } = require("./modelSelection");
const { createChatRuntime } = require("./runtime");
const { clampFleetBudget } = require("./repoMatch");
const tabBadge = require("./tabBadge");

/** How long a fleet read is believed before an action refetches it. */
const FLEET_CACHE_MS = 20_000;
/** Attempts to publish a panel before giving up until the next action. */
const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;

let sdk = null;
let api = null;
let runtime = null;
let originCache = null;
let disposed = false;
/** Unsubscribe functions for every event this plugin listens to. */
const subscriptions = [];

/** Finished runs the reader has not opened the fleet for. Cleared on view. */
let unreadFinished = 0;
/** How many hosts currently have the fleet panel on screen. */
let fleetViewers = 0;

/** The last assembled fleet, so an action does not refetch what it just read. */
let cache = { at: 0, grouped: null, items: [], archivedCount: 0, lanes: [], webhookUrl: null };

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

/**
 * Where the unread count survives a reload.
 *
 * The badge ROW is durable — the host stores it and every client reads it — but
 * the count behind it lived in module memory. So a reload left the row saying 5
 * with the counter at 0, and the next finished agent published 1: the reader
 * watched a badge count DOWN as more work finished. `deliveries` is this
 * plugin's one unsynced collection, which is what this is: an unread mark
 * belongs to the machine the reader is sitting at, not to the fleet.
 */
const UNREAD_COLLECTION = "deliveries";
const UNREAD_KEY = "badge:unread-finished";

async function readStoredUnread() {
  const row = await sdk?.collections.get(UNREAD_COLLECTION, UNREAD_KEY).catch(() => null);
  const raw = row && typeof row === "object" ? row.count : row;
  return tabBadge.nextUnreadCount(0, raw);
}

async function storeUnread(count) {
  await sdk?.collections
    .put(UNREAD_COLLECTION, UNREAD_KEY, { count }, { ifFull: "evictOldest" })
    .catch((error) => {
      // A count this plugin could not store reconciles to whatever it CAN read
      // on the next activate. Never worth failing the badge over.
      log("debug", `Could not store the unread count: ${error?.message ?? error}`);
    });
}

async function publishTabBadge() {
  if (!sdk) return;
  await storeUnread(unreadFinished);
  try {
    await sdk.contributions.publish(
      "surface",
      tabBadge.TAB_ENTITY_ID,
      "row-badge",
      tabBadge.tabBadgePayload(unreadFinished),
    );
  } catch (error) {
    log("debug", `Could not publish the tab badge: ${error?.message ?? error}`);
  }
}

async function clearTabBadge() {
  unreadFinished = 0;
  await publishTabBadge();
}

/**
 * Bring the count and the published row back into agreement, once, on activate.
 *
 * Republishes unconditionally rather than only on a mismatch: this plugin
 * cannot READ its published contribution, so "the row already says 3" is not a
 * fact it has. One publish of a value it does know is cheaper than a badge that
 * lies until the next finish.
 */
async function reconcileTabBadge() {
  unreadFinished = await readStoredUnread();
  await publishTabBadge();
}

/* ── The host, as this plugin uses it ────────────────────────────────────── */

/**
 * The agent→session index.
 *
 * ADE's own session store answers "which plugin owns this session"; it does not
 * answer "which cloud agent is this". Cursor cannot answer it either — `POST
 * /v1/agents` refuses `metadata` — so the binding lives here, in a collection
 * this plugin owns and sync replicates.
 */
const links = {
  async get(agentId) {
    return (await sdk.collections.get("sessions", `agent:${agentId}`)) ?? null;
  },
  async set(agentId, value) {
    try {
      await sdk.collections.put("sessions", `agent:${agentId}`, value, { ifFull: "evictOldest" });
    } catch (error) {
      // A session link this plugin could not store is one row it will rebuild
      // on the next open. Never fatal: the chat itself already exists.
      log("warn", `Could not record the session link: ${error?.message ?? error}`);
    }
  },
  async list() {
    const rows = await sdk.collections.list("sessions", { keyPrefix: "agent:", limit: 500 });
    return rows.map((row) => row.value).filter(Boolean);
  },
};

/**
 * Webhook deliveries this plugin has already acted on.
 *
 * A bounded cache with the platform holding the bound: `evictOldest` drops the
 * oldest ids in this collection alone when it fills, so an ingress that has run
 * for a year cannot push the fleet rows out of the store beside it. That is the
 * whole argument for giving it a collection of its own.
 */
const deliveries = {
  async has(deliveryId) {
    return Boolean(await sdk.collections.get("deliveries", `id:${deliveryId}`).catch(() => null));
  },
  async add(deliveryId, value) {
    await sdk.collections
      .put("deliveries", `id:${deliveryId}`, value, { ifFull: "evictOldest" })
      .catch((error) => {
        // A delivery id this plugin could not record is one automation that may
        // fire twice if the ack is also lost. Worth a line, never worth failing
        // the delivery — the status update itself already landed.
        log("warn", `Could not record delivery ${deliveryId}: ${error?.message ?? error}`);
      });
  },
};

/** The slice of the SDK `runtime.js` is written against. */
function chatHost() {
  return {
    chat: sdk.chat,
    automations: sdk.automations,
    webhooks: sdk.webhooks,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

/* ── Reading ADE ─────────────────────────────────────────────────────────── */

async function listLanes() {
  const result = await sdk.actions.invoke("lane", "list", {});
  return Array.isArray(result) ? result : Array.isArray(result?.lanes) ? result.lanes : [];
}

/**
 * One lane's `origin` URL and the branch Cursor would clone.
 *
 * `git.getOriginRemote` is lane-scoped — it reads `remote.origin.url` inside
 * that lane's worktree, because `extensions.worktreeConfig` lets a lane
 * override it — and answers `{remoteUrl, branch}`. Calling it with no `laneId`
 * answers the empty fallback, which is why every caller here names a lane.
 */
async function readLaneRemote(laneId) {
  const result = await sdk.actions.invoke("git", "getOriginRemote", { laneId });
  if (typeof result === "string") return { remoteUrl: result, branch: null };
  return {
    remoteUrl: result?.remoteUrl ?? result?.url ?? result?.remote ?? result?.originRemote ?? null,
    branch: result?.branch ?? null,
  };
}

/**
 * This project's `origin`, for the fleet's repo matching.
 *
 * Every lane of one project is a worktree of one repository, so the first lane
 * answers for all of them. A project with no lane has no remote to match
 * against, and the fleet then holds only the agents a chat here owns.
 */
async function getOriginRemote() {
  const lanes = await listLanes().catch(() => []);
  const laneId = lanes.find((lane) => typeof lane?.id === "string" && lane.id)?.id ?? null;
  if (!laneId) return null;
  return (await readLaneRemote(laneId)).remoteUrl;
}

/* ── Publishing ──────────────────────────────────────────────────────────── */

/**
 * Replace a panel's schema, retrying while no project is attached.
 *
 * Panel writes are project-scoped and the plugin host is machine-scoped, so at
 * cold start this can run before any project is open. Letting it throw out of
 * `activate` would read as a crash and start the restart backoff.
 */
async function publish(panelId, schema, attempt = 1) {
  if (!sdk || disposed) return;
  try {
    await sdk.panels.update(panelId, schema);
  } catch (error) {
    if (attempt >= PUBLISH_ATTEMPTS) {
      log("warn", `Could not publish the ${panelId} panel: ${error?.message ?? error}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    await publish(panelId, schema, attempt + 1);
  }
}

/**
 * Write the grouped rows into the `fleet` collection and remove what left.
 *
 * Stale keys are deleted rather than left: a row for an agent that is no longer
 * in the fleet would still render, and the reader has no way to tell a stale
 * row from a live one. Deletes are never budget-checked, so this half can never
 * be the thing that fails.
 */
async function publishRows(grouped, now) {
  const wanted = new Map();
  grouped.active.forEach((entry, index) => {
    wanted.set(fleetRowKey("active", index, entry.agent.agentId), fleetRow(entry, { now }));
  });
  let laneIndex = 0;
  for (const group of grouped.lanes) {
    for (const entry of group.entries) {
      wanted.set(fleetRowKey("lane", laneIndex++, entry.agent.agentId), fleetRow(entry, { now }));
    }
  }
  let unlinkedIndex = 0;
  for (const group of grouped.unlinked) {
    for (const entry of group.entries) {
      wanted.set(fleetRowKey("unlinked", unlinkedIndex++, entry.agent.agentId), fleetRow(entry, { now }));
    }
  }

  for (const [key, value] of wanted) {
    try {
      await sdk.collections.put("fleet", key, value, { ifFull: "evictOldest" });
    } catch (error) {
      // Prune, retry once, then skip the row and carry on — the store being
      // full costs the newest row and never the panel.
      log("warn", `Could not store fleet row ${key}: ${error?.message ?? error}`);
    }
  }

  const existing = await sdk.collections.list("fleet", { limit: 400 }).catch(() => []);
  for (const row of existing) {
    if (wanted.has(row.key)) continue;
    await sdk.collections.delete("fleet", row.key).catch(() => {});
  }
}

/**
 * The host's delivery ledger for this plugin, as the fleet panel draws it.
 *
 * `webhooks.status()` is the same row Linear's settings strip already uses.
 * This channel has no `verify`, so there is no signing-secret row — only
 * whether the relay is configured, whether events are arriving, and the URL
 * to paste into Cursor.
 */
async function readWebhookSnapshot() {
  const host = sdk;
  if (!host) return null;
  const status = await host.webhooks.status().catch(() => null);
  const url = await host.webhooks.url("cursor").catch(() => null);
  cache.webhookUrl = typeof url === "string" && url.trim() ? url.trim() : null;
  if (!status && !cache.webhookUrl) return null;
  const state = status?.state;
  let caption = "Webhook";
  let tone = "neutral";
  if (state === "ready") {
    caption = "Endpoint ready";
  } else if (state === "error") {
    caption = "Live updates hit an error";
    tone = "warning";
  } else if (state === "unconfigured" || state === "undeclared" || !state) {
    caption = "Live updates not configured yet";
    tone = "warning";
  }
  const drainError = typeof status?.lastError === "string" && status.lastError.trim()
    ? status.lastError.trim()
    : null;
  return {
    status: caption,
    tone,
    // The machine-readable half of the same fact. The panel draws `status`; a
    // page branches on `state`, and `CloudWebhookState` declares all three of
    // "ready" / "error" / "unconfigured" — so an `undeclared` host, which is a
    // distinction only the host cares about, reads as unconfigured here.
    state: state === "ready" ? "ready" : state === "error" ? "error" : "unconfigured",
    lastEvent: formatWebhookLastEvent(status?.lastReceivedAt),
    pendingDeliveries: Number(status?.pendingDeliveries) || 0,
    drainError,
    url: cache.webhookUrl,
  };
}

/**
 * The whole fleet read: Cursor, then the lanes, then the rows, then the panel.
 *
 * One function rather than four, because every entry point wants all of it —
 * the refresh gesture, the automation step, the webhook that just changed a
 * status, and the `activate` that has nothing on screen yet.
 */
async function refreshFleet(options = {}) {
  // The client is captured, not re-read. Almost every caller is a
  // fire-and-forget `void refreshFleet()`, so `deactivate` can land between two
  // of the awaits below — and a `disposed` check alone would not stop the read
  // already in flight from dereferencing a client that is now null.
  const client = api;
  if (!sdk || !client || disposed) return { state: "loading" };
  const now = Date.now();
  const webhook = await readWebhookSnapshot();
  if (disposed) return { state: "loading" };

  if (!(await client.hasKey())) {
    cache = { at: now, grouped: null, items: [], archivedCount: 0, lanes: [], webhookUrl: cache.webhookUrl };
    await publish("fleet", buildFleetPanel({ state: "no-key", webhook }));
    return { state: "no-key" };
  }

  let assembled;
  try {
    assembled = await assembleFleet(
      { api: client, listLanes, originCache, listSessionLinks: links.list },
      { includeArchived: true, limit: clampFleetBudget(options.limit), now },
    );
  } catch (error) {
    if (isMissingKeyError(error)) {
      await publish("fleet", buildFleetPanel({ state: "no-key", webhook }));
      return { state: "no-key" };
    }
    log("warn", `Could not read the cloud fleet: ${error?.message ?? error}`);
    await publish("fleet", buildFleetPanel({
      state: "error",
      error: error?.message ?? String(error),
      webhook,
    }));
    return { state: "error", error: error?.message ?? String(error) };
  }

  if (disposed) return { state: "loading" };
  const grouped = groupFleet(assembled.items);
  cache = {
    at: now,
    grouped,
    items: assembled.items,
    archivedCount: assembled.archivedCount,
    lanes: laneOptions(assembled.items),
    webhookUrl: cache.webhookUrl,
  };
  await publishRows(grouped, now);

  const counts = {
    active: grouped.active.length,
    lanes: grouped.lanes.length,
    unlinked: grouped.unlinked.length,
    total: assembled.items.length,
    archived: assembled.archivedCount,
  };
  const schema = assembled.items.length === 0
    ? buildFleetPanel({ state: "empty", counts, webhook })
    : buildFleetPanel({
      state: "list",
      counts,
      laneOptions: cache.lanes,
      footer: fleetFooter({ shown: counts.total, age: "just now" }),
      webhook,
    });
  await publish("fleet", schema);
  return { state: assembled.items.length ? "list" : "empty", counts };
}

/** The cached fleet, refreshed when it is older than the cache window. */
async function fleetEntries() {
  if (Date.now() - cache.at > FLEET_CACHE_MS || !cache.grouped) await refreshFleet();
  return cache.items;
}

async function findEntry(agentId) {
  const entries = await fleetEntries();
  return entries.find((entry) => entry.agent.agentId === agentId) ?? null;
}

/** The lane an action should act in: the entry's own, else the caller's. */
function laneFor(entry, args) {
  return entry?.ownership?.laneId
    ?? (typeof args?.laneId === "string" ? args.laneId : null)
    ?? (args?.context?.kind === "composer" ? args.context.laneId : null)
    ?? (args?.context?.kind === "lane" ? args.context.id : null)
    ?? null;
}

/**
 * The cloud agent behind a chat, or null when the chat is somebody else's.
 *
 * Walks this plugin's own session index rather than asking ADE: the session
 * store answers "which plugin owns this" and the plugin owns the other half of
 * the mapping.
 */
async function agentForSession(args) {
  const sessionId = args?.context?.kind === "session" ? args.context.id : args?.sessionId ?? null;
  if (!sessionId) return null;
  const rows = await links.list().catch(() => []);
  return rows.find((row) => row?.sessionId === sessionId)?.agentId ?? null;
}

function requireAgentId(args) {
  const agentId = typeof args?.agentId === "string" ? args.agentId.trim() : "";
  if (!agentId) throw new Error("This action needs an agent id.");
  return agentId;
}

/** One sentence for whatever Cursor refused, worded for a banner. */
function failureMessage(error, fallback) {
  if (error instanceof CursorApiError || error?.code) return error.message ?? fallback;
  return error?.message ?? fallback;
}

/**
 * A successful launch, plus a draft-clear when Send produced it.
 *
 * `{composer: {replaceText: ""}}` is the platform's own "empty is meaningful
 * for replace" verb. Clearing here rather than in the composer means a failed
 * launch leaves the prompt on screen.
 */
function launchedFrom(fromComposer, result) {
  if (!fromComposer) return result;
  return { ...result, composer: { replaceText: "" } };
}


/* ── The launch, once ────────────────────────────────────────────────────── */

/**
 * Cursor's repositories, this lane's remote, and whether they meet.
 *
 * The two probes the compiled composer ran on every keystroke, run once per
 * launch here. Both are tri-state — loading, error, ready — because a probe in
 * flight and a probe that failed are different facts, and reporting either as
 * "this repo is not connected" is the bug `useCursorCloudDraftState` was
 * written to stop.
 */
async function launchProbe(laneId) {
  let repositories = [];
  let repoProbe = "ready";
  let repoProbeMessage = null;
  try {
    const listed = await api.listRepositories();
    repositories = Array.isArray(listed?.items) ? listed.items : [];
  } catch (error) {
    repoProbe = "error";
    repoProbeMessage = failureMessage(error, "Cursor Cloud request failed.");
  }

  let laneRemote = null;
  let branch = null;
  let remoteProbe = "ready";
  let remoteError = null;
  if (laneId) {
    try {
      const remote = await readLaneRemote(laneId);
      laneRemote = remote.remoteUrl;
      branch = remote.branch;
    } catch (error) {
      remoteProbe = "error";
      remoteError = error?.message ?? "The git remote read failed.";
    }
  }

  return {
    repositories,
    repoProbe,
    repoProbeMessage,
    laneRemote,
    branch,
    remoteProbe,
    remoteError,
    repoUrl: findConnectedRepo(repositories, laneRemote),
  };
}

/** The pull request already open on a lane's branch, or null. */
async function openPrFor(laneId, branch) {
  if (!laneId || !branch) return null;
  try {
    const result = await sdk.actions.invoke("git", "getOpenPrForBranch", { laneId, branch });
    const prUrl = typeof result?.prUrl === "string" ? result.prUrl.trim() : "";
    if (!prUrl) return null;
    return {
      prUrl,
      prNumber: Number.isFinite(result?.prNumber) ? result.prNumber : null,
      title: typeof result?.title === "string" ? result.title : null,
    };
  } catch (error) {
    // A repo whose PR host this machine has no credential for answers nothing.
    // A launch that refused over it would be a launch blocked by a decoration.
    log("debug", `Could not read the open PR: ${error?.message ?? error}`);
    return null;
  }
}

/** The PR toggle's stored position. The composer has no control for it. */
async function autoOpenPrSetting() {
  const config = await sdk.config.get().catch(() => ({}));
  return config?.autoOpenPr === true;
}

/** The secret names this lane last chose to attach. Names only, never values. */
async function rememberedSecretNames(laneId) {
  if (!laneId) return [];
  const remembered = await sdk.collections
    .get("laneSecrets", laneSecretsKey(laneId))
    .catch(() => null);
  return (Array.isArray(remembered?.names) ? remembered.names : [])
    .filter((name) => isInjectableSecretName(name))
    .slice(0, MAX_ATTACHED_SECRETS);
}

/**
 * The whole launch, for both gestures.
 *
 * The composer's Enter and the launch page's Submit are ONE act with two
 * doorways, and this is the act. Written as a straight port of
 * `AgentChatPane.tsx:launchCursorCloudRun` — the same order, the same probes,
 * the same idempotency memo, the same PR rule — so the two gestures can never
 * disagree about what a Cursor Cloud launch is.
 *
 * Answers `{ok, message, ...}` and never throws for anything Cursor, git or
 * GitHub refused: both callers are surfaces that draw a sentence.
 */
async function runLaunch(form) {
  const fromComposer = form.fromComposer === true;
  const prompt = typeof form.prompt === "string" ? form.prompt.trim() : "";
  if (!prompt) return { ok: false, message: "Say what the agent should do." };

  const lanes = await listLanes().catch(() => []);
  const lane = lanes.find((row) => row.id === form.laneId) ?? lanes[0] ?? null;

  const probe = await launchProbe(lane?.id ?? null);
  // The catalog is read before the ladder rather than after, because the
  // composer's model rung branches on whether Cursor's model list has loaded at
  // all — an empty catalog says "open the picker", a full one says "that model
  // is not one of these".
  let catalog = [];
  let catalogError = null;
  try {
    const listed = await api.listModels();
    catalog = readCatalog(listed?.items);
  } catch (error) {
    catalogError = error?.message ?? "Cursor's model catalog did not load";
  }

  const unavailable = launchUnavailableReason({
    repoProbe: probe.repoProbe,
    repoProbeMessage: probe.repoProbeMessage,
    laneId: lane?.id ?? null,
    remoteProbe: probe.remoteProbe,
    remoteError: probe.remoteError,
    laneRemote: probe.laneRemote,
    repoConnected: Boolean(probe.repoUrl),
    // Only Enter checks the model. The launch PAGE is where a model gets
    // picked, and a form that refused to draw because no model was picked
    // would be a form that could never be used.
    checkModel: fromComposer,
    modelId: form.model,
    catalogModelIds: catalog.map((row) => row.id),
  });
  if (unavailable) return { ok: false, message: unavailable };

  // Memoized per draft and kept across a failure, so a retry ADOPTS the agent
  // Cursor already made rather than launching a second one on the same branch.
  const idempotencyKey = idempotencyKeyFor(prompt, probe.repoUrl);

  // Origin has to hold the branch before Cursor clones it: the cloud agent
  // clones the remote, not this machine, so uncommitted or unpushed work is
  // invisible to it.
  try {
    await ensureExistingLaneOriginReady({
      laneId: lane.id,
      branchHint: probe.branch,
      git: {
        getSyncStatus: (args) => sdk.actions.invoke("git", "getSyncStatus", args),
        push: (args) => sdk.actions.invoke("git", "push", args),
      },
    });
  } catch (error) {
    // Already one plain sentence — `ensureExistingLaneOriginReady` rewrote
    // git's stderr through `describePushFailure` before throwing.
    return { ok: false, message: error?.message ?? "ADE could not push this lane's branch to origin." };
  }

  const startingRef = probe.branch;
  if (!startingRef) {
    return {
      ok: false,
      message: "Could not read this lane's branch, so there is nothing for the cloud agent to work on.",
    };
  }

  // An existing PR WINS and forces `autoCreatePR: false`: asking Cursor to open
  // a second pull request for one branch is how a lane ends up with two.
  const existingPr = await openPrFor(lane.id, startingRef);
  const prFields = resolvePrCreateFields({
    existingPrUrl: existingPr?.prUrl,
    autoCreatePR: form.openPr === true,
  });

  const secretNames = (Array.isArray(form.secretNames) ? form.secretNames : [])
    .filter((name) => isInjectableSecretName(name))
    .slice(0, MAX_ATTACHED_SECRETS);
  const envVars = await collectSecretValues((name) => sdk.secrets.get(name), secretNames);

  const verified = verifyCreateModel({
    modelId: form.model,
    reasoningEffort: form.reasoningEffort,
    fastMode: form.fastMode,
    catalog,
    catalogError,
  });
  if (!verified.ok) return { ok: false, message: verified.message };

  const request = buildCreateRequest({
    prompt,
    repoUrl: probe.repoUrl,
    startingRef,
    model: verified.model,
    openPr: prFields.autoCreatePR,
    ...(prFields.prUrl ? { prUrl: prFields.prUrl } : {}),
    // Lane selection already decided the branch. Both were on every cloud
    // launch the compiled composer made.
    workOnCurrentBranch: true,
    skipReviewerRequest: true,
    envVars,
    name: agentNameFromPrompt(prompt),
  });

  let created;
  try {
    created = await api.createAgent(request, { idempotencyKey });
  } catch (error) {
    // The key is KEPT. See `idempotencyKeyFor`.
    return { ok: false, message: failureMessage(error, "Cursor refused the launch.") };
  }

  const agentId = created?.agent?.id ?? created?.id ?? null;
  if (!agentId) return { ok: false, message: "Cursor accepted the launch but named no agent." };

  if (form.rememberSecretNames === true && secretNames.length) {
    await sdk.collections
      .put("laneSecrets", laneSecretsKey(lane.id), { names: secretNames }, { ifFull: "evictOldest" })
      .catch(() => {});
  }

  // The agent exists. From here nothing may answer `ok: false`, because the
  // work IS under way and "it failed" would send the reader looking for it.
  clearIdempotencyKey(prompt, probe.repoUrl);

  let sessionId = null;
  try {
    const ref = await runtime.openAgent({
      agentId,
      laneId: lane.id,
      title: agentNameFromPrompt(prompt),
    });
    sessionId = ref?.sessionId ?? null;
  } catch (error) {
    log("warn", `Launched ${agentId} but could not bind a chat: ${error?.message ?? error}`);
    void refreshFleet();
    return {
      ok: true,
      agentId,
      sessionId: null,
      laneId: lane.id,
      message: "Launched on Cursor Cloud. Open it from the fleet to follow along.",
    };
  }

  void refreshFleet();
  return { ok: true, agentId, sessionId, laneId: lane.id, message: "Launched on Cursor Cloud." };
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;
  api = createCursorApi({ getApiKey: () => sdk.secrets.getProviderKey("cursor") });
  originCache = createOriginCache(getOriginRemote);
  runtime = createChatRuntime({ api, host: chatHost(), links, deliveries, log });

  // The chat seam. `chat.turn` and `chat.interrupt` are delivered reliably and
  // a throw fails that turn visibly, so both are allowed to reject; the two
  // presence events are hints and must never throw out of the listener.
  subscriptions.push(sdk.events.on("chat.turn", (payload) => runtime.handleTurn(payload)));
  subscriptions.push(sdk.events.on("chat.interrupt", (payload) => runtime.handleInterrupt(payload)));
  subscriptions.push(sdk.events.on("chat.opened", (payload) => {
    try {
      runtime.startLadder(payload);
    } catch (error) {
      log("debug", `Could not start the mirror: ${error?.message ?? error}`);
    }
  }));
  subscriptions.push(sdk.events.on("chat.closed", (payload) => {
    try {
      runtime.stopLadder(payload);
    } catch { /* a ladder that is already stopped is not an error */ }
  }));

  // A relay delivery is the only signal a chat nobody is watching ever gets.
  subscriptions.push(sdk.events.on("webhook.received", (payload) => {
    runtime.handleWebhook(payload)
      .then((result) => {
        // A status that changed a row is a fleet that changed too.
        if (result && !result.duplicate && !result.unreadable) {
          if (result.triggerId === "cloud_finished" && fleetViewers === 0) {
            unreadFinished = tabBadge.nextUnreadCount(unreadFinished, 1);
            void publishTabBadge();
          }
          void refreshFleet();
        }
      })
      .catch((error) => log("warn", `Could not handle a Cursor webhook: ${error?.message ?? error}`));
  }));

  // A lane that appeared or left changes which agents belong to this project.
  subscriptions.push(sdk.events.on("lane.changed", () => {
    originCache.reset();
    void refreshFleet();
  }));

  await reconcileTabBadge();

  await publish("fleet", buildFleetPanel({ state: "loading" }));
  await refreshFleet().catch((error) => {
    log("warn", `The first fleet read failed: ${error?.message ?? error}`);
  });
};

exports.deactivate = async () => {
  disposed = true;
  unreadFinished = 0;
  fleetViewers = 0;
  runtime?.stopAllLadders();
  while (subscriptions.length) {
    try {
      subscriptions.pop()?.();
    } catch { /* an unsubscribe that throws is not worth a crash on the way out */ }
  }
  sdk = null;
  api = null;
  runtime = null;
};

/* ── Actions ─────────────────────────────────────────────────────────────── */

exports.actions = {
  /** The panel's refresh gesture, the empty state's retry, and the CLI's. */
  async refreshFleet(args) {
    const result = await refreshFleet({ limit: args?.limit });
    if (result.state === "no-key") {
      return { message: "Connect a Cursor API key in Settings → AI connections.", ok: false };
    }
    if (result.state === "error") return { message: result.error, ok: false };
    return { message: `${result.counts?.total ?? 0} agents.` };
  },

  /** The agent panel's refresh gesture. */
  async refreshAgent(args) {
    const agentId = typeof args?.agentId === "string"
      ? args.agentId
      : typeof args?.context?.agentId === "string" ? args.context.agentId : null;
    if (!agentId) return { navigate: { panelId: "fleet" } };
    return await exports.actions.openAgentDetail({ ...args, agentId });
  },

  /** Go to the fleet — the chat header button, the palette and the CLI. */
  async openFleet() {
    void clearTabBadge();
    void refreshFleet();
    return { navigate: { panelId: "fleet" } };
  },

  /**
   * The host fires this when the fleet panel is on screen. `{ viewed: false }`
   * is the matching hide. Refcounted so a Work rail pane going idle while the
   * tab is open does not start counting again.
   */
  async ackTabBadge(args) {
    fleetViewers = tabBadge.applyViewerCount(fleetViewers, args?.viewed !== false);
    if (fleetViewers > 0) await clearTabBadge();
  },

  /** One agent's detail page. The row's `onPress`. */
  async openAgentDetail(args) {
    const agentId = requireAgentId(args);
    const entry = await findEntry(agentId);
    if (!entry) {
      await publish("agent", buildAgentPanel({ agentId, error: "It is not in this project's fleet." }));
      return { navigate: { panelId: "agent", context: { agentId } } };
    }
    let usage = null;
    try {
      const raw = await api.getAgentUsage(agentId);
      usage = {
        totalTokens: raw?.totalUsage?.totalTokens ?? null,
        costCents: raw?.cost?.chargedCents ?? null,
      };
    } catch {
      // Usage is a nicety. A key without the usage scope must not cost the page.
    }
    await publish("agent", buildAgentPanel({
      entry,
      agentId,
      usage,
      status: fleetDisplayStatus(entry),
      active: isFleetEntryActive(entry),
    }));
    return { navigate: { panelId: "agent", context: { agentId } } };
  },

  /**
   * Adopt a cloud agent as an ADE chat.
   *
   * This is the seam the whole extraction was waiting on: the session belongs
   * to this plugin, its turns arrive here, and its replies are written by this
   * process. Everything the user then does with it — following up, stopping it,
   * opening its branch — is ADE's own chat, not a mirror of somebody else's.
   */
  async openInAde(args) {
    const agentId = requireAgentId(args);
    const entry = await findEntry(agentId);
    const laneId = laneFor(entry, args);
    if (!laneId) {
      return {
        message: "Open a lane first — a cloud chat belongs to the lane whose branch it works on.",
        ok: false,
      };
    }
    try {
      const ref = await runtime.openAgent({
        agentId,
        laneId,
        title: entry?.agent?.name ?? `Cursor Cloud ${agentId.slice(0, 8)}`,
      });
      void refreshFleet();
      return {
        message: ref.created
          ? "Opened this cloud agent as a chat in ADE."
          : "This cloud agent already has a chat in ADE.",
      };
    } catch (error) {
      return { message: failureMessage(error, "Could not open this agent in ADE."), ok: false };
    }
  },

  /** Stop a running agent. */
  async stopRun(args) {
    const agentId = requireAgentId(args);
    try {
      const agent = await api.getAgent(agentId);
      const runId = typeof agent?.latestRunId === "string" ? agent.latestRunId : null;
      if (!runId) return { message: "That agent has no run to stop.", ok: false };
      await api.cancelRun(agentId, runId);
      const link = await links.get(agentId);
      if (link?.sessionId) {
        await sdk.chat.emitStatus(link.sessionId, { state: "idle", detail: "The cloud run was stopped." })
          .catch(() => {});
      }
      void refreshFleet();
      return { message: "Stopped." };
    } catch (error) {
      return { message: failureMessage(error, "Could not stop that agent."), ok: false };
    }
  },

  /**
   * Fetch a finished agent's branch into its lane.
   *
   * `attachBranch` is what does the work: the host fetches the branch into the
   * lane worktree and records it on the session, which is what lights up the
   * ordinary branch and PR affordances. A branch with no session to attach to
   * is a `git fetch`, which is the honest smaller version of the same act.
   */
  async pullIntoLane(args) {
    const agentId = requireAgentId(args);
    const entry = await findEntry(agentId);
    const branch = entry?.branch ?? null;
    if (!branch) return { message: "That agent has not pushed a branch yet.", ok: false };
    const link = await links.get(agentId);
    try {
      if (link?.sessionId) {
        await sdk.chat.attachBranch(link.sessionId, { branch });
      } else {
        await sdk.actions.invoke("git", "fetch", { laneId: laneFor(entry, args), remote: "origin" });
      }
      void refreshFleet();
      return { message: `Pulled ${branch} into the lane.` };
    } catch (error) {
      return { message: failureMessage(error, `Could not pull ${branch}.`), ok: false };
    }
  },

  async archiveAgent(args) {
    const agentId = requireAgentId(args);
    try {
      await api.archiveAgent(agentId);
      void refreshFleet();
      // The reader just archived what "Active" was showing them; putting the
      // filter back on All is the difference between an answer and a puzzle.
      return { message: "Archived.", resetState: ["status"] };
    } catch (error) {
      return { message: failureMessage(error, "Could not archive that agent."), ok: false };
    }
  },

  async unarchiveAgent(args) {
    const agentId = requireAgentId(args);
    try {
      await api.unarchiveAgent(agentId);
      void refreshFleet();
      return { message: "Unarchived." };
    } catch (error) {
      return { message: failureMessage(error, "Could not unarchive that agent."), ok: false };
    }
  },

  async deleteAgent(args) {
    const agentId = requireAgentId(args);
    try {
      await api.deleteAgent(agentId);
      await sdk.collections.delete("sessions", `agent:${agentId}`).catch(() => {});
      void refreshFleet();
      return { message: "Deleted on Cursor.", resetState: true };
    } catch (error) {
      return { message: failureMessage(error, "Could not delete that agent."), ok: false };
    }
  },

  /** The agent's PR, on the open web. */
  async openPr(args) {
    const entry = await findEntry(requireAgentId(args));
    if (!entry?.prUrl) return { message: "That agent has no pull request yet.", ok: false };
    return { openUrl: entry.prUrl };
  },

  /** The agent's own page on cursor.com. */
  async openAgentWeb(args) {
    const agentId = requireAgentId(args);
    const entry = await findEntry(agentId);
    const url = entry?.agent?.webUrl ?? agentWebUrl(agentId);
    if (!url) return { message: "That agent has no page to open.", ok: false };
    return { openUrl: url };
  },

  async openAllAgents() {
    return { openUrl: ALL_AGENTS_URL };
  },

  /**
   * The chat header's two menu entries.
   *
   * A chat-scoped socket receives a `session` context, which names the ADE
   * session and not the cloud agent behind it — so the agent id comes from this
   * plugin's own session index, walked in reverse. That reverse walk is why the
   * index is a collection rather than an in-memory map: the child restarts, and
   * a header button that stopped working after a restart would be a bug nobody
   * could reproduce on purpose.
   */
  async pullIntoLaneFromChat(args) {
    const agentId = await agentForSession(args);
    if (!agentId) return { message: "This chat is not a Cursor Cloud agent.", ok: false };
    return await exports.actions.pullIntoLane({ ...args, agentId });
  },

  async stopRunFromChat(args) {
    const agentId = await agentForSession(args);
    if (!agentId) return { message: "This chat is not a Cursor Cloud agent.", ok: false };
    return await exports.actions.stopRun({ ...args, agentId });
  },

  /**
   * The chat header's primary press: this agent's page on cursor.com.
   *
   * Built from the id rather than read from the fleet, because a chat's header
   * must answer on a machine whose fleet read failed — and the URL is a pure
   * function of the id (`cursorCloudAgentWebUrl`).
   */
  async openAgentWebFromChat(args) {
    const agentId = await agentForSession(args);
    if (!agentId) return { message: "This chat is not a Cursor Cloud agent.", ok: false };
    const url = agentWebUrl(agentId);
    if (!url) return { message: "That agent has no page to open.", ok: false };
    return { openUrl: url };
  },

  /**
   * The Automations tile's status line.
   *
   * The tile's other half is `copyWebhookUrl`, which is its `registerAction`:
   * Cursor has no API for registering a webhook, so "register" here is putting
   * the URL where the reader can paste it into Cursor's own settings.
   */
  async webhookStatus() {
    const snapshot = await readWebhookSnapshot().catch(() => null);
    if (!snapshot) {
      return {
        ok: true,
        state: "unconfigured",
        status: "Live updates not configured yet",
        tone: "warning",
        url: null,
        lastEvent: null,
        pendingDeliveries: 0,
        error: null,
        registered: false,
        canRegister: false,
      };
    }
    return {
      ok: true,
      state: snapshot.state,
      status: snapshot.status,
      tone: snapshot.tone,
      url: snapshot.url,
      lastEvent: snapshot.lastEvent,
      pendingDeliveries: snapshot.pendingDeliveries,
      error: snapshot.drainError,
      // Cursor's channel has no `verify`, so "registered" is only ever "the
      // relay is configured and has a URL to hand out".
      registered: snapshot.state === "ready",
      canRegister: Boolean(snapshot.url),
    };
  },

  /* ── Launch ────────────────────────────────────────────────────────── */

  /**
   * Draw the launch FORM for this lane.
   *
   * The vocabulary panel, for a client that cannot host a webview — the TUI,
   * and any surface where the `launch` page's fallback is what renders.
   * `launchFromComposer` is the machine-entry doorway; this is the panel one,
   * and both end in `runLaunch`.
   */
  async openLaunch(args) {
    if (args?.send === true) return await exports.actions.launchFromComposer(args);

    const context = args?.context ?? null;
    const laneId = context?.kind === "composer" ? context.laneId : (args?.laneId ?? null);
    const draft = context?.kind === "composer" ? context.draft ?? "" : "";

    if (!(await api.hasKey())) {
      await publish("launch", buildLaunchPanel({
        unavailable: "Add a Cursor API key in Settings → AI connections, then try again.",
      }));
      return { navigate: { panelId: "launch" } };
    }

    let lanes = [];
    try {
      lanes = await listLanes();
    } catch {
      lanes = [];
    }
    const lane = lanes.find((row) => row.id === laneId) ?? lanes[0] ?? null;

    // The SELECTED lane's remote, not the project's: a lane can override
    // `remote.origin.url` through `extensions.worktreeConfig`, and the form has
    // to answer for the lane the agent will actually clone.
    const probe = await launchProbe(lane?.id ?? null);
    const unavailable = launchUnavailableReason({
      repoProbe: probe.repoProbe,
      repoProbeMessage: probe.repoProbeMessage,
      laneId: lane?.id ?? null,
      remoteProbe: probe.remoteProbe,
      remoteError: probe.remoteError,
      laneRemote: probe.laneRemote,
      repoConnected: Boolean(probe.repoUrl),
    });
    if (unavailable) {
      await publish("launch", buildLaunchPanel({ unavailable }));
      return { navigate: { panelId: "launch" } };
    }

    let models = [];
    let reasoningOptions = [];
    let showSpeed = false;
    try {
      const listed = await api.listModels();
      const catalog = readCatalog(listed?.items);
      models = catalog.map((row) => row.id);
      const controls = catalogControlOptions(catalog);
      reasoningOptions = controls.reasoning;
      showSpeed = controls.speed;
    } catch {
      // A key without the models scope draws the form without the picker and
      // Cursor picks its own default, which is the same run one tap later.
      models = [];
    }

    const remembered = lane
      ? (await sdk.collections.get("laneSecrets", laneSecretsKey(lane.id)).catch(() => null))
      : null;
    const config = await sdk.config.get().catch(() => ({}));

    await publish("launch", buildLaunchPanel({
      lanes: lanes.map((row) => ({ id: row.id, name: row.name })),
      models,
      reasoningOptions,
      showSpeed,
      secretNames: Array.isArray(remembered?.names) ? remembered.names : [],
      selectedSecrets: Array.isArray(remembered?.names) ? remembered.names : [],
      rememberSecretNames: Boolean(remembered?.names?.length),
      autoOpenPr: config?.autoOpenPr === true,
      draft,
    }));
    return { navigate: { panelId: "launch" } };
  },

  /**
   * The launch form's submit, and the `launch_agent` tool.
   *
   * Both are the same act as Enter in the composer, so both run `runLaunch`.
   * This adapter's whole job is reading the FORM's field names into it and
   * turning its answer back into panel vocabulary.
   */
  async createRun(args) {
    if (args?.send === true) return await exports.actions.launchFromComposer(args);
    const form = readLaunchForm(args);
    const result = await runLaunch({
      prompt: form.prompt,
      laneId: form.laneId,
      model: form.model,
      reasoningEffort: form.reasoningEffort,
      fastMode: form.fastMode,
      openPr: form.openPr,
      secretNames: form.secretNames,
      rememberSecretNames: form.rememberSecretNames,
    });
    if (!result.ok) return { message: result.message, ok: false };
    return { message: result.message, navigate: { panelId: "fleet" } };
  },

  /**
   * The machine-entry row in the composer's own machine picker.
   *
   * Two gestures reach it. Selecting the row is a MODE and invokes nothing;
   * pressing Enter invokes this with `args.send === true` and the live draft in
   * `args.context`, which is the `ownsSend` contract. Anything else — the
   * row's "Advanced…" affordance, a palette press, a client with no composer —
   * opens the `launch` page as a picker over the composer it belongs to.
   *
   * On success it does NOT navigate: the compiled composer adopted the new
   * chat session, and yanking the reader to a fleet list after they pressed
   * Enter in a conversation would be the opposite of what they asked for. The
   * draft is cleared, which is how they know it went.
   */
  async launchFromComposer(args) {
    if (args?.send !== true) {
      return { openWebview: { surfaceId: "launch", placement: "picker" } };
    }
    const form = readComposerLaunch(args);
    const result = await runLaunch({
      fromComposer: true,
      prompt: form.prompt,
      laneId: form.laneId,
      model: form.model,
      reasoningEffort: form.reasoningEffort,
      fastMode: form.fastMode,
      // The composer has no PR toggle and no secret picker — that is what the
      // Advanced page is for — so both come from what this lane last chose.
      openPr: await autoOpenPrSetting(),
      secretNames: await rememberedSecretNames(form.laneId),
      rememberSecretNames: false,
    });
    if (!result.ok) return { message: result.message, ok: false };
    return launchedFrom(true, { message: result.message });
  },

  /* ── Automation steps and agent tools ──────────────────────────────── */

  /** Open ADE's Cursor provider settings page (desktop/web) or name it (phone, TUI). */
  async openCursorSettings() {
    return { openSettings: "agents.provider.cursor" };
  },

  /** Open ADE's Secrets tab. The launch form never carries a secret value. */
  async openSecretsSettings() {
    return { openSettings: "secrets.secrets" };
  },

  /**
   * The webhook URL, onto the clipboard.
   *
   * The URL is also drawn as `code` on the fleet panel, because a copy that
   * silently fails on a surface with no clipboard would leave a reader with no
   * way to get the string at all.
   */
  async copyWebhookUrl() {
    const url = cache.webhookUrl
      || await sdk.webhooks.url("cursor").catch(() => null);
    if (typeof url !== "string" || !url.trim()) {
      return { message: "No webhook URL yet.", ok: false };
    }
    try {
      await sdk.clipboard.write(url);
      return { message: "Webhook URL copied." };
    } catch {
      return { message: "This surface has no clipboard. The URL is on the panel.", ok: false };
    }
  },

  /** The `list_agents` tool, and the `agents` CLI word. */
  async listAgents(args) {
    const entries = await fleetEntries();
    const includeArchived = args?.includeArchived === true;
    const rows = entries
      .filter((entry) => includeArchived || !entry.agent.archived)
      .slice(0, clampFleetBudget(args?.limit))
      .map((entry) => ({
        agentId: entry.agent.agentId,
        name: entry.agent.name,
        status: fleetDisplayStatus(entry),
        branch: entry.branch,
        prUrl: entry.prUrl,
        lane: entry.ownership.laneName,
        url: entry.agent.webUrl,
        updated: formatAge(entry.agent.lastModified ?? entry.agent.createdAt),
      }));
    return { agents: rows, count: rows.length };
  },

  /** The `runs` CLI word: one agent's runs, newest first. */
  async runs(args) {
    const agentId = requireAgentId(args);
    const page = await api.listRuns(agentId, { limit: args?.limit ?? 20 });
    return { runs: Array.isArray(page?.items) ? page.items : [] };
  },

  /** The `artifacts` CLI word. */
  async artifacts(args) {
    const agentId = requireAgentId(args);
    const listed = await api.listArtifacts(agentId);
    return { artifacts: Array.isArray(listed?.items) ? listed.items : [] };
  },

  /** The `repos` CLI word: what Cursor is connected to. */
  async repos() {
    const listed = await api.listRepositories();
    return { repositories: Array.isArray(listed?.items) ? listed.items : [] };
  },

  /** The `me` CLI word: whose key this is. Never the key itself. */
  async me() {
    const who = await api.getMe();
    return {
      apiKeyName: who?.apiKeyName ?? null,
      userEmail: who?.userEmail ?? null,
      createdAt: who?.createdAt ?? null,
    };
  },

  /** The `agents` CLI word, which is the tool by another gesture. */
  async agents(args) {
    return await exports.actions.listAgents(args);
  },

  /** Universal search: this project's agents, by name or by id. */
  async searchAgents(args) {
    const query = typeof args?.query === "string" ? args.query.trim().toLowerCase() : "";
    if (!query) return { results: [] };
    const entries = await fleetEntries();
    const results = entries
      .filter((entry) => entry.agent.name.toLowerCase().includes(query)
        || entry.agent.agentId.toLowerCase().includes(query))
      .slice(0, 8)
      .map((entry) => ({
        id: entry.agent.agentId,
        title: entry.agent.name,
        subtitle: `${fleetDisplayStatus(entry)}${entry.branch ? ` · ${entry.branch}` : ""}`,
        action: "openAgentDetail",
        args: { agentId: entry.agent.agentId },
      }));
    return { results };
  },
};


/**
 * The handlers the plugin's own HTML PAGES invoke over the webview bridge.
 *
 * Built at LOAD, with every collaborator behind a getter, for the reason
 * `pageActions.js`'s header gives: a `webview` surface is a page the reader can
 * open the instant its tab is drawn, which is well before `activate`'s first
 * Cursor read has settled. A page that got "no such action" there would draw
 * its empty state and stay there.
 *
 * The two tables are DISJOINT — every id here starts with `page`, and none of
 * the manifest's own ids do — so the merge below cannot silently shadow a
 * handler the manifest declared. `test/pageActions.test.js` asserts it.
 */
const pageActions = createPageActions({
  get sdk() { return sdk; },
  get api() { return api; },
  get runtime() { return runtime; },
  links,
  log,
  listLanes,
  readLaneRemote,
  findConnectedRepo,
  readCatalog,
  catalogControlOptions,
  groupFleet,
  fleetFooter,
  refreshFleet,
  readWebhookSnapshot,
  findEntry,
  runLaunch,
  fleetSnapshot: () => cache,
  ackTabBadge: (args) => exports.actions.ackTabBadge(args),
  /**
   * Dispatch into this plugin's OWN action table by id.
   *
   * The one implementation of stop, pull, archive, delete and copy lives there,
   * where the panel rows and the agent tools already press it. `pageActions.js`
   * narrows whatever comes back to the `{ok, message}` a page can draw — the
   * file that made that promise is the file that keeps it.
   */
  invokeOwnAction: async (id, args) => {
    const handler = exports.actions[id];
    if (typeof handler !== "function") {
      throw new Error("Cursor Cloud is still starting up on this machine.");
    }
    return await handler(args ?? {});
  },
});

Object.assign(exports.actions, pageActions);

// Exported for `test/`, which drives the tables without a running daemon.
exports.__internals = {
  FLEET_CACHE_MS,
  pageActions,
  runLaunch,
};
