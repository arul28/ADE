// REST `POST /v1/agents` takes `model` as `{ id, params? }`, never a string.
//
// Cursor Cloud substitutes its default variant when `params` are omitted, so a
// launch that named reasoning or speed and then sent only `{ id }` would run a
// different model than the form showed. That is the fail-closed rule compiled
// ADE landed in #1203 (`verifyExplicitCursorModelSelection`). This module is
// the same rule against `GET /v1/models`, which is the catalog this plugin
// actually has — it talks HTTP, not `@cursor/sdk`.
//
// Classifiers and the unmet-control cases are ported from
// `cursorModelsDiscovery.ts` so a form that picked "high" and "fast" maps to
// the same parameter ids the composer would have sent.

"use strict";

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parameterHaystack(parameter) {
  return `${parameter.id} ${parameter.displayName ?? ""}`.toLowerCase().replace(/[_\-.]+/g, " ");
}

function isReasoningParameterLike(parameter) {
  return /\b(reason|reasoning|thinking|think|effort)\b/.test(parameterHaystack(parameter));
}

function isServiceTierParameterLike(parameter) {
  return /\b(speed|service|tier|mode|latency)\b/.test(parameterHaystack(parameter));
}

function normalizeReasoningValue(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === "extra-high" || normalized === "extra_high") return "xhigh";
  if (normalized === "ultra-code" || normalized === "ultra_code") return "ultracode";
  if ([
    "none",
    "dynamic",
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
    "thinking",
  ].includes(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeServiceTierValue(value) {
  const normalized = normalizeText(value);
  if (normalized === "fast") return "fast";
  if (["standard", "default", "regular", "base", "normal", "slow"].includes(normalized)) {
    return "standard";
  }
  return null;
}

function readParameterDefinitions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? entry : null;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    const rawValues = Array.isArray(record?.values) ? record.values : [];
    if (!id || !rawValues.length) continue;
    const values = [];
    for (const raw of rawValues) {
      if (typeof raw === "string") {
        if (raw.trim()) values.push({ value: raw.trim() });
        continue;
      }
      const nested = raw && typeof raw === "object" ? raw : null;
      const nestedValue = typeof nested?.value === "string" ? nested.value.trim() : "";
      if (!nestedValue) continue;
      const displayName = typeof nested?.displayName === "string" && nested.displayName.trim()
        ? nested.displayName.trim()
        : undefined;
      values.push(displayName ? { value: nestedValue, displayName } : { value: nestedValue });
    }
    if (!values.length) continue;
    const displayName = typeof record.displayName === "string" && record.displayName.trim()
      ? record.displayName.trim()
      : undefined;
    out.push(displayName ? { id, displayName, values } : { id, values });
  }
  return out;
}

function readVariants(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const record = entry && typeof entry === "object" ? entry : null;
    const rawParams = Array.isArray(record?.params) ? record.params : [];
    const params = [];
    for (const param of rawParams) {
      const nested = param && typeof param === "object" ? param : null;
      const id = typeof nested?.id === "string" ? nested.id.trim() : "";
      const paramValue = typeof nested?.value === "string" ? nested.value.trim() : "";
      if (id && paramValue) params.push({ id, value: paramValue });
    }
    if (!params.length) continue;
    const displayName = typeof record.displayName === "string" ? record.displayName : "";
    const description = typeof record.description === "string" ? record.description : "";
    out.push({
      params,
      displayName,
      description,
      isDefault: record.isDefault === true,
    });
  }
  return out;
}

/**
 * `GET /v1/models` items, as rows the resolver can match.
 *
 * A string item is an id with no parameters — still a valid model, just one
 * that cannot express reasoning or speed.
 */
/**
 * What a person should see for one model id.
 *
 * Cursor's catalog names a model with an id, not a title, so a picker that
 * printed `row.id` printed `composer-2` where every other model chip in ADE
 * prints `Composer 2`. Cursor's own answer wins when it sends one; otherwise
 * the id is turned into words, which is a presentation rule and not a mapping
 * table — a table would go stale the week Cursor adds a model.
 *
 * A segment with no vowel and at most four letters is an acronym (`gpt` →
 * `GPT`), and a segment that starts with a digit is a version and is left
 * alone (`4.5` stays `4.5`).
 */
