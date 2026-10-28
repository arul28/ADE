import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * What the copy leaves out, as `find` arguments evaluated from the project
 * root: the project database (copied separately through SQLite so the
 * write-ahead log is not lost), sockets, the Apple tools' DerivedData (a
 * cache that pins the old path), and, unless dependencies are copied
 * too, dependency folders. Left-out dependencies are reinstalled after the
 * move; a lane's `node_modules` *link* to the main checkout is always kept and
 * re-pointed, so lanes work once the main checkout has its dependencies.
 * `keep` names dependency folders that hold files committed to git: those are
 * part of the project and always copied.
 */
function findExclusions(keep: readonly string[], includeDependencies: boolean): string[] {
  const kept = keep.flatMap((dir) => ["!", "-path", escapeFindPattern(dir)]);
  return [
    "(",
    ...(includeDependencies ? [] : ["(", "-name", "node_modules", "-type", "d", ...kept, ")", "-o"]),
    // The search index is a cache the brain may hold open; it is rebuilt.
    "-path", "./.ade/cache/search-index.db",
    "-o", "-path", "./.ade/cache/search-index.db-wal",
    "-o", "-path", "./.ade/cache/search-index.db-shm",
    "-o", "-path", "./.ade/ade.db",
    "-o", "-path", "./.ade/ade.db-wal",
    "-o", "-path", "./.ade/ade.db-shm",
    "-o", "-type", "s",
    // Xcode's build folder for the Apple tools, in the main checkout and in
    // every lane: a rebuildable cache, and one that pins the old path
    // (SwiftPM's workspace-state.json names absolute package paths, so a
    // copied one fails the next build with "no XCFramework found").
    "-o", "(", "-path", `*/${REBUILDABLE_DERIVED_DATA}`, "-type", "d", ")",
    ")", "-prune",
  ];
}

/** The Apple tools' DerivedData, relative to a checkout (the main one or a lane's). Never copied by a move. */
export const REBUILDABLE_DERIVED_DATA = ".ade/cache/ios-simulator/DerivedData";

/**
 * The DerivedData folders the copy leaves out: the main checkout's and each
 * lane's under `.ade/worktrees`. Lanes elsewhere do not move.
 */
function rebuildableCacheDirs(root: string): string[] {
  const dirs = [path.join(root, REBUILDABLE_DERIVED_DATA)];
  try {
    for (const lane of fs.readdirSync(path.join(root, ".ade", "worktrees"))) {
      dirs.push(path.join(root, ".ade", "worktrees", lane, REBUILDABLE_DERIVED_DATA));
    }
  } catch {
    // No lanes inside the project.
  }
  return dirs.filter((dir) => {
    try {
      return fs.lstatSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/** `find -path` takes a glob, so a folder named with `*`, `?` or `[` must be escaped. */
function escapeFindPattern(value: string): string {
  return value.replace(/[\\*?[\]]/gu, (match) => `\\${match}`);
}

/**
 * Dependency folders (`./a/node_modules`) that hold files committed to git, in
 * the main checkout and the given lanes. Rare (a vendored or patched package),
 * but those files are the project's own and must move with it.
 */
export async function trackedDependencyDirs(root: string, laneRelativePaths: readonly string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const relative of ["", ...laneRelativePaths]) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("git", ["-C", path.join(root, relative), "ls-files", "-z"], {
        timeout: 5 * 60_000,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }));
    } catch {
      continue; // a checkout git cannot read is caught by the verify step
    }
    for (const file of stdout.split("\0")) {
      const match = file.match(/^(.*?(?:^|\/)node_modules)\//u);
      if (match?.[1]) dirs.add(`./${path.posix.join(relative, match[1])}`);
    }
  }
  return [...dirs];
}

/** `du`'s own limit. A project that takes longer is not measured, and the move check says so. */
export const DISK_USAGE_TIMEOUT_MS = 10 * 60_000;

/**
 * Bytes under `root` (`du`), optionally leaving out `node_modules`, or null
 * when the run ended without a total. `du -sk` prints its one total line at
 * the end, so a run killed at the limit prints nothing: reading that as 0 B
 * would tell the move there is room it never checked.
 */
async function duBytes(root: string, options: { ignoreDependencies?: boolean } = {}): Promise<number | null> {
  const args = options.ignoreDependencies ? ["-skI", "node_modules", root] : ["-sk", root];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/usr/bin/du", args, { timeout: DISK_USAGE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    // du exits 1 when a few files are unreadable and still prints a total; a
    // run killed at its limit prints none, which is not the same as 0 B.
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const kilobytes = Number.parseInt(stdout.trim().split(/\s+/u)[0] ?? "", 10);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

/** Bytes a folder takes on disk (`du`), optionally leaving out `node_modules`. An unmeasurable folder counts as 0 B; the move check asks `measureProject` when it needs to know. */
export async function diskUsageBytes(root: string, options: { ignoreDependencies?: boolean } = {}): Promise<number> {
  return (await duBytes(root, options)) ?? 0;
}

/** Bytes the copy will write, bytes of dependency folders it leaves out, and whether `du` measured them. */
export type ProjectMeasurement =
  | { measured: true; copyBytes: number; dependencyBytes: number }
  /** `du` ended without a total; there are no byte counts to read, only the fact that they are unknown. */
  | { measured: false };

/** `doneAt` is null while `du` still runs: every check joins that run instead of starting another. */
const measureCache = new Map<string, { doneAt: number | null; value: Promise<ProjectMeasurement> }>();
/**
 * The move dialog re-checks on every destination change; a finished size is
 * reused for a minute. The minute counts from when `du` finished, not when it
 * started: lanes full of node_modules take `du` over a minute, and counting
 * from the start threw each result away before anyone could use it.
 */
const MEASURE_CACHE_MS = 60_000;

export function measureProject(root: string): Promise<ProjectMeasurement> {
  const cached = measureCache.get(root);
  if (cached && (cached.doneAt === null || Date.now() - cached.doneAt < MEASURE_CACHE_MS)) return cached.value;
  const entry: { doneAt: number | null; value: Promise<ProjectMeasurement> } = {
    doneAt: null,
    value: Promise.all([
      duBytes(root, { ignoreDependencies: true }),
      duBytes(root),
      // Left out of the copy, so not part of what it needs; an unmeasured one
      // counts as 0 B, which only overstates the copy.
      Promise.all(rebuildableCacheDirs(root).map((dir) => duBytes(dir, { ignoreDependencies: true })))
        .then((sizes) => sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)),
    ])
      .then(([withoutDependencies, total, skipped]): ProjectMeasurement => {
        if (withoutDependencies === null || total === null) return { measured: false };
        return {
          measured: true,
          copyBytes: Math.max(0, withoutDependencies - skipped),
          dependencyBytes: Math.max(0, total - withoutDependencies),
        };
      })
      .finally(() => {
        entry.doneAt = Date.now();
      }),
  };
  measureCache.set(root, entry);
  return entry.value;
}

/** Relative paths (`./a/b`) the copy includes, written to `listFile`. Returns how many. */
export function writeCopyList(root: string, listFile: string, keep: readonly string[], includeDependencies: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(listFile);
    const child = spawn("/usr/bin/find", [".", ...findExclusions(keep, includeDependencies), "-o", "-print"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let count = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      for (const byte of chunk) if (byte === 10) count += 1;
    });
    child.stdout.pipe(out);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      out.end(() => {
        if (code !== 0) {
          reject(new Error(`ADE couldn't list every file in the project. ${firstLine(stderr)}`.trim()));
          return;
        }
        resolve(count);
      });
    });
  });
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * Copies the project into `copyRoot` with `ditto`, which keeps permissions,
 * extended attributes, ACLs and symlinks. (macOS 27's `rsync` is openrsync,
 * which drops extended attributes.) The copy runs from a bill of materials so
 * the exclusions above are honored. On the same drive `clone` makes APFS
 * clones: the copy is near-instant and takes no space until a file changes.
 * Any error fails the copy.
 */
