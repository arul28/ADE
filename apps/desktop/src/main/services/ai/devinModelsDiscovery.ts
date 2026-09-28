/**
 * Devin CLI model discovery.
 *
 * `devin models list --format json` reports every model family the account can
 * use, with per-variant context/output limits. ADE's curated Devin rows are
 * only durable family picks; this is the live catalog the account actually
 * offers, so the picker does not drift behind Cognition's releases.
 *
 * The response is large (52+ families, hundreds of variants), and the ACP
 * dynamic rows cross the sync wire, so this maps to ONE row per family — the
 * family's aliases ride the row, and a preferred variant carries the real
 * `model_uid` and limits. The registry's own cap still applies downstream.
 *
 * Discovery is lazy and cached: a status read serves the last catalog and warms
 * in the background only when cold, so the picker never blocks on a subprocess.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createDynamicAcpModelDescriptor,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Internal enum names (`MODEL_PRIVATE_11`, `MODEL_GPT_5_2_LOW`) are not valid
 * `--model` tokens and would surface as unusable rows.
 */
function isUsableModelUid(uid: string): boolean {
  return !/^MODEL_/i.test(uid);
}

/**
 * Pick the family's representative variant: a `-medium` tier when present (the
 * usual default middle), else `-high`, else the first usable variant.
 */
function pickVariant(variants: unknown[]): Json | null {
  const usable = variants
    .filter(isRecord)
    .filter((variant) => {
      const uid = readString(variant.model_uid);
      return Boolean(uid && isUsableModelUid(uid));
    });
  if (!usable.length) return null;
  const uidOf = (variant: Json): string => readString(variant.model_uid) ?? "";
  return usable.find((variant) => /-medium$/i.test(uidOf(variant)))
    ?? usable.find((variant) => /-high$/i.test(uidOf(variant)))
    ?? usable[0]!;
}

/**
 * Pure parse of `devin models list --format json` stdout into ADE descriptors.
 * Returns [] on any malformed input rather than throwing into a status read.
 */
export function parseDevinModels(stdout: string): ModelDescriptor[] {
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    return [];
  }
  const families = isRecord(root) && Array.isArray(root.families) ? root.families : [];
  const out: ModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    if (!isRecord(family)) continue;
    const label = readString(family.family_label) ?? readString(family.slug);
    const variants = Array.isArray(family.variants) ? family.variants : [];
    const chosen = pickVariant(variants);
    if (!chosen) continue;
    const uid = readString(chosen.model_uid);
    if (!uid || !isUsableModelUid(uid) || seen.has(uid)) continue;
    seen.add(uid);
    const contextWindow = readNumber(chosen.max_context_tokens);
    const maxOutputTokens = readNumber(chosen.max_output_tokens);
    const descriptor = createDynamicAcpModelDescriptor("devin", uid, {
      ...(readString(chosen.label) ? { displayName: readString(chosen.label)! } : label ? { displayName: label } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
    // The family label and its aliases (`swe`, `opus`, `gpt`, …) resolve to this
    // row so a user can name a family without knowing its variant uid.
    const aliasRefs = [label, ...(Array.isArray(family.aliases) ? family.aliases : [])]
      .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
      .filter((value) => value.length > 0 && value !== uid.toLowerCase());
    if (aliasRefs.length) {
      descriptor.aliases = [...new Set([...(descriptor.aliases ?? []), ...aliasRefs])];
    }
    out.push(descriptor);
  }
  return out;
}

/** Don't re-spawn a failing discovery on every status read. */
const MIN_RETRY_MS = 30_000;

let cache: { at: number; models: ModelDescriptor[] } | null = null;
let inflight: Promise<ModelDescriptor[]> | null = null;
let lastAttemptAt = 0;

/** Last catalog if still fresh, else null — never spawns. */
export function getCachedDevinModels(): ModelDescriptor[] | null {
  return cache && Date.now() - cache.at < CACHE_TTL_MS ? cache.models : null;
}

/** Run `devin models list --format json` and parse it. Throws on spawn failure. */
export async function discoverDevinModels(options?: {
  binaryPath?: string | null;
  timeoutMs?: number;
}): Promise<ModelDescriptor[]> {
  const binary =
    options?.binaryPath?.trim()
    || process.env.DEVIN_EXECUTABLE?.trim()
    || process.env.DEVIN_CLI_EXECUTABLE?.trim()
    || "devin";
  const { stdout } = await execFileAsync(binary, ["models", "list", "--format", "json"], {
    timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  const models = parseDevinModels(stdout);
  cache = { at: Date.now(), models };
  return models;
}

/**
 * Discovery for a status read: returns the cache when warm and otherwise kicks
 * one background refresh (deduped), resolving to [] while it is in flight.
 */
export function warmDevinModels(): Promise<ModelDescriptor[]> {
  const cached = getCachedDevinModels();
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  // A failed attempt (a CLI that errors while authenticated) must not spawn on
  // every status read; back off before trying again.
  if (Date.now() - lastAttemptAt < MIN_RETRY_MS) return Promise.resolve([]);
  lastAttemptAt = Date.now();
  inflight = discoverDevinModels()
    .catch(() => [] as ModelDescriptor[])
    .finally(() => { inflight = null; });
  return inflight;
}
