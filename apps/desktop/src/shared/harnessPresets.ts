/**
 * Harness presets — a saved pairing of a *body* and a *brain*.
 *
 * ADE can run ten agent harnesses (Claude Code, Codex, OpenCode, Droid, Pi, and
 * the ACP CLIs) and each of them can be pointed at several different sources of
 * intelligence: a native sign-in held in its own config home, a stored API key,
 * or a subscription borrowed through ADE's proxy. Choosing that pair correctly
 * is four separate controls in the composer today, and nothing remembers the
 * combination you settled on. A preset is that combination, named, with a logo,
 * so "Opus on my work account, plan mode, subagents on Haiku" is one row in a
 * list rather than four pickers re-set from memory every time.
 *
 * This module is the whole data model and nothing else — no React, no IPC, no
 * `window`. Presets travel through the account settings store as one
 * account-scoped value (see `renderer/lib/accountSettingsSync.ts`), so every
 * machine you sign in on sees the same list; keeping the shape and its
 * validation here is what lets the renderer, the tests, and any later CLI
 * surface agree on what a preset is.
 *
 * The one rule with teeth: **a preset never carries a credential.** The `key`
 * source holds the id of a credential in the API-key store, never the key, and
 * `exportHarnessPreset` rebuilds the source from that fixed set of fields so a
 * shared file cannot leak a secret even if a future writer stapled one onto the
 * object in memory.
 */

/** The harnesses a preset can name — the `AgentChatProvider` ids ADE can run. */
export const HARNESS_PRESET_BODIES = [
  "claude",
  "codex",
  "opencode",
  "droid",
  "pi",
  "qwen",
  "kimi",
  "grok",
  "copilot",
  "cursor",
] as const;

export type HarnessPresetBody = (typeof HARNESS_PRESET_BODIES)[number];

export function isHarnessPresetBody(value: unknown): value is HarnessPresetBody {
  return typeof value === "string" && (HARNESS_PRESET_BODIES as readonly string[]).includes(value);
}

/** Display names for the bodies. Sentence case, matching the settings pages. */
export const HARNESS_PRESET_BODY_LABELS: Record<HarnessPresetBody, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  opencode: "OpenCode",
  droid: "Droid",
  pi: "Pi",
  qwen: "Qwen Code",
  kimi: "Kimi",
  grok: "Grok",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
};

export function harnessBodyLabel(body: string): string {
  return isHarnessPresetBody(body) ? HARNESS_PRESET_BODY_LABELS[body] : body;
}

/**
 * Providers that hold more than one local sign-in, and are therefore the only
 * ones an `account` or `subscription` source can name. Mirrors
 * `shared/types/providerInstances.ts`; re-stated rather than imported so this
 * module stays free of the machine-local registry's types.
 */
export const HARNESS_PRESET_ACCOUNT_PROVIDERS = ["claude", "codex"] as const;
export type HarnessPresetAccountProvider = (typeof HARNESS_PRESET_ACCOUNT_PROVIDERS)[number];

export function isHarnessPresetAccountProvider(value: unknown): value is HarnessPresetAccountProvider {
  return value === "claude" || value === "codex";
}

/**
 * Where the preset's intelligence comes from.
 *
 * - `account` — a native sign-in ADE already holds, named by provider instance.
 * - `key` — a credential in the API-key store, named by id. Never the value.
 * - `subscription` — a Claude or Codex subscription used from *another* harness
 *   through ADE's proxy. That needs a second sign-in the proxy holds, which is
 *   why an imported preset can report it as missing.
 */
export type HarnessPresetSource =
  | { kind: "account"; provider: HarnessPresetAccountProvider; instanceId: string }
  | { kind: "key"; provider: string; credentialId: string; label: string }
  | { kind: "subscription"; provider: HarnessPresetAccountProvider };

export type HarnessPresetSourceKind = HarnessPresetSource["kind"];

/**
 * The preset's mark.
 *
 * `ade` is the default and costs nothing to store. `provider` names a provider
 * whose brand mark the renderer already ships. `upload` and `generated` carry a
 * PNG data URL — the only part of a preset big enough to matter, which is why
 * export drops one over {@link HARNESS_PRESET_LOGO_EXPORT_MAX_BYTES}.
 */
export type HarnessPresetLogo =
  | { kind: "ade" }
  | { kind: "provider"; providerId: string }
  | { kind: "upload"; dataUrl: string }
  | { kind: "generated"; dataUrl: string };