function modelLabel(record, id) {
  const given = typeof record?.displayName === "string" ? record.displayName.trim() : "";
  const named = given || (typeof record?.name === "string" ? record.name.trim() : "");
  if (named) return named;
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d/.test(part)) return part;
      if (part.length <= 4 && !/[aeiou]/i.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ") || id;
}

function readCatalog(items) {
  const rows = [];
  const list = Array.isArray(items) ? items : [];
  for (const entry of list) {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id) rows.push({ id, label: modelLabel(null, id), aliases: [], parameters: [], variants: [] });
      continue;
    }
    const record = entry && typeof entry === "object" ? entry : null;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!id) continue;
    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((alias) => typeof alias === "string" && alias.trim()).map((alias) => alias.trim())
      : [];
    rows.push({
      id,
      label: modelLabel(record, id),
      aliases,
      parameters: readParameterDefinitions(record.parameters),
      variants: readVariants(record.variants),
    });
  }
  return rows;
}

function findRow(catalog, modelId) {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) return null;
  return catalog.find((row) =>
    row.id.trim().toLowerCase() === wanted
    || row.aliases.some((alias) => alias.trim().toLowerCase() === wanted),
  ) ?? null;
}

/**
 * The controls the launch form can honestly offer, given this catalog.
 *
 * Empty arrays mean the form omits that field: a control with nothing to pick
 * would be a switch that silently does nothing.
 */
function catalogControlOptions(catalog) {
  const reasoning = [];
  const seenReasoning = new Set();
  let speed = false;
  for (const row of catalog) {
    for (const parameter of row.parameters) {
      if (isReasoningParameterLike(parameter)) {
        for (const entry of parameter.values) {
          const value = normalizeReasoningValue(entry.value) ?? normalizeReasoningValue(entry.displayName);
          if (!value || seenReasoning.has(value)) continue;
          seenReasoning.add(value);
          reasoning.push({
            value,
            label: entry.displayName?.trim() || value,
          });
        }
      }
      if (isServiceTierParameterLike(parameter)) speed = true;
    }
    for (const variant of row.variants) {
      const label = `${variant.displayName} ${variant.description}`;
      if (/\bfast\b/i.test(label)) speed = true;
      const effort = normalizeReasoningValue(variant.displayName) ?? normalizeReasoningValue(variant.description);
      if (effort && !seenReasoning.has(effort)) {
        seenReasoning.add(effort);
        reasoning.push({ value: effort, label: effort });
      }
    }
  }
  return { reasoning, speed };
}

