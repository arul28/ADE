import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  createDynamicDroidCliModelDescriptor,
  sortDroidCliDescriptorsForPicker,
  type ModelCapabilities,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { resolveAdeCacheFile } from "../shared/adeCacheFile";
import { runAfterLaunchQuiet } from "../shared/launchQuiet";
import { spawnAsync, writeTextAtomic } from "../shared/utils";

export type DroidExecHelpModelRow = {
  id: string;
  displayName: string;
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

/*
 * The last `droid exec --help` answer, on disk. That answer comes from the
 * binary and from the custom models in Factory's `settings.json`, so it is
 * kept with both files' size and modification time: a brain that starts
 * with neither file changed shows the list without starting droid (about
 * 40 MB read from disk on a cold start). A changed file, an answer older
 * than {@link POSITIVE_TTL_MS}, or a sign-in change (`clearDroidCliModelsCache`)
 * drops it.
 */
const DISK_CACHE_FILE = "droid-models-cache.json";
const DISK_CACHE_VERSION = 1;

type FileStamp = { size: number; mtimeMs: number };
type DroidModelsDiskEntry = {
  version: typeof DISK_CACHE_VERSION;
  droidPath: string;
  binary: FileStamp;
  settings: FileStamp | null;
  savedAt: number;
  models: DroidExecHelpModelRow[];
};

function fileStamp(filePath: string): FileStamp | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

function sameStamp(a: FileStamp | null | undefined, b: FileStamp | null): boolean {
  if (!a || !b) return !a && !b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Factory's settings file, as the spawned droid finds it (`FACTORY_HOME_OVERRIDE` names the home that holds `.factory`). */
function factorySettingsPath(): string {
  const home = process.env.FACTORY_HOME_OVERRIDE?.trim() || homedir();
  return path.join(home, ".factory", "settings.json");
}

function readDiskModels(droidPath: string): DroidExecHelpModelRow[] | null {
  try {
    const entry = JSON.parse(fs.readFileSync(resolveAdeCacheFile(DISK_CACHE_FILE), "utf8")) as Partial<DroidModelsDiskEntry>;
    if (entry.version !== DISK_CACHE_VERSION || entry.droidPath !== droidPath) return null;
    if (typeof entry.savedAt !== "number" || Date.now() - entry.savedAt > POSITIVE_TTL_MS) return null;
    const binary = fileStamp(droidPath);
    if (!binary || !sameStamp(entry.binary, binary) || !sameStamp(entry.settings, fileStamp(factorySettingsPath()))) return null;
    const models = Array.isArray(entry.models)
      ? entry.models.filter((row): row is DroidExecHelpModelRow =>
        typeof row?.id === "string" && row.id.length > 0 && typeof row.displayName === "string")
      : [];
    return models.length ? models : null;
  } catch {
    return null;
  }
}

function writeDiskModels(droidPath: string, models: DroidExecHelpModelRow[]): void {
  const binary = fileStamp(droidPath);
  if (!binary || !models.length) return;
  const entry: DroidModelsDiskEntry = {
    version: DISK_CACHE_VERSION,
    droidPath,
    binary,
    settings: fileStamp(factorySettingsPath()),
    savedAt: Date.now(),
    models,
  };
  try {
    writeTextAtomic(resolveAdeCacheFile(DISK_CACHE_FILE), JSON.stringify(entry));
  } catch {
    // Without the file the next brain asks droid again; nothing else changes.
  }
}

function clearDiskModels(): void {
  try {
    fs.rmSync(resolveAdeCacheFile(DISK_CACHE_FILE), { force: true });
  } catch {
    // Best effort, as the write.
  }
}

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
    const helpResult = await spawnAsync(droidPath, ["exec", "--help"], {
      timeout: 8_000,
      maxOutputBytes: 64_000,
      cwd: tmpdir(),
    });
    if (helpResult.status === 0) {
      const rows = parseDroidExecHelpModels(helpResult.stdout ?? "");
      if (rows.length) {
        cached = { at: now, models: rows };
        writeDiskModels(droidPath, rows);
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
      const result = await spawnAsync(droidPath, args, { timeout: 2_500, cwd: tmpdir() });
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

  if (cached?.models.length) {
    return cached.models;
  }
  cached = { at: now, models: [] };
  return [];
}

function canonicalDroidReplacementForAlias(id: string): DroidExecHelpModelRow | null {
  const normalized = id.trim().toLowerCase();
  if (
    normalized === "claude-fable-5"
    || normalized === "fable"
    || normalized === "fable-5"
    || normalized === "fable-5.0"
    || normalized === "fable-5.1"
    || normalized === "fable-5-1"
  ) {
    return {
      id: `claude-fable-5-1`,
      displayName: "Fable 5.1",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: CANONICAL_DROID_ANTHROPIC_CAPABILITIES,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultracode"],
      defaultReasoningEffort: "high",
    };
  }
  if (
    normalized === "claude-sonnet-4-6"
    || normalized === "sonnet-4-6"
  ) {
    return {
      id: `claude-sonnet-5`,
      displayName: "Sonnet 5 (1.2x)",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: CANONICAL_DROID_ANTHROPIC_CAPABILITIES,
      reasoningTiers: ["low", "medium", "high", "max"],
    };
  }
  if (normalized === "opus") {
    return {
      id: `claude-opus-5-5`,
      displayName: "Opus 5.5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: CANONICAL_DROID_ANTHROPIC_CAPABILITIES,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    };
  }
  if (
    normalized === "claude-opus-4-8"
    || normalized === "opus-4.8"
    || normalized === "opus-4-8"
    || normalized === "claude-opus-4-7"
    || normalized === "opus-4-7"
    || normalized === "opus-4.7"
    || normalized === "claude-opus-4-6"
    || normalized === "claude-opus-4-6-fast"
    || normalized === "opus-4-6"
    || normalized === "opus-4.6"
    || normalized === "claude-opus-4-7-1m"
    || normalized === "claude-opus-4-7[1m]"
    || normalized === "opus-1m"
    || normalized === "opus[1m]"
  ) {
    return {
      id: `claude-opus-5`,
      displayName: "Opus 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: CANONICAL_DROID_ANTHROPIC_CAPABILITIES,
      reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    };
  }
  return null;
}

function normalizeDroidDiscoveredModel(row: DroidExecHelpModelRow): DroidExecHelpModelRow {
  return canonicalDroidReplacementForAlias(row.id) ?? row;
}

async function listDroidModelsFromSdk(droidPath: string): Promise<DroidExecHelpModelRow[]> {
  // Model probes used to call createSession(), which writes an empty
  // `New Session` stub under ~/.factory/sessions on every warmup. CLI help
  // is enough for the picker and does not create session files.
  return listDroidModelsFromCli(droidPath);
}

export function clearDroidCliModelsCache(): void {
  clearDiskModels();
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
  // Not in the first seconds of a launch, and not beside the other
  // background CLI starts (`launchQuiet.ts`).
  void runAfterLaunchQuiet(() => listDroidModelsFromSdk(droidPath))
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
  // A new process: the last answer for this same droid and settings file.
  const fromDisk = !cached && droidPathForRevalidate ? readDiskModels(droidPathForRevalidate) : null;
  if (fromDisk) {
    cached = { at: now, models: fromDisk };
    return fromDisk;
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
  // Droid's own `--help` lists the custom models it can run (its
  // `.factory/settings.json` `customModels`); it no longer reads the old
  // `config.json` `custom_models`, so ADE does not either.
  const baseRows: DroidExecHelpModelRow[] = fromSdk;

  const descriptors: ModelDescriptor[] = [];
  const descriptorIds = new Map<string, number>();
  const descriptorPreferredDuplicateSources = new Map<string, boolean>();
  for (const rawRow of baseRows) {
    const row = normalizeDroidDiscoveredModel(rawRow);
    const trimmed = String(row.id ?? "").trim();
    if (!trimmed) continue;
    const preferredDuplicateSource = rawRow.id.trim().toLowerCase() === trimmed.toLowerCase();
    const descriptor = createDynamicDroidCliModelDescriptor(trimmed, row.displayName, {
      ...(row.reasoningTiers?.length ? { reasoningTiers: row.reasoningTiers } : {}),
      ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
      ...(row.serviceTiers?.length ? { serviceTiers: row.serviceTiers } : {}),
      ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
      ...(row.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
      ...(row.capabilities ? { capabilities: row.capabilities } : {}),
    });
    const descriptorKey = descriptor.id.toLowerCase();
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