export const DEFAULT_HARNESS_PRESET_LOGO: HarnessPresetLogo = { kind: "ade" };

/** "Same as main" — the subagent model follows whatever the preset's model is. */
export const HARNESS_PRESET_SUBAGENT_INHERIT = "inherit";

/** "Follows subagents" — a built-in agent takes the subagent model. */
export const HARNESS_PRESET_AGENT_FOLLOWS = "follows";

/** The built-in agents a Claude preset can pin to a specific model. */
export const HARNESS_PRESET_AGENT_KEYS = ["explore", "plan", "generalPurpose"] as const;
export type HarnessPresetAgentKey = (typeof HARNESS_PRESET_AGENT_KEYS)[number];

export const HARNESS_PRESET_AGENT_LABELS: Record<HarnessPresetAgentKey, string> = {
  explore: "Explore",
  plan: "Plan",
  generalPurpose: "General-purpose",
};

export type HarnessPresetAgentOverrides = Partial<Record<HarnessPresetAgentKey, string>>;

/**
 * The sentence shown when a built-in agent is pinned to a specific model.
 *
 * Pinning takes the agent off Claude Code's own prompt and onto ADE's copy of
 * it, and that copy stops tracking upstream the moment it is made. Saying so at
 * the point of the choice is the difference between a preference and a silent
 * fork.
 */
export function harnessPresetAgentOverrideNote(agent: HarnessPresetAgentKey): string {
  const name = HARNESS_PRESET_AGENT_LABELS[agent];
  return `${name} now runs on ADE's copy of Anthropic's ${name} prompt. Updates to Claude Code do not change it.`;
}

/** `#rrggbb` only — the renderer renders it raw, so anything else is rejected. */
export const HARNESS_PRESET_ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_HARNESS_PRESET_ACCENT = "#7c5ce0";

export const HARNESS_PRESET_NAME_MAX_LENGTH = 60;

/** One saved body-plus-brain pairing. */
export type HarnessPreset = {
  id: string;
  name: string;
  /** The harness ADE runs. */
  harness: HarnessPresetBody;
  /** Where the intelligence comes from. */
  source: HarnessPresetSource;
  /** Model id, as the model registry or a custom endpoint spells it. */
  model: string;
  /** Thinking level, when the model offers tiers. Absent means "runtime default". */
  reasoningEffort?: string;
  /** `"inherit"` = same as main. Otherwise a model id. */
  subagentModel: string;
  /** Per-built-in-agent pins. `"follows"` = follows the subagent model. */
  agentOverrides: HarnessPresetAgentOverrides;
  /** The harness's own permission vocabulary — `default`, `plan`, `full-auto`, … */
  permissionMode: string;
  accentColor: string;
  logo: HarnessPresetLogo;
  createdAt: string;
  updatedAt: string;
};

/** A preset being edited: everything a user chooses, without the bookkeeping. */
export type HarnessPresetDraft = Omit<HarnessPreset, "id" | "createdAt" | "updatedAt">;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type HarnessPresetField =
  | "name"
  | "harness"
  | "source"
  | "model"
  | "subagentModel"
  | "permissionMode"
  | "accentColor"
  | "logo";

export type HarnessPresetErrors = Partial<Record<HarnessPresetField, string>>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateSource(source: unknown): string | null {
  if (!source || typeof source !== "object") return "Choose where this harness gets its intelligence.";
  const candidate = source as Record<string, unknown>;
  if (candidate.kind === "account") {
    if (!isHarnessPresetAccountProvider(candidate.provider)) {
      return "Only Claude and Codex accounts can be used as a source.";
    }
    if (!isNonEmptyString(candidate.instanceId)) return "Choose an account.";
    return null;
  }
  if (candidate.kind === "key") {
    if (!isNonEmptyString(candidate.provider)) return "Choose a provider for this key.";
    if (!isNonEmptyString(candidate.credentialId)) return "Choose a stored key.";
    return null;
  }
  if (candidate.kind === "subscription") {
    if (!isHarnessPresetAccountProvider(candidate.provider)) {
      return "Only a Claude or Codex subscription can be borrowed through the proxy.";
    }
    return null;
  }
  return "Choose where this harness gets its intelligence.";
}

