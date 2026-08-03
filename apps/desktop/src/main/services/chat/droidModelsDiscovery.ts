import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSession } from "@factory/droid-sdk";
import {
  createDynamicDroidCliModelDescriptor,
  sortDroidCliDescriptorsForPicker,
  type ModelCapabilities,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { spawnAsync } from "../shared/utils";
import { ensureDroidSpawnsAreWindowless } from "./droidSdkWindowsHide";

export type DroidExecHelpModelRow = {
  id: string;
  displayName: string;
  /** True when sourced from ~/.factory/config.json (vibeproxy / custom proxy). */
  customProxy?: boolean;
  reasoningTiers?: string[];
  defaultReasoningEffort?: string;
  serviceTiers?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
};
type DroidCliModelDiscoveryMode = "probe" | "cached-or-fallback";

let cached: { at: number; models: DroidExecHelpModelRow[] } | null = null;
let inflight: Promise<DroidExecHelpModelRow[]> | null = null;
let warmInFlight = false;
let lastWarmAttemptAt = 0;
const TTL_MS = 120_000;
// Serve last-known-good rows well past the freshness window (revalidating in
// the background) so passive consumers never lose models between probes.
const POSITIVE_TTL_MS = 6 * 60 * 60_000;

const CANONICAL_DROID_ANTHROPIC_CAPABILITIES: Partial<ModelCapabilities> = {
  tools: true,
  vision: true,
  reasoning: true,
  streaming: true,
};

export function parseDroidExecHelpModels(stdout: string): DroidExecHelpModelRow[] {
  const lines = stdout.split(/\r?\n/);
  const rows: DroidExecHelpModelRow[] = [];
  const seen = new Set<string>();
  let inModelSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(Available Models|Custom Models):$/i.test(trimmed)) {
      inModelSection = true;
      continue;
    }
    if (!inModelSection) continue;
    if (!trimmed.length) continue;
    if (
      /^(Model details|Authentication|Examples|Autonomy Levels|Session Flags|Tool Controls):$/i.test(trimmed)
      || /^[-A-Z][\w -]+:$/i.test(trimmed)
    ) {
      break;
    }
    const match = line.match(/^\s{2,}([a-z0-9][\w.:()+-]*)\s{2,}(.+?)\s*$/i);
    if (!match) continue;
    const id = match[1].trim();
    const displayName = match[2].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, displayName });
  }

  return rows;
}

export function parseDroidExecHelpModelIds(stdout: string): string[] {
  return parseDroidExecHelpModels(stdout).map((row) => row.id);
}

/**
 * Best-effort: ask the Droid CLI for models (flags vary by version).
 */
export async function listDroidModelIdsFromCli(droidPath: string): Promise<string[]> {
  return (await listDroidModelsFromCli(droidPath)).map((row) => row.id);
}

