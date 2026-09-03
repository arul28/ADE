// The launch path: a form's values become one `POST /v1/agents`.
//
// Ported from `apps/desktop/src/main/services/chat/cursorCloudCreateOptions.ts`
// and the composer's own draft state (`useCursorCloudDraftState.ts`). Three
// rules from core survive verbatim, because each one is a bug somebody already
// found:
//
//   1. **`CURSOR_`-prefixed secret names are refused.** Cursor owns that
//      namespace in the run environment, and a user's `CURSOR_API_KEY` shadowing
//      the agent's own credential breaks the run in a way nothing explains.
//   2. **`openPr` is creation-time only.** Cursor cannot add a PR to a run that
//      is already going, so a form that let it be toggled later would be a
//      switch that silently does nothing.
//   3. **The repo has to be connected to Cursor.** Cursor clones from its own
//      GitHub connection, not from this machine, so a lane whose remote Cursor
//      has never seen fails at create with a sentence nobody can act on. The
//      form checks first and says which of the two is missing.
//
// One thing does NOT survive: `metadata`. `POST /v1/agents` refuses it with
// `[feature_unavailable] API v1 agent metadata is not enabled`, so the
// agent→session binding lives in this plugin's own `sessions` collection
// instead of in Cursor's tags. Core learned that the same way — see the note at
// the top of `cursorCloudCreateOptions.ts`.

"use strict";

const { repoMatchKey, repoLabel } = require("./repoMatch");

/** Cursor's own environment namespace. A user secret may not enter it. */
const RESERVED_ENV_PREFIX = "CURSOR_";

/** How many secrets one launch may attach. The form draws one toggle each. */
const MAX_ATTACHED_SECRETS = 18;

/** The collection key a lane's remembered secret names live at. */
function laneSecretsKey(laneId) {
  return `lane:${laneId}`;
}

/** True for a name this plugin will inject into the cloud run. */
function isInjectableSecretName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return false;
  return !trimmed.toUpperCase().startsWith(RESERVED_ENV_PREFIX);
}

/**
 * The form's values, as the fields `panels.buildLaunchPanel` declared them.
 *
 * Secrets arrive as one toggle each (`secret:NAME`) because the vocabulary has
 * no multi-select, and a toggle each is the honest drawing: the reader sees
 * every name they are attaching rather than a count.
 */
function readLaunchForm(args = {}) {
  const secretNames = [];
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("secret:") || value !== true) continue;
    const name = key.slice("secret:".length);
    if (isInjectableSecretName(name) && !secretNames.includes(name)) secretNames.push(name);
  }
  const speed = typeof args.fastMode === "string" ? args.fastMode.trim() : "";
  return {
    prompt: typeof args.prompt === "string" ? args.prompt.trim() : "",
    laneId: typeof args.laneId === "string" && args.laneId.trim() ? args.laneId.trim() : null,
    model: typeof args.model === "string" && args.model.trim() ? args.model.trim() : null,
    reasoningEffort: typeof args.reasoningEffort === "string" && args.reasoningEffort.trim()
      ? args.reasoningEffort.trim()
      : null,
    // "" is no opinion. "fast" / "standard" are the two values Cursor's
    // catalog actually names. A boolean toggle would send `false` for an
    // untouched control and that would fail-close every launch.
    fastMode: speed === "fast" ? true : speed === "standard" ? false : null,
    openPr: args.openPr === true,
    rememberSecretNames: args.rememberSecretNames === true,
    secretNames: secretNames.slice(0, MAX_ATTACHED_SECRETS),
  };
}

/**
 * The composer's Send, as the same fields the form would have posted.
 *
 * `args.send === true` is the ownsSend intercept. The prompt is the live
 * draft, the model is the composer picker, and Fast is only sent when the
 * toggle is actually on — a default-false boolean must not become REST
 * `standard` and fail-close the launch.
 */
function readComposerLaunch(args = {}) {
  const context = args.context && args.context.kind === "composer" ? args.context : null;
  const draft = typeof context?.draft === "string" ? context.draft.trim() : "";
  const prompt = draft || (typeof args.prompt === "string" ? args.prompt.trim() : "");
  const laneId = (typeof context?.laneId === "string" && context.laneId.trim())
    || (typeof args.laneId === "string" && args.laneId.trim())
    || "";
  const model = (typeof context?.modelId === "string" && context.modelId.trim())
    || (typeof args.model === "string" && args.model.trim())
    || "";
  const reasoning = typeof context?.reasoningEffort === "string" ? context.reasoningEffort.trim() : "";
  return {
    prompt,
    laneId: laneId || null,
    model: model || null,
    reasoningEffort: reasoning || null,
    fastMode: context?.fastMode === true ? true : null,
    openPr: args.openPr === true,
    rememberSecretNames: false,
    secretNames: [],
  };
}