function validateLogo(logo: unknown): string | null {
  if (!logo || typeof logo !== "object") return "Choose a logo.";
  const candidate = logo as Record<string, unknown>;
  if (candidate.kind === "ade") return null;
  if (candidate.kind === "provider") {
    return isNonEmptyString(candidate.providerId) ? null : "Choose a provider logo.";
  }
  if (candidate.kind === "upload" || candidate.kind === "generated") {
    if (!isNonEmptyString(candidate.dataUrl)) return "Choose an image.";
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(candidate.dataUrl)) {
      return "The logo must be a PNG, JPEG, or WebP image.";
    }
    return null;
  }
  return "Choose a logo.";
}

/**
 * Field errors for a draft, keyed by the control that is wrong.
 *
 * Returns `{}` for a valid draft, so `Object.keys(errors).length === 0` is the
 * whole "can I save this" question and no caller re-derives it.
 */
export function validateHarnessPreset(draft: Partial<HarnessPresetDraft> | null | undefined): HarnessPresetErrors {
  const errors: HarnessPresetErrors = {};
  if (!draft) {
    return { name: "Give this harness a name.", harness: "Choose a harness.", source: "Choose a source.", model: "Choose a model." };
  }

  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!name) errors.name = "Give this harness a name.";
  else if (name.length > HARNESS_PRESET_NAME_MAX_LENGTH) {
    errors.name = `Names are at most ${HARNESS_PRESET_NAME_MAX_LENGTH} characters.`;
  }

  if (!isHarnessPresetBody(draft.harness)) errors.harness = "Choose a harness.";

  const sourceError = validateSource(draft.source);
  if (sourceError) errors.source = sourceError;

  if (!isNonEmptyString(draft.model)) errors.model = "Choose a model.";

  if (draft.subagentModel != null && !isNonEmptyString(draft.subagentModel)) {
    errors.subagentModel = "Choose a subagent model, or leave it on Same as main.";
  }

  if (draft.permissionMode != null && !isNonEmptyString(draft.permissionMode)) {
    errors.permissionMode = "Choose a permission mode.";
  }

  if (draft.accentColor != null && !HARNESS_PRESET_ACCENT_PATTERN.test(draft.accentColor)) {
    errors.accentColor = "Accents are six-digit hex colors, like #7c5ce0.";
  }

  const logoError = validateLogo(draft.logo ?? DEFAULT_HARNESS_PRESET_LOGO);
  if (logoError) errors.logo = logoError;

  return errors;
}

export function harnessPresetIsValid(draft: Partial<HarnessPresetDraft> | null | undefined): boolean {
  return Object.keys(validateHarnessPreset(draft)).length === 0;
}

// ---------------------------------------------------------------------------
// Normalisation — what comes back out of storage
// ---------------------------------------------------------------------------

function normalizeAgentOverrides(value: unknown): HarnessPresetAgentOverrides {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: HarnessPresetAgentOverrides = {};
  for (const key of HARNESS_PRESET_AGENT_KEYS) {
    const entry = raw[key];
    if (isNonEmptyString(entry) && entry !== HARNESS_PRESET_AGENT_FOLLOWS) out[key] = entry;
  }
  return out;
}

