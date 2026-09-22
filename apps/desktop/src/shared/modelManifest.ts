// ---------------------------------------------------------------------------
// Model manifest — the model directory ADE can update without a release.
//
// `model-manifest.json` ships inside every build and is re-fetched at runtime
// from GitHub `main` (see main/services/ai/modelManifestService.ts). It can add
// models the bundled registry does not know, patch existing rows (hide one,
// fix a price or a context window), and move the app-wide and per-provider
// defaults. Every entry can be gated to an ADE version range, because some new
// models need more than a slug — a new effort level or runtime contract — and
// only a release can ship that code.
//
// This module is pure: parsing, validation, and version gating. Applying a
// manifest to the registry lives in modelRegistry.ts.
// ---------------------------------------------------------------------------

import type { ModelDescriptor, ModelProviderGroup } from "./modelRegistry";

export const MODEL_MANIFEST_SCHEMA_VERSION = 1;

export const MODEL_MANIFEST_REMOTE_URL =
  "https://raw.githubusercontent.com/arul28/ADE/main/apps/desktop/src/shared/model-manifest.json";

/** Descriptor fields a manifest may set. Everything else is code-owned. */
export const MODEL_MANIFEST_PATCHABLE_FIELDS = [
  "shortId",
  "aliases",
  "displayName",
  "family",
  "authTypes",
  "contextWindow",
  "maxOutputTokens",
  "capabilities",
  "reasoningTiers",
  "defaultReasoningEffort",
  "serviceTiers",
  "color",
  "providerRoute",
  "providerModelId",
  "cliCommand",
  "isCliWrapped",
  "deprecated",
  "inputPricePer1M",
  "outputPricePer1M",
  "costTier",
] as const satisfies readonly (keyof ModelDescriptor)[];

export type ModelManifestPatchableField = (typeof MODEL_MANIFEST_PATCHABLE_FIELDS)[number];
export type ModelManifestFields = Partial<Pick<ModelDescriptor, ModelManifestPatchableField>>;

/** Fields that decide what runs; a manifest may set them only on a model it adds. */
export const MODEL_MANIFEST_ROUTING_FIELDS = [
  "family",
  "providerRoute",
  "cliCommand",
  "isCliWrapped",
  "authTypes",
] as const satisfies readonly ModelManifestPatchableField[];

/** Fields a manifest must supply to add a model the registry does not have. */
const REQUIRED_FOR_NEW_MODEL = [
  "shortId",
  "displayName",
  "family",
  "authTypes",
  "contextWindow",
  "maxOutputTokens",
  "capabilities",
  "color",
  "providerRoute",
  "providerModelId",
  "isCliWrapped",
] as const satisfies readonly ModelManifestPatchableField[];

export type ModelManifestVersionGate = {
  /** Inclusive lowest ADE version the entry applies to. */
  minAdeVersion?: string;
  /** Exclusive highest ADE version the entry applies to. */
  maxAdeVersionExclusive?: string;
};

export type ModelManifestModelEntry = ModelManifestVersionGate & {
  /** Canonical registry id, e.g. `openai/gpt-6-sol`. */
  id: string;
  /** Insert a new model right after this registry id (picker order). */
  after?: string;
  fields: ModelManifestFields;
};

export type ModelManifestDefault = ModelManifestVersionGate & { model: string };

export type ModelManifestDefaults = {
  /** App-wide default: used wherever ADE picks a model without a provider. */
  app?: ModelManifestDefault[];
  /** Per-provider default, e.g. `{ codex: [{ model: "openai/gpt-6-astra" }] }`. */
  providers?: Partial<Record<ModelProviderGroup, ModelManifestDefault[]>>;
};

export type ModelManifest = {
  version: number;
  /** ISO timestamp; a newer bundled manifest beats an older cached one. */
  updatedAt: string;
  defaults?: ModelManifestDefaults;
  models: ModelManifestModelEntry[];
};

// ---------------------------------------------------------------------------
// Version gating
// ---------------------------------------------------------------------------

