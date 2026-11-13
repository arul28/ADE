/**
 * The files git ignores in a cloud computer's lanes (`.env`, a local
 * database): ADE Cloud's idle cleanup commits and pushes the work before it
 * deletes an unused computer, and git never pushes these, so its warning
 * lists them. The brain reads them at its idle step, while it is awake
 * anyway, and sends a short summary with its disk report; nothing wakes a
 * computer to look.
 *
 * One `git ls-files --others --ignored --exclude-standard --directory` per
 * lane: a folder git ignores whole is one entry and is never walked.
 */

import { execFile } from "node:child_process";
import { CLOUD_IGNORED_FILES_MAX_PATHS, type CloudIgnoredFiles } from "../../../../desktop/src/shared/adeCloud";

/** One lane's read gives up after this long: that lane is reported as unread (the summary says it may be incomplete), never held up. */
const GIT_TIMEOUT_MS = 15_000;
/** More entries than this in one lane are counted in `more`, not looked at. */
const MAX_ENTRIES_READ = 5_000;

/**
 * Folders a build or an install makes again: counted, never listed, so the
 * warning names what the person would really lose.
 */
const REBUILDABLE = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".vite",
  "target", "coverage", "__pycache__", ".venv", "venv", ".tox", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".gradle",
  "DerivedData", "Pods", ".dart_tool", ".expo", ".angular", "obj",
]);

/** ADE's own folder (its lanes' worktrees live there) and git's: never the person's files. */
const NOT_THE_PERSONS = new Set([".ade", ".git"]);

/** Named first: what people most often lose and miss. */
const LIKELY_PRECIOUS = /(^|\/|: )(\.env[^/]*|[^/]*\.(db|sqlite|sqlite3|pem|key|p12|keystore|jks)|secrets?[^/]*|credentials[^/]*|\.npmrc|\.netrc)\/?$/i;

type Run = (cwd: string) => Promise<string>;

function defaultRun(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * The summary from each lane's list: the likely precious first, then by name;
 * build folders only counted. `skipped` entries (past the per-lane cap) count
 * in `more`; `incomplete` says some lane couldn't be read at all.
 */
export function summarizeIgnoredFiles(
  lanes: ReadonlyArray<{ laneName: string; paths: readonly string[] }>,
  now: number,
  extra: { skipped?: number; incomplete?: boolean } = {},
): CloudIgnoredFiles {
  const named = lanes.filter((lane) => lane.paths.length > 0);
  const prefix = named.length > 1;
  const kept: string[] = [];
  let rebuildable = 0;
  for (const lane of named) {
    for (const raw of lane.paths) {
      const path = raw.trim();
      if (!path) continue;
      const first = path.split("/")[0]!;
      if (NOT_THE_PERSONS.has(first)) continue;
      const segments = path.replace(/\/$/, "").split("/");
      if (segments.some((segment) => REBUILDABLE.has(segment))) {
        rebuildable += 1;
        continue;
      }
      kept.push(prefix ? `${lane.laneName}: ${path}` : path);
    }
  }
  kept.sort((left, right) => Number(LIKELY_PRECIOUS.test(right)) - Number(LIKELY_PRECIOUS.test(left)) || left.localeCompare(right));
  const paths = kept.slice(0, CLOUD_IGNORED_FILES_MAX_PATHS);
  return {
    checkedAt: now,
    paths,
    more: kept.length - paths.length + (extra.skipped ?? 0),
    rebuildable,
    ...(extra.incomplete ? { incomplete: true } : {}),
  };
}

/**
 * Reads every lane's ignored files and sums them up. A lane that can't be read
 * marks the summary `incomplete` (sent anyway, so an older "none found" never
 * stands for a lane nobody read). Null only with no lane.
 */
export async function readCloudIgnoredFiles(
  lanes: ReadonlyArray<{ laneName: string; worktreePath: string }>,
  options: { run?: Run; now?: () => number; logger?: { warn(event: string, data?: unknown): void } } = {},
): Promise<CloudIgnoredFiles | null> {
  const run = options.run ?? defaultRun;
  if (!lanes.length) return null;
  const read: Array<{ laneName: string; paths: string[] }> = [];
  let skipped = 0;
  let unread = 0;
  for (const lane of lanes) {
    try {
      const entries = (await run(lane.worktreePath)).split("\0").filter(Boolean);
      skipped += Math.max(0, entries.length - MAX_ENTRIES_READ);
      read.push({ laneName: lane.laneName, paths: entries.slice(0, MAX_ENTRIES_READ) });
    } catch (error) {
      unread += 1;
      options.logger?.warn("cloud.ignored_files_read_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return summarizeIgnoredFiles(read, (options.now ?? Date.now)(), { skipped, incomplete: unread > 0 });
}