/**
 * Is this lane's remote one Cursor can clone?
 *
 * Compared through `repoMatchKey`, so `git@github.com:owner/repo.git` and
 * `https://github.com/owner/repo` are the same repository — which they are, and
 * which a plain string compare would deny.
 */
function findConnectedRepo(repositories, remoteUrl) {
  const wanted = repoMatchKey(remoteUrl);
  if (!wanted) return null;
  const rows = Array.isArray(repositories) ? repositories : [];
  for (const row of rows) {
    const url = typeof row === "string" ? row : row?.url;
    if (repoMatchKey(url) === wanted) return typeof url === "string" ? url : String(url);
  }
  return null;
}

/**
 * The create body, in `V1CreateAgentRequest` shape.
 *
 * Only the fields `POST /v1/agents` actually accepts. `model` is the REST
 * `{ id, params? }` object, omitted rather than sent empty, so a form left on
 * "Cursor's default" gets Cursor's default instead of a validation error about
 * a model named "".
 */
function buildCreateRequest(input) {
  const { prompt, repoUrl, branch, startingRef, model, openPr, envVars, name } = input;
  // `startingRef` is the compiled composer's own name for the ref Cursor clones,
  // read from the lane's git remote rather than from the lane row; `branch` is
  // the older caller's word for the same thing and still works.
  const ref = readText(startingRef) ?? readText(branch);
  const request = {
    prompt: { text: prompt },
    repos: [{ url: repoUrl, ...(ref ? { startingRef: ref } : {}) }],
  };
  if (name) request.name = name;
  const modelField = readCreateModelField(model);
  if (modelField) request.model = modelField;
  if (openPr) request.autoCreatePR = true;
  // `prUrl` and `autoCreatePR` are mutually exclusive by construction — see
  // `resolvePrCreateFields`, which is the only thing that should compute them.
  const prUrl = readText(input.prUrl);
  if (prUrl) request.prUrl = prUrl;
  // Lane selection already decided the branch, so the agent commits to it
  // rather than branching again underneath ADE. Verbatim from the compiled
  // composer, which passed both on every cloud launch it made.
  if (input.workOnCurrentBranch === true) request.workOnCurrentBranch = true;
  if (input.skipReviewerRequest === true) request.skipReviewerRequest = true;
  const env = envVars && typeof envVars === "object" ? envVars : null;
  if (env && Object.keys(env).length) request.envVars = env;
  return request;
}

function readText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * REST `model` is `{ id, params? }`. A leftover string id is wrapped so an
 * older caller cannot send the shape Cursor's catalog silently substitutes.
 */
function readCreateModelField(model) {
  if (typeof model === "string") {
    const id = model.trim();
    return id ? { id } : null;
  }
  if (!model || typeof model !== "object") return null;
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) return null;
  const params = Array.isArray(model.params)
    ? model.params
      .map((entry) => {
        const paramId = typeof entry?.id === "string" ? entry.id.trim() : "";
        const value = typeof entry?.value === "string" ? entry.value.trim() : "";
        return paramId && value ? { id: paramId, value } : null;
      })
      .filter(Boolean)
    : [];
  return params.length ? { id, params } : { id };
}

/**
 * Secret name → value, for the names the reader ticked.
 *
 * Values come from THIS PLUGIN's secret store (`ade.secrets`), never from
 * ADE's project secrets: a plugin reading the project's own `.env` would be a
 * capability nobody granted at install. A name with no stored value is skipped
 * rather than sent empty — an empty environment variable is not the same as an
 * absent one, and the difference breaks scripts.
 */
async function collectSecretValues(getSecret, names) {
  const envVars = {};
  for (const name of names) {
    if (!isInjectableSecretName(name)) continue;
    const value = await getSecret(name).catch(() => null);
    if (typeof value !== "string" || value.length === 0) continue;
    envVars[name] = value;
  }
  return envVars;
}

/**
 * The agent's name, which is what the fleet row's title shows.
 *
 * The prompt's first line, clipped — the same thing the built-in composer put
 * in the chat title, so a row a user launched from ADE reads the way the chat
 * that launched it does.
 */
