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
  const { prompt, repoUrl, branch, model, openPr, envVars, name } = input;
  const request = {
    prompt: { text: prompt },
    repos: [{ url: repoUrl, ...(branch ? { startingRef: branch } : {}) }],
  };
  if (name) request.name = name;
  const modelField = readCreateModelField(model);
  if (modelField) request.model = modelField;
  if (openPr) request.autoCreatePR = true;
  const env = envVars && typeof envVars === "object" ? envVars : null;
  if (env && Object.keys(env).length) request.envVars = env;
  return request;
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

module.exports = {
  MAX_ATTACHED_SECRETS,
  RESERVED_ENV_PREFIX,
  agentNameFromPrompt,
  buildCreateRequest,
  collectSecretValues,
  findConnectedRepo,
  isInjectableSecretName,
  laneSecretsKey,
  readCreateModelField,
  readLaunchForm,
  repoCaption,
};
