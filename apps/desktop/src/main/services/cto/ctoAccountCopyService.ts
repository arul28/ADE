/**
 * The CTO's account copy (`shared/ctoAccountCopy.ts`): written by its home
 * machine after each turn, restored by a new home when the CTO moves there.
 *
 * Who is the CTO: the account's home record (`cto.homeMachine`) names one
 * machine. That machine writes the copy and runs CTO turns; any other machine
 * that still holds a CTO thread for the repository does neither (`homeGate`).
 * So an old home that wakes after a move stays quiet instead of running a
 * second CTO next to the new one.
 *
 * The copy holds what a fresh provider thread is rebuilt from anyway: the
 * identity, the two notes files, the open-work list, the routines and the
 * last turns. A new home restores those and starts its own thread, which
 * reads the carried turns once (`carriedTail`), the same way a model switch
 * rebuilds the thread on one machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  CTO_ACCOUNT_COPY_MAX_CHARS,
  CTO_ACCOUNT_COPY_TAIL_MAX_CHARS,
  CTO_ACCOUNT_COPY_VAULT_KEY,
  CTO_ACCOUNT_COPY_VAULT_KIND,
  type CtoAccountCopy,
  type CtoAccountCopyRoutine,
  type CtoAccountCopyStatus,
  type CtoAdoptAccountCopyResult,
} from "../../../shared/ctoAccountCopy";
import { CTO_HOME_SETTING_KEY, isCtoHomeMachineRecord, type CtoHomeMachineRecord } from "../../../shared/ctoHomeMachine";
import { CTO_USER_NOTES_MAX_BYTES, type CtoIdentity } from "../../../shared/types/cto";
import { ACCOUNT_VAULT_NO_REVISION } from "../../../shared/types/accountVault";
import { writeTextAtomic } from "../shared/utils";
import { isAdeCloudComputer } from "../adeCloud/cloudComputerRules";
import type { CtoMemoryService } from "./ctoMemoryService";

const ENCODED_PREFIX = "gz1:";
const SAVE_DEBOUNCE_MS = 3_000;
const SYNC_TIMEOUT_MS = 10_000;
/** After a move that couldn't read the account: how often, and how many times, to ask again. */
const ADOPT_RETRY_MS = 30_000;
const ADOPT_RETRY_ATTEMPTS = 20;
/** How fresh this machine's copy of the home record must be before it refuses a CTO turn. */
const HOME_RECHECK_MAX_AGE_MS = 15_000;

