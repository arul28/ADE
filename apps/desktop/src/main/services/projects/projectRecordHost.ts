import fs from "node:fs";
import path from "node:path";

import { PROJECT_ICON_MIME_TYPES_BY_EXTENSION } from "../../../shared/projectIcons";
import {
  decodeProjectRecordIcon,
  projectRecordIconValue,
  projectRecordPendingScope,
  type ProjectRecordIconValue,
} from "../../../shared/projectRecord";
import type { ProjectIcon } from "../../../shared/types";
import { createFileNewLaneAccountStore, type NewLaneAccountStore } from "../lanes/newLaneSettingsStore";
import { rasterizeProjectIconPngWithSips } from "./projectIconThumbnail";

/**
 * What the desktop main process and the brain share about the project record
 * (`shared/projectRecord.ts`): how a host reads it when it has no account
 * store, what a reader shows for each state, and how an icon is shrunk to fit.
 */

/** The slice of the account settings store the record needs. */
export type ProjectRecordStore = NewLaneAccountStore;

const STAND_IN_CACHE_MAX = 256;
const standInCache = new Map<string, { mtimeMs: number; size: number; rows: Record<string, unknown> | null }>();

/**
 * The record on a host with no account store (a `--no-sync` brain, a desktop
 * whose brain is not answering): the same rows in `.ade/project-record.json`,
 * on this computer only. Reads are kept in memory while the file's time and
 * size hold, so a project list costs a stat, not a read.
 */
export function createProjectRecordStandInStore(projectRoot: string): ProjectRecordStore {
  const filePath = path.join(projectRoot, ".ade", "project-record.json");
  const fileStore = createFileNewLaneAccountStore(filePath);
  return {
    get(scope, key) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return undefined;
      }
      let entry = standInCache.get(filePath);
      if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
        let rows: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
          rows = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        } catch {
          rows = null;
        }
        entry = { mtimeMs: stat.mtimeMs, size: stat.size, rows };
        if (standInCache.size >= STAND_IN_CACHE_MAX) standInCache.clear();
        standInCache.set(filePath, entry);
      }
      return entry.rows?.[`${scope}|${key}`];
    },
    set: (scope, key, value) => {
      // Two writes in the same millisecond can leave the time and size as they were.
      standInCache.delete(filePath);
      return fileStore.set(scope, key, value);
    },
  };
}

/**
 * This machine's record write that the account store has not taken yet, kept
 * in the stand-in file. Undefined when there is none, or when the file cannot
 * be read (then nothing is sent from it).
 */
export function readProjectRecordPending(projectRoot: string, scope: string, key: string): unknown {
  return createProjectRecordStandInStore(projectRoot).get(projectRecordPendingScope(scope), key);
}

/**
 * Saves (a value) or clears (undefined) the pending write for one key. The
 * write goes through a temp file and a rename, and throws instead of
 * replacing a damaged file.
 */
export function writeProjectRecordPending(projectRoot: string, scope: string, key: string, value: unknown): void {
  createProjectRecordStandInStore(projectRoot).set(projectRecordPendingScope(scope), key, value);
}

/**
 * What a reader shows for a project:
 * - `record`: the record's custom icon, already a small data URL (no file read).
 * - `detected`: the record says the custom icon was removed; detect from the
 *   project files and ignore this machine's own override.
 * - `local`: as before the record (own override, then detected). `migrate`
 *   says this machine should upload its own custom override once, because
 *   the repository's record has no icon yet.
 */
export type ProjectRecordIconDecision =
  | { use: "record"; icon: ProjectIcon }
  | { use: "detected" }
  | { use: "local"; migrate: boolean };

export function decideProjectRecordIcon(scope: string | null, raw: unknown): ProjectRecordIconDecision {
  if (!scope) return { use: "local", migrate: false };
  const icon = decodeProjectRecordIcon(raw);
  switch (icon.state) {
    case "custom":
      return { use: "record", icon: { dataUrl: icon.dataUrl, sourcePath: null, mimeType: icon.mimeType } };
    case "none":
      return { use: "detected" };
    case "absent":
      return { use: "local", migrate: true };
    default:
      // A value this version cannot read is never replaced from a read.
      return { use: "local", migrate: false };
  }
}

type NativeImageLike = {
  createFromPath(filePath: string): {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    resize(options: { width: number; height: number; quality: "best" }): {
      toPNG(): Buffer;
      toJPEG(quality: number): Buffer;
    };
  };
};