function agentNameFromPrompt(prompt, max = 60) {
  const firstLine = String(prompt ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return "Cursor Cloud agent";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/** A one-line description of the repository, for the form's caption. */
function repoCaption(remoteUrl) {
  const label = repoLabel(remoteUrl);
  return label ? `Cursor clones ${label} and pushes back to it.` : null;
}


/* ── The launch ladder, the origin push, and the PR fields ───────────────── */

/**
 * The sentence the composer showed instead of a raw git push error.
 *
 * Verbatim from `cursorCloudUtils.ts:CURSOR_CLOUD_BRANCH_DIVERGED_MESSAGE`. A
 * diverged branch is the one case where ADE must not push at all: the cloud
 * agent clones origin, and force-pushing over commits origin has that this
 * machine does not is data loss nobody asked for.
 */
const BRANCH_DIVERGED_MESSAGE =
  "This lane's branch is behind origin and also has local commits origin does not have. "
  + "Pull or rebase in the lane, then send again.";

/**
 * A failed pre-launch push as one plain sentence.
 *
 * Ported branch for branch from `describeCursorCloudPushFailure`. Git's own
 * stderr ("! [rejected] … hint: …") is not something a reader should have to
 * parse in a composer banner, and the two cases that have an action — behind
 * origin, and refused credentials — say what that action is.
 */
function describePushFailure(error, branch) {
  const raw = readText(error?.message) ?? String(error ?? "").trim() ?? "";
  const message = raw || "Cursor Cloud request failed.";
  const trimmed = readText(branch);
  const subject = trimmed ? `Branch ${trimmed}` : "This lane's branch";
  if (/non-fast-forward|\[rejected\]|fetch first|behind its remote/i.test(message)) {
    return `${subject} is behind origin, so ADE could not push it. Pull or rebase in the lane, then send again.`;
  }
  if (/permission denied|authentication failed|could not read from remote|\b403\b/i.test(message)) {
    return `ADE could not push ${subject.toLowerCase()} to origin: GitHub refused the push. Check your access, then send again.`;
  }
  const firstLine = message.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? message;
  return `ADE could not push ${subject.toLowerCase()} to origin: ${firstLine}`;
}

/**
 * Prepare an existing lane's origin ref before Cursor clones it.
 *
 * Ported from `ensureExistingLaneOriginReadyForCursorCloud`. Behind-only skips
 * the push (origin is newer, and origin is what the cloud clones). Diverged
 * blocks. Local-ahead or no-upstream pushes. A failed push always aborts —
 * origin LISTING the branch is not proof it has these commits, and launching
 * anyway produces an agent working on the wrong tree.
 *
 * `git` is `{getSyncStatus, push}`, both of them plugin-visible verbs in ADE's
 * `git` action domain (`adeActions/registry.ts`), so nothing here needs a
 * capability this plugin was not already granted.
 */
async function ensureExistingLaneOriginReady(args) {
  const { laneId, branchHint = null, git } = args;
  let sync = null;
  try {
    sync = (await git.getSyncStatus({ laneId })) ?? null;
  } catch {
    // An unreadable sync status is not a diverged branch. The push below is
    // what actually decides, and it fails loudly if origin refuses.
    sync = null;
  }
  if (sync?.hasUpstream && (sync.diverged === true || (sync.ahead > 0 && sync.behind > 0))) {
    throw new Error(BRANCH_DIVERGED_MESSAGE);
  }
  const needsPush = !sync?.hasUpstream || sync.ahead > 0;
  if (!needsPush) return { pushed: false };
  try {
    await git.push({ laneId });
  } catch (error) {
    throw new Error(describePushFailure(error, readText(sync?.upstreamRef) ?? branchHint));
  }
  return { pushed: true };
}

/**
 * `prUrl` and `autoCreatePR` are create-time only and mutually exclusive.
 *
 * Ported from `resolveCursorCloudPrCreateFields`. A branch that already has a
 * pull request attaches to THAT one; asking Cursor to open a second is how a
 * lane ends up with two PRs for one branch. Note the asymmetry the compiled
 * helper has and this keeps: the no-PR answer omits `prUrl` entirely rather
 * than sending it null.
 */
function resolvePrCreateFields(input = {}) {
  const prUrl = readText(input.existingPrUrl);
  if (prUrl) return { autoCreatePR: false, prUrl };
  return { autoCreatePR: input.autoCreatePR === true };
}

/**
 * Why Cursor Cloud cannot take this work, in the compiled composer's own words
 * and in its own order.
 *
 * Ported from `useCursorCloudDraftState.ts:cursorCloudUnavailableReason`. The
 * order is the whole point: every sentence names the thing that is actually
 * true right now, so a probe still in flight cannot be reported as "this repo
 * is not connected" and a failed read gets a sentence the reader can retry.
 *
 * The model pair at the end only runs for a caller that is about to SEND
 * (`checkModel`), because the launch form picks the model itself and would
 * otherwise refuse to draw the picker that fixes it.
 */
function launchUnavailableReason(input = {}) {
  if (input.repoProbe === "loading") return "Checking Cursor Cloud…";
  if (input.repoProbe === "error") return readText(input.repoProbeMessage) ?? "Cursor Cloud request failed.";
  if (!readText(input.laneId)) return "Choose a lane before sending to Cursor Cloud.";
  if (input.remoteProbe === "idle" || input.remoteProbe === "loading") {
    return "Checking this lane's git remote…";
  }
  if (input.remoteProbe === "error") {
    const detail = readText(input.remoteError) ?? "The git remote read failed.";
    return `Could not read this lane's git remote: ${detail}`;
  }
  if (!readText(input.laneRemote)) {
    return "This lane has no GitHub remote, so there is nothing for Cursor Cloud to clone.";
  }
  if (input.repoConnected !== true) {
    return "This repo is not connected to Cursor. Connect it in Cursor, then try again.";
  }
  if (input.checkModel === true) {
    const catalogIds = Array.isArray(input.catalogModelIds) ? input.catalogModelIds : [];
    const modelId = readText(input.modelId);
    if (!modelId || !catalogIds.includes(modelId)) {
      // The compiled composer branched on whether the catalog had loaded at
      // all: an empty catalog means "open the picker", a full one means "the
      // model you have picked is not one of these".
      return catalogIds.length > 0
        ? "Choose a Cursor Cloud model first"
        : "Cursor's model list has not loaded yet. Open the model picker to load it, then try again.";
    }
  }
  return null;
}

/* ── Idempotency ─────────────────────────────────────────────────────────── */

/**
 * One create key per draft, kept across a failure.
 *
 * Ported from `cursorCloudIdempotencyByDraftRef`. The key is memoized on
 * `prompt \0 repoUrl` and DELETED only on success, so a retry of a send that
 * failed somewhere after `POST /v1/agents` adopts the agent Cursor already made
 * instead of launching a second one against the same branch. Cursor's
 * `Idempotency-Key` header is what makes the adoption happen; this map is only
 * what remembers which key belongs to which draft.
 *
 * Module-level rather than per-activate for the same reason the compiled ref is
 * component-level: the map has to outlive the failure it exists for.
 */
const idempotencyByDraft = new Map();
/** A draft key this map will not grow past. A stale key costs one duplicate. */
const MAX_IDEMPOTENCY_KEYS = 64;

function draftKey(promptText, repoUrl) {
  return `${String(promptText ?? "")}\0${String(repoUrl ?? "")}`;
}

function randomKey() {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === "function") return globalThis.crypto.randomUUID();
  // A host with no WebCrypto still gets a key unique enough to dedupe one
  // draft's retries, which is the whole of what Cursor compares.
  return `ade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function idempotencyKeyFor(promptText, repoUrl) {
  const key = draftKey(promptText, repoUrl);
  const existing = idempotencyByDraft.get(key);
  if (existing) return existing;
  if (idempotencyByDraft.size >= MAX_IDEMPOTENCY_KEYS) {
    const oldest = idempotencyByDraft.keys().next().value;
    if (oldest !== undefined) idempotencyByDraft.delete(oldest);
  }
  const next = randomKey();
  idempotencyByDraft.set(key, next);
  return next;
}

/** Called ONLY on a launch that fully succeeded. See `idempotencyKeyFor`. */
function clearIdempotencyKey(promptText, repoUrl) {
  idempotencyByDraft.delete(draftKey(promptText, repoUrl));
}

module.exports = {
  BRANCH_DIVERGED_MESSAGE,
  MAX_ATTACHED_SECRETS,
  RESERVED_ENV_PREFIX,
  agentNameFromPrompt,
  buildCreateRequest,
  clearIdempotencyKey,
  collectSecretValues,
  describePushFailure,
  ensureExistingLaneOriginReady,
  findConnectedRepo,
  idempotencyKeyFor,
  isInjectableSecretName,
  laneSecretsKey,
  launchUnavailableReason,
  resolvePrCreateFields,
  readCreateModelField,
  readComposerLaunch,
  readLaunchForm,
  repoCaption,
};
