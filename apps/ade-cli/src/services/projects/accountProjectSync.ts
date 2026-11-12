import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_PROJECT_PATHS,
  githubRepoIdentityFromOrigin,
  githubRepoKey,
  type AccountProjectCopiesRequest,
  type AccountProjectCopiesResponse,
  type AccountProjectCopyInput,
  type AccountProjectListResponse,
  type AccountProjectView,
  type GithubRepoIdentity,
} from "../../../../desktop/src/shared/accountProject";
import { ACCOUNT_PROJECT_MAX_COPIES_PER_MACHINE } from "../../../../account-directory/src/accountProjects/contract";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { isInsideTempFolder } from "../../../../desktop/src/main/services/shared/pathCompare";
import type { ProjectAccountLink, ProjectRecord, ProjectRegistry } from "./projectRegistry";
import type { ProjectFolderState } from "./projectFolderPresence";
import type { GithubRepoLookup, GithubRepoLookupResult } from "./githubRepoLookup";

/**
 * The machine side of the account's project list.
 *
 * It runs after each heartbeat the account directory accepted (the brain's
 * machine publisher calls `afterHeartbeat`), so it adds no timer and no
 * repeated request of its own:
 *
 * 1. The heartbeat answer carries the list's cursor. When it differs from the
 *    one held here, read what changed (`GET /account/projects?since=`).
 * 2. Build this machine's copies from the registry: projects the person
 *    opened, with a GitHub origin, in a real folder (not a temp, scratch or
 *    hidden one, not a test registration, not gone).
 * 3. Ask GitHub for the repository id of a few copies whose answer is due.
 * 4. When the copies, or what the account knows about them, changed since the
 *    last publish, send them all in one `PUT /account/projects/copies`, and
 *    write the links (account project id, repository id) on the registry.
 *
 * The first publish for an account is the first fill: projects opened in the
 * last 90 days ask to be added (`add: "auto"`). After it, a copy is recorded
 * only when its project is already on the account; a person adds a project
 * explicitly. A dev test machine never adds.
 *
 * Account rules: it works only while signed in, and only for the account the
 * heartbeat's token belongs to. A different account resets what is held here
 * (the list, the fill mark, the publish digest), so the old account's list is
 * never shown or published under the new one. Nothing local is deleted; the
 * repository ids found stay, since they are facts about GitHub.
 *
 * Old servers: a heartbeat answer with no cursor means the directory has no
 * project list, and this does nothing.
 */

const STATE_FILE = "account-projects.json";
const STATE_VERSION = 1;
const FIRST_FILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const LOOKUP_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKUP_NOT_FOUND_RETRY_MS = 24 * 60 * 60 * 1000;
const LOOKUP_UNSUPPORTED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKUP_BACKOFF_BASE_MS = 60 * 1000;
const LOOKUP_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const LOOKUPS_PER_RUN = 10;
const LOOKUPS_PER_FIRST_FILL = 25;
const LOOKUP_CONCURRENCY = 3;
const PUBLISH_BACKOFF_BASE_MS = 60 * 1000;
const PUBLISH_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/** Even with no visible change, look at the folders again this often (a deleted folder). */
const FULL_RECHECK_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LIST_BODY_BYTES = 8 * 1024 * 1024;
/** Path segments that mark a scratch folder. */
const SCRATCH_SEGMENT = /^(tmp|temp|scratch)$/i;

type RepoLookupEntry = {
  status: "found" | "not_found" | "unavailable" | "unsupported";
  repoId?: number;
  owner?: string;
  name?: string;
  defaultBranch?: string | null;
  checkedAt: number;
  failures: number;
  nextAt: number;
};

export type AccountProjectSyncState = {
  version: typeof STATE_VERSION;
  /** The account everything below belongs to, except `repoLookups`. */
  userId: string | null;
  cursor: number | null;
  projects: Record<string, AccountProjectView>;
  firstFill: { at: number; machineKey: string } | null;
  published: { digest: string; machineKey: string; at: number } | null;
  publishFailures: { count: number; nextAt: number } | null;
  /** Checkout ids chosen as the main copy; kept until the folder goes, so the main does not flip. */
  mainCheckouts: string[];
  /** By the origin's alias key. Machine facts about GitHub: kept across accounts. */
  repoLookups: Record<string, RepoLookupEntry>;
};