function normalizeSource(value: unknown): HarnessPresetSource | null {
  if (validateSource(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "account") {
    return {
      kind: "account",
      provider: raw.provider as HarnessPresetAccountProvider,
      instanceId: String(raw.instanceId).trim(),
    };
  }
  if (raw.kind === "key") {
    return {
      kind: "key",
      provider: String(raw.provider).trim(),
      credentialId: String(raw.credentialId).trim(),
      label: isNonEmptyString(raw.label) ? raw.label.trim() : String(raw.provider).trim(),
    };
  }
  return { kind: "subscription", provider: raw.provider as HarnessPresetAccountProvider };
}

function normalizeLogo(value: unknown): HarnessPresetLogo {
  if (validateLogo(value)) return { ...DEFAULT_HARNESS_PRESET_LOGO };
  const raw = value as Record<string, unknown>;
  if (raw.kind === "provider") return { kind: "provider", providerId: String(raw.providerId).trim() };
  if (raw.kind === "upload") return { kind: "upload", dataUrl: String(raw.dataUrl) };
  if (raw.kind === "generated") return { kind: "generated", dataUrl: String(raw.dataUrl) };
  return { ...DEFAULT_HARNESS_PRESET_LOGO };
}

/**
 * Coerce one stored row into a preset, or drop it.
 *
 * A preset that lost its harness, source or model cannot be launched, so it is
 * discarded rather than repaired into something that looks runnable and is not.
 * Everything else has a defensible default.
 */
export function normalizeHarnessPreset(value: unknown): HarnessPreset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isNonEmptyString(raw.id)) return null;
  if (!isHarnessPresetBody(raw.harness)) return null;
  const source = normalizeSource(raw.source);
  if (!source) return null;
  if (!isNonEmptyString(raw.model)) return null;

  const name = isNonEmptyString(raw.name)
    ? raw.name.trim().slice(0, HARNESS_PRESET_NAME_MAX_LENGTH)
    : harnessBodyLabel(raw.harness);
  const accentColor =
    typeof raw.accentColor === "string" && HARNESS_PRESET_ACCENT_PATTERN.test(raw.accentColor)
      ? raw.accentColor.toLowerCase()
      : DEFAULT_HARNESS_PRESET_ACCENT;
  const createdAt = isNonEmptyString(raw.createdAt) ? raw.createdAt : new Date(0).toISOString();

  return {
    id: raw.id.trim(),
    name,
    harness: raw.harness,
    source,
    model: raw.model.trim(),
    ...(isNonEmptyString(raw.reasoningEffort) ? { reasoningEffort: raw.reasoningEffort.trim() } : {}),
    subagentModel: isNonEmptyString(raw.subagentModel) ? raw.subagentModel.trim() : HARNESS_PRESET_SUBAGENT_INHERIT,
    agentOverrides: normalizeAgentOverrides(raw.agentOverrides),
    permissionMode: isNonEmptyString(raw.permissionMode) ? raw.permissionMode.trim() : "default",
    accentColor,
    logo: normalizeLogo(raw.logo),
    createdAt,
    updatedAt: isNonEmptyString(raw.updatedAt) ? raw.updatedAt : createdAt,
  };
}

