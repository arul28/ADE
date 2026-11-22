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

/** An action's capture output: who made it, and the result values that name its files. */
export type AdeCaptureAction = {
  source: AdeCaptureSource;
  /** The values in the action's result that name a file it wrote; non-strings are skipped. */
  paths(result: Record<string, unknown>): unknown[];
};

const resultField = (field: string, source: AdeCaptureSource): AdeCaptureAction => ({
  source,
  paths: (result) => [result[field]],
});

/**
 * ADE actions that write a capture file, with the result fields that name it.
 * Keyed `domain.action`, as `run_ade_action` dispatches them.
 *
 * Also the list of what a caller on another machine may read back
 * (`read_remote_caller_capture`): an Apple proof verb run there with
 * `proof: false` files nothing where it ran, and its caller files these files
 * in its own drawer. A proof verb missing here leaves that caller with nothing.
 */
export const ADE_CAPTURE_ACTIONS: ReadonlyMap<string, AdeCaptureAction> =
  new Map([
    ["ios_simulator.screenshot", resultField("filePath", "ade-capture")],
    // `ade apple proof-bundle`: the bundle's still is what gets filed.
    ["ios_simulator.captureProofBundle", resultField("screenshotPath", "ade-capture")],
    // One still per iPhone Duo panel.
    ["ios_simulator.duoAppStoreScreenshots", {
      source: "ade-capture",
      paths: (result) => (Array.isArray(result.shots) ? result.shots : [])
        .map((shot) => (shot && typeof shot === "object" ? (shot as Record<string, unknown>).filePath : null)),
    }],
    // `SimRecording.path`; a discarded recording's file is gone and hashes to nothing.
    ["ios_simulator.recordStop", resultField("path", "ade-recorder")],
    ["app_control.observe", resultField("filePath", "ade-capture")],
    ["built_in_browser.observe", resultField("filePath", "ade-capture")],
    ["built_in_browser.exportHar", resultField("filePath", "ade-capture")],
    ["built_in_browser.stopRecording", resultField("path", "ade-recorder")],
    // `ade mac-desktop proof` files the frame its own `screenshot` step wrote.
    ["mac_desktop.screenshot", resultField("filePath", "ade-capture")],
    // `ade screen record stop --machine` / `ade app-control record stop
    // --machine`: run there with `proof: false`, filed in the caller's drawer.
    ["mac_desktop.stopRecording", resultField("filePath", "ade-recorder")],
    ["app_control.stopRecording", resultField("filePath", "ade-recorder")],
    ["android_emulator.screenshot", resultField("path", "ade-capture")],
    // P1 agent suite: every MP4 part of a recording (a rotation starts a new one).
    ["android_emulator.recordStop", {
      source: "ade-recorder",
      paths: (result) => (Array.isArray(result.segments) ? result.segments : [])
        .map((segment) => (segment && typeof segment === "object" ? (segment as Record<string, unknown>).path : null)),
    }],
    ["android_emulator.captureProofBundle", resultField("screenshotPath", "ade-capture")],
    // Parity: `ade android play-store-shots`, one PNG per screen (a foldable's cover and inner).
    ["android_emulator.storeScreenshots", {
      source: "ade-capture",
      paths: (result) => (Array.isArray(result.shots) ? result.shots : [])
        .map((shot) => (shot && typeof shot === "object" ? (shot as Record<string, unknown>).filePath : null)),
    }],
    // P1 look: `ade android render` (a desktop window draws it).
    ["android_emulator.requestRender", {
      source: "ade-capture",
      paths: (result) => (Array.isArray(result.paths) ? result.paths : []),
    }],
  ]);
