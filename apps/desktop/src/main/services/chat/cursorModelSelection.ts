/**
 * Cursor model SELECTION: turning what a chat chose (reasoning effort, Fast or
 * a service tier, model options) into the `ModelSelection.params` Cursor runs.
 *
 * Discovery (`cursorModelsDiscovery.ts`) owns the catalog: fetching it, caching
 * it per API key, and listing models for the picker. This module only reads
 * that catalog. It never fetches on its own, except through
 * `readCursorSdkCatalog`, which owns the cache and the timeout.
 *
 * Three callers want different things from one resolve:
 * - A LOCAL send is best-effort. It sends the params that resolved, on `ok`
 *   and on `partial` alike, and names once what it could not apply.
 * - A cloud CREATE fails closed on anything but `ok`, because Cursor Cloud
 *   silently runs its own default variant for params it was not sent.
 * - A cloud FOLLOW-UP refuses only a model the catalog does not list. For the
 *   rest it is best-effort, like a local send.
 */
import type { AgentChatCursorConfigOption, AgentChatSession } from "../../../shared/types";
import {
  cursorControlParameterIds,
  normalizeCursorMetadataText,
  normalizeCursorServiceTierValue,
  peekCursorSdkCatalogRows,
  readCursorSdkCatalog,
  type CursorCliModelRow,
  type CursorModelParameterDefinition,
  type CursorModelParameterValue,
} from "./cursorModelsDiscovery";

/**
 * A model control the verified catalog cannot express for the chosen model.
 *
 * Reported only when the model DECLARES a parameter of that class and the
 * requested value maps onto none of its values. A model that declares no
 * parameter of the class at all leaves the control inapplicable, which is not
 * an unmet control: Cursor has no variant to silently substitute, so the
 * selection stays `ok`.
 */
export type CursorSdkModelSelectionUnmetControl = "reasoning" | "fast" | "standard" | "config";

/**
 * What ADE could make of a Cursor model selection.
 *
 * The four outcomes are deliberately distinct, because the callers want
 * different things from them. A local chat send is best-effort: it sends
 * whatever params resolved, on `ok` and on `partial` alike. A cloud create
 * fails closed on anything but `ok`, because Cursor Cloud silently substitutes
 * its own default variant when `params` are omitted — and the error it shows
 * has to name the real cause rather than blame the user's selection for a
 * network fault.
 */
export type CursorSdkModelSelectionResult =
  | { status: "ok"; params: CursorModelParameterValue[] }
  | {
      status: "partial";
      params: CursorModelParameterValue[];
      unmet: CursorSdkModelSelectionUnmetControl[];
    }
  | { status: "unknown-model" }
  | { status: "catalog-unavailable"; reason: string };

const CURSOR_SDK_UNMET_CONTROL_LABELS: Record<CursorSdkModelSelectionUnmetControl, string> = {
  reasoning: "reasoning effort",
  fast: "fast tier",
  standard: "standard tier",
  config: "model options",
};

/**
 * The error a fail-closed caller shows for a selection it cannot use.
 *
 * Each outcome names its own cause: a cold or failed catalog is ADE's problem
 * to retry, an unlisted model is a stale picker, and a partial resolve is the
 * one case where the user's own control is what could not be expressed.
 */
export function describeCursorSdkModelSelectionFailure(
  modelSdkId: string,
  selection: Exclude<CursorSdkModelSelectionResult, { status: "ok" }>,
): string {
  if (selection.status === "catalog-unavailable") {
    return `Could not load Cursor's model catalog (${selection.reason}). Try again.`;
  }
  if (selection.status === "unknown-model") {
    return `Cursor Cloud does not list model ${modelSdkId.trim() || "(unnamed)"}. Refresh Cursor models.`;
  }
  const controls = selection.unmet.map((entry) => CURSOR_SDK_UNMET_CONTROL_LABELS[entry]).join(" and ");
  return `Cursor Cloud could not verify the selected model settings (${controls}). Refresh Cursor models and try again.`;
}

