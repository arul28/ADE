/**
 * GitHub activity for the Usage page: commits, pull requests, and the code
 * movement inside them.
 *
 * Lifted out of `usageTrackingService.ts` — which was approaching four thousand
 * lines — because this is the one part of it that talks to something outside
 * the machine. It shells out to `gh`, parses what comes back, and is otherwise
 * unrelated to ledger scanning, provider quota polling, or the account rollup;
 * the service consumes it through `scanGithubActivityStats` and merges the
 * result into the daily series itself.
 *
 * Everything here fails soft. A machine with no `gh`, no auth, or no remote is
 * the common case, not an error state, so every path returns an empty stats
 * object carrying a sentence about why rather than throwing into the page.
 */
import { spawn } from "node:child_process";
import { isRecord, nowIso, getErrorMessage, safeJsonParse } from "../shared/utils";
import { localDayKey } from "./localDay";

/**
 * The window to report on.
 *
 * Structural rather than an import of the service's `ResolvedAdeUsageRange`:
 * this module needs two ISO bounds and nothing else, and taking the type by
 * shape keeps the dependency one-way — the service imports this, never the
 * reverse.
 */
export type GithubActivityRange = {
  since: string | null;
  until: string;
  /**
   * Carried by the service's resolved range and accepted so one can be passed
   * straight through, but never read here — which preset produced the bounds is
   * the page's business, not this module's.
   */
  preset?: string;
};

/** A `gh` call that hangs must not hold the Usage page open indefinitely. */
const GITHUB_STATS_COMMAND_TIMEOUT_MS = 60_000;
/** A repo with tens of thousands of PRs must not be read into memory whole. */
const GITHUB_STATS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function toFiniteNumber(value: unknown): number {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toNonNegativeInt(value: unknown): number {
  return Math.max(0, Math.floor(toFiniteNumber(value)));
}

export type GitHubDailyPoint = {
  date: string;
  commits: number;
  prs: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
};

export type GitHubActivityStats = {
  repo: string | null;
  available: boolean;
  fetchedAt: string | null;
  error: string | null;
  commitsCreated: number;
  prsTracked: number;
  prsOpen: number;
  prsMerged: number;
  prsClosed: number;
  prAdditions: number;
  prDeletions: number;
  filesChanged: number;
  daily: GitHubDailyPoint[];
};

export type GitHubPullRequestRow = {
  number?: number;
  state?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  author?: { login?: string | null } | null;
};

export const EMPTY_GITHUB_STATS: GitHubActivityStats = {
  repo: null,
  available: false,
  fetchedAt: null,
  error: null,
  commitsCreated: 0,
  prsTracked: 0,
  prsOpen: 0,
  prsMerged: 0,
  prsClosed: 0,
  prAdditions: 0,
  prDeletions: 0,
  filesChanged: 0,
  daily: [],
};

export function makeEmptyGithubStats(error: string | null = null, repo: string | null = null): GitHubActivityStats {
  return {
    ...EMPTY_GITHUB_STATS,
    repo,
    error,
  };
}

export function runBufferedCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const maxOutputBytes = options.maxOutputBytes ?? GITHUB_STATS_MAX_OUTPUT_BYTES;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`${command} timed out`)));
    }, options.timeoutMs ?? GITHUB_STATS_COMMAND_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`${command} produced too much output`)));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
      });
    });
  });
}

function parseGithubRepoJson(raw: string): string | null {
  const parsed = safeJsonParse<unknown>(raw.trim(), null);
  if (!isRecord(parsed)) return null;
  const owner = isRecord(parsed.owner) ? parsed.owner.login : parsed.owner;
  const name = parsed.name;
  if (typeof owner !== "string" || typeof name !== "string" || !owner || !name) return null;
  return `${owner}/${name}`;
}

function parseGithubViewerLogin(raw: string): string | null {
  const parsed = safeJsonParse<unknown>(raw.trim(), null);
  if (!isRecord(parsed) || typeof parsed.login !== "string" || !parsed.login.trim()) return null;
  return parsed.login.trim();
}

function parseGithubCommitDates(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t")[1] ?? "")
    .filter((date) => Number.isFinite(Date.parse(date)));
}

function timestampInRange(value: string | null | undefined, range: GithubActivityRange): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  if (range.since && timestamp < Date.parse(range.since)) return false;
  return timestamp <= Date.parse(range.until);
}

function githubCommitDateArgs(range: GithubActivityRange): string[] {
  const args: string[] = [];
  if (range.since) args.push("-F", `since=${range.since}`);
  args.push("-F", `until=${range.until}`);
  return args;
}

function githubRepoParts(repo: string): { owner: string; name: string } | null {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) return null;
  return { owner, name };
}

function githubPullRequestGraphqlQuery(): string {
  return [
    "query($owner: String!, $name: String!, $endCursor: String) {",
    "  repository(owner: $owner, name: $name) {",
    "    pullRequests(first: 100, after: $endCursor, orderBy: { field: UPDATED_AT, direction: DESC }) {",
    "      pageInfo { hasNextPage endCursor }",
    "      nodes {",
    "        number state createdAt updatedAt closedAt mergedAt additions deletions changedFiles",
    "        author { login }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
}

function dateKeyFromIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return localDayKey(timestamp) || null;
}

export type GithubCommandRunner = typeof runBufferedCommand;