export async function copyProjectTree(args: {
  sourceRoot: string;
  copyRoot: string;
  keepDependencyDirs: readonly string[];
  includeDependencies: boolean;
  clone: boolean;
  onProgress: (copiedFiles: number, totalFiles: number) => void;
}): Promise<{ totalFiles: number }> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-move-"));
  try {
    const listFile = path.join(workDir, "files.txt");
    const bomFile = path.join(workDir, "files.bom");
    const totalFiles = await writeCopyList(args.sourceRoot, listFile, args.keepDependencyDirs, args.includeDependencies);
    await execFileAsync("/usr/bin/mkbom", ["-s", "-i", listFile, bomFile], { timeout: 10 * 60_000 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/ditto", ["-V", ...(args.clone ? ["--clone"] : []), "--bom", bomFile, args.sourceRoot, args.copyRoot], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let copied = 0;
      let lastReport = 0;
      let errors = "";
      let pending = "";
      const onData = (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("copying file ")) copied += 1;
          else if (line.startsWith("ditto: ")) errors += `${line}\n`;
        }
        const now = Date.now();
        if (now - lastReport > 200) {
          lastReport = now;
          args.onProgress(Math.min(copied, totalFiles), totalFiles);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 && !errors) {
          args.onProgress(totalFiles, totalFiles);
          resolve();
          return;
        }
        reject(new Error(describeCopyFailure(errors, code)));
      });
    });
    return { totalFiles };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function describeCopyFailure(errors: string, code: number | null): string {
  if (/No space left on device/i.test(errors)) return "The new location ran out of space.";
  const first = firstLine(errors).replace(/^ditto:\s*/, "");
  return first ? `Copying failed: ${first}` : `Copying failed (ditto exited ${code}).`;
}

/** How many entries the copy holds, counted with the same exclusions as the list. */
export async function countCopiedEntries(copyRoot: string, keep: readonly string[], includeDependencies: boolean): Promise<number> {
  const listFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-move-count-")), "files.txt");
  try {
    return await writeCopyList(copyRoot, listFile, keep, includeDependencies);
  } finally {
    fs.rmSync(path.dirname(listFile), { recursive: true, force: true });
  }
}

/** Whether two paths (or their nearest existing folders) are on the same volume. */
export function onSameVolume(a: string, b: string): boolean {
  const device = (target: string): number | null => {
    for (let current = path.resolve(target); ; current = path.dirname(current)) {
      try {
        return fs.statSync(current).dev;
      } catch {
        if (path.dirname(current) === current) return null;
      }
    }
  };
  const first = device(a);
  return first !== null && first === device(b);
}
