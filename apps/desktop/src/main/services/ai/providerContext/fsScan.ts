/**
 * Bounded, async file reads and the repository layout for the provider
 * context list. Every read is capped, and a missing file is simply absent.
 */

import fs from "node:fs";
import path from "node:path";

import { parseJsonc } from "../../../../shared/theme/jsonc";
import { isRecord } from "../../mcp/mcpProviderConfigScan";
import { isPathInside, pathsEqual } from "../../shared/pathCompare";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** An instruction or rule file larger than this is counted from its first part. */
export const MAX_TEXT_BYTES = 512 * 1024;
/** A SKILL.md or agent file: only its frontmatter and first paragraph are listed. */
export const MAX_HEADER_BYTES = 32 * 1024;
/** `~/.claude.json` keeps chat history and can be large; it must be parsed whole (the MCP scanner's cap). */
export const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES_PER_DIR = 300;
const MAX_ANCESTORS = 40;

// ---------------------------------------------------------------------------
// One inventory call
// ---------------------------------------------------------------------------

export type ProviderContextLogger = { warn: (event: string, data?: Record<string, unknown>) => void };

export type Ctx = {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  /** The repository the cwd is in (its worktree root), or null. */
  gitRoot: string | null;
  /** The main checkout of that repository (differs from gitRoot in a linked worktree). */
  mainRoot: string | null;
  logger: ProviderContextLogger | null | undefined;
  nextId: (prefix: string) => string;
  /** Each JSON config parsed once per call, by resolved path: `~/.claude.json` is read for several MCP sources. */
  jsonCache: Map<string, Promise<Record<string, unknown> | null>>;
};

const EXPECTED_FS_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EISDIR"]);

function warnUnexpected(ctx: Pick<Ctx, "logger">, event: string, target: string, error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code && EXPECTED_FS_CODES.has(code)) return;
  ctx.logger?.warn(event, { path: target, error: error instanceof Error ? error.message : String(error) });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type ReadText = { text: string; truncated: boolean; bytes: number };

export async function readTextCapped(
  ctx: Pick<Ctx, "logger">,
  file: string,
  maxBytes = MAX_TEXT_BYTES,
  /** A file that is only useful whole (JSON): over the cap, return it truncated and empty, unread. */
  options: { wholeOnly?: boolean } = {},
): Promise<ReadText | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return null;
    if (options.wholeOnly && stat.size > maxBytes) return { text: "", truncated: true, bytes: stat.size };
    handle = await fs.promises.open(file, "r");
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8").replace(/^﻿/, ""),
      truncated: stat.size > maxBytes,
      bytes: stat.size,
    };
  } catch (error) {
    warnUnexpected(ctx, "provider_context.read_failed", file, error);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonUncached(ctx: Pick<Ctx, "logger">, file: string): Promise<Record<string, unknown> | null> {
  const read = await readTextCapped(ctx, file, MAX_CONFIG_BYTES, { wholeOnly: true });
  if (!read) return null;
  if (read.truncated) {
    // Half a JSON file does not parse, so the file is skipped whole. Say so:
    // otherwise every server in it silently disappears from the list.
    ctx.logger?.warn("provider_context.config_too_large", { path: file, bytes: read.bytes, maxBytes: MAX_CONFIG_BYTES });
    return null;
  }
  try {
    const parsed = parseJsonc(read.text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A config file that is not valid JSON is the provider's to report.
    return null;
  }
}

/** A JSON or JSONC config as an object, parsed at most once per inventory call. */
export function readJsonCapped(ctx: Pick<Ctx, "logger" | "jsonCache">, file: string): Promise<Record<string, unknown> | null> {
  const key = path.resolve(file);
  let pending = ctx.jsonCache.get(key);
  if (!pending) {
    pending = readJsonUncached(ctx, key);
    ctx.jsonCache.set(key, pending);
  }
  return pending;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(ctx: Pick<Ctx, "logger">, dir: string): Promise<fs.Dirent[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES_PER_DIR);
  } catch (error) {
    warnUnexpected(ctx, "provider_context.list_failed", dir, error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function displayPath(home: string, target: string): string {
  const resolved = path.resolve(target);
  if (pathsEqual(resolved, home)) return "~";
  return isPathInside(resolved, home) ? `~${resolved.slice(home.length)}` : resolved;
}

/** A file or folder's shown path and its full path, for "Show in Finder". */
export function located(ctx: Pick<Ctx, "home">, target: string): { source: string; path: string } {
  return { source: displayPath(ctx.home, target), path: path.resolve(target) };
}

// ---------------------------------------------------------------------------
// Repository layout
// ---------------------------------------------------------------------------

export async function findGitRoot(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (await exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** For a linked worktree, the main checkout (its `.git` file points at `<main>/.git/worktrees/<name>`). */
export async function findMainRoot(ctx: Pick<Ctx, "logger">, gitRoot: string | null): Promise<string | null> {
  if (!gitRoot) return null;
  const dotGit = await readTextCapped(ctx, path.join(gitRoot, ".git"), 4096);
  const pointer = dotGit?.text.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
  if (!pointer) return gitRoot;
  const gitDir = path.resolve(gitRoot, pointer.trim());
  const commonDir = (await readTextCapped(ctx, path.join(gitDir, "commondir"), 4096))?.text.trim();
  const common = commonDir ? path.resolve(gitDir, commonDir) : gitDir;
  return path.basename(common) === ".git" ? path.dirname(common) : gitRoot;
}

/** `top` down to `cwd`, both included; just `[cwd]` when there is no top. */
export function dirsTopDown(cwd: string, top: string | null): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    dirs.push(dir);
    if (!top || pathsEqual(dir, path.resolve(top))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.reverse();
}

/** Every ancestor from the filesystem root (excluded) down to `cwd`. */
export function allAncestorsTopDown(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dirs.push(dir);
    dir = parent;
  }
  return dirs.reverse();
}