export async function scanGithubPullRequestPages({
  projectRoot,
  repoParts,
  viewer,
  range,
  runCommand = runBufferedCommand,
}: {
  projectRoot: string;
  repoParts: { owner: string; name: string };
  viewer: string;
  range: GithubActivityRange;
  runCommand?: GithubCommandRunner;
}): Promise<GitHubPullRequestRow[]> {
  const rows: GitHubPullRequestRow[] = [];
  let endCursor: string | null = null;
  do {
    const raw = await runCommand(
      "gh",
      [
        "api",
        "graphql",
        "-F",
        `owner=${repoParts.owner}`,
        "-F",
        `name=${repoParts.name}`,
        ...(endCursor ? ["-F", `endCursor=${endCursor}`] : []),
        "-f",
        `query=${githubPullRequestGraphqlQuery()}`,
        "--jq",
        ".data.repository.pullRequests",
      ],
      { cwd: projectRoot },
    );
    const page = safeJsonParse<unknown>(raw.trim(), null);
    if (!isRecord(page)) break;
    const nodes = Array.isArray(page.nodes)
      ? page.nodes.filter(isRecord) as GitHubPullRequestRow[]
      : [];
    rows.push(...nodes.filter((row) => isRecord(row.author) && row.author.login === viewer));

    const oldestUpdatedAt = nodes
      .map((row) => typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : Number.NaN)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (range.since && oldestUpdatedAt != null && oldestUpdatedAt < Date.parse(range.since)) break;

    const pageInfo = isRecord(page.pageInfo) ? page.pageInfo : null;
    const hasNextPage = pageInfo?.hasNextPage === true;
    endCursor = hasNextPage && typeof pageInfo?.endCursor === "string" && pageInfo.endCursor
      ? pageInfo.endCursor
      : null;
  } while (endCursor);
  return rows;
}

function addGithubDaily(
  byDate: Map<string, GitHubDailyPoint>,
  date: string | null,
  patch: Partial<Omit<GitHubDailyPoint, "date">>,
): void {
  if (!date) return;
  const point = byDate.get(date) ?? {
    date,
    commits: 0,
    prs: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
  };
  point.commits += toNonNegativeInt(patch.commits);
  point.prs += toNonNegativeInt(patch.prs);
  point.insertions += toNonNegativeInt(patch.insertions);
  point.deletions += toNonNegativeInt(patch.deletions);
  point.filesChanged += toNonNegativeInt(patch.filesChanged);
  byDate.set(date, point);
}

export async function scanGithubActivityStats(projectRoot: string | null | undefined, range: GithubActivityRange): Promise<GitHubActivityStats> {
  if (!projectRoot) return makeEmptyGithubStats("No project root is available.");
  try {
    const repoRaw = await runBufferedCommand("gh", ["repo", "view", "--json", "owner,name"], {
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    const repo = parseGithubRepoJson(repoRaw);
    if (!repo) return makeEmptyGithubStats("Unable to resolve the GitHub repository.", null);

    const viewerRaw = await runBufferedCommand("gh", ["api", "user", "--cache", "10m"], {
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    const viewer = parseGithubViewerLogin(viewerRaw);
    if (!viewer) return makeEmptyGithubStats("Unable to resolve the GitHub user.", repo);
    const repoParts = githubRepoParts(repo);
    if (!repoParts) return makeEmptyGithubStats("Unable to resolve the GitHub repository.", repo);

    const [prs, commitRaw] = await Promise.all([
      scanGithubPullRequestPages({ projectRoot, repoParts, viewer, range }),
      runBufferedCommand(
        "gh",
        [
          "api",
          `repos/${repo}/commits`,
          "--method",
          "GET",
          "--cache",
          "10m",
          "-F",
          `author=${viewer}`,
          ...githubCommitDateArgs(range),
          "--paginate",
          "--jq",
          ".[] | [.sha, .commit.author.date] | @tsv",
        ],
        { cwd: projectRoot },
      ),
    ]);

    const dailyByDate = new Map<string, GitHubDailyPoint>();
    const mergedPrs = prs.filter((pr) => timestampInRange(pr.mergedAt, range));
    const closedPrs = prs.filter((pr) => timestampInRange(pr.closedAt, range));
    const prsCreatedInRange = prs.filter((pr) => timestampInRange(pr.createdAt, range));
    const commitsInRange = parseGithubCommitDates(commitRaw).filter((date) => timestampInRange(date, range));
    for (const date of commitsInRange) {
      addGithubDaily(dailyByDate, dateKeyFromIso(date), { commits: 1 });
    }

    for (const pr of prsCreatedInRange) {
      addGithubDaily(dailyByDate, dateKeyFromIso(pr.createdAt), {
        prs: 1,
      });
    }

    for (const pr of mergedPrs) {
      addGithubDaily(dailyByDate, dateKeyFromIso(pr.mergedAt), {
        insertions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        filesChanged: pr.changedFiles ?? 0,
      });
    }

    const prsMerged = mergedPrs.length;
    const prsClosed = closedPrs.filter((pr) => String(pr.state ?? "").toUpperCase() === "CLOSED").length;
    return {
      repo,
      available: true,
      fetchedAt: nowIso(),
      error: null,
      commitsCreated: commitsInRange.length,
      prsTracked: prsCreatedInRange.length,
      prsOpen: prsCreatedInRange.filter((pr) => String(pr.state ?? "").toUpperCase() === "OPEN").length,
      prsMerged,
      prsClosed,
      prAdditions: mergedPrs.reduce((sum, pr) => sum + toNonNegativeInt(pr.additions), 0),
      prDeletions: mergedPrs.reduce((sum, pr) => sum + toNonNegativeInt(pr.deletions), 0),
      filesChanged: mergedPrs.reduce((sum, pr) => sum + toNonNegativeInt(pr.changedFiles), 0),
      daily: Array.from(dailyByDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
    };
  } catch (error) {
    return makeEmptyGithubStats(getErrorMessage(error), null);
  }
}
