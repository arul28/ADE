import type { GithubService } from "../github/githubService";
import type { AdeDb } from "../state/kvDb";
import { asNumber, asString, getErrorMessage, isRecord, nowIso } from "../shared/utils";
import type { GitHubRepoRef } from "../../../shared/types/git";
import type {
  GitHubPrStack,
  GitHubPrStackMembership,
} from "../../../shared/types/prs";

type GitHubPrStackRow = {
  project_id: string;
  repo_owner: string;
  repo_name: string;
  github_stack_number: number;
  github_stack_id: string;
  github_node_id: string | null;
  base_branch: string;
  is_open: number;
  created_at: string;
  synced_at: string;
  last_error: string | null;
};

type GitHubPrStackEntryRow = {
  project_id: string;
  repo_owner: string;
  repo_name: string;
  github_stack_number: number;
  github_pr_number: number;
  position: number;
  state: string;
  is_draft: number;
  merged_at: string | null;
  head_branch: string;
  head_sha: string;
};

type GithubStackStoreLogger = {
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

type DecodedGithubStack = {
  row: GitHubPrStackRow;
  entries: GitHubPrStackEntryRow[];
};

function repoKey(repo: GitHubRepoRef): string {
  return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
}

function repoPrKey(owner: string, name: string, prNumber: number): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}#${prNumber}`;
}

function stackKey(owner: string, name: string, stackNumber: number): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}#${stackNumber}`;
}

function stackFromRows(
  row: GitHubPrStackRow,
  entries: GitHubPrStackEntryRow[],
): GitHubPrStack {
  return {
    id: row.github_stack_id,
    number: Number(row.github_stack_number),
    nodeId: row.github_node_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    baseBranch: row.base_branch,
    open: Number(row.is_open) !== 0,
    createdAt: row.created_at,
    syncedAt: row.synced_at,
    lastError: row.last_error,
    entries: [...entries]
      .sort((left, right) => Number(left.position) - Number(right.position))
      .map((entry) => ({
        githubPrNumber: Number(entry.github_pr_number),
        position: Number(entry.position),
        state: entry.state === "closed" ? "closed" : "open",
        isDraft: Number(entry.is_draft) !== 0,
        mergedAt: entry.merged_at,
        headBranch: entry.head_branch,
        headSha: entry.head_sha,
      })),
  };
}

