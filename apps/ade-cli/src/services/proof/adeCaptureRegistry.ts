import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathKey } from "../../../../desktop/src/main/services/shared/pathCompare";

/** Where ADE-made bytes came from, as the proof drawer labels them. */
export type AdeCaptureSource = "ade-capture" | "ade-recorder";

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;

type Entry = { sha256: string; bytes: number; source: AdeCaptureSource; expiresAt: number };

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number } | null> {
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
      hash.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }
    return { sha256: hash.digest("hex"), bytes };
  } catch {
    return null;
  }
}

/**
 * Files that ADE's own capture actions wrote, by path and content hash.
 *
 * An ingest may call its bytes "Captured by ADE" or "Recorded by ADE" only
 * when the file still hashes to what a capture action produced. Labels in the
 * ingest arguments are typed by the caller and prove nothing.
 */
export type AdeCaptureRegistry = {
  remember(filePath: string, source: AdeCaptureSource): Promise<void>;
  /** The source of a remembered file whose bytes are unchanged, else null. */
  match(filePath: string): Promise<AdeCaptureSource | null>;
};

export function createAdeCaptureRegistry(options: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}): AdeCaptureRegistry {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const prune = () => {
    const at = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
    // Oldest first: a Map keeps insertion order.
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    async remember(filePath, source) {
      if (!path.isAbsolute(filePath)) return;
      const fingerprint = await hashFile(filePath);
      if (!fingerprint) return;
      const key = pathKey(filePath);
      entries.delete(key);
      entries.set(key, { ...fingerprint, source, expiresAt: now() + ttlMs });
      prune();
    },
    async match(filePath) {
      prune();
      if (!path.isAbsolute(filePath)) return null;
      const entry = entries.get(pathKey(filePath));
      if (!entry) return null;
      const fingerprint = await hashFile(filePath);
      if (!fingerprint || fingerprint.sha256 !== entry.sha256 || fingerprint.bytes !== entry.bytes) {
        return null;
      }
      return entry.source;
    },
  };
}

/**
 * ADE actions that write a capture file, with the result field that names it.
 * Keyed `domain.action`, as `run_ade_action` dispatches them.
 */
export const ADE_CAPTURE_ACTIONS: ReadonlyMap<string, { field: "filePath" | "path"; source: AdeCaptureSource }> =
  new Map([
    ["ios_simulator.screenshot", { field: "filePath", source: "ade-capture" }],
    ["app_control.observe", { field: "filePath", source: "ade-capture" }],
    ["built_in_browser.observe", { field: "filePath", source: "ade-capture" }],
    ["built_in_browser.exportHar", { field: "filePath", source: "ade-capture" }],
    ["built_in_browser.stopRecording", { field: "path", source: "ade-recorder" }],
  ]);
