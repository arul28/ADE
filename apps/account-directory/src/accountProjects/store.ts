import {
  ACCOUNT_PROJECT_MAX_ALIASES_PER_PROJECT,
  ACCOUNT_PROJECT_MAX_COPIES,
  ACCOUNT_PROJECT_MAX_LIVE,
  ACCOUNT_PROJECT_MAX_ROWS,
  type AccountProjectCopyAddMode,
  type AccountProjectCopyResult,
  type AccountProjectCopyView,
  type AccountProjectView,
} from "./contract";

/**
 * The D1 side of the account's project list (migration 0028).
 *
 * D1 has no interactive transaction, only `batch`, which runs its statements
 * in one transaction. So every write here is planned against a snapshot of
 * the account's rows read first, and then sent as ONE batch. Two requests at
 * once can plan against the same snapshot. The batch's first statement checks
 * that the account's counter still has the snapshot's value and fails the
 * batch on a primary key when it does not (as do the unique keys: one live
 * row per repository id, one project per address), and the slower write is
 * planned again from a fresh snapshot (`withRetry`). Each batch ends with
 * fix-ups for what one plan can do to itself: a later copy merging an earlier
 * copy's project moves copies and addresses off the merged row, a merge into
 * a removed project leaves it no copies, and a merge that moves another
 * machine's copies keeps one main copy per machine and project.
 */

export type ProjectRow = {
  id: string;
  user_id: string;
  host: string;
  repo_id: number | null;
  repo_key: string;
  owner: string;
  name: string;
  default_branch: string | null;
  added_at: number;
  last_explicit_add_at: number | null;
  removed_at: number | null;
  merged_into: string | null;
  change_seq: number;
  updated_at: number;
};

type AliasRow = { repo_key: string; project_id: string; created_at: number };

type CopyRow = {
  machine_key: string;
  checkout_id: string;
  project_id: string;
  root_path: string;
  is_main: number;
  last_seen_at: number;
};

const PROJECT_COLUMNS = `id, user_id, host, repo_id, repo_key, owner, name, default_branch, added_at,
  last_explicit_add_at, removed_at, merged_into, change_seq, updated_at`;

/** A repository as one request names it. Validated by the routes. */
export type IdentityInput = {
  host: string;
  owner: string;
  name: string;
  repoKey: string;
  canonicalRepoKey: string | null;
  repoId: number | null;
  defaultBranch: string | null;
};