type Logger = {
  info?: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

/** The brain's account vault, narrowed to what the copy needs. */
export type CtoAccountCopyVault = {
  get(scope: string, kind: typeof CTO_ACCOUNT_COPY_VAULT_KIND, key: string): string | null;
  list(scope?: string): Array<{ kind: string; key: string; revision: string; deleted?: boolean }>;
  trySet(
    scope: string,
    kind: typeof CTO_ACCOUNT_COPY_VAULT_KIND,
    key: string,
    value: string,
    options?: { expectedRevision?: string },
  ): "queued" | "stale" | "refused";
  sync(options?: { maxAgeMs?: number } | null): Promise<unknown>;
};

/** The brain's account settings store, narrowed. */
export type CtoAccountCopySettings = {
  get(scope: string, key: string): unknown;
  set(scope: string, key: string, value: unknown): unknown;
  sync?(options?: { maxAgeMs?: number } | null): Promise<unknown>;
};

/** What the chat service hands the copy: the CTO thread's tail and routines. */
export type CtoAccountCopySources = {
  tail: string;
  routines: CtoAccountCopyRoutine[];
};

export type CtoHomeGate =
  | { ok: true }
  | { ok: false; homeName: string; message: string };

export type CtoAccountCopyServiceArgs = {
  adeDir: string;
  /** `repo:<origin>` for this project, or null when it has no origin to share. */
  repoScope: () => string | null;
  vault: CtoAccountCopyVault | null;
  settings: CtoAccountCopySettings | null;
  /** This machine's sync device id; null before it signed in. */
  deviceId: () => string | null;
  deviceName: () => string | null;
  ctoState: {
    getIdentity: () => CtoIdentity;
    updateIdentity: (patch: Partial<Omit<CtoIdentity, "version" | "updatedAt">>) => unknown;
  };
  ctoMemory: Pick<CtoMemoryService, "readNotes" | "writeNotes" | "readOpenWorkText" | "replaceOpenWorkText">;
  /** The CTO thread's tail and routines, read when a copy is written. */
  readSources: () => Promise<CtoAccountCopySources>;
  /** Re-creates routines on this machine's CTO thread, replacing the ones it had. Null: the thread doesn't exist yet. */
  replaceRoutines: (routines: CtoAccountCopyRoutine[]) => Promise<boolean>;
  /** The CTO's thread here, if any, opens a new provider thread on its next turn. */
  startFreshThread?: () => Promise<void>;
  /** Is the CTO's thread running anything? A late restore waits for it to settle. */
  threadIsBusy?: () => Promise<boolean>;
  /** How a move here landed, for product analytics (`ctoHomeProductAnalytics.ts`). */
  onMoveLanded?: (outcome: "completed" | "kept" | "failed") => void;
  logger: Logger;
  now?: () => number;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

const sameDevice = (left: string | null | undefined, right: string | null | undefined): boolean =>
  Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());

/** The identity fields that travel. Account ids are this machine's own, so they stay behind. */
function portableIdentity(identity: CtoIdentity): Record<string, unknown> {
  const withoutAccount = <T extends { instanceId?: string | null } | null | undefined>(prefs: T): T => {
    if (!prefs) return prefs;
    const { instanceId: _instanceId, ...rest } = prefs;
    return rest as T;
  };
  return {
    name: identity.name,
    persona: identity.persona,
    ...(identity.systemPromptExtension !== undefined ? { systemPromptExtension: identity.systemPromptExtension } : {}),
    ...(identity.onboardingState !== undefined ? { onboardingState: identity.onboardingState } : {}),
    modelPreferences: withoutAccount(identity.modelPreferences),
    fallbackModels: (identity.fallbackModels ?? []).map((prefs) => withoutAccount(prefs)),
    avatar: identity.avatar ?? null,
    personality: identity.personality ?? null,
    timeZone: identity.timeZone ?? null,
  };
}

export function encodeCtoAccountCopy(copy: CtoAccountCopy): string | null {
  let candidate = copy;
  // A long tail is what grows past the ceiling: keep its newest half until it fits.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const encoded = `${ENCODED_PREFIX}${gzipSync(Buffer.from(JSON.stringify(candidate), "utf8")).toString("base64")}`;
    if (encoded.length <= CTO_ACCOUNT_COPY_MAX_CHARS) return encoded;
    if (!candidate.tail) return null;
    candidate = { ...candidate, tail: candidate.tail.length < 512 ? "" : candidate.tail.slice(Math.floor(candidate.tail.length / 2)) };
  }
  return null;
}

export function decodeCtoAccountCopy(value: string | null | undefined): CtoAccountCopy | null {
  if (!value || !value.startsWith(ENCODED_PREFIX)) return null;
  try {
    const parsed = JSON.parse(gunzipSync(Buffer.from(value.slice(ENCODED_PREFIX.length), "base64")).toString("utf8")) as Partial<CtoAccountCopy>;
    if (parsed?.v !== 1 || typeof parsed.ownerDeviceId !== "string" || !parsed.ownerDeviceId.trim()) return null;
    return {
      v: 1,
      ownerDeviceId: parsed.ownerDeviceId,
      ownerName: typeof parsed.ownerName === "string" && parsed.ownerName.trim() ? parsed.ownerName : "another computer",
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString(),
      identity: parsed.identity && typeof parsed.identity === "object" ? parsed.identity as Record<string, unknown> : {},
      projectNotes: typeof parsed.projectNotes === "string" ? parsed.projectNotes : "",
      userNotes: typeof parsed.userNotes === "string" ? parsed.userNotes : "",
      openWork: typeof parsed.openWork === "string" ? parsed.openWork : null,
      routines: Array.isArray(parsed.routines)
        ? parsed.routines.filter((routine): routine is CtoAccountCopyRoutine =>
          Boolean(routine) && typeof routine.prompt === "string" && typeof routine.cron === "string" && routine.cron.trim().length > 0)
        : [],
      tail: typeof parsed.tail === "string" ? parsed.tail : "",
    };
  } catch {
    return null;
  }
}

