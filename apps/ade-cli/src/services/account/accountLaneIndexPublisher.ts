/**
 * The account lane index (`PUT /account/lanes`): every brain, on a person's
 * own computer and on an ADE Cloud computer, tells the account which lanes it
 * has (name, branch, PR number, main checkout or not). A client with no
 * computer awake finds a lane that something mentions (a PR, a chat) there.
 *
 * - A project runtime calls `noteAccountLanesChanged` when its lanes or PRs
 *   change, and once when it opens. The publish runs 30 s after the first
 *   such call (one write for a burst of changes), never on a timer.
 * - The whole set of this machine's lanes goes in each write. A project not
 *   open in this run keeps the rows it last sent (`<ADE_HOME>/account-lanes.json`);
 *   a project no longer in the registry drops its rows.
 * - The same set as the last write sends nothing (a hash, here and on the
 *   server).
 * - The primary lane goes with its stored name ("Primary") and
 *   `isPrimary: true`; clients name it "Main checkout".
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AccountLaneIndexEntry, AccountLaneIndexPut, AccountLaneIndexPutResult } from "../../../../account-directory/src/cloud/contract";
import { ACCOUNT_LANE_INDEX_MAX_PER_MACHINE } from "../../../../account-directory/src/cloud/contract";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

export const ACCOUNT_LANES_DEBOUNCE_MS = 30_000;

/** One project's lanes as its runtime reads them; `projectId` is filled in here from the registry. */
export type AccountLaneReader = () => Promise<Array<Omit<AccountLaneIndexEntry, "projectId">>>;

export type AccountLaneIndexPublisherDeps = {
  adeHome: string;
  machineKey: () => string | null;
  /** The account server's lane index route; null when not signed in. Answers null from an older server. */
  putLanes: () => Promise<((index: AccountLaneIndexPut) => Promise<AccountLaneIndexPutResult | null>) | null>;
  /** The projects in this brain's registry: the brain's id, and the account project id when it is known. */
  listProjects: () => Array<{ projectId: string; accountProjectId?: string | null }>;
  logger: Logger;
  debounceMs?: number;
};

export type AccountLaneIndexPublisher = {
  /** A project's lanes or PRs changed (or it opened): publish 30 s from now. */
  note: (projectId: string, read: AccountLaneReader) => void;
  /** Publishes now (tests, and a brain that stops). */
  flush: () => Promise<void>;
  dispose: () => void;
};

type CacheFile = { v: 1; machineKey: string | null; hash: string | null; projects: Record<string, Array<Omit<AccountLaneIndexEntry, "projectId">>> };

let installed: AccountLaneIndexPublisher | null = null;

/** The brain's one publisher; a runtime's notes go nowhere until it is installed. */
export function installAccountLaneIndexPublisher(publisher: AccountLaneIndexPublisher | null): void {
  installed = publisher;
}

/** A project runtime's lanes or PRs changed. */
export function noteAccountLanesChanged(projectId: string, read: AccountLaneReader): void {
  installed?.note(projectId, read);
}

/** The hash of a lane set: the same lanes in any order hash the same. */
export function accountLaneIndexHash(lanes: readonly AccountLaneIndexEntry[]): string {
  const sorted = [...lanes].sort((a, b) => (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export function createAccountLaneIndexPublisher(deps: AccountLaneIndexPublisherDeps): AccountLaneIndexPublisher {
  const { logger } = deps;
  const file = path.join(deps.adeHome, "account-lanes.json");
  const debounceMs = deps.debounceMs ?? ACCOUNT_LANES_DEBOUNCE_MS;
  const pending = new Map<string, AccountLaneReader>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;

  const readCache = (): CacheFile => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CacheFile>;
      if (parsed?.v === 1 && parsed.projects && typeof parsed.projects === "object") {
        return { v: 1, machineKey: parsed.machineKey ?? null, hash: parsed.hash ?? null, projects: parsed.projects };
      }
    } catch {
      // None yet: nothing sent before.
    }
    return { v: 1, machineKey: null, hash: null, projects: {} };
  };
  const writeCache = (cache: CacheFile): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      logger.warn("account.lanes_cache_write_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  };

  const publish = async (): Promise<void> => {
    const machineKey = deps.machineKey();
    if (!machineKey) return;
    const cache = readCache();
    // Another machine key (a copy of the disk): its rows are not this machine's.
    if (cache.machineKey !== machineKey) {
      cache.machineKey = machineKey;
      cache.hash = null;
      cache.projects = {};
    }
    const reads = [...pending.entries()];
    pending.clear();
    for (const [projectId, read] of reads) {
      try {
        cache.projects[projectId] = await read();
      } catch (error) {
        logger.warn("account.lanes_read_failed", { projectId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const projects = deps.listProjects();
    const known = new Map(projects.map((project) => [project.projectId, project.accountProjectId ?? null]));
    for (const projectId of Object.keys(cache.projects)) if (!known.has(projectId)) delete cache.projects[projectId];
    const lanes: AccountLaneIndexEntry[] = [];
    for (const [projectId, rows] of Object.entries(cache.projects)) {
      for (const row of rows) lanes.push({ ...row, projectId: known.get(projectId) ?? null });
    }
    const capped = lanes.slice(0, ACCOUNT_LANE_INDEX_MAX_PER_MACHINE);
    const hash = accountLaneIndexHash(capped);
    if (hash === cache.hash) {
      writeCache(cache);
      return;
    }
    const put = await deps.putLanes().catch(() => null);
    if (!put) {
      // Not signed in: the rows are kept, and the next change (or brain start) sends them.
      writeCache(cache);
      return;
    }
    try {
      const answer = await put({ machineKey, hash, lanes: capped });
      // An older server (null) has no index: it is not asked again for the same set.
      cache.hash = hash;
      logger.info("account.lanes_published", { count: capped.length, changed: answer?.changed ?? null, truncated: lanes.length > capped.length });
    } catch (error) {
      logger.warn("account.lanes_publish_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    writeCache(cache);
  };

  const run = (): Promise<void> => {
    if (running) {
      // A note during a publish: one more publish after it.
      schedule();
      return running;
    }
    running = publish().finally(() => {
      running = null;
    });
    return running;
  };

  // The first note starts the wait and later ones join it, so frequent PR
  // updates can never hold the publish back for good.
  function schedule(): void {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
    timer.unref?.();
  }

  return {
    note(projectId, read) {
      if (disposed || !projectId) return;
      pending.set(projectId, read);
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await (running ?? Promise.resolve());
      await run();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