function parseReleaseVersion(value: string | null | undefined): number[] | null {
  const match = String(value ?? "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Does an entry apply to this ADE build?
 *
 * Only a plain release version (`1.2.78`) is gated. Dev builds, prereleases,
 * and unknown versions see every entry — they run the newest code, and hiding
 * models from the people building ADE would only hide bugs.
 */
export function modelManifestGateAllows(
  gate: ModelManifestVersionGate,
  adeVersion: string | null | undefined,
): boolean {
  const current = parseReleaseVersion(adeVersion);
  if (!current || (current[0] === 0 && current[1] === 0 && current[2] === 0)) return true;
  const min = parseReleaseVersion(gate.minAdeVersion);
  if (min && compareVersions(current, min) < 0) return false;
  const max = parseReleaseVersion(gate.maxAdeVersionExclusive);
  if (max && compareVersions(current, max) >= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// The manifest is fetched unsigned from GitHub, so every value it can set is
// constrained to what ADE already knows how to run: a known route launched by
// its own known CLI, known families/auth/efforts, and plain model ids. It can
// add rows and change metadata; it cannot point ADE at a new binary.

/** Every route a manifest may use, with the only CLI that route may launch. */
export const MODEL_MANIFEST_ROUTE_CLI: Readonly<Record<string, string>> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "cursor-sdk": "cursor",
  "droid-cli": "droid",
  "copilot-acp": "copilot",
  "grok-acp": "grok",
  "kimi-acp": "kimi",
  "qwen-acp": "qwen",
};
const ALLOWED_FAMILIES = new Set([
  "anthropic", "openai", "google", "mistral", "deepseek", "xai", "cursor", "factory", "qwen", "moonshot", "github-copilot",
]);
const ALLOWED_AUTH_TYPES = new Set(["cli-subscription", "api-key", "oauth"]);
const ALLOWED_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);
const ALLOWED_SERVICE_TIERS = new Set(["fast"]);
const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function isModelRef(value: unknown): value is string {
  return typeof value === "string" && MODEL_REF_PATTERN.test(value);
}

function isAllowedList(allowed: Set<string>) {
  return (value: unknown): boolean =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && allowed.has(entry));
}

function isDisplayName(value: unknown): boolean {
  // Printable, single-line, short: it is rendered in pickers on every client.
  return typeof value === "string" && value.trim().length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
}

const FIELD_VALIDATORS: Record<ModelManifestPatchableField, (value: unknown) => boolean> = {
  shortId: isModelRef,
  aliases: (value) => Array.isArray(value) && value.every(isModelRef),
  displayName: isDisplayName,
  family: (value) => typeof value === "string" && ALLOWED_FAMILIES.has(value),
  authTypes: isAllowedList(ALLOWED_AUTH_TYPES),
  contextWindow: isPositiveNumber,
  maxOutputTokens: isPositiveNumber,
  capabilities: (value) =>
    isRecord(value)
    && ["tools", "vision", "reasoning", "streaming"].every((key) => typeof value[key] === "boolean"),
  reasoningTiers: isAllowedList(ALLOWED_EFFORTS),
  defaultReasoningEffort: (value) => typeof value === "string" && ALLOWED_EFFORTS.has(value),
  serviceTiers: isAllowedList(ALLOWED_SERVICE_TIERS),
  color: (value) => typeof value === "string" && COLOR_PATTERN.test(value),
  providerRoute: (value) => typeof value === "string" && Object.prototype.hasOwnProperty.call(MODEL_MANIFEST_ROUTE_CLI, value),
  providerModelId: isModelRef,
  cliCommand: (value) => typeof value === "string" && Object.values(MODEL_MANIFEST_ROUTE_CLI).includes(value),
  isCliWrapped: (value) => typeof value === "boolean",
  deprecated: (value) => typeof value === "boolean",
  inputPricePer1M: isNonNegativeNumber,
  outputPricePer1M: isNonNegativeNumber,
  costTier: (value) => value === "low" || value === "medium" || value === "high" || value === "very_high",
};

/**
 * A gate that does not parse must fail the file: silently ignoring a typo'd
 * `minAdeVersion` would expose the model to every build it was meant to skip.
 */
function parseGate(raw: UnknownRecord, path: string, errors: string[]): ModelManifestVersionGate {
  const gate: ModelManifestVersionGate = {};
  for (const key of ["minAdeVersion", "maxAdeVersionExclusive"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !parseReleaseVersion(raw[key])) {
      errors.push(`${path}.${key} must be a release version like 1.2.80`);
      continue;
    }
    gate[key] = (raw[key] as string).trim();
  }
  return gate;
}

function parseDefaultList(raw: unknown, path: string, errors: string[]): ModelManifestDefault[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const list: ModelManifestDefault[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry) || !isNonEmptyString(entry.model)) {
      errors.push(`${path}[${index}].model must be a non-empty string`);
      return;
    }
    if (!isModelRef(entry.model)) {
      errors.push(`${path}[${index}].model is not a valid model id`);
      return;
    }
    list.push({ model: entry.model.trim(), ...parseGate(entry, `${path}[${index}]`, errors) });
  });
  return list;
}

