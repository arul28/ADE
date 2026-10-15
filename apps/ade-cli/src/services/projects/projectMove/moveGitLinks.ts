import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git links in a copied project.
 *
 * A linked worktree is two files that name each other:
 * `<lane>/.git` ("gitdir: <repo>/.git/worktrees/<name>") and
 * `<repo>/.git/worktrees/<name>/gitdir` ("<lane>/.git"). Git writes both as
 * absolute paths, so in a copy every lane still points at the original repo,
 * and a commit made there lands in the original.
 *
 * This module never runs `git worktree repair`. Even given explicit lane
 * paths, repair also rewrites any other registered worktree it can reach, so
 * run inside a copy it pointed a lane outside the project at the copy and the
 * original lost it. Writing the two small files directly touches nothing
 * outside the copy.
 */

/**
 * Every spelling a stored path may use for the old root: as given, its real
 * path, and on macOS both sides of the `/tmp`, `/var` and `/etc` aliases for
 * `/private/...`. One project can store `/private/tmp/x` for itself and
 * `/tmp/x` for its lanes, depending on which tool wrote the row.
 */
export function rootSpellings(root: string): string[] {
  const spellings = new Set<string>([stripTrailingSlash(path.resolve(root))]);
  try {
    spellings.add(stripTrailingSlash(fs.realpathSync(root)));
  } catch {
    // a missing root keeps its given spelling
  }
  if (process.platform === "darwin") {
    for (const spelling of [...spellings]) {
      const aliased = spelling.match(/^\/private(\/(?:tmp|var|etc)(?:\/.*)?)$/u);
      if (aliased?.[1]) spellings.add(aliased[1]);
      else if (/^\/(?:tmp|var|etc)(?:\/|$)/u.test(spelling)) spellings.add(`/private${spelling}`);
    }
  }
  return [...spellings];
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/** `candidate` relative to whichever spelling of the root contains it, or null. */
export function relativeToRoot(candidate: string, spellings: string[]): string | null {
  for (const root of spellings) {
    if (candidate === root) return "";
    if (candidate.startsWith(`${root}/`)) return candidate.slice(root.length + 1);
  }
  return null;
}

export type WorktreeLink = {
  /** Folder name under `.git/worktrees`. */
  name: string;
  /** Where the lane lives, as recorded. */
  lanePath: string;
  /** Path inside the project, when the lane is inside it. */
  relativePath: string | null;
  /** Whether the lane folder exists (in the copy for inside lanes, on disk for outside lanes). */
  exists: boolean;
};

/** Every linked worktree registered in `<repoRoot>/.git/worktrees`, classified against the old root. */
export function listWorktreeLinks(repoRoot: string, oldSpellings: string[]): WorktreeLink[] {
  const adminRoot = path.join(repoRoot, ".git", "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(adminRoot);
  } catch {
    return [];
  }
  const links: WorktreeLink[] = [];
  for (const name of names.sort()) {
    let pointer: string;
    try {
      pointer = fs.readFileSync(path.join(adminRoot, name, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    if (!pointer) continue;
    const lanePath = path.dirname(path.resolve(adminRoot, name, pointer));
    const relativePath = relativeToRoot(lanePath, oldSpellings);
    const exists = relativePath === null
      ? fs.existsSync(lanePath)
      : fs.existsSync(path.join(repoRoot, relativePath));
    links.push({ name, lanePath, relativePath, exists });
  }
  return links;
}

/**
 * Points every lane inside the copied project at the copy, with relative links
 * computed for the final location. The copy sits beside the final location
 * (`<final>.ade-moving`), so the same relative links resolve in both.
 * Lanes outside the project are left alone until the switch-over.
 */
export function rewriteWorktreeLinksInCopy(args: {
  copyRoot: string;
  finalRoot: string;
  oldSpellings: string[];
}): { inside: WorktreeLink[]; missing: WorktreeLink[]; outside: WorktreeLink[] } {
  const links = listWorktreeLinks(args.copyRoot, args.oldSpellings);
  const inside: WorktreeLink[] = [];
  const missing: WorktreeLink[] = [];
  const outside: WorktreeLink[] = [];
  for (const link of links) {
    if (link.relativePath === null) {
      outside.push(link);
      continue;
    }
    const finalLane = path.join(args.finalRoot, link.relativePath);
    const finalAdmin = path.join(args.finalRoot, ".git", "worktrees", link.name);
    writeFileKeepingMode(
      path.join(args.copyRoot, ".git", "worktrees", link.name, "gitdir"),
      `${path.relative(finalAdmin, path.join(finalLane, ".git"))}\n`,
    );
    const laneInCopy = path.join(args.copyRoot, link.relativePath);
    if (link.exists) {
      writeFileKeepingMode(path.join(laneInCopy, ".git"), `gitdir: ${path.relative(finalLane, finalAdmin)}\n`);
      inside.push(link);
    } else {
      // A lane whose folder is already gone keeps its entry, so git still
      // shows it as prunable instead of ADE deciding to forget it.
      missing.push(link);
    }
  }
  return { inside, missing, outside };
}

function writeFileKeepingMode(file: string, content: string): void {
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const temp = `${file}.ade-move-${process.pid}`;
  fs.writeFileSync(temp, content, mode === undefined ? undefined : { mode });
  fs.renameSync(temp, file);
}

async function gitConfig(configFile: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["config", "--file", configFile, ...args], {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

/**
 * Turns on relative worktree links so the next move needs no rewrite, and new
 * lanes get relative links. The format version has to change first: with the
 * extension set on a version 0 repository, git refuses the repository.
 * Needs git 2.48 or later to open afterwards.
 */
export async function enableRelativeWorktrees(copyRoot: string): Promise<void> {
  const configFile = path.join(copyRoot, ".git", "config");
  await gitConfig(configFile, ["core.repositoryformatversion", "1"]);
  await gitConfig(configFile, ["extensions.relativeWorktrees", "true"]);
  await gitConfig(configFile, ["worktree.useRelativePaths", "true"]);
}

/** Values in the copy's `.git/config` that name the old root (a hooks path, for one), rewritten. */
export async function rewriteAbsoluteGitConfig(args: {
  copyRoot: string;
  finalRoot: string;
  oldSpellings: string[];
}): Promise<string[]> {
  const configFile = path.join(args.copyRoot, ".git", "config");
  const raw = await gitConfig(configFile, ["--list", "-z"]);
  const changed: string[] = [];
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    const relative = relativeToRoot(value, args.oldSpellings);
    if (relative === null) continue;
    const next = relative ? path.join(args.finalRoot, relative) : args.finalRoot;
    await gitConfig(configFile, ["--fixed-value", "--replace-all", key, next, value]);
    changed.push(key);
  }
  return changed;
}

/**
 * Symlinks in the copy that point into the old root, pointed into the final
 * root instead. A link left alone would keep using the original's files, and
 * dangle once the original is deleted.
 */
export async function relinkAbsoluteSymlinks(args: {
  copyRoot: string;
  finalRoot: string;
  oldSpellings: string[];
}): Promise<number> {
  const links = await listSymlinks(args.copyRoot);
  let count = 0;
  for (const link of links) {
    let target: string;
    try {
      target = fs.readlinkSync(link);
    } catch {
      continue;
    }
    if (!path.isAbsolute(target)) continue;
    const relative = relativeToRoot(target, args.oldSpellings);
    if (relative === null) continue;
    const next = relative ? path.join(args.finalRoot, relative) : args.finalRoot;
    const temp = `${link}.ade-move-${process.pid}`;
    fs.symlinkSync(next, temp);
    fs.renameSync(temp, link);
    count += 1;
  }
  return count;
}

function listSymlinks(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/find", [root, "(", "-name", "node_modules", "-type", "d", ")", "-prune", "-o", "-type", "l", "-print0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Listing links in the copy failed (find exited ${code}).`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean));
    });
  });
}

/**
 * At the switch-over: a lane that lives outside the project now belongs to
 * the moved repository. The link stays absolute, because a relative link
 * across drives breaks as soon as either one is mounted elsewhere.
 */
export function pointOutsideLaneAt(lane: WorktreeLink, finalRoot: string): void {
  writeFileKeepingMode(
    path.join(lane.lanePath, ".git"),
    `gitdir: ${path.join(finalRoot, ".git", "worktrees", lane.name)}\n`,
  );
}