export type AccountProjectHeartbeat = {
  baseUrl: string;
  accessToken: string;
  machineKey: string;
  accountOwnerId: string | null;
  accountProjectsCursor: number | null;
};

type Logger = {
  info?: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
};

export type AccountProjectSyncOptions = {
  adeDir: string;
  registry: Pick<ProjectRegistry, "list" | "setAccountLinks" | "resolveMovedProjectId" | "path">;
  /** The account signed in on this machine now, or null. */
  getAccountUserId: () => string | null;
  lookupRepo: GithubRepoLookup;
  readFolderStates: (records: readonly { rootPath: string }[]) => Promise<ProjectFolderState[]>;
  isDevTestMachine: () => boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
};

export type AccountProjectSync = {
  /** Fire and forget; at most one run at a time, a heartbeat during a run runs once after it. */
  afterHeartbeat: (event: AccountProjectHeartbeat) => void;
  /** Resolves when the current run (and a queued one) finished. For shutdown and checks. */
  idle: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// State file

function emptyState(): AccountProjectSyncState {
  return {
    version: STATE_VERSION,
    userId: null,
    cursor: null,
    projects: {},
    firstFill: null,
    published: null,
    publishFailures: null,
    mainCheckouts: [],
    repoLookups: {},
  };
}

export function accountProjectStatePath(adeDir: string): string {
  return path.join(adeDir, STATE_FILE);
}

export function readAccountProjectState(adeDir: string): AccountProjectSyncState {
  try {
    const parsed = JSON.parse(fs.readFileSync(accountProjectStatePath(adeDir), "utf8")) as Partial<AccountProjectSyncState>;
    if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) return emptyState();
    return {
      ...emptyState(),
      ...parsed,
      projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {},
      mainCheckouts: Array.isArray(parsed.mainCheckouts) ? parsed.mainCheckouts.filter((id) => typeof id === "string") : [],
      repoLookups: parsed.repoLookups && typeof parsed.repoLookups === "object" ? parsed.repoLookups : {},
    };
  } catch {
    return emptyState();
  }
}