/** Coerce a stored list, dropping unusable rows and duplicate ids. */
export function normalizeHarnessPresetList(value: unknown): HarnessPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: HarnessPreset[] = [];
  for (const entry of value) {
    const preset = normalizeHarnessPreset(entry);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    out.push(preset);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function presetLabel(preset: Pick<HarnessPreset, "name" | "harness">): string {
  const name = preset.name.trim();
  return name.length ? name : harnessBodyLabel(preset.harness);
}

/**
 * The muted second line everywhere a preset is listed: `Harness · model`.
 *
 * `resolveModelName` lets a surface that has the model registry in hand show
 * "Claude Opus 4.5" where a surface that does not shows the raw id, without
 * this module reaching for the registry itself.
 */
export function presetSummary(
  preset: Pick<HarnessPreset, "harness" | "model">,
  resolveModelName?: (modelId: string) => string | null | undefined,
): string {
  const model = resolveModelName?.(preset.model)?.trim() || preset.model;
  return `${harnessBodyLabel(preset.harness)} · ${model}`;
}

/** One phrase naming the brain, for the list page's source column. */
export function presetSourceLabel(
  source: HarnessPresetSource,
  resolveAccountLabel?: (instanceId: string) => string | null | undefined,
): string {
  if (source.kind === "account") {
    const label = resolveAccountLabel?.(source.instanceId)?.trim();
    const provider = harnessBodyLabel(source.provider);
    return label ? `${provider} account · ${label}` : `${provider} account`;
  }
  if (source.kind === "key") {
    return `API key · ${source.label}`;
  }
  return `${harnessBodyLabel(source.provider)} subscription`;
}

/** Subagent row copy. `"inherit"` reads as the sentence, not as the token. */
export function presetSubagentLabel(
  preset: Pick<HarnessPreset, "subagentModel">,
  resolveModelName?: (modelId: string) => string | null | undefined,
): string {
  if (preset.subagentModel === HARNESS_PRESET_SUBAGENT_INHERIT) return "Same as main";
  return resolveModelName?.(preset.subagentModel)?.trim() || preset.subagentModel;
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

export const HARNESS_PRESET_EXPORT_KIND = "ade.harness-preset";
export const HARNESS_PRESET_EXPORT_VERSION = 1;

/**
 * Biggest logo an export carries. A 256×256 PNG lands well under this; anything
 * past it is a pasted screenshot, and a shared preset file is not the place for
 * a quarter-megabyte of base64.
 */
export const HARNESS_PRESET_LOGO_EXPORT_MAX_BYTES = 200 * 1024;

export type HarnessPresetExport = {
  kind: typeof HARNESS_PRESET_EXPORT_KIND;
  version: typeof HARNESS_PRESET_EXPORT_VERSION;
  exportedAt: string;
  preset: {
    name: string;
    harness: HarnessPresetBody;
    /** A reference to a credential or an account — never a credential value. */
    source: HarnessPresetSource;
    model: string;
    reasoningEffort?: string;
    subagentModel: string;
    agentOverrides: HarnessPresetAgentOverrides;
    permissionMode: string;
    accentColor: string;
    logo: HarnessPresetLogo;
  };
  /** Anything the export deliberately dropped, in the user's own words. */
  notes: string[];
};

/**
 * Rebuild the source from a fixed field list.
 *
 * This is the leak guard, and it is a rebuild rather than a delete-list on
 * purpose: a future field that happens to hold a key value is dropped by
 * default instead of surviving until someone remembers to blacklist it.
 */
function sourceForExport(source: HarnessPresetSource): HarnessPresetSource {
  if (source.kind === "account") {
    return { kind: "account", provider: source.provider, instanceId: source.instanceId };
  }
  if (source.kind === "key") {
    return { kind: "key", provider: source.provider, credentialId: source.credentialId, label: source.label };
  }
  return { kind: "subscription", provider: source.provider };
}

function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  // base64 → bytes, minus the padding the tail carries.
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * A preset as a shareable object. `id`, `createdAt` and `updatedAt` are left
 * behind — they describe this machine's copy, not the thing being shared.
 */
export function exportHarnessPreset(preset: HarnessPreset, now: () => Date = () => new Date()): HarnessPresetExport {
  const notes: string[] = [];
  let logo = normalizeLogo(preset.logo);
  if ((logo.kind === "upload" || logo.kind === "generated") && dataUrlByteLength(logo.dataUrl) > HARNESS_PRESET_LOGO_EXPORT_MAX_BYTES) {
    notes.push("The logo was too large to share, so this preset carries the ADE mark instead.");
    logo = { ...DEFAULT_HARNESS_PRESET_LOGO };
  }
  if (preset.source.kind === "key") {
    notes.push("The API key itself is not in this file — whoever imports it needs their own key for this provider.");
  }
  if (preset.source.kind === "account") {
    notes.push("The provider account is named, not included — whoever imports it needs their own sign-in.");
  }
  if (preset.source.kind === "subscription") {
    notes.push("The subscription sign-in is not in this file — whoever imports it signs in through ADE's proxy.");
  }

  return {
    kind: HARNESS_PRESET_EXPORT_KIND,
    version: HARNESS_PRESET_EXPORT_VERSION,
    exportedAt: now().toISOString(),
    preset: {
      name: preset.name,
      harness: preset.harness,
      source: sourceForExport(preset.source),
      model: preset.model,
      ...(preset.reasoningEffort ? { reasoningEffort: preset.reasoningEffort } : {}),
      subagentModel: preset.subagentModel,
      agentOverrides: normalizeAgentOverrides(preset.agentOverrides),
      permissionMode: preset.permissionMode,
      accentColor: preset.accentColor,
      logo,
    },
    notes,
  };
}

/** What an imported preset needs before it can run on this machine. */
export type HarnessPresetMissing = "account" | "key" | "subscription-signin";

export type HarnessPresetImportContext = {
  /** Provider-instance ids this machine holds. */
  accountInstanceIds?: readonly string[];
  /** Credential ids in this machine's API-key store. */
  credentialIds?: readonly string[];
  /** Whether ADE's proxy can hold a subscription sign-in on this host. */
  proxySignInAvailable?: boolean;
};

export type HarnessPresetImportResult = {
  preset: HarnessPresetDraft;
  missing: HarnessPresetMissing[];
  /** Notes the exporting side wrote, passed straight through. */
  notes: string[];
};

export class HarnessPresetImportError extends Error {}

/**
 * Read an exported preset back.
 *
 * Returns a draft rather than a preset: the importing machine mints the id and
 * the timestamps, so importing the same file twice makes two presets instead of
 * one preset that overwrites itself. `missing` is what the wizard lists — an
 * account this machine does not have, a key it does not hold, or a proxy
 * sign-in it cannot perform.
 */
export function importHarnessPreset(
  input: unknown,
  context: HarnessPresetImportContext = {},
): HarnessPresetImportResult {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new HarnessPresetImportError("That file is not a harness ADE can read.");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HarnessPresetImportError("That file is not a harness ADE can read.");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.kind !== HARNESS_PRESET_EXPORT_KIND) {
    throw new HarnessPresetImportError("That file is not a harness ADE can read.");
  }
  if (typeof envelope.version !== "number" || envelope.version > HARNESS_PRESET_EXPORT_VERSION) {
    throw new HarnessPresetImportError("That harness was saved by a newer version of ADE.");
  }
  const body = envelope.preset;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HarnessPresetImportError("That harness file is missing its settings.");
  }
  const raw = body as Record<string, unknown>;
  if (!isHarnessPresetBody(raw.harness)) {
    throw new HarnessPresetImportError("That harness names an agent ADE cannot run.");
  }
  const source = normalizeSource(raw.source);
  if (!source) {
    throw new HarnessPresetImportError("That harness does not say where its intelligence comes from.");
  }
  if (!isNonEmptyString(raw.model)) {
    throw new HarnessPresetImportError("That harness does not name a model.");
  }

  const missing: HarnessPresetMissing[] = [];
  if (source.kind === "account" && !(context.accountInstanceIds ?? []).includes(source.instanceId)) {
    missing.push("account");
  }
  if (source.kind === "key" && !(context.credentialIds ?? []).includes(source.credentialId)) {
    missing.push("key");
  }
  if (source.kind === "subscription" && context.proxySignInAvailable !== true) {
    missing.push("subscription-signin");
  }

  const preset: HarnessPresetDraft = {
    name: isNonEmptyString(raw.name)
      ? raw.name.trim().slice(0, HARNESS_PRESET_NAME_MAX_LENGTH)
      : harnessBodyLabel(raw.harness),
    harness: raw.harness,
    source,
    model: raw.model.trim(),
    ...(isNonEmptyString(raw.reasoningEffort) ? { reasoningEffort: raw.reasoningEffort.trim() } : {}),
    subagentModel: isNonEmptyString(raw.subagentModel) ? raw.subagentModel.trim() : HARNESS_PRESET_SUBAGENT_INHERIT,
    agentOverrides: normalizeAgentOverrides(raw.agentOverrides),
    permissionMode: isNonEmptyString(raw.permissionMode) ? raw.permissionMode.trim() : "default",
    accentColor:
      typeof raw.accentColor === "string" && HARNESS_PRESET_ACCENT_PATTERN.test(raw.accentColor)
        ? raw.accentColor.toLowerCase()
        : DEFAULT_HARNESS_PRESET_ACCENT,
    logo: normalizeLogo(raw.logo),
  };

  const notes = Array.isArray(envelope.notes)
    ? envelope.notes.filter((note): note is string => typeof note === "string")
    : [];

  return { preset, missing, notes };
}