export type CursorSdkModelConfigValue = string | boolean | number;

export type CursorSdkModelSelectionInput = {
  modelSdkId: string;
  reasoningEffort?: string | null;
  fastMode?: boolean | null;
  serviceTier?: "fast" | "standard" | null;
  /**
   * The chat's Cursor config values (`AgentChatSession.cursorConfigValues`),
   * keyed by model parameter id. The SDK has no separate config channel: a
   * model option reaches Cursor only as a `ModelSelection.params` entry, so a
   * value is sent when the model declares that parameter and the value is one
   * of its values. A key the model does not declare is inapplicable and
   * dropped, the same rule as a control the model has no parameter for.
   */
  configValues?: Readonly<Record<string, CursorSdkModelConfigValue>> | null;
};

function findCursorModelRow(
  rows: readonly CursorCliModelRow[],
  modelSdkId: string,
): CursorCliModelRow | undefined {
  const normalized = modelSdkId.trim().toLowerCase();
  if (!normalized) return undefined;
  return rows.find((entry) =>
    entry.id.trim().toLowerCase() === normalized
    || (entry.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized),
  );
}

/**
 * Every parameter a model row declares: its `parameters`, plus any parameter
 * that only its `variants` carry (the cloud catalog can publish variants
 * without the parent definition).
 */
function declaredCursorModelParameters(row: CursorCliModelRow): CursorModelParameterDefinition[] {
  const byId = new Map<string, CursorModelParameterDefinition>();
  for (const parameter of row.parameters ?? []) {
    byId.set(parameter.id, { ...parameter, values: [...parameter.values] });
  }
  for (const variant of row.variants ?? []) {
    for (const param of variant.params) {
      const existing = byId.get(param.id) ?? { id: param.id, values: [] };
      if (!existing.values.some((entry) => entry.value === param.value)) {
        existing.values.push({ value: param.value });
      }
      byId.set(param.id, existing);
    }
  }
  return [...byId.values()];
}

function cursorConfigValueText(value: CursorSdkModelConfigValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return value.trim();
}

/** The declared value a config value names, matched on the value or its display name. */
function matchCursorParameterValue(
  parameter: CursorModelParameterDefinition,
  value: CursorSdkModelConfigValue,
): string | null {
  const wanted = cursorConfigValueText(value).toLowerCase();
  if (!wanted) return null;
  const match = parameter.values.find((entry) =>
    entry.value.trim().toLowerCase() === wanted
    || (entry.displayName?.trim().toLowerCase() ?? "") === wanted,
  );
  return match ? match.value.trim() : null;
}

function hasCursorConfigValues(values: CursorSdkModelSelectionInput["configValues"]): boolean {
  return Boolean(values && Object.keys(values).some((key) => key.trim().length > 0));
}

/**
 * Resolve a model selection against an already-fetched catalog.
 *
 * `rows` is the catalog the caller verified — a probe result, or the in-memory
 * cache. An empty array is an authoritative empty catalog, not a load failure:
 * every model is unlisted.
 */
