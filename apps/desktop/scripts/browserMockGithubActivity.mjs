/**
 * The GitHub part of the browser mock snapshot
 * (export-browser-mock-ade-snapshot.mjs): the viewer's pull requests and
 * commit dates in the project's repository, fetched once for every stats
 * preset, under one deadline.
 *
 * On an ADE Cloud computer each `gh` run first waits on ADE's GitHub token,
 * and this repository has thousands of pull requests, so the fetch must never
 * hold the export: it stops at the deadline and keeps what arrived.
 */
import { execFile, spawn } from "node:child_process";

/** One overall budget for every GitHub call. */
export const GITHUB_STATS_DEADLINE_MS = 30_000;

const PROGRESS_EVERY_MS = 5_000;

function runGh(args, cwd, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * Runs a paginated `gh` call and hands each output line to `onLine` as pages
 * arrive. Resolves true when gh finished, false when `signal` stopped it
 * first (the lines so far stay usable); rejects when gh itself failed.
 */
function streamGhLines(args, cwd, signal, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
    let pending = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trim());
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on("error", (error) => (signal.aborted ? resolve(false) : reject(error)));
    child.on("close", (code) => {
      if (signal.aborted) return resolve(false);
      if (pending.trim()) onLine(pending.trim());
      if (code === 0) resolve(true);
      else reject(new Error(stderr.trim().split("\n")[0] || `gh exited with ${code}`));
    });
  });
}

/** Pull requests by last update: every one created, merged or closed after a time was updated after it. */
const PULL_REQUEST_QUERY = [
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

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const timeOf = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : Date.now());

/**
 * Fetches once, newest first, and prints progress. Returns
 * `{ repo, prRows, commitDates, coveredSince, error }`: `coveredSince` is the
 * time from which both lists are complete (null: complete), so a preset that
 * starts earlier has partial numbers and is skipped. `error` says why there
 * are no numbers at all.
 */
export async function fetchGithubActivityForBrowser({ cwd, deadlineMs = GITHUB_STATS_DEADLINE_MS }) {
  const log = (line) => console.log(`[export-browser-mock-ade] GitHub stats: ${line}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const startedAt = Date.now();
  const seconds = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
  const failed = (reason) => {
    console.warn(`[export-browser-mock-ade] GitHub stats skipped (${reason}); the snapshot shows no GitHub numbers.`);
    return { repo: null, prRows: [], commitDates: [], coveredSince: null, error: reason };
  };
  let progress = null;
  try {
    log(`reading the repository and GitHub user (gives up after ${deadlineMs / 1000} s)`);
    let repoInfoRaw;
    let viewerRaw;
    try {
      [repoInfoRaw, viewerRaw] = await Promise.all([
        runGh(["repo", "view", "--json", "owner,name"], cwd, controller.signal),
        runGh(["api", "user", "--cache", "10m"], cwd, controller.signal),
      ]);
    } catch (error) {
      if (controller.signal.aborted) return failed(`gh did not answer in ${deadlineMs / 1000} s`);
      throw error;
    }
    const repoInfo = JSON.parse(repoInfoRaw);
    const owner = typeof repoInfo.owner === "string" ? repoInfo.owner : repoInfo.owner?.login;
    const repo = owner && repoInfo.name ? `${owner}/${repoInfo.name}` : null;
    if (!repo) throw new Error("Unable to resolve GitHub repo.");
    const viewer = JSON.parse(viewerRaw).login;
    if (typeof viewer !== "string" || !viewer) throw new Error("Unable to resolve GitHub user.");

    log(`reading ${viewer}'s pull requests and commits in ${repo}`);
    const prRows = [];
    const commitDates = [];
    let oldestPrUpdate = null;
    // The list follows commit (committer) order; an author date can be older.
    let oldestCommitted = null;
    progress = setInterval(() => log(`${prRows.length} pull requests and ${commitDates.length} commits so far (${seconds()})`), PROGRESS_EVERY_MS);
    const [prsDone, commitsDone] = await Promise.all([
      streamGhLines([
        "api",
        "graphql",
        "--paginate",
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${repoInfo.name}`,
        "-f",
        `query=${PULL_REQUEST_QUERY}`,
        "--jq",
        ".data.repository.pullRequests.nodes[] | @json",
      ], cwd, controller.signal, (line) => {
        const row = parseJsonLine(line);
        if (!row) return;
        if (typeof row.updatedAt === "string") oldestPrUpdate = row.updatedAt;
        if (row.author?.login === viewer) prRows.push(row);
      }),
      streamGhLines([
        "api",
        `repos/${repo}/commits`,
        "--method",
        "GET",
        "--cache",
        "10m",
        "-F",
        `author=${viewer}`,
        "-F",
        "per_page=100",
        "--paginate",
        "--jq",
        ".[] | [.sha, .commit.author.date, .commit.committer.date] | @tsv",
      ], cwd, controller.signal, (line) => {
        const [, authored, committed] = line.split("\t");
        if (!authored) return;
        commitDates.push(authored);
        if (committed && (!oldestCommitted || timeOf(committed) < timeOf(oldestCommitted))) oldestCommitted = committed;
      }),
    ]);
    // Both lists are complete from the later of the points they reached.
    const reached = [];
    if (!prsDone) reached.push(timeOf(oldestPrUpdate));
    if (!commitsDone) reached.push(timeOf(oldestCommitted));
    const coveredSince = reached.length ? new Date(Math.max(...reached)).toISOString() : null;
    if (coveredSince) {
      log(`stopped at ${deadlineMs / 1000} s with ${prRows.length} pull requests and ${commitDates.length} commits, complete since ${coveredSince.slice(0, 10)}; a range reaching further back is skipped`);
    } else {
      log(`${prRows.length} pull requests and ${commitDates.length} commits in ${seconds()}`);
    }
    return { repo, prRows, commitDates, coveredSince, error: null };
  } catch (error) {
    return failed(error instanceof Error ? error.message.split("\n")[0] : String(error));
  } finally {
    clearTimeout(timer);
    if (progress) clearInterval(progress);
    // A call still running after another failed must not hold the export.
    controller.abort();
  }
}