/** Note lines of both files, this machine's first, as many of the copy's as fit. */
function mergeUserNotes(local: string, carried: string): string {
  const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const merged = lines(local);
  const seen = new Set(merged);
  for (const line of lines(carried)) {
    if (seen.has(line)) continue;
    const next = [...merged, line].join("\n");
    if (Buffer.byteLength(`${next}\n`, "utf8") > CTO_USER_NOTES_MAX_BYTES) break;
    merged.push(line);
    seen.add(line);
  }
  return merged.join("\n");
}

export function createCtoAccountCopyService(args: CtoAccountCopyServiceArgs) {
  const { logger } = args;
  const now = () => args.now?.() ?? Date.now();
  const ctoDir = path.join(args.adeDir, "cto");
  const carriedTailPath = path.join(ctoDir, "carried-conversation.json");
  const carriedRoutinesPath = path.join(ctoDir, "carried-routines.json");
  /** The last copy from another machine this one took: its owner and when it was saved. */
  const takenCopyPath = path.join(ctoDir, "account-copy-taken.json");
  let lastWrittenHash: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;
  let saveAgain = false;
  let disposed = false;

  const me = (): string | null => args.deviceId()?.trim() || null;
  const myName = (): string => args.deviceName()?.trim() || os.hostname();

  const readHome = (): CtoHomeMachineRecord | null => {
    const scope = args.repoScope();
    if (!scope || !args.settings) return null;
    try {
      const value = args.settings.get(scope, CTO_HOME_SETTING_KEY);
      return isCtoHomeMachineRecord(value) ? value : null;
    } catch {
      return null;
    }
  };

  /**
   * No home chosen, a home with no account identity (an SSH machine), or this
   * one. A machine that doesn't know its own device id yet can't be the named
   * home: it would save over the home's copy.
   */
  const homeIsHere = (record: CtoHomeMachineRecord | null): boolean => {
    if (!record || !record.deviceId) return true;
    const self = me();
    if (!self) return false;
    return sameDevice(record.deviceId, self);
  };

  const readCopyRow = (): { copy: CtoAccountCopy | null; revision: string | null } => {
    const scope = args.repoScope();
    if (!scope || !args.vault) return { copy: null, revision: null };
    try {
      // A removed copy still has a revision, and a write must name it.
      const row = args.vault.list(scope).find((item) =>
        item.kind === CTO_ACCOUNT_COPY_VAULT_KIND && item.key === CTO_ACCOUNT_COPY_VAULT_KEY);
      const value = row && !row.deleted ? args.vault.get(scope, CTO_ACCOUNT_COPY_VAULT_KIND, CTO_ACCOUNT_COPY_VAULT_KEY) : null;
      return { copy: decodeCtoAccountCopy(value), revision: row?.revision ?? null };
    } catch (error) {
      logger.warn("cto.account_copy_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return { copy: null, revision: null };
    }
  };

  const build = async (): Promise<CtoAccountCopy | null> => {
    const self = me();
    if (!self) return null;
    const sources = await args.readSources();
    const tail = sources.tail.length > CTO_ACCOUNT_COPY_TAIL_MAX_CHARS
      ? sources.tail.slice(sources.tail.length - CTO_ACCOUNT_COPY_TAIL_MAX_CHARS)
      : sources.tail;
    return {
      v: 1,
      ownerDeviceId: self,
      ownerName: myName(),
      savedAt: new Date(now()).toISOString(),
      identity: portableIdentity(args.ctoState.getIdentity()),
      projectNotes: args.ctoMemory.readNotes("project"),
      userNotes: args.ctoMemory.readNotes("user"),
      openWork: args.ctoMemory.readOpenWorkText(),
      // Routines a move brought that have no CTO thread to land on yet.
      routines: readJson<{ routines?: CtoAccountCopyRoutine[] }>(carriedRoutinesPath)?.routines ?? sources.routines,
      tail,
    };
  };

  const saveNow = async (reason: string): Promise<void> => {
    const scope = args.repoScope();
    const self = me();
    if (!scope || !args.vault || !self || disposed) return;
    const home = readHome();
    if (!homeIsHere(home)) return;
    const existing = readCopyRow();
    if (existing.copy && !sameDevice(existing.copy.ownerDeviceId, self)) {
      // With no home chosen yet, two machines could each think they are it:
      // write only over our own copy, never over another machine's.
      if (!home?.deviceId) return;
      // The home writes over another machine's copy only once it has taken a
      // copy since it became the home. Until then the copy is the CTO the old
      // home handed over (or kept saving before it heard of the move), and
      // this machine missed it when it moved in because its account couldn't
      // be reached: take it now, once the CTO isn't in the middle of a turn.
      if (!takenForMove(home)) {
        if (await args.threadIsBusy?.().catch(() => false)) {
          logger.info?.("cto.account_copy_late_restore_waits", { reason });
          return;
        }
        logger.info?.("cto.account_copy_late_restore", { reason, savedAt: existing.copy.savedAt });
        await restore(existing.copy, home);
        lastWrittenHash = null;
      }
    }
    const copy = await build();
    if (!copy) return;
    const { savedAt: _savedAt, ...stable } = copy;
    const hash = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    if (hash === lastWrittenHash && existing.copy && sameDevice(existing.copy.ownerDeviceId, self)) return;
    const encoded = encodeCtoAccountCopy(copy);
    if (!encoded) {
      logger.warn("cto.account_copy_too_large", { reason });
      return;
    }
    const answer = args.vault.trySet(
      scope,
      CTO_ACCOUNT_COPY_VAULT_KIND,
      CTO_ACCOUNT_COPY_VAULT_KEY,
      encoded,
      // No row here is a claim too: the account may have one this machine has
      // not pulled yet, and a blind write would replace it.
      { expectedRevision: existing.revision ?? ACCOUNT_VAULT_NO_REVISION },
    );
    if (answer === "queued") {
      lastWrittenHash = hash;
      logger.info?.("cto.account_copy_saved", { reason, chars: encoded.length });
    } else {
      logger.warn("cto.account_copy_not_saved", { reason, answer });
    }
  };

  /** One save at a time; a request during one runs once more after it. */
  const save = (reason: string): Promise<void> => {
    if (saving) {
      saveAgain = true;
      return saving;
    }
    saving = (async () => {
      try {
        await saveNow(reason);
        while (saveAgain && !disposed) {
          saveAgain = false;
          await saveNow(reason);
        }
      } catch (error) {
        logger.warn("cto.account_copy_save_failed", { reason, error: error instanceof Error ? error.message : String(error) });
      } finally {
        saving = null;
      }
    })();
    return saving;
  };

  const noteTurnEnded = (): void => {
    if (disposed) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void save("turn_ended");
    }, SAVE_DEBOUNCE_MS);
    saveTimer.unref?.();
  };

  const homeName = (record: CtoHomeMachineRecord | null): string => record?.name?.trim() || "another computer";

  /**
   * May a CTO turn run here? Refused only when the account names another
   * machine as home, after reading the account once more: a machine just
   * chosen may still hold the old record.
   */
  const homeGate = async (ctoName: string): Promise<CtoHomeGate> => {
    let record = readHome();
    if (homeIsHere(record)) return { ok: true };
    if (args.settings?.sync) {
      await withTimeout(args.settings.sync({ maxAgeMs: HOME_RECHECK_MAX_AGE_MS }), SYNC_TIMEOUT_MS);
      record = readHome();
      if (homeIsHere(record)) return { ok: true };
    }
    const name = homeName(record);
    return { ok: false, homeName: name, message: `${ctoName} lives on ${name} now. Open the CTO there, or move it back here.` };
  };

  /**
   * A home record naming this machine, marked as the ADE Cloud computer it is
   * when the client that chose it (a phone, a list pick) could not tell, so
   * every surface can wake it later or make a new one.
   */
  const withOwnCloudId = (record: CtoHomeMachineRecord): CtoHomeMachineRecord => {
    if (record.cloudInstanceId || !record.deviceId || !homeIsHere(record) || !isAdeCloudComputer()) return record;
    return { ...record, cloudInstanceId: process.env.ADE_CLOUD_INSTANCE_ID!.trim() };
  };

  /** The same answer from this machine's copy of the account, without asking it again. */
  const homeIsHereNow = (): boolean => homeIsHere(readHome());

  const writeJson = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  };

  const readJson = <T>(file: string): T | null => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  };

  /** Puts routines from a copy on this machine's CTO thread, now or once it exists. */
  const applyCarriedRoutines = async (): Promise<void> => {
    const pending = readJson<{ routines?: CtoAccountCopyRoutine[] }>(carriedRoutinesPath);
    if (!pending || !Array.isArray(pending.routines)) return;
    const applied = await args.replaceRoutines(pending.routines).catch((error: unknown) => {
      logger.warn("cto.account_copy_routines_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    });
    if (applied) fs.rmSync(carriedRoutinesPath, { force: true });
  };

  /** Has this machine taken a copy since it became the home in `home`? */
  const takenForMove = (home: CtoHomeMachineRecord): boolean => {
    const taken = readJson<{ forChosenAt?: string }>(takenCopyPath);
    return Boolean(taken && taken.forChosenAt === home.chosenAt);
  };

  const restore = async (copy: CtoAccountCopy, home: CtoHomeMachineRecord | null): Promise<void> => {
    // Written first, so a restore that fails part-way is never run twice.
    writeJson(takenCopyPath, {
      ownerDeviceId: copy.ownerDeviceId,
      savedAt: copy.savedAt,
      forChosenAt: home?.chosenAt ?? null,
      takenAt: new Date(now()).toISOString(),
    });
    const identity = { ...copy.identity } as Partial<Omit<CtoIdentity, "version" | "updatedAt">>;
    // Account ids are this machine's own: keep the account it already picked
    // for the same provider, instead of falling back to the default one.
    const localPrefs = args.ctoState.getIdentity().modelPreferences;
    if (identity.modelPreferences && localPrefs?.instanceId && localPrefs.provider === identity.modelPreferences.provider) {
      identity.modelPreferences = { ...identity.modelPreferences, instanceId: localPrefs.instanceId };
    }
    if (Object.keys(identity).length) {
      try {
        args.ctoState.updateIdentity(identity);
      } catch (error) {
        logger.warn("cto.account_copy_identity_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      args.ctoMemory.writeNotes("project", copy.projectNotes);
    } catch (error) {
      logger.warn("cto.account_copy_notes_failed", { scope: "project", error: error instanceof Error ? error.message : String(error) });
    }
    try {
      // About the person, for every project on this machine: kept, and joined.
      args.ctoMemory.writeNotes("user", mergeUserNotes(args.ctoMemory.readNotes("user"), copy.userNotes));
    } catch (error) {
      logger.warn("cto.account_copy_notes_failed", { scope: "user", error: error instanceof Error ? error.message : String(error) });
    }
    try {
      // No open work in the copy: this machine's list is from an earlier stay, and goes.
      args.ctoMemory.replaceOpenWorkText(copy.openWork);
    } catch (error) {
      logger.warn("cto.account_copy_open_work_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    writeJson(carriedTailPath, {
      fromName: copy.ownerName,
      savedAt: copy.savedAt,
      restoredAt: new Date(now()).toISOString(),
      tail: copy.tail,
    });
    writeJson(carriedRoutinesPath, { routines: copy.routines });
    await applyCarriedRoutines();
    await args.startFreshThread?.().catch((error: unknown) => {
      logger.warn("cto.account_copy_fresh_thread_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  };

  /**
   * After a move whose account read failed: ask the account again now and
   * then, and save (which takes the old home's copy) once it answers, rather
   * than waiting for the first turn to end here.
   */
  let adoptRetry: ReturnType<typeof setTimeout> | null = null;
  const retryAdoptLater = (attempt = 1): void => {
    if (disposed || adoptRetry || attempt > ADOPT_RETRY_ATTEMPTS || !args.vault) return;
    const vault = args.vault;
    adoptRetry = setTimeout(() => {
      adoptRetry = null;
      void withTimeout(vault.sync(), SYNC_TIMEOUT_MS).then((synced) => {
        if (disposed) return;
        if (synced === "ready") void save("adopt_retry");
        else retryAdoptLater(attempt + 1);
      });
    }, ADOPT_RETRY_MS);
    adoptRetry.unref?.();
  };

  /**
   * This machine is the CTO's home now. Agree with the account's home record,
   * take the CTO from the copy when another machine wrote it last, then write
   * the copy as the home.
   */
  const adopt = async (input: { home?: unknown }): Promise<CtoAdoptAccountCopyResult> => {
    const scope = args.repoScope();
    if (scope && args.settings && isCtoHomeMachineRecord(input.home)) {
      try {
        args.settings.set(scope, CTO_HOME_SETTING_KEY, withOwnCloudId(input.home));
      } catch (error) {
        logger.warn("cto.account_copy_home_write_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const self = me();
    if (!scope || !args.vault || !self) return { restored: false, fromName: null, savedAt: null };
    if (!homeIsHere(readHome())) return { restored: false, fromName: null, savedAt: null };
    // The copy the old home wrote last, not this machine's cached one.
    const synced = await withTimeout(args.vault.sync(), SYNC_TIMEOUT_MS);
    if (synced !== "ready") {
      // Writing now could replace the CTO the old home left in the account
      // with this machine's older one. The first save after the account
      // answers takes that copy instead (`saveNow`).
      logger.warn("cto.account_copy_adopt_unsynced", { status: synced ?? "timeout" });
      retryAdoptLater();
      args.onMoveLanded?.("failed");
      return { restored: false, fromName: null, savedAt: null };
    }
    const { copy } = readCopyRow();
    if (!copy || sameDevice(copy.ownerDeviceId, self)) {
      await save("adopt");
      args.onMoveLanded?.("kept");
      return { restored: false, fromName: null, savedAt: copy?.savedAt ?? null };
    }
    await restore(copy, readHome());
    lastWrittenHash = null;
    logger.info?.("cto.account_copy_restored", { savedAt: copy.savedAt, routines: copy.routines.length, tailChars: copy.tail.length });
    await save("adopt");
    args.onMoveLanded?.("completed");
    return { restored: true, fromName: copy.ownerName, savedAt: copy.savedAt };
  };

  const status = (): CtoAccountCopyStatus => {
    const scope = args.repoScope();
    if (!scope || !args.vault) return { available: false, savedAt: null, ownerName: null, ownerIsThisMachine: false };
    const { copy } = readCopyRow();
    return {
      available: true,
      savedAt: copy?.savedAt ?? null,
      ownerName: copy?.ownerName ?? null,
      ownerIsThisMachine: Boolean(copy && sameDevice(copy.ownerDeviceId, me())),
    };
  };

  /** The turns a copy carried here, until this thread has as many of its own. */
  const carriedTail = (): { fromName: string; tail: string; restoredAt: string | null } | null => {
    const carried = readJson<{ fromName?: string; tail?: string; restoredAt?: string }>(carriedTailPath);
    if (!carried?.tail?.trim()) return null;
    return {
      fromName: carried.fromName?.trim() || "another computer",
      tail: carried.tail,
      restoredAt: typeof carried.restoredAt === "string" ? carried.restoredAt : null,
    };
  };

  const dropCarriedTail = (): void => {
    fs.rmSync(carriedTailPath, { force: true });
  };

  /** Saves a change still waiting on the debounce and waits for a save in flight, then stops. */
  const dispose = async (): Promise<void> => {
    const pending = saveTimer != null;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (adoptRetry) clearTimeout(adoptRetry);
    adoptRetry = null;
    if (pending && !disposed) await save("shutdown");
    else if (saving) await saving;
    disposed = true;
  };

  return {
    noteTurnEnded,
    save,
    adopt,
    status,
    homeGate,
    homeIsHereNow,
    carriedTail,
    dropCarriedTail,
    applyCarriedRoutines,
    dispose,
  };
}

export type CtoAccountCopyService = ReturnType<typeof createCtoAccountCopyService>;