function resolveCursorSdkModelSelectionFromRows(
  rows: readonly CursorCliModelRow[],
  args: CursorSdkModelSelectionInput,
): CursorSdkModelSelectionResult {
  const modelSdkId = args.modelSdkId.trim();
  if (!modelSdkId) return { status: "unknown-model" };
  const row = findCursorModelRow(rows, modelSdkId);
  if (!row) return { status: "unknown-model" };
  const reasoning = normalizeCursorMetadataText(args.reasoningEffort);
  const requestedTier = args.serviceTier ?? (
    args.fastMode === true ? "fast" : args.fastMode === false ? "standard" : null
  );
  const wantsFast = requestedTier === "fast";
  const wantsStandard = requestedTier === "standard";
  const out = new Map<string, string>();
  const { reasoningParameterIds, serviceTierParameterIds } = cursorControlParameterIds(row);
  const applyParams = (
    params: readonly CursorModelParameterValue[],
    options: { preserveExistingReasoning?: boolean } = {},
  ): void => {
    for (const param of params) {
      const id = param.id.trim();
      const value = param.value.trim();
      if (!id || !value) continue;
      if (options.preserveExistingReasoning && reasoningParameterIds.has(id) && out.has(id)) continue;
      out.set(id, value);
    }
  };

  if (reasoning) {
    const matchingVariant = (row.variants ?? []).find((variant) => {
      const label = normalizeCursorMetadataText(`${variant.displayName} ${variant.description ?? ""}`);
      return variant.params.some((param) =>
        reasoningParameterIds.has(param.id)
        && normalizeCursorMetadataText(param.value) === reasoning,
      ) || label.includes(reasoning);
    });
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
    for (const parameter of row.parameters ?? []) {
      if (!reasoningParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeCursorMetadataText(entry.value) === reasoning
        || normalizeCursorMetadataText(entry.displayName) === reasoning,
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  if (wantsFast) {
    const matchingVariant = (row.variants ?? []).find((variant) => {
      const label = normalizeCursorMetadataText(`${variant.displayName} ${variant.description ?? ""}`);
      return variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeCursorServiceTierValue(param.value) === "fast",
      ) || label.includes("fast");
    });
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
    for (const parameter of row.parameters ?? []) {
      if (!serviceTierParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeCursorServiceTierValue(entry.value) === "fast"
        || normalizeCursorServiceTierValue(entry.displayName) === "fast",
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  if (wantsStandard) {
    const matchingVariant = (row.variants ?? []).find((variant) => {
      const label = normalizeCursorMetadataText(`${variant.displayName} ${variant.description ?? ""}`);
      const hasFastParam = variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeCursorServiceTierValue(param.value) === "fast"
      );
      const hasStandardParam = variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeCursorServiceTierValue(param.value) === "standard"
      );
      return hasStandardParam || (!hasFastParam && /\b(standard|default|regular|base|normal|slow)\b/.test(label));
    });
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
    for (const parameter of row.parameters ?? []) {
      if (!serviceTierParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeCursorServiceTierValue(entry.value) === "standard"
        || normalizeCursorServiceTierValue(entry.displayName) === "standard"
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  // Config values fill the parameters the dedicated controls left alone. The
  // effort picker and the Fast chip are the controls the user sees for their
  // own parameters, so a config value never speaks for a control the user set.
  let configUnmet = false;
  if (hasCursorConfigValues(args.configValues)) {
    const declared = new Map(declaredCursorModelParameters(row).map((parameter) => [parameter.id, parameter]));
    for (const [rawId, rawValue] of Object.entries(args.configValues ?? {})) {
      const id = rawId.trim();
      const parameter = declared.get(id);
      if (!parameter) continue;
      if (out.has(id)) continue;
      if (reasoning && reasoningParameterIds.has(id)) continue;
      if (requestedTier && serviceTierParameterIds.has(id)) continue;
      const value = matchCursorParameterValue(parameter, rawValue);
      if (value) out.set(id, value);
      else configUnmet = true;
    }
  }

  const params = [...out.entries()].map(([id, value]) => ({ id, value }));
  // A control the model defines no parameter for is INAPPLICABLE, not unmet.
  // Cursor has no variant to substitute for a class the row never declares, so
  // there is nothing to enforce and nothing the user could pick differently.
  // Only a class the model DOES declare, whose requested value ADE cannot map
  // onto one of its values, is unmet. A stale draft carrying a reasoning effort
  // from a previously selected model must not block a model such as
  // `composer-2.5`, whose catalog row has no reasoning parameter at all.
  // Presence of a parameter is not enough: a Fast variant that also carries a
  // default reasoning value must not satisfy a different requested effort.
  const unmet: CursorSdkModelSelectionUnmetControl[] = [];
  if (reasoning && reasoningParameterIds.size > 0) {
    const matched = params.some((param) =>
      reasoningParameterIds.has(param.id)
      && normalizeCursorMetadataText(param.value) === reasoning
    );
    if (!matched) unmet.push("reasoning");
  }
  if (wantsFast && serviceTierParameterIds.size > 0) {
    const matched = params.some((param) =>
      serviceTierParameterIds.has(param.id)
      && normalizeCursorServiceTierValue(param.value) === "fast"
    );
    if (!matched) unmet.push("fast");
  }
  if (wantsStandard && serviceTierParameterIds.size > 0) {
    const matched = params.some((param) =>
      serviceTierParameterIds.has(param.id)
      && normalizeCursorServiceTierValue(param.value) === "standard"
    );
    if (!matched) unmet.push("standard");
  }
  if (args.serviceTier && serviceTierParameterIds.size === 0) {
    unmet.push(args.serviceTier);
  }
  if (configUnmet) unmet.push("config");
  if (unmet.length) return { status: "partial", params, unmet };
  // An explicitly-known model with no parameterized controls is still a valid
  // selection. The empty array lets callers distinguish it from a model that
  // was not present in the verified SDK catalog.
  return { status: "ok", params };
}


/**
 * Whether the selection names anything only the catalog can turn into params.
 *
 * `fastMode: false` asks for the standard tier, so it counts. A chat never
 * passes it: `cursorSdkSelectionInputForSession` reads a chat's stored "not
 * fast" as no tier opinion at all.
 */
export function hasExplicitCursorSelection(input: CursorSdkModelSelectionInput): boolean {
  return Boolean(input.reasoningEffort?.trim())
    || input.fastMode != null
    || input.serviceTier != null
    || hasCursorConfigValues(input.configValues);
}

type CursorSelectionSession = Pick<
  AgentChatSession,
  "reasoningEffort" | "fastMode" | "cursorCloudServiceTier" | "cursorConfigValues"
>;

/** Everything a chat chose for a Cursor model, in the resolver's terms. */
export function cursorSdkSelectionInputForSession(
  session: CursorSelectionSession,
  modelSdkId: string,
): CursorSdkModelSelectionInput {
  return {
    modelSdkId,
    reasoningEffort: session.reasoningEffort,
    // A chat stores "not fast" as `false` or as no value. Neither is a request
    // for the standard tier, so Cursor's tier stays unset unless Fast is on.
    fastMode: session.fastMode === true ? true : null,
    serviceTier: session.cursorCloudServiceTier ?? null,
    configValues: session.cursorConfigValues ?? null,
  };
}

/**
 * Resolve a selection against the catalog in memory, whichever key loaded it.
 *
 * Synchronous and never fetches. It takes no API key, so it cannot say whose
 * failure an empty cache is: its `catalog-unavailable` reason is fixed.
 */
export function resolveCursorSdkModelSelectionFromCache(
  input: CursorSdkModelSelectionInput,
): CursorSdkModelSelectionResult {
  if (!input.modelSdkId.trim()) return { status: "unknown-model" };
  const rows = peekCursorSdkCatalogRows();
  if (!rows) return { status: "catalog-unavailable", reason: "Cursor's model catalog has not loaded yet." };
  return resolveCursorSdkModelSelectionFromRows(rows, input);
}

/** The params a best-effort send carries: what resolved on `ok` and on `partial`. */
export function cursorSelectionParams(
  selection: CursorSdkModelSelectionResult,
): CursorModelParameterValue[] | undefined {
  return selection.status === "ok" || selection.status === "partial" ? selection.params : undefined;
}

/** Best-effort params from the catalog in memory; `undefined` when it cannot answer. */
export function resolveCursorSdkModelSelectionParams(
  input: CursorSdkModelSelectionInput,
): CursorModelParameterValue[] | undefined {
  return cursorSelectionParams(resolveCursorSdkModelSelectionFromCache(input));
}

/**
 * Resolve a selection for a LOCAL send or worker launch.
 *
 * Reads the catalog in memory. When that cannot answer and the chat chose a
 * control the params must carry, this loads this key's catalog first. A chat
 * with no renderer behind it (the CLI, an automation, the first send after a
 * restart) never ran the picker's fetch, and without the load its choices
 * would be dropped without a word. A load that failed for this key within the
 * freshness window answers at once with that cause, so an offline machine
 * does not wait on every send.
 */
export async function resolveCursorSdkLocalSelection(
  apiKey: string | null | undefined,
  input: CursorSdkModelSelectionInput,
): Promise<CursorSdkModelSelectionResult> {
  const cached = resolveCursorSdkModelSelectionFromCache(input);
  if (cached.status !== "catalog-unavailable" || !hasExplicitCursorSelection(input)) return cached;
  const catalog = await readCursorSdkCatalog(apiKey, { failFast: true });
  return catalog.status === "loaded"
    ? resolveCursorSdkModelSelectionFromRows(catalog.rows, input)
    : { status: "catalog-unavailable", reason: catalog.reason };
}

/**
 * Resolve a selection against this key's catalog, for a CLOUD run.
 *
 * The catalog in memory answers when it holds this key's rows. The cache is
 * keyed by a hash of the API key, so one key never resolves against another
 * key's rows. Otherwise the catalog is fetched once, and a successful empty
 * fetch stays empty: every model is unlisted.
 */
export async function resolveCursorSdkModelSelection(
  apiKey: string | null | undefined,
  input: CursorSdkModelSelectionInput,
): Promise<CursorSdkModelSelectionResult> {
  const catalog = await readCursorSdkCatalog(apiKey);
  return catalog.status === "loaded"
    ? resolveCursorSdkModelSelectionFromRows(catalog.rows, input)
    : { status: "catalog-unavailable", reason: catalog.reason };
}

/**
 * Verify a selection for a cloud CREATE, or refuse the launch.
 *
 * The single owner of the fail-closed rule that both cloud create paths obey.
 * Cursor Cloud silently substitutes its own default variant when `params` are
 * omitted, so a create that cannot express the user's chosen controls must
 * fail with the cause named rather than quietly run a different model.
 *
 * Returns null when the caller chose no control. Callers supply their own
 * fallback for that case: a cloud launch sends no params, and a chat send
 * falls back to its session's best-effort params.
 *
 * @throws the sentence from `describeCursorSdkModelSelectionFailure`.
 */
export async function verifyExplicitCursorModelSelection(
  apiKey: string | null | undefined,
  input: CursorSdkModelSelectionInput,
): Promise<CursorModelParameterValue[] | null> {
  if (!hasExplicitCursorSelection(input)) return null;
  const selection = await resolveCursorSdkModelSelection(apiKey, input);
  if (selection.status !== "ok") {
    throw new Error(describeCursorSdkModelSelectionFailure(input.modelSdkId, selection));
  }
  return selection.params;
}

/**
 * Resolve a selection for a cloud FOLLOW-UP on an agent that already runs.
 *
 * Refuses only when the catalog positively does not list the model: the stale
 * picker is the cause, and Cursor would reject the run anyway. A catalog that
 * cannot load, or a control the model cannot express, does not stop a
 * conversation already under way. The caller sends `cursorSelectionParams` of
 * the result and names what it could not apply
 * (`describeUnappliedCursorSelection`).
 *
 * Returns null when the caller chose no control, as the create path does.
 *
 * @throws the sentence from `describeCursorSdkModelSelectionFailure` for an unlisted model.
 */
export async function resolveCursorSdkFollowUpSelection(
  apiKey: string | null | undefined,
  input: CursorSdkModelSelectionInput,
): Promise<Exclude<CursorSdkModelSelectionResult, { status: "unknown-model" }> | null> {
  if (!hasExplicitCursorSelection(input)) return null;
  const selection = await resolveCursorSdkModelSelection(apiKey, input);
  if (selection.status === "unknown-model") {
    throw new Error(describeCursorSdkModelSelectionFailure(input.modelSdkId, selection));
  }
  return selection;
}

/** The chat's own choices, named for a notice. */
function cursorSelectionChoiceLabels(input: CursorSdkModelSelectionInput): string[] {
  return [
    input.reasoningEffort?.trim() ? `${input.reasoningEffort.trim()} reasoning effort` : null,
    input.fastMode === true || input.serviceTier === "fast" ? "Fast" : null,
    input.serviceTier === "standard" || (input.fastMode === false && input.serviceTier == null)
      ? "the standard tier"
      : null,
    hasCursorConfigValues(input.configValues) ? "model options" : null,
  ].filter((entry): entry is string => Boolean(entry));
}

/**
 * The notice a best-effort send owes the user for what it could not apply, or
 * null when it applied everything the chat chose.
 */
export function describeUnappliedCursorSelection(
  input: CursorSdkModelSelectionInput,
  selection: CursorSdkModelSelectionResult,
): string | null {
  const model = input.modelSdkId.trim() || "(unnamed)";
  if (selection.status === "catalog-unavailable") {
    if (!hasExplicitCursorSelection(input)) return null;
    const chosen = cursorSelectionChoiceLabels(input);
    return `Cursor's model list could not be loaded (${selection.reason}), so ${model} runs without ${chosen.join(", ") || "the selected model settings"} until it loads.`;
  }
  if (selection.status === "partial") {
    const controls = selection.unmet.map((entry) => CURSOR_SDK_UNMET_CONTROL_LABELS[entry]).join(" and ");
    return `Cursor cannot apply the selected ${controls} to ${model}, so this run uses Cursor's default for ${selection.unmet.length > 1 ? "them" : "it"}.`;
  }
  return null;
}

/**
 * Whether a `{ fastMode: true }` resolve shows the model has a Fast tier.
 *
 * Only a fully expressed selection with params does. A model that declares no
 * tier resolves `ok` with no params, and a partial resolve is the case where
 * the tier is exactly what ADE could not express.
 */
export function cursorSelectionHasFastTier(selection: CursorSdkModelSelectionResult): boolean {
  return selection.status === "ok" && selection.params.length > 0;
}

/**
 * Whether the model has a Fast tier, per the catalog in memory, or null when
 * that catalog cannot say (not loaded, or the model is not in it).
 *
 * Never fetches: the callers run inside a model switch and a status read,
 * which must not wait on Cursor. Unknown is not unsupported.
 */
export function cursorModelFastTierFromCache(modelSdkId: string): boolean | null {
  const selection = resolveCursorSdkModelSelectionFromCache({ modelSdkId, fastMode: true });
  if (selection.status === "catalog-unavailable" || selection.status === "unknown-model") return null;
  return cursorSelectionHasFastTier(selection);
}

/** What of a chat's Cursor choices a model cannot take. */
export type UnsupportedCursorSelection = {
  reasoningEffort: boolean;
  fastMode: boolean;
  serviceTier: boolean;
  /** Config keys whose value the model declares the option for but cannot take. */
  configKeys: string[];
};

/**
 * What of a chat's choices `modelSdkId` cannot take, per the catalog in memory.
 *
 * For a chat that adopted a model it did not pick, such as a cloud run started
 * on cursor.com. The rule is the one a send applies: a choice is unsupported
 * when it would come back unmet (the model declares that control, and the
 * value maps onto none of its values), and Fast is unsupported on a model with
 * no Fast tier. A control the model does not declare is inapplicable, not
 * unsupported, and stays. Null when the catalog cannot say.
 */
export function unsupportedCursorSelection(
  session: CursorSelectionSession,
  modelSdkId: string,
): UnsupportedCursorSelection | null {
  const rows = peekCursorSdkCatalogRows();
  const row = rows ? findCursorModelRow(rows, modelSdkId) : undefined;
  if (!row) return null;
  const input = cursorSdkSelectionInputForSession(session, modelSdkId);
  const resolve = (partial: Omit<CursorSdkModelSelectionInput, "modelSdkId">): CursorSdkModelSelectionResult =>
    resolveCursorSdkModelSelectionFromRows([row], { modelSdkId, ...partial });
  const unmet = (partial: Omit<CursorSdkModelSelectionInput, "modelSdkId">): boolean =>
    resolve(partial).status === "partial";
  const declared = new Map(declaredCursorModelParameters(row).map((parameter) => [parameter.id, parameter]));
  return {
    reasoningEffort: Boolean(input.reasoningEffort?.trim()) && unmet({ reasoningEffort: input.reasoningEffort }),
    fastMode: session.fastMode === true && !cursorSelectionHasFastTier(resolve({ fastMode: true })),
    serviceTier: input.serviceTier != null && unmet({ serviceTier: input.serviceTier }),
    configKeys: Object.entries(input.configValues ?? {}).flatMap(([key, value]) => {
      const parameter = declared.get(key.trim());
      return parameter && matchCursorParameterValue(parameter, value) == null ? [key] : [];
    }),
  };
}

/**
 * The model options a Cursor model declares beyond reasoning effort and the
 * service tier (those two have their own controls), from the catalog in
 * memory. Empty when the catalog has not loaded or the model declares none.
 */
export function listCursorSdkModelConfigParameters(modelSdkId: string): CursorModelParameterDefinition[] {
  const rows = peekCursorSdkCatalogRows();
  const row = rows ? findCursorModelRow(rows, modelSdkId) : undefined;
  if (!row) return [];
  const { reasoningParameterIds, serviceTierParameterIds } = cursorControlParameterIds(row);
  return declaredCursorModelParameters(row).filter((parameter) =>
    parameter.values.length > 0
    && !reasoningParameterIds.has(parameter.id)
    && !serviceTierParameterIds.has(parameter.id),
  );
}

/**
 * The model's own options as the config options the composer renders.
 *
 * The SDK runtime has no config channel of its own: these are the model's
 * parameters, and a value the user picks rides the next run's
 * `ModelSelection.params`. An option the chat never set reports `null`, which
 * is Cursor's default. Reporting an unset boolean as `false` made every client
 * send an explicit `false` the user never chose.
 */
export function cursorSdkConfigOptions(
  modelSdkId: string,
  values: Readonly<Record<string, CursorSdkModelConfigValue>> | null | undefined,
): AgentChatCursorConfigOption[] {
  return listCursorSdkModelConfigParameters(modelSdkId).map((parameter): AgentChatCursorConfigOption => {
    const isBoolean = parameter.values.length === 2
      && parameter.values.every((entry) => ["true", "false"].includes(entry.value.trim().toLowerCase()));
    const current = values?.[parameter.id];
    const base = {
      id: parameter.id,
      name: parameter.displayName ?? parameter.id,
      category: "model",
    };
    if (isBoolean) {
      return {
        ...base,
        type: "boolean",
        currentValue: current == null
          ? null
          : current === true || (typeof current === "string" && current.trim().toLowerCase() === "true"),
      };
    }
    return {
      ...base,
      type: "select",
      currentValue: current == null || current === "" ? null : String(current),
      // The empty choice sends nothing, so Cursor applies the model's default.
      options: [
        { value: "", label: "Default" },
        ...parameter.values.map((entry) => ({ value: entry.value, label: entry.displayName ?? entry.value })),
      ],
    };
  });
}