async function listDroidModelsFromCli(droidPath: string): Promise<DroidExecHelpModelRow[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) {
    return cached.models;
  }
  if (inflight) {
    return inflight;
  }
  inflight = listDroidModelsFromCliInner(droidPath).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function listDroidModelsFromCliInner(droidPath: string): Promise<DroidExecHelpModelRow[]> {
  const now = Date.now();
  try {
    const helpResult = await spawnAsync(droidPath, ["exec", "--help"], { timeout: 8_000, maxOutputBytes: 64_000 });
    if (helpResult.status === 0) {
      const rows = parseDroidExecHelpModels(helpResult.stdout ?? "");
      if (rows.length) {
        cached = { at: now, models: rows };
        return rows;
      }
    }
  } catch {
    // Fall through to legacy probes below.
  }

  const probes: string[][] = [
    ["models", "--json"],
    ["model", "list", "--json"],
    ["models"],
  ];

  for (const args of probes) {
    try {
      const result = await spawnAsync(droidPath, args, { timeout: 2_500 });
      if (result.status !== 0) continue;
      const stdout = (result.stdout ?? "").trim();
      if (!stdout) continue;

      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (Array.isArray(parsed)) {
          const rows: DroidExecHelpModelRow[] = [];
          for (const row of parsed) {
            if (typeof row === "string" && row.trim()) {
              const id = row.trim();
              rows.push({ id, displayName: id });
              continue;
            }
            if (row && typeof row === "object") {
              const r = row as Record<string, unknown>;
              const id = typeof r.id === "string" ? r.id.trim() : typeof r.model === "string" ? r.model.trim() : "";
              const displayName = typeof r.name === "string" && r.name.trim().length ? r.name.trim() : id;
              if (id) rows.push({ id, displayName });
            }
          }
          if (rows.length) {
            cached = { at: now, models: rows };
            return rows;
          }
        }
      } catch {
        // not JSON
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^usage:/i.test(l) && !/^options:/i.test(l));
      const bare: DroidExecHelpModelRow[] = [];
      const seen = new Set<string>();
      for (const line of lines) {
        const m = line.match(/^([a-z0-9][\w.-]*)$/i);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          bare.push({ id: m[1], displayName: m[1] });
        }
      }
      if (bare.length >= 3) {
        cached = { at: now, models: bare };
        return bare;
      }
    } catch {
      // try next probe
    }
  }

  cached = { at: now, models: [] };
  return [];
}

function addUnique(out: string[], value: string | null | undefined): void {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return;
  if (!out.includes(normalized)) out.push(normalized);
}

function normalizeDroidReasoningEffort(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (normalized) {
    case "none":
    case "dynamic":
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "ultracode":
      return normalized;
    case "extra-high":
    case "extra_high":
      return "xhigh";
    case "ultra-code":
    case "ultra_code":
      return "ultracode";
    default:
      return null;
  }
}

function normalizeDroidReasoningEfforts(value: unknown, defaultValue: unknown): string[] | undefined {
  const out: string[] = [];
  addUnique(out, normalizeDroidReasoningEffort(defaultValue));
  if (Array.isArray(value)) {
    for (const entry of value) addUnique(out, normalizeDroidReasoningEffort(entry));
  }
  return out.length ? out : undefined;
}

function readSdkModelRows(initResult: unknown): DroidExecHelpModelRow[] {
  const record = initResult && typeof initResult === "object" ? initResult as Record<string, unknown> : null;
  const raw = Array.isArray(record?.availableModels) ? record.availableModels : [];
  const seen = new Set<string>();
  const rows: DroidExecHelpModelRow[] = [];
  for (const entry of raw) {
    const model = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!model) continue;
    const id = typeof model.id === "string" && model.id.trim().length
      ? model.id.trim()
      : typeof model.modelId === "string"
        ? model.modelId.trim()
        : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof model.displayName === "string" && model.displayName.trim().length
      ? model.displayName.trim()
      : typeof model.shortDisplayName === "string" && model.shortDisplayName.trim().length
        ? model.shortDisplayName.trim()
        : id;
    const reasoningTiers = normalizeDroidReasoningEfforts(
      model.supportedReasoningEfforts,
      model.defaultReasoningEffort,
    );
    rows.push({
      id,
      displayName,
      customProxy: model.isCustom === true,
      ...(reasoningTiers?.length ? { reasoningTiers } : {}),
      capabilities: {
        vision: model.noImageSupport !== true,
        reasoning: Boolean(reasoningTiers?.length),
      },
    });
  }
  return rows;
}

