import path from "node:path";
import { hashFile } from "../../../../desktop/src/main/services/computerUse/proofFingerprint";
import { pathKey } from "../../../../desktop/src/main/services/shared/pathCompare";

/** Where ADE-made bytes came from, as the proof drawer labels them. */
export type AdeCaptureSource = "ade-capture" | "ade-recorder";

/**
 * A remembered capture: who made it, and the hash its bytes had then.
 * `release` puts the claimed entry back, for a filing that failed or was filed
 * as an attach. It does nothing after the first call, once the entry expired,
 * or once the path was re-captured.
 */
export type AdeCaptureMatch = { source: AdeCaptureSource; sha256: string; release(): void };

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;

type Entry = { sha256: string; bytes: number; source: AdeCaptureSource; expiresAt: number };

/**
 * Files that ADE's own capture actions wrote, by path and content hash.
 *
 * An ingest may call its bytes "Captured by ADE" or "Recorded by ADE" only
 * when the file still hashes to what a capture action produced. Labels in the
 * ingest arguments are typed by the caller and prove nothing.
 */
export type AdeCaptureRegistry = {
  remember(filePath: string, source: AdeCaptureSource): Promise<void>;
  /**
   * The capture behind a remembered file whose bytes are unchanged, else null.
   * Claims the entry: a second filing of the same capture, even a concurrent
   * one, is an attach. The match's `release` hands it back when the filing did
   * not keep it.
   */
  match(filePath: string): Promise<AdeCaptureMatch | null>;
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
      const key = pathKey(filePath);
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      const fingerprint = await hashFile(filePath);
      if (!fingerprint || fingerprint.sha256 !== entry.sha256 || fingerprint.bytes !== entry.bytes) {
        return null;
      }
      let released = false;
      return {
        source: entry.source,
        sha256: entry.sha256,
        release() {
          if (released) return;
          released = true;
          if (entry.expiresAt <= now() || entries.has(key)) return;
          entries.set(key, entry);
          prune();
        },
      };
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