/**
 * Validate an untrusted manifest. Structural problems reject the whole file;
 * the caller then keeps whatever manifest it already had. A remote file that
 * half-parses is more dangerous than a stale one.
 */
export function parseModelManifest(
  raw: unknown,
): { ok: true; manifest: ModelManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["manifest must be an object"] };
  if (raw.version !== MODEL_MANIFEST_SCHEMA_VERSION) {
    errors.push(`unsupported manifest version ${String(raw.version)}`);
  }
  if (!isNonEmptyString(raw.updatedAt) || !Number.isFinite(Date.parse(raw.updatedAt))) {
    errors.push("updatedAt must be an ISO timestamp");
  }
  if (!Array.isArray(raw.models)) errors.push("models must be an array");
  if (errors.length) return { ok: false, errors };

  const models: ModelManifestModelEntry[] = [];
  const seenIds = new Set<string>();
  (raw.models as unknown[]).forEach((entry, index) => {
    const path = `models[${index}]`;
    if (!isRecord(entry) || !isModelRef(entry.id)) {
      errors.push(`${path}.id must be a valid model id`);
      return;
    }
    const id = entry.id.trim();
    if (seenIds.has(id)) errors.push(`${path}: duplicate id ${id}`);
    seenIds.add(id);
    if (!isRecord(entry.fields)) {
      errors.push(`${path}.fields must be an object`);
      return;
    }
    const fields: UnknownRecord = {};
    for (const [key, value] of Object.entries(entry.fields)) {
      const validate = FIELD_VALIDATORS[key as ModelManifestPatchableField];
      if (!validate) {
        errors.push(`${path}.fields.${key} is not a patchable field`);
        continue;
      }
      if (!validate(value)) {
        errors.push(`${path}.fields.${key} has an invalid value`);
        continue;
      }
      fields[key] = value;
    }
    const route = fields.providerRoute as string | undefined;
    const cli = fields.cliCommand as string | undefined;
    if (route && cli && MODEL_MANIFEST_ROUTE_CLI[route] !== cli) {
      errors.push(`${path}: route ${route} cannot launch ${cli}`);
    }
    models.push({
      id,
      ...(isModelRef(entry.after) ? { after: entry.after.trim() } : {}),
      ...parseGate(entry, path, errors),
      fields: fields as ModelManifestFields,
    });
  });

  const defaults: ModelManifestDefaults = {};
  if (raw.defaults !== undefined) {
    if (!isRecord(raw.defaults)) {
      errors.push("defaults must be an object");
    } else {
      const app = parseDefaultList(raw.defaults.app, "defaults.app", errors);
      if (app.length) defaults.app = app;
      if (raw.defaults.providers !== undefined) {
        if (!isRecord(raw.defaults.providers)) {
          errors.push("defaults.providers must be an object");
        } else {
          const providers: ModelManifestDefaults["providers"] = {};
          for (const [provider, list] of Object.entries(raw.defaults.providers)) {
            const parsed = parseDefaultList(list, `defaults.providers.${provider}`, errors);
            if (parsed.length) providers[provider as ModelProviderGroup] = parsed;
          }
          defaults.providers = providers;
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      version: MODEL_MANIFEST_SCHEMA_VERSION,
      updatedAt: (raw.updatedAt as string).trim(),
      ...(defaults.app || defaults.providers ? { defaults } : {}),
      models,
    },
  };
}

/** Fields missing for an entry that must add a brand-new registry row. */
export function missingFieldsForNewModel(fields: ModelManifestFields): string[] {
  return REQUIRED_FOR_NEW_MODEL.filter((key) => fields[key] === undefined);
}

export function modelManifestUpdatedAtMs(manifest: ModelManifest | null | undefined): number {
  const parsed = Date.parse(manifest?.updatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
