import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * What the copy leaves out, as `find` arguments evaluated from the project
 * root: dependency folders (reinstalled after the move, and pnpm needs its
 * store on the new drive anyway; a lane's `node_modules` *link* to the main
 * checkout is kept and re-pointed, so lanes work once the main checkout is
 * reinstalled), the project database (copied separately through SQLite so the
 * write-ahead log is not lost), and sockets. `keep` names dependency folders
 * that hold files committed to git: those are part of the project and copied.
 */
function findExclusions(keep: readonly string[]): string[] {
  const kept = keep.flatMap((dir) => ["!", "-path", escapeFindPattern(dir)]);
  return [
    "(",
    "(", "-name", "node_modules", "-type", "d", ...kept, ")",
    "-o", "-path", "./.ade/ade.db",
    "-o", "-path", "./.ade/ade.db-wal",
    "-o", "-path", "./.ade/ade.db-shm",
    "-o", "-type", "s",
    ")", "-prune",
  ];
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
/** Bytes a folder takes on disk (`du`), optionally leaving out `node_modules`. */
export async function diskUsageBytes(root: string, options: { ignoreDependencies?: boolean } = {}): Promise<number> {
  const args = options.ignoreDependencies ? ["-skI", "node_modules", root] : ["-sk", root];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/usr/bin/du", args, { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    // du exits 1 when a few files are unreadable and still prints a total.
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  return (Number.parseInt(stdout.trim().split(/\s+/u)[0] ?? "0", 10) || 0) * 1024;
}

const measureCache = new Map<string, { at: number; value: Promise<{ copyBytes: number; dependencyBytes: number }> }>();
/** The move dialog re-checks on every destination change; the project's size is measured once a minute at most. */
const MEASURE_CACHE_MS = 60_000;

/** Bytes the copy will write, and bytes of dependency folders it leaves out. */
export function measureProject(root: string): Promise<{ copyBytes: number; dependencyBytes: number }> {
  const cached = measureCache.get(root);
  if (cached && Date.now() - cached.at < MEASURE_CACHE_MS) return cached.value;
  const value = Promise.all([diskUsageBytes(root, { ignoreDependencies: true }), diskUsageBytes(root)])
    .then(([withoutDependencies, total]) => ({
      copyBytes: withoutDependencies,
      dependencyBytes: Math.max(0, total - withoutDependencies),
    }));
  measureCache.set(root, { at: Date.now(), value });
  return value;
}

/** Relative paths (`./a/b`) the copy includes, written to `listFile`. Returns how many. */
export function writeCopyList(root: string, listFile: string, keep: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(listFile);
    const child = spawn("/usr/bin/find", [".", ...findExclusions(keep), "-o", "-print"], {
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
 * the exclusions above are honored. Any error fails the copy.
 */
export async function copyProjectTree(args: {
  sourceRoot: string;
  copyRoot: string;
  keepDependencyDirs: readonly string[];
  onProgress: (copiedFiles: number, totalFiles: number) => void;
}): Promise<{ totalFiles: number }> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-move-"));
  try {
    const listFile = path.join(workDir, "files.txt");
    const bomFile = path.join(workDir, "files.bom");
    const totalFiles = await writeCopyList(args.sourceRoot, listFile, args.keepDependencyDirs);
    await execFileAsync("/usr/bin/mkbom", ["-s", "-i", listFile, bomFile], { timeout: 10 * 60_000 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/ditto", ["-V", "--bom", bomFile, args.sourceRoot, args.copyRoot], {
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
export async function countCopiedEntries(copyRoot: string, keep: readonly string[]): Promise<number> {
  const listFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-move-count-")), "files.txt");
  try {
    return await writeCopyList(copyRoot, listFile, keep);
  } finally {
    fs.rmSync(path.dirname(listFile), { recursive: true, force: true });
  }
}