function canonicalDroidReplacementForAlias(
  id: string,
  options?: { customProxy?: boolean },
): DroidExecHelpModelRow | null {
  const normalized = id.trim().toLowerCase();
  const idPrefix = options?.customProxy ? "custom:" : "";
  const customProxy = options?.customProxy ? { customProxy: true } : {};
  if (
    normalized === "claude-sonnet-4-6"
    || normalized === "sonnet-4-6"
    || (options?.customProxy && normalized === "claude-sonnet-5")
  ) {
    return {
      id: `${idPrefix}claude-sonnet-5`,
      displayName: "Sonnet 5 (1.2x)",
      ...customProxy,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: CANONICAL_DROID_ANTHROPIC_CAPABILITIES,
      reasoningTiers: ["low", "medium", "high", "max"],
    };
  }
  if (
    normalized === "opus"
    || (options?.customProxy && normalized === "claude-opus-5")
  ) {
    return {
      id: `${idPrefix}claude-opus-5`,
      displayName: "Opus 5",
      ...customProxy,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: CANONICAL_DROID_ANTHROPIC_CAPABILITIES,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    };
  }
  if (
    normalized === "claude-opus-4-7"
    || normalized === "opus-4-7"
    || normalized === "opus-4.7"
    || normalized === "claude-opus-4-6"
    || normalized === "claude-opus-4-6-fast"
    || normalized === "opus-4-6"
    || normalized === "opus-4.6"
    || (options?.customProxy && normalized === "claude-opus-4-8")
  ) {
    return {
      id: `${idPrefix}claude-opus-4-8`,
      displayName: "Opus 4.8 1M",
      ...customProxy,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: CANONICAL_DROID_ANTHROPIC_CAPABILITIES,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultracode"],
      serviceTiers: ["fast"],
    };
  }
  return null;
}

function normalizeDroidDiscoveredModel(row: DroidExecHelpModelRow): DroidExecHelpModelRow {
  const id = row.id.trim().toLowerCase();
  const customProxy = row.customProxy === true && id.startsWith("custom:");
  const normalizedCustomId = customProxy ? id.slice("custom:".length) : id;
  const replacement = canonicalDroidReplacementForAlias(normalizedCustomId, { customProxy });
  if (replacement) return replacement;
  return row;
}