function resolveFromRow(row, args) {
  const reasoning = normalizeReasoningValue(args.reasoningEffort);
  const wantsFast = args.fastMode === true;
  const wantsStandard = args.fastMode === false;
  const out = new Map();
  const reasoningParameterIds = new Set(
    row.parameters.filter(isReasoningParameterLike).map((entry) => entry.id),
  );
  const serviceTierParameterIds = new Set(
    row.parameters.filter(isServiceTierParameterLike).map((entry) => entry.id),
  );
  const applyParams = (params, options = {}) => {
    for (const param of params) {
      const id = param.id.trim();
      const value = param.value.trim();
      if (!id || !value) continue;
      if (options.preserveExistingReasoning && reasoningParameterIds.has(id) && out.has(id)) continue;
      out.set(id, value);
    }
  };

  if (reasoning) {
    const matchingVariant = row.variants.find((variant) => {
      const label = normalizeText(`${variant.displayName} ${variant.description}`);
      return variant.params.some((param) =>
        reasoningParameterIds.has(param.id)
        && normalizeText(param.value) === reasoning,
      ) || label.includes(reasoning);
    });
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
    for (const parameter of row.parameters) {
      if (!reasoningParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeText(entry.value) === reasoning
        || normalizeText(entry.displayName) === reasoning,
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  if (wantsFast) {
    const matchingVariant = row.variants.find((variant) => {
      const label = normalizeText(`${variant.displayName} ${variant.description}`);
      return variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeServiceTierValue(param.value) === "fast",
      ) || label.includes("fast");
    });
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
    for (const parameter of row.parameters) {
      if (!serviceTierParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeServiceTierValue(entry.value) === "fast"
        || normalizeServiceTierValue(entry.displayName) === "fast",
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  if (wantsStandard) {
    const matchingVariant = row.variants.find((variant) => {
      const label = normalizeText(`${variant.displayName} ${variant.description}`);
      const hasFastParam = variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeServiceTierValue(param.value) === "fast",
      );
      const hasStandardParam = variant.params.some((param) =>
        serviceTierParameterIds.has(param.id)
        && normalizeServiceTierValue(param.value) === "standard",
      );
      return hasStandardParam || (!hasFastParam && /\b(standard|default|regular|base|normal|slow)\b/.test(label));
    });
    if (matchingVariant) applyParams(matchingVariant.params, { preserveExistingReasoning: true });
    for (const parameter of row.parameters) {
      if (!serviceTierParameterIds.has(parameter.id)) continue;
      const value = parameter.values.find((entry) =>
        normalizeServiceTierValue(entry.value) === "standard"
        || normalizeServiceTierValue(entry.displayName) === "standard",
      );
      if (value) out.set(parameter.id, value.value);
    }
  }

  const params = [...out.entries()].map(([id, value]) => ({ id, value }));
  // Fails CLOSED. A catalog row that declares no reasoning parameter at all, or
  // no service tier, cannot express what the reader asked for — so the request
  // is UNMET, not satisfied. Gating each check on `size > 0` read the absence of
  // the parameter as proof that nothing needed to be sent, and the launch went
  // to Cursor with no params: the reader picked "high" and got the row's
  // default, with nothing on screen to say so.
  const unmet = [];
  if (reasoning) {
    const matched = params.some((param) =>
      reasoningParameterIds.has(param.id) && normalizeText(param.value) === reasoning,
    );
    if (!matched) unmet.push("reasoning effort");
  }
  if (wantsFast) {
    const matched = params.some((param) =>
      serviceTierParameterIds.has(param.id) && normalizeServiceTierValue(param.value) === "fast",
    );
    if (!matched) unmet.push("fast mode");
  }
  if (wantsStandard) {
    const matched = params.some((param) =>
      serviceTierParameterIds.has(param.id) && normalizeServiceTierValue(param.value) === "standard",
    );
    if (!matched) unmet.push("standard speed");
  }
  if (unmet.length) {
    return {
      status: "partial",
      params,
      message: `Cursor Cloud could not verify the selected model settings (${unmet.join(" and ")}). Refresh Cursor models and try again.`,
    };
  }
  return { status: "ok", params };
}

/**
 * The REST `model` field for one create, or a refusal.
 *
 * No model id → omit the field (Cursor's default).
 * A model id and no controls → `{ id }` with no params, even if the catalog
 * has not loaded: compiled create does the same.
 * A control the user actually picked must resolve against a loaded catalog, or
 * the launch fails rather than running Cursor's substitute variant.
 */
function verifyCreateModel(input = {}) {
  const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
  const reasoningEffort = typeof input.reasoningEffort === "string" ? input.reasoningEffort.trim() : "";
  const fastMode = input.fastMode === true ? true : input.fastMode === false ? false : null;
  const hasExplicitSelection = Boolean(reasoningEffort) || fastMode != null;
  if (!modelId) {
    if (hasExplicitSelection) {
      return {
        ok: false,
        message: "Cursor Cloud cannot apply reasoning or speed settings without a selected model. Pick a model and try again.",
      };
    }
    return { ok: true, model: null };
  }
  if (!hasExplicitSelection) {
    return { ok: true, model: { id: modelId } };
  }
  if (input.catalogError) {
    return {
      ok: false,
      message: `Could not load Cursor's model catalog (${input.catalogError}). Try again.`,
    };
  }
  const catalog = Array.isArray(input.catalog) ? input.catalog : [];
  const row = findRow(catalog, modelId);
  if (!row) {
    return {
      ok: false,
      message: `Cursor Cloud does not list model ${modelId}. Refresh Cursor models.`,
    };
  }
  const resolved = resolveFromRow(row, { reasoningEffort, fastMode });
  if (resolved.status !== "ok") {
    return { ok: false, message: resolved.message };
  }
  return {
    ok: true,
    model: resolved.params.length
      ? { id: modelId, params: resolved.params }
      : { id: modelId },
  };
}

module.exports = {
  catalogControlOptions,
  normalizeReasoningValue,
  normalizeServiceTierValue,
  readCatalog,
  verifyCreateModel,
};