/** One sentence per missing prerequisite, for the wizard's banner. */
export function harnessPresetMissingCopy(missing: HarnessPresetMissing): string {
  if (missing === "account") return "This harness names a provider account this computer does not have. Pick one of yours.";
  if (missing === "key") return "This harness names an API key this computer does not hold. Pick one of yours, or add it in Secrets.";
  return "This harness borrows a subscription through ADE's proxy, which is not signed in on this computer yet.";
}

// ---------------------------------------------------------------------------
// List operations
// ---------------------------------------------------------------------------

/**
 * A name that is not already taken, for Duplicate and for Import.
 *
 * "Opus work" becomes "Opus work 2", then "Opus work 3" — not "Opus work copy
 * copy", which is what a suffix-append produces on the third pass.
 */
export function uniqueHarnessPresetName(desired: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((name) => name.trim().toLowerCase()));
  const base = desired.trim() || "Harness";
  if (!taken.has(base.toLowerCase())) return base.slice(0, HARNESS_PRESET_NAME_MAX_LENGTH);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate.slice(0, HARNESS_PRESET_NAME_MAX_LENGTH);
  }
  return `${base} ${Date.now()}`.slice(0, HARNESS_PRESET_NAME_MAX_LENGTH);
}

/** Match a preset against the model picker's search box. */
export function harnessPresetMatchesQuery(preset: HarnessPreset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    preset.name.toLowerCase().includes(needle)
    || harnessBodyLabel(preset.harness).toLowerCase().includes(needle)
    || preset.model.toLowerCase().includes(needle)
  );
}