export function createGithubStackStore(args: {
  db: AdeDb;
  projectId: string;
  githubService: GithubService;
  logger: GithubStackStoreLogger;
  onSnapshotChanged: () => void;
  onReconciled: () => void;
}) {
  const { db, githubService, logger, projectId } = args;
  const reconcileInFlight = new Map<string, Promise<GitHubPrStack>>();
  const reconcileDirty = new Set<string>();
  const repositoryReconcileInFlight = new Map<string, Promise<GitHubPrStack[]>>();
  const repoMutationTails = new Map<string, Promise<void>>();

  const withRepoMutationLock = async <T>(
    repo: GitHubRepoRef,
    mutation: () => Promise<T>,
  ): Promise<T> => {
    const key = repoKey(repo);
    const previous = repoMutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    repoMutationTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await mutation();
    } finally {
      release();
      if (repoMutationTails.get(key) === tail) repoMutationTails.delete(key);
    }
  };

  const parseMembership = (raw: unknown): GitHubPrStackMembership | null => {
    if (!isRecord(raw)) return null;
    const base = isRecord(raw.base) ? raw.base : {};
    const id = String(raw.id ?? "").trim();
    const number = asNumber(raw.number);
    const size = asNumber(raw.size);
    const position = asNumber(raw.position);
    const baseBranch = asString(base.ref).trim();
    if (!id || number <= 0 || size <= 0 || position <= 0 || !baseBranch) return null;
    return {
      id,
      number,
      size,
      position,
      baseBranch,
    };
  };

  const list = (repo?: GitHubRepoRef | null): GitHubPrStack[] => {
    const params: Array<string | number> = [projectId];
    const repoWhere = repo
      ? "and lower(repo_owner) = lower(?) and lower(repo_name) = lower(?)"
      : "";
    if (repo) params.push(repo.owner, repo.name);
    const rows = db.all<GitHubPrStackRow>(
      `select *
         from github_pr_stacks
        where project_id = ?
          ${repoWhere}
        order by github_stack_number desc`,
      params,
    );
    if (rows.length === 0) return [];
    const entries = db.all<GitHubPrStackEntryRow>(
      `select *
         from github_pr_stack_entries
        where project_id = ?
          ${repoWhere}
        order by github_stack_number desc, position asc`,
      params,
    );
    const entriesByStack = new Map<string, GitHubPrStackEntryRow[]>();
    for (const entry of entries) {
      const key = stackKey(entry.repo_owner, entry.repo_name, Number(entry.github_stack_number));
      const stackEntries = entriesByStack.get(key) ?? [];
      stackEntries.push(entry);
      entriesByStack.set(key, stackEntries);
    }
    return rows.map((row) => stackFromRows(
      row,
      entriesByStack.get(stackKey(row.repo_owner, row.repo_name, Number(row.github_stack_number))) ?? [],
    ));
  };

  const membershipsByPr = (repo?: GitHubRepoRef | null): Map<string, GitHubPrStackMembership> => {
    const memberships = new Map<string, GitHubPrStackMembership>();
    for (const stack of list(repo)) {
      const size = stack.entries.length;
      for (const entry of stack.entries) {
        memberships.set(
          repoPrKey(stack.repoOwner, stack.repoName, entry.githubPrNumber),
          {
            id: stack.id,
            number: stack.number,
            size,
            position: entry.position,
            baseBranch: stack.baseBranch,
          },
        );
      }
    }
    return memberships;
  };

  const decode = (repo: GitHubRepoRef, rawStack: unknown): DecodedGithubStack => {
    if (!isRecord(rawStack)) throw new Error("GitHub returned an invalid stack.");
    const stackNumber = asNumber(rawStack.number);
    const stackId = String(rawStack.id ?? "").trim();
    const base = isRecord(rawStack.base) ? rawStack.base : {};
    const baseBranch = asString(base.ref).trim();
    const rawEntries = Array.isArray(rawStack.pull_requests) ? rawStack.pull_requests : [];
    if (stackNumber <= 0 || !stackId || !baseBranch) {
      throw new Error("GitHub returned incomplete stack identity.");
    }
    const syncedAt = nowIso();
    const createdAt = asString(rawStack.created_at).trim() || syncedAt;
    const seenPrNumbers = new Set<number>();
    const entries: GitHubPrStackEntryRow[] = rawEntries.map((rawEntry, index) => {
      const entry = isRecord(rawEntry) ? rawEntry : {};
      const head = isRecord(entry.head) ? entry.head : {};
      const githubPrNumber = asNumber(entry.number);
      const state = asString(entry.state).trim().toLowerCase();
      const headBranch = asString(head.ref).trim();
      const headSha = asString(head.sha).trim();
      if (githubPrNumber <= 0 || seenPrNumbers.has(githubPrNumber)) {
        throw new Error(`GitHub stack #${stackNumber} contains an invalid pull request entry.`);
      }
      if ((state !== "open" && state !== "closed") || !headBranch || !headSha) {
        throw new Error(`GitHub stack #${stackNumber} contains an incomplete pull request entry.`);
      }
      seenPrNumbers.add(githubPrNumber);
      return {
        project_id: projectId,
        repo_owner: repo.owner,
        repo_name: repo.name,
        github_stack_number: stackNumber,
        github_pr_number: githubPrNumber,
        position: index + 1,
        state,
        is_draft: entry.draft === true ? 1 : 0,
        merged_at: asString(entry.merged_at).trim() || null,
        head_branch: headBranch,
        head_sha: headSha,
      };
    });
    return {
      row: {
        project_id: projectId,
        repo_owner: repo.owner,
        repo_name: repo.name,
        github_stack_number: stackNumber,
        github_stack_id: stackId,
        github_node_id: asString(rawStack.node_id).trim() || null,
        base_branch: baseBranch,
        is_open: rawStack.open === false ? 0 : 1,
        created_at: createdAt,
        synced_at: syncedAt,
        last_error: null,
      },
      entries,
    };
  };

  const writeDecoded = (stack: DecodedGithubStack): void => {
    const { row, entries } = stack;
    db.run(
      `insert into github_pr_stacks(
           project_id, repo_owner, repo_name, github_stack_number,
           github_stack_id, github_node_id, base_branch, is_open,
           created_at, synced_at, last_error
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
         on conflict(project_id, repo_owner, repo_name, github_stack_number) do update set
           github_stack_id = excluded.github_stack_id,
           github_node_id = excluded.github_node_id,
           base_branch = excluded.base_branch,
           is_open = excluded.is_open,
           created_at = excluded.created_at,
           synced_at = excluded.synced_at,
           last_error = null`,
      [
        row.project_id,
        row.repo_owner,
        row.repo_name,
        row.github_stack_number,
        row.github_stack_id,
        row.github_node_id,
        row.base_branch,
        row.is_open,
        row.created_at,
        row.synced_at,
      ],
    );
    db.run(
      `delete from github_pr_stack_entries
        where project_id = ?
          and lower(repo_owner) = lower(?)
          and lower(repo_name) = lower(?)
          and github_stack_number = ?`,
      [projectId, row.repo_owner, row.repo_name, row.github_stack_number],
    );
    for (const entry of entries) {
      db.run(
        `delete from github_pr_stack_entries
          where project_id = ?
            and lower(repo_owner) = lower(?)
            and lower(repo_name) = lower(?)
            and github_pr_number = ?
            and github_stack_number <> ?`,
        [
          projectId,
          entry.repo_owner,
          entry.repo_name,
          entry.github_pr_number,
          entry.github_stack_number,
        ],
      );
      db.run(
        `insert into github_pr_stack_entries(
             project_id, repo_owner, repo_name, github_stack_number,
             github_pr_number, position, state, is_draft, merged_at,
             head_branch, head_sha
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.project_id,
            entry.repo_owner,
            entry.repo_name,
            entry.github_stack_number,
            entry.github_pr_number,
            entry.position,
            entry.state,
            entry.is_draft,
            entry.merged_at,
            entry.head_branch,
            entry.head_sha,
          ],
      );
    }
  };

  const replace = (repo: GitHubRepoRef, rawStack: unknown): GitHubPrStack => {
    const decoded = decode(repo, rawStack);
    db.run("begin immediate");
    try {
      writeDecoded(decoded);
      db.run("commit");
    } catch (error) {
      try {
        db.run("rollback");
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
    args.onSnapshotChanged();
    return stackFromRows(decoded.row, decoded.entries);
  };

  const reconcile = async (
    repo: GitHubRepoRef,
    stackNumber: number,
  ): Promise<GitHubPrStack> => {
    const key = `${repoKey(repo)}#${stackNumber}`;
    const existing = reconcileInFlight.get(key);
    if (existing) {
      reconcileDirty.add(key);
      return existing.then(async (stack) => {
        if (!reconcileDirty.delete(key)) return stack;
        return await reconcile(repo, stackNumber);
      });
    }
    let request!: Promise<GitHubPrStack>;
    request = withRepoMutationLock(repo, async () => {
      try {
        const { data } = await githubService.apiRequest<unknown>({
          method: "GET",
          path: `/repos/${repo.owner}/${repo.name}/stacks/${stackNumber}`,
        });
        return replace(repo, data);
      } catch (error) {
        db.run(
          `update github_pr_stacks
              set last_error = ?, synced_at = ?
            where project_id = ?
              and lower(repo_owner) = lower(?)
              and lower(repo_name) = lower(?)
              and github_stack_number = ?`,
          [getErrorMessage(error), nowIso(), projectId, repo.owner, repo.name, stackNumber],
        );
        throw error;
      }
    })
      .finally(() => {
        if (reconcileInFlight.get(key) === request) reconcileInFlight.delete(key);
      });
    reconcileInFlight.set(key, request);
    return request;
  };

  const reconcileRepository = async (
    repo: GitHubRepoRef,
    options: { notifySnapshotChanged?: boolean } = {},
  ): Promise<GitHubPrStack[]> => {
    const key = repoKey(repo);
    const existing = repositoryReconcileInFlight.get(key);
    if (existing) return existing;
    let request!: Promise<GitHubPrStack[]>;
    request = withRepoMutationLock(repo, async () => {
      const rawStacks: unknown[] = [];
      const maxPages = 100;
      for (let page = 1; page <= maxPages; page += 1) {
        const { data, linkHeader } = await githubService.apiRequest<unknown[]>({
          method: "GET",
          path: `/repos/${repo.owner}/${repo.name}/stacks`,
          query: { per_page: 100, page },
        });
        rawStacks.push(...(Array.isArray(data) ? data : []));
        if (!githubService.parseNextLink(linkHeader ?? null)) break;
        if (page === maxPages) {
          throw new Error(`GitHub stack list exceeded the ${maxPages}-page safety limit.`);
        }
      }
      const decodedStacks = rawStacks.map((rawStack) => decode(repo, rawStack));
      const seenPrNumbers = new Set<number>();
      for (const stack of decodedStacks) {
        for (const entry of stack.entries) {
          if (seenPrNumbers.has(entry.github_pr_number)) {
            throw new Error(
              `GitHub returned pull request #${entry.github_pr_number} in more than one stack.`,
            );
          }
          seenPrNumbers.add(entry.github_pr_number);
        }
      }
      db.run("begin immediate");
      try {
        db.run(
          `delete from github_pr_stacks
            where project_id = ?
              and lower(repo_owner) = lower(?)
              and lower(repo_name) = lower(?)`,
          [projectId, repo.owner, repo.name],
        );
        for (const stack of decodedStacks) writeDecoded(stack);
        db.run("commit");
      } catch (error) {
        try {
          db.run("rollback");
        } catch {
          // Preserve the original persistence error.
        }
        throw error;
      }
      if (options.notifySnapshotChanged !== false) args.onSnapshotChanged();
      return decodedStacks.map((stack) => stackFromRows(stack.row, stack.entries));
    }).finally(() => {
      if (repositoryReconcileInFlight.get(key) === request) {
        repositoryReconcileInFlight.delete(key);
      }
    });
    repositoryReconcileInFlight.set(key, request);
    return request;
  };

  const scheduleReconcile = (repo: GitHubRepoRef, stackNumber: number): void => {
    void reconcile(repo, stackNumber).then(() => {
      args.onReconciled();
    }).catch((error) => {
      logger.warn("prs.github_stack_reconcile_failed", {
        repo: `${repo.owner}/${repo.name}`,
        stackNumber,
        error: getErrorMessage(error),
      });
    });
  };

  const knownStackNumberForPr = (
    repo: GitHubRepoRef,
    githubPrNumber: number,
  ): number | null => {
    const row = db.get<{ github_stack_number: number }>(
      `select github_stack_number
         from github_pr_stack_entries
        where project_id = ?
          and lower(repo_owner) = lower(?)
          and lower(repo_name) = lower(?)
          and github_pr_number = ?
        limit 1`,
      [projectId, repo.owner, repo.name, githubPrNumber],
    );
    return row ? Number(row.github_stack_number) : null;
  };

  return {
    knownStackNumberForPr,
    list,
    membershipsByPr,
    parseMembership,
    reconcile,
    reconcileRepository,
    scheduleReconcile,
  };
}
