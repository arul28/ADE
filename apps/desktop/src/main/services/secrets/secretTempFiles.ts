import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateDirectory, securePrivatePath } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { Logger } from "../logging/logger";

/**
 * Temporary private files for secrets a person handed one chat's agent.
 *
 * The secret card can keep a value out of the project's secrets: ADE writes it
 * to a file only this OS user can read and gives the agent the path, so a CLI
 * token (`wrangler`, `expo`) can be fed to a command as `"$(cat <file>)"`.
 * The value never reaches the transcript, an event, a log line or a tool
 * result; the agent's own commands can read the file, and the card says so.
 *
 * Layout: `<ADE home>/secrets/temp-files/<id>` holds the value, and
 * `<id>.json` beside it holds who it is for and when it expires (never the
 * value). One sidecar per file instead of a shared index, so several runtimes
 * on one machine never race on a manifest.
 *
 * A file goes away when its chat is archived or deleted, when its time runs
 * out (24 hours by default), and on the next runtime start if it outlived
 * either while ADE was not running.
 */

export const SECRET_TEMP_FILE_DEFAULT_TTL_MS = 24 * 60 * 60_000;
export const SECRET_TEMP_FILE_MIN_TTL_MS = 60_000;
export const SECRET_TEMP_FILE_MAX_TTL_MS = 24 * 60 * 60_000;
/** A value file with no sidecar this old is a write that never finished. */
const ORPHAN_GRACE_MS = 60_000;
/** How soon a removal that failed is tried again. */
const REMOVE_RETRY_MS = 60_000;
const FILE_ID_PATTERN = /^[a-f0-9]{32}$/;

export type SecretTempFileRecord = {
  id: string;
  /** Absolute path of the value file. */
  path: string;
  /** The secret's name as the agent asked for it. */
  name: string;
  chatSessionId: string;
  /** The agent's retry key, when it gave one. */
  requestId: string | null;
  createdAt: string;
  expiresAt: string;
};

export type SecretTempFileStore = ReturnType<typeof createSecretTempFileStore>;