async function listDroidModelsFromSdk(droidPath: string): Promise<DroidExecHelpModelRow[]> {
  const now = Date.now();
  // This runs createSession() in-process (not in the worker), so the SDK spawns
  // `droid` straight from the Electron main process on a passive warm path.
  ensureDroidSpawnsAreWindowless();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const session = await createSession({
      execPath: droidPath,
      cwd: process.cwd(),
      abortSignal: controller.signal,
    });
    try {
      const rows = readSdkModelRows(session.initResult);
      cached = { at: now, models: rows };
      return rows;
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function clearDroidCliModelsCache(): void {
  cached = null;
  inflight = null;
  warmInFlight = false;
  lastWarmAttemptAt = 0;
}

/**
 * Age the positive model cache so the next consumer revalidates, without
 * dropping last-known-good rows. Generic provider readiness invalidation
 * must not blank the droid model list — only a credential change does that
 * ({@link clearDroidCliModelsCache}).
 */
export function markDroidModelCachesStale(): void {
  if (cached) cached = { ...cached, at: Math.min(cached.at, Date.now() - TTL_MS) };
  lastWarmAttemptAt = 0;
}

function warmDroidModels(droidPath: string): void {
  const now = Date.now();
  // At most one background SDK session per freshness window — a fresh cached
  // result (even an empty one) or a recent attempt means don't re-probe, so
  // an unauthenticated droid doesn't get a session spawned per passive call.
  if (warmInFlight || now - lastWarmAttemptAt < TTL_MS) return;
  if (cached && now - cached.at < TTL_MS) return;
  lastWarmAttemptAt = now;
  warmInFlight = true;
  void listDroidModelsFromSdk(droidPath)
    .catch(() => undefined)
    .finally(() => {
      warmInFlight = false;
    });
}

function getCachedDroidModels(droidPathForRevalidate?: string | null): DroidExecHelpModelRow[] | null {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) {
    return cached.models;
  }
  // Stale-while-revalidate: serve last-known-good rows past the freshness
  // window and refresh in the background so passive consumers never watch
  // models blink out between active probes.
  if (cached && now - cached.at < POSITIVE_TTL_MS && cached.models.length) {
    if (droidPathForRevalidate) warmDroidModels(droidPathForRevalidate);
    return cached.models;
  }
  return null;
}

/**
 * Read custom models from `~/.factory/config.json`.
 *
 * Vibeproxy (and other tools) inject custom models into the Droid CLI by
 * writing entries to this file.  Each entry carries the raw model ID, a
 * human-readable display name, and a `custom:` prefixed ID that the CLI
 * uses internally.
 */
async function readFactoryConfigCustomModels(): Promise<DroidExecHelpModelRow[]> {
  try {
    const configPath = join(homedir(), ".factory", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const customModels = parsed.custom_models;
    if (!Array.isArray(customModels)) return [];
    const rows: DroidExecHelpModelRow[] = [];
    for (const entry of customModels) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const model = typeof e.model === "string" ? e.model.trim() : "";
      const displayName = typeof e.model_display_name === "string" ? e.model_display_name.trim() : "";
      if (!model) continue;
      // The droid CLI wraps custom models with a "custom:" prefix.
      const id = `custom:${model}`;
      rows.push({ id, displayName: displayName || id, customProxy: true });
    }
    return rows;
  } catch {
    return [];
  }
}

export async function discoverDroidCliModelDescriptors(
  droidPath: string,
  options?: { mode?: DroidCliModelDiscoveryMode },
): Promise<ModelDescriptor[]> {
  const fromSdk = options?.mode === "cached-or-fallback"
    ? getCachedDroidModels(droidPath) ?? []
    : await listDroidModelsFromSdk(droidPath).catch(() => []);
  if (!fromSdk.length && options?.mode === "cached-or-fallback") {
    warmDroidModels(droidPath);
  }
  const baseRows: DroidExecHelpModelRow[] = fromSdk;

  // Merge custom models from ~/.factory/config.json so vibeproxy-injected
  // models appear even when the CLI help output doesn't list them.
  const customRows = await readFactoryConfigCustomModels();

  const descriptors: ModelDescriptor[] = [];
  const descriptorIds = new Map<string, number>();
  const descriptorPreferredDuplicateSources = new Map<string, boolean>();
  for (const rawRow of [...baseRows, ...customRows]) {
    const row = normalizeDroidDiscoveredModel(rawRow);
    const trimmed = String(row.id ?? "").trim();
    if (!trimmed) continue;
    const descriptorKey = trimmed.toLowerCase();
    const preferredDuplicateSource = rawRow.id.trim().toLowerCase() === trimmed.toLowerCase();
    const descriptor = createDynamicDroidCliModelDescriptor(trimmed, row.displayName, {
      customProxy: row.customProxy,
      ...(row.reasoningTiers?.length ? { reasoningTiers: row.reasoningTiers } : {}),
      ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
      ...(row.serviceTiers?.length ? { serviceTiers: row.serviceTiers } : {}),
      ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
      ...(row.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
      ...(row.capabilities ? { capabilities: row.capabilities } : {}),
    });
    const existingIndex = descriptorIds.get(descriptorKey);
    if (existingIndex !== undefined) {
      const existingPreferred = descriptorPreferredDuplicateSources.get(descriptorKey) ?? false;
      if (!existingPreferred && preferredDuplicateSource) {
        descriptors[existingIndex] = descriptor;
        descriptorPreferredDuplicateSources.set(descriptorKey, true);
      }
      continue;
    }
    descriptorIds.set(descriptorKey, descriptors.length);
    descriptorPreferredDuplicateSources.set(descriptorKey, preferredDuplicateSource);
    descriptors.push(descriptor);
  }
  return sortDroidCliDescriptorsForPicker(descriptors);
}

export const discoverDroidSdkModelDescriptors = discoverDroidCliModelDescriptors;