export class AccountProjectLimitError extends Error {
  constructor(readonly limit: "live_projects" | "project_rows") {
    super(limit);
    this.name = "AccountProjectLimitError";
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

export function newAccountProjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ap_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The account's change counter inside a statement (bind the user id once more). */
const ACCOUNT_SEQ = "(select seq from account_project_state where user_id = ?)";

/**
 * Copies count and show only for a machine still on the account. Removing a
 * machine deletes its copies, best effort; when that delete fails, this keeps
 * its folders out of every answer and out of the limit.
 */
const ON_ACCOUNT_MACHINE = "join machines m on m.user_id = c.user_id and m.machine_key = c.machine_key";

/** The first statement of every write batch: the account's counter goes up by one. */
function bumpAccountSeq(db: D1Database, userId: string, now: number): D1PreparedStatement {
  return db.prepare(`
    insert into account_project_state (user_id, seq, floor_seq, updated_at) values (?, 1, 0, ?)
    on conflict(user_id) do update set seq = seq + 1, updated_at = excluded.updated_at
  `).bind(userId, now);
}

/** The addresses one request names, each once. */
function identityKeys(input: Pick<IdentityInput, "repoKey" | "canonicalRepoKey">): string[] {
  return [...new Set([input.repoKey, input.canonicalRepoKey].filter((key): key is string => Boolean(key)))];
}

/** SQLite's own text order (binary), so the plan and the batch's fix-ups pick the same row. */
const byCheckoutId = (left: { checkoutId: string }, right: { checkoutId: string }): number =>
  left.checkoutId < right.checkoutId ? -1 : left.checkoutId > right.checkoutId ? 1 : 0;

// ---------------------------------------------------------------------------
// Snapshot

type Snapshot = {
  seq: number;
  floor: number;
  projects: Map<string, ProjectRow>;
  /** By address. */
  aliases: Map<string, AliasRow>;
  /** This machine's copies, by checkout id (only when a machine was named). */
  machineCopies: Map<string, CopyRow>;
  /** Copies of every other machine of the account. */
  otherCopyCount: number;
};

async function loadSnapshot(db: D1Database, userId: string, machineKey: string | null): Promise<Snapshot> {
  const [state, projects, aliases, copies, otherCopies] = await db.batch([
    db.prepare("select seq, floor_seq from account_project_state where user_id = ?").bind(userId),
    db.prepare(`select ${PROJECT_COLUMNS} from account_projects where user_id = ?`).bind(userId),
    db.prepare("select repo_key, project_id, created_at from account_project_aliases where user_id = ?").bind(userId),
    db.prepare(`
      select machine_key, checkout_id, project_id, root_path, is_main, last_seen_at
        from account_project_copies where user_id = ? and machine_key = ?
    `).bind(userId, machineKey ?? ""),
    db.prepare("select count(*) as count from account_project_copies where user_id = ? and machine_key <> ?")
      .bind(userId, machineKey ?? ""),
  ]);
  const stateRow = (state?.results?.[0] ?? null) as { seq: number; floor_seq: number } | null;
  return {
    seq: stateRow?.seq ?? 0,
    floor: stateRow?.floor_seq ?? 0,
    projects: new Map(((projects?.results ?? []) as ProjectRow[]).map((row) => [row.id, { ...row }])),
    aliases: new Map(((aliases?.results ?? []) as AliasRow[]).map((row) => [row.repo_key, { ...row }])),
    machineCopies: new Map(((copies?.results ?? []) as CopyRow[]).map((row) => [row.checkout_id, { ...row }])),
    otherCopyCount: Number((otherCopies?.results?.[0] as { count?: number } | undefined)?.count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// The plan: in-memory changes that each carry their statement

class Plan {
  readonly statements: D1PreparedStatement[] = [];
  /** Projects whose view changed, so their `change_seq` goes up. */
  readonly touched = new Set<string>();

  constructor(
    readonly db: D1Database,
    readonly userId: string,
    readonly snapshot: Snapshot,
    readonly now: number,
  ) {}

  /** The live project a row was merged into, following at most a few hops. */
  follow(project: ProjectRow | undefined): ProjectRow | null {
    let current = project ?? null;
    for (let hops = 0; current?.merged_into && hops < 8; hops += 1) {
      current = this.snapshot.projects.get(current.merged_into) ?? null;
    }
    return current?.merged_into ? null : current;
  }

  liveCount(): number {
    let count = 0;
    for (const project of this.snapshot.projects.values()) {
      if (project.removed_at == null) count += 1;
    }
    return count;
  }

  aliasesOf(projectId: string): AliasRow[] {
    return [...this.snapshot.aliases.values()].filter((alias) => alias.project_id === projectId);
  }

  /** Make room for one more row by purging the oldest tombstones (merged first). */
  private makeRoomForRow(): void {
    if (this.snapshot.projects.size < ACCOUNT_PROJECT_MAX_ROWS) return;
    const tombstones = [...this.snapshot.projects.values()]
      .filter((row) => row.removed_at != null && !this.touched.has(row.id))
      .sort((left, right) => {
        const leftMerged = left.merged_into ? 0 : 1;
        const rightMerged = right.merged_into ? 0 : 1;
        return leftMerged - rightMerged || (left.removed_at ?? 0) - (right.removed_at ?? 0);
      });
    const victim = tombstones[0];
    if (!victim) throw new AccountProjectLimitError("project_rows");
    this.snapshot.projects.delete(victim.id);
    for (const alias of this.aliasesOf(victim.id)) this.snapshot.aliases.delete(alias.repo_key);
    this.statements.push(
      this.db.prepare("delete from account_project_aliases where user_id = ? and project_id = ?").bind(this.userId, victim.id),
      this.db.prepare("delete from account_project_copies where user_id = ? and project_id = ?").bind(this.userId, victim.id),
      this.db.prepare("delete from account_projects where user_id = ? and id = ?").bind(this.userId, victim.id),
      // A client whose cursor is older than this purge cannot learn about it
      // from a delta, so it gets the whole list.
      this.db.prepare(`update account_project_state set floor_seq = ${ACCOUNT_SEQ} where user_id = ?`)
        .bind(this.userId, this.userId),
    );
  }

  /** A new project with every address the request names. */
  create(input: IdentityInput, explicit: boolean): ProjectRow {
    if (this.liveCount() >= ACCOUNT_PROJECT_MAX_LIVE) throw new AccountProjectLimitError("live_projects");
    this.makeRoomForRow();
    const row: ProjectRow = {
      id: newAccountProjectId(),
      user_id: this.userId,
      host: input.host,
      repo_id: input.repoId,
      repo_key: input.canonicalRepoKey ?? input.repoKey,
      owner: input.owner,
      name: input.name,
      default_branch: input.defaultBranch,
      added_at: this.now,
      last_explicit_add_at: explicit ? this.now : null,
      removed_at: null,
      merged_into: null,
      change_seq: 0,
      updated_at: this.now,
    };
    this.snapshot.projects.set(row.id, row);
    this.touched.add(row.id);
    this.statements.push(this.db.prepare(`
      insert into account_projects (id, user_id, host, repo_id, repo_key, owner, name, default_branch,
        added_at, last_explicit_add_at, removed_at, merged_into, change_seq, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ${ACCOUNT_SEQ}, ?)
    `).bind(
      row.id, this.userId, row.host, row.repo_id, row.repo_key, row.owner, row.name, row.default_branch,
      row.added_at, row.last_explicit_add_at, this.userId, row.updated_at,
    ));
    for (const key of identityKeys(input)) this.setAlias(key, row);
    return row;
  }

  /**
   * Point one address at a project. An address the snapshot did not have is
   * a plain insert: when another request added it after our read (two
   * address-only adds at once), the primary key fails this batch and it plans
   * again from what the other one wrote, instead of leaving a second project
   * with no address. A known address moves with an upsert.
   */
  setAlias(repoKey: string, project: ProjectRow): void {
    const existing = this.snapshot.aliases.get(repoKey);
    if (existing?.project_id === project.id) return;
    if (existing) this.touched.add(existing.project_id);
    this.snapshot.aliases.set(repoKey, { repo_key: repoKey, project_id: project.id, created_at: this.now });
    this.touched.add(project.id);
    this.statements.push(existing
      ? this.db.prepare(`
        insert into account_project_aliases (user_id, repo_key, project_id, created_at) values (?, ?, ?, ?)
        on conflict(user_id, repo_key) do update set project_id = excluded.project_id, created_at = excluded.created_at
      `).bind(this.userId, repoKey, project.id, this.now)
      : this.db.prepare("insert into account_project_aliases (user_id, repo_key, project_id, created_at) values (?, ?, ?, ?)")
        .bind(this.userId, repoKey, project.id, this.now));
    this.trimAliases(project);
  }

  /** Keep at most the per-project number of addresses: the oldest that is not the current one goes. */
  private trimAliases(project: ProjectRow): void {
    const aliases = this.aliasesOf(project.id)
      .filter((alias) => alias.repo_key !== project.repo_key)
      .sort((left, right) => left.created_at - right.created_at || left.repo_key.localeCompare(right.repo_key));
    const over = aliases.length + 1 - ACCOUNT_PROJECT_MAX_ALIASES_PER_PROJECT;
    for (const alias of aliases.slice(0, Math.max(0, over))) {
      this.snapshot.aliases.delete(alias.repo_key);
      this.statements.push(this.db.prepare("delete from account_project_aliases where user_id = ? and repo_key = ? and project_id = ?")
        .bind(this.userId, alias.repo_key, project.id));
    }
  }

  setRepoId(project: ProjectRow, repoId: number): void {
    if (project.repo_id === repoId) return;
    project.repo_id = repoId;
    this.touched.add(project.id);
    this.statements.push(this.db.prepare("update account_projects set repo_id = ? where user_id = ? and id = ?")
      .bind(repoId, this.userId, project.id));
  }

  /**
   * `from` and `into` are the same repository. `from` keeps its id as a
   * tombstone pointing at `into`; its addresses and copies move. The merged
   * project is on the account unless the person removed it: a live row beats
   * a removed one only when it was added explicitly after that removal.
   */
  merge(from: ProjectRow, into: ProjectRow): void {
    if (from.id === into.id || from.merged_into) return;
    const live = [from, into].filter((row) => row.removed_at == null);
    const removed = [from, into].filter((row) => row.removed_at != null);
    let removedAt: number | null;
    const explicitAt = Math.max(from.last_explicit_add_at ?? 0, into.last_explicit_add_at ?? 0) || null;
    if (removed.length === 0) removedAt = null;
    else if (live.length === 0) removedAt = Math.max(...removed.map((row) => row.removed_at ?? 0));
    else {
      const liveRow = live[0]!;
      const removedRow = removed[0]!;
      removedAt = (liveRow.last_explicit_add_at ?? 0) > (removedRow.removed_at ?? 0) ? null : removedRow.removed_at;
    }
    for (const alias of this.aliasesOf(from.id)) alias.project_id = into.id;
    for (const copy of this.snapshot.machineCopies.values()) {
      if (copy.project_id === from.id) copy.project_id = into.id;
    }
    from.merged_into = into.id;
    from.removed_at = from.removed_at ?? this.now;
    into.removed_at = removedAt;
    into.last_explicit_add_at = explicitAt;
    if (into.default_branch == null && from.default_branch != null) into.default_branch = from.default_branch;
    this.touched.add(from.id);
    this.touched.add(into.id);
    this.statements.push(
      this.db.prepare("update account_project_aliases set project_id = ? where user_id = ? and project_id = ?")
        .bind(into.id, this.userId, from.id),
      this.db.prepare("update account_project_copies set project_id = ? where user_id = ? and project_id = ?")
        .bind(into.id, this.userId, from.id),
      this.db.prepare(`
        update account_projects set merged_into = ?, removed_at = coalesce(removed_at, ?), updated_at = ?
         where user_id = ? and id = ? and merged_into is null
      `).bind(into.id, this.now, this.now, this.userId, from.id),
      this.db.prepare(`
        update account_projects set removed_at = ?, last_explicit_add_at = ?,
               default_branch = coalesce(default_branch, ?), updated_at = ?
         where user_id = ? and id = ?
      `).bind(removedAt, explicitAt, from.default_branch, this.now, this.userId, into.id),
    );
    this.trimAliases(into);
  }

  /** Facts a client learned from GitHub: the current address and name, the default branch. */
  updateFacts(project: ProjectRow, input: IdentityInput): void {
    const next = {
      repo_key: input.canonicalRepoKey ?? project.repo_key,
      owner: input.canonicalRepoKey ? input.owner : project.owner,
      name: input.canonicalRepoKey ? input.name : project.name,
      default_branch: input.defaultBranch ?? project.default_branch,
    };
    if (
      next.repo_key === project.repo_key && next.owner === project.owner
      && next.name === project.name && next.default_branch === project.default_branch
    ) return;
    Object.assign(project, next);
    this.touched.add(project.id);
    this.statements.push(this.db.prepare(`
      update account_projects set repo_key = ?, owner = ?, name = ?, default_branch = ?, updated_at = ?
       where user_id = ? and id = ?
    `).bind(next.repo_key, next.owner, next.name, next.default_branch, this.now, this.userId, project.id));
  }

  revive(project: ProjectRow): void {
    if (this.liveCount() >= ACCOUNT_PROJECT_MAX_LIVE) throw new AccountProjectLimitError("live_projects");
    project.removed_at = null;
    project.last_explicit_add_at = this.now;
    this.touched.add(project.id);
    this.statements.push(this.db.prepare(`
      update account_projects set removed_at = null, last_explicit_add_at = ?, updated_at = ? where user_id = ? and id = ?
    `).bind(this.now, this.now, this.userId, project.id));
  }

  markExplicitAdd(project: ProjectRow): void {
    project.last_explicit_add_at = this.now;
    this.statements.push(this.db.prepare("update account_projects set last_explicit_add_at = ? where user_id = ? and id = ?")
      .bind(this.now, this.userId, project.id));
  }

  remove(project: ProjectRow): void {
    if (project.removed_at != null) return;
    project.removed_at = this.now;
    this.touched.add(project.id);
    for (const [checkoutId, copy] of this.snapshot.machineCopies) {
      if (copy.project_id === project.id) this.snapshot.machineCopies.delete(checkoutId);
    }
    this.statements.push(
      this.db.prepare("update account_projects set removed_at = ?, updated_at = ? where user_id = ? and id = ?")
        .bind(this.now, this.now, this.userId, project.id),
      // The folders stay on their machines; the account just stops listing them.
      this.db.prepare("delete from account_project_copies where user_id = ? and project_id = ?").bind(this.userId, project.id),
    );
  }

  upsertCopy(machineKey: string, copy: { checkoutId: string; projectId: string; rootPath: string; isMain: boolean }): void {
    const existing = this.snapshot.machineCopies.get(copy.checkoutId);
    const isMain = copy.isMain ? 1 : 0;
    if (existing && existing.project_id === copy.projectId && existing.root_path === copy.rootPath && existing.is_main === isMain) return;
    if (existing) this.touched.add(existing.project_id);
    this.touched.add(copy.projectId);
    this.snapshot.machineCopies.set(copy.checkoutId, {
      machine_key: machineKey,
      checkout_id: copy.checkoutId,
      project_id: copy.projectId,
      root_path: copy.rootPath,
      is_main: isMain,
      last_seen_at: this.now,
    });
    this.statements.push(this.db.prepare(`
      insert into account_project_copies (user_id, machine_key, checkout_id, project_id, root_path, is_main, last_seen_at)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id, machine_key, checkout_id) do update set
        project_id = excluded.project_id, root_path = excluded.root_path,
        is_main = excluded.is_main, last_seen_at = excluded.last_seen_at
    `).bind(this.userId, machineKey, copy.checkoutId, copy.projectId, copy.rootPath, isMain, this.now));
  }

  deleteCopy(machineKey: string, checkoutId: string): void {
    const existing = this.snapshot.machineCopies.get(checkoutId);
    if (!existing) return;
    this.snapshot.machineCopies.delete(checkoutId);
    this.touched.add(existing.project_id);
    this.statements.push(this.db.prepare("delete from account_project_copies where user_id = ? and machine_key = ? and checkout_id = ?")
      .bind(this.userId, machineKey, checkoutId));
  }

  /**
   * The batch: a guard, the account's counter, the changes, the touched
   * projects' `change_seq`, then the fix-ups. The guard fails the whole batch
   * on the state row's primary key when another write moved the counter
   * after our snapshot, so a plan never commits against rows it did not see
   * (a removal, a merge, the live count); `withRetry` plans it again.
   */
  async commit(): Promise<boolean> {
    if (this.statements.length === 0) return false;
    const guard = this.db.prepare(`
      insert into account_project_state (user_id, seq, floor_seq, updated_at)
      select ?, 0, 0, 0 where coalesce(${ACCOUNT_SEQ}, 0) <> ?
    `).bind(this.userId, this.userId, this.snapshot.seq);
    const bump = bumpAccountSeq(this.db, this.userId, this.now);
    const touched = [...this.touched].filter((id) => this.snapshot.projects.has(id));
    const stamps = touched.map((id) => this.db.prepare(`update account_projects set change_seq = ${ACCOUNT_SEQ} where user_id = ? and id = ?`)
      .bind(this.userId, this.userId, id));
    const fixups = [
      // A batch that ran between our read and this one merged a row we wrote to.
      this.db.prepare(`
        update account_project_aliases set project_id = (
          select merged_into from account_projects p where p.id = account_project_aliases.project_id)
         where user_id = ? and project_id in (select id from account_projects where user_id = ? and merged_into is not null)
      `).bind(this.userId, this.userId),
      this.db.prepare(`
        update account_project_copies set project_id = (
          select merged_into from account_projects p where p.id = account_project_copies.project_id)
         where user_id = ? and project_id in (select id from account_projects where user_id = ? and merged_into is not null)
      `).bind(this.userId, this.userId),
      // A removed project lists no copies.
      this.db.prepare(`
        delete from account_project_copies
         where user_id = ? and project_id in (select id from account_projects where user_id = ? and removed_at is not null)
      `).bind(this.userId, this.userId),
      // One main copy per machine and project: the lowest checkout id among the flagged ones stays.
      this.db.prepare(`
        update account_project_copies set is_main = 0
         where user_id = ? and is_main = 1 and exists (
           select 1 from account_project_copies d
            where d.user_id = account_project_copies.user_id
              and d.machine_key = account_project_copies.machine_key
              and d.project_id = account_project_copies.project_id
              and d.is_main = 1 and d.checkout_id < account_project_copies.checkout_id)
      `).bind(this.userId),
    ];
    await this.db.batch([guard, bump, ...this.statements, ...stamps, ...fixups]);
    return true;
  }
}

/** Plans per write: each lost race costs one, and one write of the account wins each round. */
const WRITE_ATTEMPTS = 8;

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      // Another write of the account committed after our snapshot (the
      // guard), or wrote the same address or repository id first: plan again
      // from what it wrote, after a short random wait so racers spread out.
      if (!isUniqueViolation(error) || attempt >= WRITE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// Identity

type Resolution =
  | { kind: "found"; project: ProjectRow }
  | { kind: "missing" };

/**
 * Find the project of one repository, and teach the account what this request
 * knows about it: a repository id for an address-only row, a second address,
 * that two rows are one repository (merge), or that an address now names a
 * different repository (it moves). Never creates.
 */
function resolveIdentity(plan: Plan, input: IdentityInput): Resolution {
  const { snapshot } = plan;
  const keys = identityKeys(input);
  const byKey = keys
    .map((key) => ({ key, project: plan.follow(snapshot.projects.get(snapshot.aliases.get(key)?.project_id ?? "")) }))
    .filter((entry): entry is { key: string; project: ProjectRow } => entry.project !== null);
  const byId = input.repoId == null
    ? null
    : [...snapshot.projects.values()].find((row) =>
      row.merged_into == null && row.host === input.host && row.repo_id === input.repoId) ?? null;

  let target: ProjectRow | null = byId;
  if (!target && input.repoId != null) {
    // An address-only row of this address takes the id.
    target = byKey.find((entry) => entry.project.repo_id == null)?.project ?? null;
    if (target) plan.setRepoId(target, input.repoId);
  }
  if (!target && input.repoId == null) target = byKey[0]?.project ?? null;
  if (!target) {
    return { kind: "missing" };
  }
  for (const { key, project } of byKey) {
    if (project.id === target.id) continue;
    if (project.repo_id == null) plan.merge(project, target);
    // The address names another repository now (a new repository took an old
    // name): it moves to this one, and the other project keeps its other addresses.
    else plan.setAlias(key, target);
  }
  for (const key of keys) plan.setAlias(key, target);
  plan.updateFacts(target, input);
  return { kind: "found", project: target };
}

/** Add, or bring back: an explicit add from a person. */
export async function addProject(
  db: D1Database,
  userId: string,
  input: IdentityInput,
  now: number,
): Promise<{ projectId: string; created: boolean; revived: boolean }> {
  return withRetry(async () => {
    const plan = new Plan(db, userId, await loadSnapshot(db, userId, null), now);
    const found = resolveIdentity(plan, input);
    let created = false;
    let revived = false;
    let project: ProjectRow;
    if (found.kind === "found") {
      project = found.project;
      if (project.removed_at != null) {
        plan.revive(project);
        revived = true;
      } else {
        plan.markExplicitAdd(project);
      }
    } else {
      project = plan.create(input, true);
      created = true;
    }
    await plan.commit();
    return { projectId: project.id, created, revived };
  });
}

export async function removeProject(
  db: D1Database,
  userId: string,
  projectId: string,
  now: number,
): Promise<string | null> {
  return withRetry(async () => {
    const plan = new Plan(db, userId, await loadSnapshot(db, userId, null), now);
    const project = plan.follow(plan.snapshot.projects.get(projectId));
    if (!project) return null;
    plan.remove(project);
    await plan.commit();
    return project.id;
  });
}

export type CopyPlanInput = IdentityInput & {
  checkoutId: string;
  rootPath: string;
  isMain: boolean;
  add: AccountProjectCopyAddMode;
};

/**
 * Replace one machine's copies with `copies`: resolve each copy's project
 * (adding it when the copy says `auto` and the account has no such project),
 * record the copies of live projects, and delete the machine's copies it no
 * longer sends.
 */
export async function replaceMachineCopies(
  db: D1Database,
  userId: string,
  machineKey: string,
  copies: CopyPlanInput[],
  now: number,
): Promise<AccountProjectCopyResult[]> {
  return withRetry(async () => {
    const plan = new Plan(db, userId, await loadSnapshot(db, userId, machineKey), now);
    const results: AccountProjectCopyResult[] = [];
    const planned: Array<{ checkoutId: string; projectId: string; rootPath: string; isMain: boolean }> = [];
    let room = ACCOUNT_PROJECT_MAX_COPIES - plan.snapshot.otherCopyCount;
    for (const copy of copies) {
      let resolution = resolveIdentity(plan, copy);
      if (resolution.kind === "missing" && copy.add === "auto") {
        try {
          resolution = { kind: "found", project: plan.create(copy, false) };
        } catch (error) {
          if (!(error instanceof AccountProjectLimitError)) throw error;
          results.push({ checkoutId: copy.checkoutId, status: "limit", projectId: null, isMain: false });
          continue;
        }
      }
      if (resolution.kind === "missing") {
        results.push({ checkoutId: copy.checkoutId, status: "not_on_account", projectId: null, isMain: false });
        continue;
      }
      if (resolution.project.removed_at != null) {
        results.push({ checkoutId: copy.checkoutId, status: "removed", projectId: resolution.project.id, isMain: false });
        continue;
      }
      if (room <= 0) {
        results.push({ checkoutId: copy.checkoutId, status: "limit", projectId: resolution.project.id, isMain: false });
        continue;
      }
      room -= 1;
      planned.push({ checkoutId: copy.checkoutId, projectId: resolution.project.id, rootPath: copy.rootPath, isMain: copy.isMain });
    }
    // A later copy can merge an earlier copy's project into another one (a
    // removed one, too): record each copy under the project it ends on.
    const recorded: typeof planned = [];
    for (const copy of planned) {
      const project = plan.follow(plan.snapshot.projects.get(copy.projectId));
      if (project?.removed_at != null) {
        results.push({ checkoutId: copy.checkoutId, status: "removed", projectId: project.id, isMain: false });
        continue;
      }
      recorded.push({ ...copy, projectId: project?.id ?? copy.projectId });
    }
    // Exactly one main copy per project on this machine: the first one the
    // machine flagged (by checkout id), or the first copy when none is.
    const mainByProject = new Map<string, string>();
    const byId = [...recorded].sort(byCheckoutId);
    for (const copy of byId) {
      if (copy.isMain && !mainByProject.has(copy.projectId)) mainByProject.set(copy.projectId, copy.checkoutId);
    }
    for (const copy of byId) {
      if (!mainByProject.has(copy.projectId)) mainByProject.set(copy.projectId, copy.checkoutId);
    }
    const kept = new Set<string>();
    for (const copy of recorded) {
      const isMain = mainByProject.get(copy.projectId) === copy.checkoutId;
      kept.add(copy.checkoutId);
      plan.upsertCopy(machineKey, { ...copy, isMain });
      results.push({ checkoutId: copy.checkoutId, status: "linked", projectId: copy.projectId, isMain });
    }
    for (const checkoutId of [...plan.snapshot.machineCopies.keys()]) {
      if (!kept.has(checkoutId)) plan.deleteCopy(machineKey, checkoutId);
    }
    await plan.commit();
    const order = new Map(copies.map((copy, index) => [copy.checkoutId, index]));
    return results.sort((left, right) => (order.get(left.checkoutId) ?? 0) - (order.get(right.checkoutId) ?? 0));
  });
}

// ---------------------------------------------------------------------------
// Reads

function copyView(row: CopyRow): AccountProjectCopyView {
  return {
    projectId: row.project_id,
    machineKey: row.machine_key,
    checkoutId: row.checkout_id,
    rootPath: row.root_path,
    isMain: row.is_main === 1,
    lastSeenAt: row.last_seen_at,
  };
}

function projectView(row: ProjectRow, aliases: string[], copies: AccountProjectCopyView[]): AccountProjectView {
  return {
    id: row.id,
    host: row.host,
    repoId: row.repo_id,
    repoKey: row.repo_key,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    addedAt: row.added_at,
    removedAt: row.removed_at,
    mergedInto: row.merged_into,
    aliases: aliases.sort(),
    copies: copies.sort((left, right) =>
      left.machineKey.localeCompare(right.machineKey) || left.checkoutId.localeCompare(right.checkoutId)),
  };
}

/**
 * Projects that changed after `since`, read in one batch (one transaction, so
 * the cursor and the rows agree). `since` null, older than the floor (as the
 * batch sees it), or newer than the account's counter gives the whole list.
 */
export async function listProjects(
  db: D1Database,
  userId: string,
  since: number | null,
): Promise<{ cursor: number; reset: boolean; projects: AccountProjectView[] }> {
  const state = await db.prepare("select seq, floor_seq from account_project_state where user_id = ?")
    .bind(userId).first<{ seq: number; floor_seq: number }>();
  const seq = state?.seq ?? 0;
  const floor = state?.floor_seq ?? 0;
  const reset = since == null || since < floor || since > seq;
  const after = reset ? -1 : since;
  const [projects, aliases, copies, current] = await db.batch([
    db.prepare(`select ${PROJECT_COLUMNS} from account_projects where user_id = ? and change_seq > ? order by change_seq, id`)
      .bind(userId, after),
    db.prepare(`
      select a.repo_key, a.project_id, a.created_at from account_project_aliases a
        join account_projects p on p.id = a.project_id
       where a.user_id = ? and p.user_id = ? and p.change_seq > ?
    `).bind(userId, userId, after),
    db.prepare(`
      select c.machine_key, c.checkout_id, c.project_id, c.root_path, c.is_main, c.last_seen_at
        from account_project_copies c join account_projects p on p.id = c.project_id
        ${ON_ACCOUNT_MACHINE}
       where c.user_id = ? and p.user_id = ? and p.change_seq > ?
    `).bind(userId, userId, after),
    db.prepare("select seq, floor_seq from account_project_state where user_id = ?").bind(userId),
  ]);
  const currentState = (current?.results?.[0] ?? null) as { seq: number; floor_seq: number } | null;
  // A purge between the first read and this batch raised the floor past
  // `since`: a delta would miss the purged rows, so answer the whole list.
  if (!reset && after < Number(currentState?.floor_seq ?? 0)) return listProjects(db, userId, null);
  const aliasesByProject = new Map<string, string[]>();
  for (const alias of (aliases?.results ?? []) as AliasRow[]) {
    aliasesByProject.set(alias.project_id, [...(aliasesByProject.get(alias.project_id) ?? []), alias.repo_key]);
  }
  const copiesByProject = new Map<string, AccountProjectCopyView[]>();
  for (const copy of (copies?.results ?? []) as CopyRow[]) {
    copiesByProject.set(copy.project_id, [...(copiesByProject.get(copy.project_id) ?? []), copyView(copy)]);
  }
  const cursor = Number(currentState?.seq ?? seq);
  return {
    cursor,
    reset,
    projects: ((projects?.results ?? []) as ProjectRow[]).map((row) =>
      projectView(row, aliasesByProject.get(row.id) ?? [], copiesByProject.get(row.id) ?? [])),
  };
}

export async function readProject(db: D1Database, userId: string, projectId: string): Promise<AccountProjectView | null> {
  const [project, aliases, copies] = await db.batch([
    db.prepare(`select ${PROJECT_COLUMNS} from account_projects where user_id = ? and id = ?`).bind(userId, projectId),
    db.prepare("select repo_key, project_id, created_at from account_project_aliases where user_id = ? and project_id = ?")
      .bind(userId, projectId),
    db.prepare(`
      select c.machine_key, c.checkout_id, c.project_id, c.root_path, c.is_main, c.last_seen_at
        from account_project_copies c ${ON_ACCOUNT_MACHINE}
       where c.user_id = ? and c.project_id = ?
    `).bind(userId, projectId),
  ]);
  const row = (project?.results?.[0] ?? null) as ProjectRow | null;
  if (!row) return null;
  return projectView(
    row,
    ((aliases?.results ?? []) as AliasRow[]).map((alias) => alias.repo_key),
    ((copies?.results ?? []) as CopyRow[]).map(copyView),
  );
}

/** The account's change counter, for the heartbeat answer. 0 for an account with no list yet. */
export async function readAccountProjectsCursor(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare("select seq from account_project_state where user_id = ?").bind(userId).first<{ seq: number }>();
  return row?.seq ?? 0;
}

/**
 * A machine left the account (removed, or its key was replaced): its copies
 * go, and the projects they belonged to count as changed so every client
 * reads them again. One batch; nothing happens when the machines had none.
 */
export async function deleteMachineCopies(db: D1Database, userId: string, machineKeys: readonly string[], now: number): Promise<number> {
  const keys = [...new Set(machineKeys)].filter(Boolean);
  if (keys.length === 0) return 0;
  const marks = keys.map(() => "?").join(", ");
  const held = await db.prepare(`select count(*) as count from account_project_copies where user_id = ? and machine_key in (${marks})`)
    .bind(userId, ...keys).first<{ count: number }>();
  const count = Number(held?.count ?? 0);
  if (count === 0) return 0;
  await db.batch([
    bumpAccountSeq(db, userId, now),
    db.prepare(`
      update account_projects set change_seq = ${ACCOUNT_SEQ}
       where user_id = ? and id in (
         select project_id from account_project_copies where user_id = ? and machine_key in (${marks}))
    `).bind(userId, userId, userId, ...keys),
    db.prepare(`delete from account_project_copies where user_id = ? and machine_key in (${marks})`).bind(userId, ...keys),
  ]);
  return count;
}

/** Clerk `user.deleted`: every row of the account goes. Safe to repeat. */
export async function deleteAccountProjects(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("delete from account_project_copies where user_id = ?").bind(userId),
    db.prepare("delete from account_project_aliases where user_id = ?").bind(userId),
    db.prepare("delete from account_projects where user_id = ?").bind(userId),
    db.prepare("delete from account_project_state where user_id = ?").bind(userId),
  ]);
}