function writeState(adeDir: string, state: AccountProjectSyncState): void {
  fs.mkdirSync(adeDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(accountProjectStatePath(adeDir), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

/** The state for `userId`: the same, or a fresh one that keeps only the GitHub facts. */
function stateForAccount(state: AccountProjectSyncState, userId: string): AccountProjectSyncState {
  if (state.userId === userId) return state;
  return { ...emptyState(), userId, repoLookups: state.repoLookups };
}

// ---------------------------------------------------------------------------
// What `projects.accountList` answers

export type AccountProjectListRpcResult =
  | { state: "signed_out"; projects: [] }
  /** Signed in, but this machine has not read the account's list yet (or the directory has none). */
  | { state: "not_loaded"; projects: [] }
  | { state: "ready"; cursor: number; projects: AccountProjectView[] };

/** The list as this machine last read it, for the signed-in account only. Removed and merged rows are left out. */
export function readAccountProjectListForRpc(adeDir: string, accountUserId: string | null): AccountProjectListRpcResult {
  if (!accountUserId) return { state: "signed_out", projects: [] };
  const state = readAccountProjectState(adeDir);
  if (state.userId !== accountUserId || state.cursor === null) return { state: "not_loaded", projects: [] };
  const projects = Object.values(state.projects)
    .filter((project) => project.removedAt === null && project.mergedInto === null)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return { state: "ready", cursor: state.cursor, projects };
}

// ---------------------------------------------------------------------------
// Pure helpers

/** The `sub` of a JWT, without checking it: the server checked it; this only binds the answer to its account. */
function tokenSubject(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown };
    return typeof parsed.sub === "string" && parsed.sub.trim() ? parsed.sub.trim() : null;
  } catch {
    return null;
  }
}

/** Whether a folder is a place the person keeps a project, not a temp, scratch or hidden one. */
function isEligibleFolder(rootPath: string): boolean {
  if (isInsideTempFolder(rootPath)) return false;
  const segments = rootPath.split(/[\\/]+/).filter(Boolean);
  return !segments.some((segment) => SCRATCH_SEGMENT.test(segment) || (segment.startsWith(".") && segment !== "." && segment !== ".."));
}

function backoff(base: number, max: number, failures: number): number {
  return Math.min(max, base * 2 ** Math.max(0, Math.min(failures - 1, 20)));
}

function lookupDue(entry: RepoLookupEntry | undefined, now: number): boolean {
  return !entry || entry.nextAt <= now;
}

function nextLookupEntry(previous: RepoLookupEntry | undefined, result: GithubRepoLookupResult, now: number): RepoLookupEntry {
  switch (result.kind) {
    case "found":
      return {
        status: "found",
        repoId: result.repoId,
        owner: result.owner,
        name: result.name,
        defaultBranch: result.defaultBranch,
        checkedAt: now,
        failures: 0,
        nextAt: now + LOOKUP_REFRESH_MS,
      };
    case "not_found":
      // Keep an id found before: a repository that turned private for this
      // credential is still the same repository.
      return { ...previous, status: previous?.repoId ? "found" : "not_found", checkedAt: now, failures: 0, nextAt: now + LOOKUP_NOT_FOUND_RETRY_MS };
    case "unsupported":
      return { status: "unsupported", checkedAt: now, failures: 0, nextAt: now + LOOKUP_UNSUPPORTED_RETRY_MS };
    case "unavailable": {
      const failures = (previous?.failures ?? 0) + 1;
      return {
        ...previous,
        status: previous?.repoId ? "found" : "unavailable",
        checkedAt: now,
        failures,
        nextAt: now + backoff(LOOKUP_BACKOFF_BASE_MS, LOOKUP_BACKOFF_MAX_MS, failures),
      };
    }
  }
}

type Candidate = {
  record: ProjectRecord;
  identity: GithubRepoIdentity;
};

/** The account project a copy matches in the list held here, following merges. */
function matchProject(
  projects: Record<string, AccountProjectView>,
  copy: { host: string; repoKey: string; canonicalRepoKey?: string | null; repoId?: number | null },
): AccountProjectView | null {
  const values = Object.values(projects);
  let found = (copy.repoId != null
    ? values.find((project) => project.mergedInto === null && project.host === copy.host && project.repoId === copy.repoId)
    : undefined)
    ?? values.find((project) => project.aliases.includes(copy.repoKey) || (copy.canonicalRepoKey != null && project.aliases.includes(copy.canonicalRepoKey)))
    ?? null;
  for (let hops = 0; found?.mergedInto && hops < 8; hops += 1) found = projects[found.mergedInto] ?? null;
  return found;
}

/**
 * The copies to publish. One main copy per repository on this machine: the
 * one chosen before while its folder is still listed (it moves with a
 * project move), else the most recently opened.
 */
function buildCopies(args: {
  candidates: Candidate[];
  state: AccountProjectSyncState;
  resolveMoved: (checkoutId: string) => string | null;
  now: number;
  autoAdd: boolean;
}): { copies: AccountProjectCopyInput[]; mainCheckouts: string[] } {
  const { candidates, state, now } = args;
  const ordered = [...candidates]
    .sort((left, right) => right.record.lastOpenedAt - left.record.lastOpenedAt || left.record.projectId.localeCompare(right.record.projectId))
    .slice(0, ACCOUNT_PROJECT_MAX_COPIES_PER_MACHINE);
  const sticky = new Set(state.mainCheckouts.map((id) => args.resolveMoved(id) ?? id));
  const groupKey = (candidate: Candidate) => {
    const lookup = state.repoLookups[candidate.identity.repoKey];
    return lookup?.repoId ? `id:${candidate.identity.host}:${lookup.repoId}` : `key:${candidate.identity.repoKey}`;
  };
  const mainByGroup = new Map<string, string>();
  for (const candidate of ordered) {
    if (sticky.has(candidate.record.projectId) && !mainByGroup.has(groupKey(candidate))) {
      mainByGroup.set(groupKey(candidate), candidate.record.projectId);
    }
  }
  for (const candidate of ordered) {
    if (!mainByGroup.has(groupKey(candidate))) mainByGroup.set(groupKey(candidate), candidate.record.projectId);
  }
  const copies = ordered.map((candidate): AccountProjectCopyInput => {
    const lookup = state.repoLookups[candidate.identity.repoKey];
    const found = lookup?.repoId ? lookup : null;
    const owner = found?.owner ?? candidate.identity.owner;
    const name = found?.name ?? candidate.identity.name;
    return {
      host: candidate.identity.host,
      owner,
      name,
      repoKey: candidate.identity.repoKey,
      canonicalRepoKey: found ? githubRepoKey(candidate.identity.host, owner, name) : null,
      repoId: found?.repoId ?? null,
      defaultBranch: found?.defaultBranch ?? null,
      checkoutId: candidate.record.projectId,
      rootPath: candidate.record.rootPath,
      isMain: mainByGroup.get(groupKey(candidate)) === candidate.record.projectId,
      add: args.autoAdd && now - candidate.record.lastOpenedAt <= FIRST_FILL_WINDOW_MS ? "auto" : "none",
    };
  });
  return { copies, mainCheckouts: [...mainByGroup.values()].sort() };
}

/** What, if it changes, needs a publish: the copies (without `add`) and how the account knows each one now. */
function publishDigest(machineKey: string, copies: AccountProjectCopyInput[], state: AccountProjectSyncState): string {
  const known = copies.map((copy) => {
    const project = matchProject(state.projects, copy);
    return project ? `${project.id}:${project.removedAt === null ? 1 : 0}` : "-";
  });
  const body = {
    machineKey,
    fill: state.firstFill !== null,
    copies: copies.map(({ add: _add, ...copy }) => copy),
    known,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

// ---------------------------------------------------------------------------
// The service

export function createAccountProjectSync(options: AccountProjectSyncOptions): AccountProjectSync {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? {};
  let running: Promise<void> | null = null;
  let queued: AccountProjectHeartbeat | null = null;
  /** What the last full run saw; an equal heartbeat with nothing due skips the folder checks. */
  let lastInputs: { key: string; at: number } | null = null;

  const request = async <T>(
    event: AccountProjectHeartbeat,
    method: "GET" | "PUT",
    pathAndQuery: string,
    body?: unknown,
  ): Promise<{ ok: true; value: T } | { ok: false; status: number | null }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(new URL(pathAndQuery, event.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${event.accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, status: response.status };
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_LIST_BODY_BYTES) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, status: null };
      }
      const text = await response.text();
      if (text.length > MAX_LIST_BODY_BYTES) return { ok: false, status: null };
      return { ok: true, value: JSON.parse(text) as T };
    } catch {
      return { ok: false, status: null };
    } finally {
      clearTimeout(timer);
    }
  };

  /** Read what changed since the cursor held, into `state`. False when the read failed. */
  const pull = async (event: AccountProjectHeartbeat, state: AccountProjectSyncState): Promise<boolean> => {
    const since = state.cursor === null ? "" : `?since=${state.cursor}`;
    const result = await request<AccountProjectListResponse>(event, "GET", `${ACCOUNT_PROJECT_PATHS.root}${since}`);
    if (!result.ok || !Array.isArray(result.value?.projects) || typeof result.value.cursor !== "number") {
      logger.warn?.("account_projects.pull_failed", { status: result.ok ? "bad_body" : result.status });
      return false;
    }
    const page = result.value;
    const projects = page.reset ? {} : { ...state.projects };
    for (const project of page.projects) projects[project.id] = project;
    state.projects = projects;
    state.cursor = page.cursor;
    return true;
  };

  const eligibleCandidates = async (): Promise<Candidate[]> => {
    const records = options.registry.list().filter((record) =>
      record.catalogVisibility === "recent"
      && record.registrationSource !== "test"
      && isEligibleFolder(record.rootPath));
    const withIdentity = records
      .map((record) => ({ record, identity: githubRepoIdentityFromOrigin(record.gitOriginUrl) }))
      .filter((candidate): candidate is Candidate => candidate.identity !== null);
    // A folder that is gone is not a copy. A drive that is not plugged in, or
    // a check that ran out of time, keeps the copy: it is still the person's.
    const states = await options.readFolderStates(withIdentity.map((candidate) => candidate.record));
    return withIdentity.filter((_candidate, index) => states[index] !== "gone");
  };

  const runLookups = async (candidates: Candidate[], state: AccountProjectSyncState, limit: number): Promise<void> => {
    const at = now();
    // An answer for a folder that is no longer a copy is not asked again
    // until it is one; without this it would stay due, and every heartbeat
    // would run in full.
    const candidateKeys = new Set(candidates.map((candidate) => candidate.identity.repoKey));
    for (const [repoKey, entry] of Object.entries(state.repoLookups)) {
      if (!candidateKeys.has(repoKey) && entry.nextAt <= at) state.repoLookups[repoKey] = { ...entry, nextAt: at + LOOKUP_NOT_FOUND_RETRY_MS };
    }
    const due = [...new Map(candidates
      .filter((candidate) => lookupDue(state.repoLookups[candidate.identity.repoKey], at))
      .map((candidate) => [candidate.identity.repoKey, candidate.identity])).values()]
      .slice(0, limit);
    for (let index = 0; index < due.length; index += LOOKUP_CONCURRENCY) {
      await Promise.all(due.slice(index, index + LOOKUP_CONCURRENCY).map(async (identity) => {
        let result: GithubRepoLookupResult;
        try {
          result = await options.lookupRepo({ host: identity.host, owner: identity.owner, name: identity.name });
        } catch {
          result = { kind: "unavailable", reason: "lookup_threw" };
        }
        state.repoLookups[identity.repoKey] = nextLookupEntry(state.repoLookups[identity.repoKey], result, now());
      }));
    }
    if (due.length > 0) {
      const counts: Record<string, number> = {};
      for (const identity of due) {
        const status = state.repoLookups[identity.repoKey]?.status ?? "unknown";
        counts[status] = (counts[status] ?? 0) + 1;
      }
      logger.info?.("account_projects.repo_lookups", { count: due.length, ...counts });
    }
  };

  /** The registry links for every record: set on linked copies, cleared everywhere else. */
  const writeLinks = (
    userId: string,
    copies: AccountProjectCopyInput[],
    linked: Map<string, string>,
    state: AccountProjectSyncState,
  ): void => {
    const copyIds = new Set(copies.map((copy) => copy.checkoutId));
    const links: ProjectAccountLink[] = [];
    for (const record of options.registry.list()) {
      const identity = githubRepoIdentityFromOrigin(record.gitOriginUrl);
      const repoId = identity ? state.repoLookups[identity.repoKey]?.repoId ?? null : null;
      const projectId = copyIds.has(record.projectId) ? linked.get(record.projectId) ?? null : null;
      links.push({
        projectId: record.projectId,
        githubRepoId: repoId ?? (record.githubRepoId ?? null),
        accountProjectId: projectId,
        accountProjectUserId: projectId ? userId : null,
      });
    }
    try {
      const changed = options.registry.setAccountLinks(links);
      if (changed > 0) logger.info?.("account_projects.registry_links_written", { changed });
    } catch (error) {
      logger.warn?.("account_projects.registry_links_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const registryStamp = (): string => {
    try {
      const stat = fs.statSync(options.registry.path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "none";
    }
  };

  const runOnce = async (event: AccountProjectHeartbeat): Promise<void> => {
    // Old directory: no project list there.
    if (event.accountProjectsCursor === null) return;
    const userId = tokenSubject(event.accessToken);
    // Only for the account the token belongs to, and only while it is still
    // the one signed in here (an account switch can race the heartbeat).
    if (!userId || options.getAccountUserId() !== userId) return;
    if (event.accountOwnerId && event.accountOwnerId !== userId) return;

    const loaded = readAccountProjectState(options.adeDir);
    const state = stateForAccount(loaded, userId);
    const switched = state !== loaded;
    if (switched) logger.info?.("account_projects.account_changed", { hadAccount: loaded.userId !== null });
    const at = now();

    // A new folder shows as a registry change (the stamp below), so only
    // lookups already held can fall due without one.
    const anyLookupDue = Object.values(state.repoLookups).some((entry) => entry.nextAt <= at);
    const publishBlocked = state.publishFailures !== null && state.publishFailures.nextAt > at;
    const inputsKey = JSON.stringify([userId, event.machineKey, event.accountProjectsCursor, state.cursor, registryStamp(), state.firstFill?.at ?? null, publishBlocked]);
    if (!switched && !anyLookupDue && lastInputs?.key === inputsKey && at - lastInputs.at < FULL_RECHECK_MS) return;

    let dirty = switched;
    if (state.cursor !== event.accountProjectsCursor) {
      if (await pull(event, state)) dirty = true;
    }
    // Signed out or switched while the read ran: drop what was read.
    if (options.getAccountUserId() !== userId) return;

    const candidates = await eligibleCandidates();
    const lookupsBefore = JSON.stringify(state.repoLookups);
    await runLookups(candidates, state, state.firstFill ? LOOKUPS_PER_RUN : LOOKUPS_PER_FIRST_FILL);
    if (JSON.stringify(state.repoLookups) !== lookupsBefore) dirty = true;

    const autoAdd = state.firstFill === null && !options.isDevTestMachine();
    const { copies, mainCheckouts } = buildCopies({
      candidates,
      state,
      resolveMoved: (id) => options.registry.resolveMovedProjectId(id),
      now: at,
      autoAdd,
    });
    if (JSON.stringify(mainCheckouts) !== JSON.stringify(state.mainCheckouts)) {
      state.mainCheckouts = mainCheckouts;
      dirty = true;
    }
    const digest = publishDigest(event.machineKey, copies, state);
    const needsPublish = state.published?.digest !== digest || state.published.machineKey !== event.machineKey;

    if (needsPublish && !publishBlocked) {
      const body: AccountProjectCopiesRequest = { machineKey: event.machineKey, copies };
      const result = await request<AccountProjectCopiesResponse>(event, "PUT", ACCOUNT_PROJECT_PATHS.copies, body);
      if (options.getAccountUserId() !== userId) return;
      if (result.ok && Array.isArray(result.value?.copies)) {
        const linked = new Map<string, string>();
        const statuses: Record<string, number> = {};
        for (const copy of result.value.copies) {
          statuses[copy.status] = (statuses[copy.status] ?? 0) + 1;
          if (copy.status === "linked" && copy.projectId) linked.set(copy.checkoutId, copy.projectId);
        }
        const wasFill = state.firstFill === null;
        if (wasFill) state.firstFill = { at, machineKey: event.machineKey };
        state.publishFailures = null;
        if (typeof result.value.cursor === "number" && result.value.cursor !== state.cursor) await pull(event, state);
        if (options.getAccountUserId() !== userId) return;
        // Stored from the list as it is after this publish, so the next
        // heartbeat finds nothing to send.
        state.published = { digest: publishDigest(event.machineKey, copies, state), machineKey: event.machineKey, at };
        writeLinks(userId, copies, linked, state);
        logger.info?.("account_projects.published", { copies: copies.length, firstFill: wasFill, autoAdd: wasFill && autoAdd, ...statuses });
      } else {
        const count = (state.publishFailures?.count ?? 0) + 1;
        state.publishFailures = { count, nextAt: at + backoff(PUBLISH_BACKOFF_BASE_MS, PUBLISH_BACKOFF_MAX_MS, count) };
        logger.warn?.("account_projects.publish_failed", { status: result.ok ? "bad_body" : result.status, failures: count });
      }
      dirty = true;
    } else if (!needsPublish && dirty) {
      // A list change that does not touch this machine's copies can still
      // change a link (a project merged elsewhere): keep the registry right.
      const linked = new Map<string, string>();
      for (const copy of copies) {
        const project = matchProject(state.projects, copy);
        if (project && project.removedAt === null && project.copies.some((held) => held.checkoutId === copy.checkoutId && held.machineKey === event.machineKey)) {
          linked.set(copy.checkoutId, project.id);
        }
      }
      writeLinks(userId, copies, linked, state);
    }

    if (dirty) {
      try {
        writeState(options.adeDir, state);
      } catch (error) {
        logger.warn?.("account_projects.state_write_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    lastInputs = {
      key: JSON.stringify([userId, event.machineKey, event.accountProjectsCursor, state.cursor, registryStamp(), state.firstFill?.at ?? null, state.publishFailures !== null && state.publishFailures.nextAt > now()]),
      at,
    };
  };

  const drain = async (event: AccountProjectHeartbeat): Promise<void> => {
    let next: AccountProjectHeartbeat | null = event;
    while (next) {
      const current: AccountProjectHeartbeat = next;
      queued = null;
      try {
        await runOnce(current);
      } catch (error) {
        logger.warn?.("account_projects.sync_failed", { error: error instanceof Error ? error.message : String(error) });
      }
      next = queued;
    }
  };

  return {
    afterHeartbeat(event) {
      if (running) {
        queued = event;
        return;
      }
      running = drain(event).finally(() => {
        running = null;
      });
    },
    async idle() {
      while (running) await running;
    },
  };
}