export type ProjectRecordIconEncoder = {
  /** Electron's image module, in the desktop main process. */
  nativeImage?: NativeImageLike;
};

const RASTER_EDGES = [64, 48, 32] as const;
const JPEG_STEPS = [[64, 75], [48, 60], [32, 50]] as const;
/** Raw files above this cannot fit once base64 adds a third. */
const RAW_MAX_BYTES = 8_800;

function rawFileValue(sourcePath: string): ProjectRecordIconValue | null {
  const mimeType = PROJECT_ICON_MIME_TYPES_BY_EXTENSION[path.extname(sourcePath).toLowerCase()]?.[0];
  if (!mimeType) return null;
  try {
    if (fs.statSync(sourcePath).size > RAW_MAX_BYTES) return null;
    return projectRecordIconValue(`data:${mimeType};base64,${fs.readFileSync(sourcePath).toString("base64")}`);
  } catch {
    return null;
  }
}

function nativeImageValue(sourcePath: string, nativeImage: NativeImageLike): ProjectRecordIconValue | null {
  try {
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (!(width > 0 && height > 0)) return null;
    const sized = (edge: number) => {
      const limit = Math.min(edge, Math.max(width, height));
      const scale = limit / Math.max(width, height);
      return image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: "best",
      });
    };
    for (const edge of RASTER_EDGES) {
      const value = projectRecordIconValue(`data:image/png;base64,${sized(edge).toPNG().toString("base64")}`);
      if (value) return value;
    }
    // A busy image can still be too large as a PNG; a JPEG loses transparency
    // but keeps the icon shared.
    for (const [edge, quality] of JPEG_STEPS) {
      const value = projectRecordIconValue(`data:image/jpeg;base64,${sized(edge).toJPEG(quality).toString("base64")}`);
      if (value) return value;
    }
  } catch {
    // Fall through to the other encoders.
  }
  return null;
}

function sipsValue(sourcePath: string): ProjectRecordIconValue | null {
  for (const edge of RASTER_EDGES) {
    const dataUrl = rasterizeProjectIconPngWithSips(sourcePath, edge);
    if (!dataUrl) return null;
    const value = projectRecordIconValue(dataUrl);
    if (value) return value;
  }
  return null;
}

/**
 * The record value for an icon file: a copy at most 64 px on its long side
 * whose stored JSON stays under the record's limit, stepping down in size and
 * then to JPEG until it fits. An SVG small enough is kept as it is (it stays
 * sharp at any size). Null when nothing fits or the file cannot be read; the
 * caller keeps the local icon and logs it.
 */
export function encodeProjectRecordIcon(sourcePath: string, encoder: ProjectRecordIconEncoder = {}): ProjectRecordIconValue | null {
  const isSvg = path.extname(sourcePath).toLowerCase() === ".svg";
  if (isSvg) {
    const raw = rawFileValue(sourcePath);
    if (raw) return raw;
  }
  return (encoder.nativeImage ? nativeImageValue(sourcePath, encoder.nativeImage) : null)
    ?? sipsValue(sourcePath)
    ?? (isSvg ? null : rawFileValue(sourcePath));
}

const ENCODED_CACHE_MAX = 64;
const MIGRATION_RETRY_MS = 10 * 60_000;
const encodedCache = new Map<string, { value: ProjectRecordIconValue | null; attemptedAt: number }>();

/**
 * The record value for this machine's own override, for the one-time upload
 * of a project from before the record. Null while an attempt for the same
 * repository and the same file is under ten minutes old (a signed-out
 * machine, an icon that does not fit), so a read path never shrinks the same
 * image again or keeps rewriting the store.
 */
export function claimProjectRecordMigration(
  scope: string,
  sourcePath: string,
  encode: (sourcePath: string) => ProjectRecordIconValue | null,
  now = Date.now(),
): ProjectRecordIconValue | null {
  let signature = "-";
  try {
    const stat = fs.statSync(sourcePath);
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const key = `${scope}\u0000${sourcePath}\u0000${signature}`;
  const previous = encodedCache.get(key);
  if (previous && now - previous.attemptedAt < MIGRATION_RETRY_MS) return null;
  const value = previous ? previous.value : encode(sourcePath);
  if (encodedCache.size >= ENCODED_CACHE_MAX) encodedCache.clear();
  encodedCache.set(key, { value, attemptedAt: now });
  return value;
}
