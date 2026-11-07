import fs from "node:fs";
import path from "node:path";
import {
  normalizeAndroidMachinePreferences,
  type AndroidMachinePreferences,
} from "../../../shared/types/androidEmulator";
import { writeFileAtomic } from "../state/durableFile";

/*
 * The machine's Android preferences (recording overlays, auto-record, the
 * storage warning, the remote bitrate cap), in the machine's Android
 * settings file (`<ADE home>/android/settings.json`) under `preferences`.
 *
 * The file also holds the SDK folder (`sdkPath`, `androidSdkSetup.ts`). One
 * `AndroidSettingsFile` serves both stores. Every write reads the file first
 * and changes only its own keys, so a preferences write keeps `sdkPath` and
 * an SDK write keeps `preferences`.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** Why a write to the settings file was refused: its JSON does not parse, so a merge would drop its keys. */
export class AndroidSettingsFileBrokenError extends Error {}

/**
 * The machine's Android settings file, read once per change. The cache key is
 * the file's mtime and size, so two writes in the same mtime tick are still
 * told apart.
 */
export type AndroidSettingsFile = {
  /** False when there is no file path (a test host): the keys live in memory only. */
  persistent: boolean;
  /** The file's keys; empty when it is missing or broken (a broken file reads as defaults). */
  read(): Record<string, unknown>;
  /**
   * Sets `keys` and keeps every other key the file holds. Written to a temp
   * file and renamed over the old one. A file that does not parse is kept as
   * it is, and the write throws: merging over `{}` would lose `sdkPath`.
   * `keys` may be built from the body the write itself read, so a merge never
   * works on an older read.
   */
  writeKeys(keys: Record<string, unknown> | ((body: Record<string, unknown>) => Record<string, unknown>)): void;
};

/**
 * `problem`: the file is there but ADE could not read it (`unreadable`) or
 * parse it (`invalid`), so a write must not replace it.
 */
type SettingsRead = { body: Record<string, unknown>; problem: null | "unreadable" | "invalid" };

const SETTINGS_PROBLEM_TEXT: Record<NonNullable<SettingsRead["problem"]>, string> = {
  unreadable: "could not be read",
  invalid: "is not valid JSON",
};

function readSettingsBody(file: string): SettingsRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Missing: there is nothing to keep. Any other read error (a permission
    // error, a lock on Windows) is broken, so a write does not replace the file.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { body: {}, problem: null };
    return { body: {}, problem: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { body: parsed as Record<string, unknown>, problem: null }
      : { body: {}, problem: "invalid" };
  } catch {
    return { body: {}, problem: "invalid" };
  }
}

/** With no file (a test host), the keys live in memory. */
export function createAndroidSettingsFile(file: string | null | undefined): AndroidSettingsFile {
  let memory: Record<string, unknown> = {};
  let cache: { mtimeMs: number; size: number; value: Record<string, unknown> } | null = null;
  return {
    persistent: Boolean(file),
    read() {
      if (!file) return memory;
      try {
        const stat = fs.statSync(file);
        if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.value;
        const current = readSettingsBody(file);
        // A file that could not be read is not cached, so the next read tries again.
        if (current.problem === "unreadable") return current.body;
        cache = { mtimeMs: stat.mtimeMs, size: stat.size, value: current.body };
        return current.body;
      } catch {
        return {};
      }
    },
    writeKeys(keys) {
      if (!file) {
        memory = { ...memory, ...(typeof keys === "function" ? keys(memory) : keys) };
        return;
      }
      const current = readSettingsBody(file);
      if (current.problem) {
        throw new AndroidSettingsFileBrokenError(
          `The Android settings file ${file} ${SETTINGS_PROBLEM_TEXT[current.problem]}, so ADE did not change it. Fix the file or delete it, then try again.`,
        );
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body = { ...current.body, ...(typeof keys === "function" ? keys(current.body) : keys), updatedAt: new Date().toISOString() };
      writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
      cache = null;
    },
  };
}

export type AndroidMachinePreferenceStore = {
  read(): AndroidMachinePreferences;
  /** Merges `patch` over what is stored and answers the result. */
  write(patch: Partial<AndroidMachinePreferences>): AndroidMachinePreferences;
};

/** The preferences in the settings file, under `preferences`; they start at the defaults. */
export function createAndroidMachinePreferenceStore(settings: AndroidSettingsFile): AndroidMachinePreferenceStore {
  let cache: { source: Record<string, unknown>; value: AndroidMachinePreferences } | null = null;
  const read = (): AndroidMachinePreferences => {
    const source = settings.read();
    if (cache && cache.source === source) return cache.value;
    const value = normalizeAndroidMachinePreferences(source.preferences);
    cache = { source, value };
    return value;
  };
  return {
    read,
    write(patch) {
      // Merged over the body the write reads and checks, not an earlier read.
      let next = read();
      settings.writeKeys((body) => {
        next = normalizeAndroidMachinePreferences(patch, normalizeAndroidMachinePreferences(body.preferences));
        return { preferences: next };
      });
      return next;
    },
  };
}