function readSidecar(filePath: string): SecretTempFileRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SecretTempFileRecord>;
    if (
      typeof parsed.id !== "string"
      || !FILE_ID_PATTERN.test(parsed.id)
      || typeof parsed.chatSessionId !== "string"
      || typeof parsed.name !== "string"
      || typeof parsed.expiresAt !== "string"
      || typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      path: path.join(path.dirname(filePath), parsed.id),
      name: parsed.name,
      chatSessionId: parsed.chatSessionId,
      requestId: typeof parsed.requestId === "string" && parsed.requestId ? parsed.requestId : null,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function createSecretTempFileStore(options: {
  dir?: string;
  now?: () => number;
  logger?: Pick<Logger, "info" | "warn"> | null;
  platform?: NodeJS.Platform;
} = {}) {
  const dir = options.dir ?? path.join(resolveMachineAdeLayout().secretsDir, "temp-files");
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const sidecarPath = (id: string) => path.join(dir, `${id}.json`);

  /**
   * Files whose removal failed (Windows: a scanner or a command holding the
   * file open). The next sweep, armed within `REMOVE_RETRY_MS`, tries them
   * again even when they have not expired, since their chat already ended.
   */
  const pendingRemoval = new Set<string>();
  let retrySoon = false;

  /**
   * Remove one value and its sidecar. Never throws: on Windows `rmSync` still
   * fails with EBUSY/EPERM while another process has the file open, and one
   * stuck file must not stop the rest or take the runtime down.
   */
  const removeRecordFiles = (id: string): boolean => {
    try {
      // Value first: a crash in between leaves a sidecar the next sweep drops,
      // never a value with no record of when it expires.
      fs.rmSync(path.join(dir, id), { force: true });
      fs.rmSync(sidecarPath(id), { force: true });
      pendingRemoval.delete(id);
      return true;
    } catch (error) {
      pendingRemoval.add(id);
      options.logger?.warn("project_secret.temp_file_remove_failed", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const list = (): SecretTempFileRecord[] => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const records: SecretTempFileRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = readSidecar(path.join(dir, name));
      if (record) records.push(record);
    }
    return records;
  };

  const armExpiry = (): void => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    const next = list().reduce<number | null>((soonest, record) => {
      const at = Date.parse(record.expiresAt);
      return Number.isFinite(at) && (soonest == null || at < soonest) ? at : soonest;
    }, null);
    if (next == null) return;
    // One timer for the soonest expiry, only while a file exists: nothing runs when there are none.
    const soonest = pendingRemoval.size > 0 || retrySoon ? Math.min(next, now() + REMOVE_RETRY_MS) : next;
    const delay = Math.min(Math.max(soonest - now(), 1_000), 2 ** 31 - 1);
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      try {
        sweep();
      } catch (error) {
        options.logger?.warn("project_secret.temp_files_sweep_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        armExpiry();
      }
    }, delay);
    expiryTimer.unref?.();
  };

  /** Drops expired files, sidecars with no value, and values no sidecar describes. */
  const sweep = (): number => {
    let removed = 0;
    retrySoon = false;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    const present = new Set(names);
    for (const name of names) {
      const full = path.join(dir, name);
      if (name.endsWith(".json")) {
        const record = readSidecar(full);
        if (!record) {
          try {
            fs.rmSync(full, { force: true });
          } catch {
            retrySoon = true;
          }
          continue;
        }
        const expired = !(Date.parse(record.expiresAt) > now());
        if ((expired || !present.has(record.id) || pendingRemoval.has(record.id)) && removeRecordFiles(record.id)) removed += 1;
        continue;
      }
      if (!FILE_ID_PATTERN.test(name) || present.has(`${name}.json`)) continue;
      // A value with no sidecar: a write in progress (another runtime) or one that crashed.
      try {
        if (now() - fs.statSync(full).mtimeMs > ORPHAN_GRACE_MS) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        // Gone already, or held open: the next sweep tries again.
      }
    }
    if (removed > 0) options.logger?.info("project_secret.temp_files_swept", { removed });
    armExpiry();
    return removed;
  };

  return {
    dir,

    /**
     * Write one value to a new owner-only file. Created exclusively under a
     * random name, locked down while still empty, then filled; a file that
     * could not be secured or filled is removed, never left behind.
     */
    write(input: {
      chatSessionId: string;
      requestId?: string | null;
      name: string;
      value: string;
      ttlMs?: number | null;
    }): SecretTempFileRecord {
      ensurePrivateDirectory(dir, { platform });
      const ttl = Math.min(
        Math.max(Math.floor(input.ttlMs ?? SECRET_TEMP_FILE_DEFAULT_TTL_MS), SECRET_TEMP_FILE_MIN_TTL_MS),
        SECRET_TEMP_FILE_MAX_TTL_MS,
      );
      const id = crypto.randomBytes(16).toString("hex");
      const valuePath = path.join(dir, id);
      const createdAtMs = now();
      const record: SecretTempFileRecord = {
        id,
        path: valuePath,
        name: input.name,
        chatSessionId: input.chatSessionId,
        requestId: input.requestId?.trim() || null,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + ttl).toISOString(),
      };
      const fd = fs.openSync(valuePath, "wx", 0o600);
      try {
        try {
          // Windows ignores the mode: the owner-only ACL goes on before the value does.
          securePrivatePath(valuePath, { platform });
          fs.writeSync(fd, input.value);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        const sidecarFd = fs.openSync(sidecarPath(id), "wx", 0o600);
        try {
          fs.writeSync(sidecarFd, JSON.stringify({ ...record, path: undefined }));
        } finally {
          fs.closeSync(sidecarFd);
        }
      } catch (error) {
        removeRecordFiles(id);
        throw error;
      }
      options.logger?.info("project_secret.temp_file_written", {
        chatSessionId: record.chatSessionId,
        name: record.name,
        expiresAt: record.expiresAt,
      });
      armExpiry();
      return record;
    },

    /** The live file an earlier call with this retry key wrote, if it still exists. */
    find(input: { chatSessionId: string; requestId: string }): SecretTempFileRecord | null {
      const requestId = input.requestId.trim();
      if (!requestId) return null;
      const match = list().find((record) =>
        record.chatSessionId === input.chatSessionId
        && record.requestId === requestId
        && Date.parse(record.expiresAt) > now());
      if (!match) return null;
      return fs.existsSync(match.path) ? match : null;
    },

    /** The chat was archived or deleted: its files go with it. */
    removeForChat(chatSessionId: string): number {
      const id = chatSessionId.trim();
      if (!id) return 0;
      let removed = 0;
      let failed = false;
      for (const record of list()) {
        if (record.chatSessionId !== id) continue;
        if (removeRecordFiles(record.id)) removed += 1;
        else failed = true;
      }
      if (removed > 0) options.logger?.info("project_secret.temp_files_removed_for_chat", { chatSessionId: id, removed });
      // A file that could not go yet is past its chat: the retry timer takes it.
      if (removed > 0 || failed) armExpiry();
      return removed;
    },

    sweep,

    dispose(): void {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
    },
  };
}

let machineStore: SecretTempFileStore | null = null;

/**
 * The machine's store, shared by every project a runtime hosts. The first use
 * sweeps what an earlier run left behind.
 */
export function machineSecretTempFiles(logger?: Pick<Logger, "info" | "warn"> | null): SecretTempFileStore {
  if (!machineStore) {
    machineStore = createSecretTempFileStore({ logger: logger ?? null });
    try {
      machineStore.sweep();
    } catch (error) {
      logger?.warn("project_secret.temp_files_sweep_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return machineStore;
}
