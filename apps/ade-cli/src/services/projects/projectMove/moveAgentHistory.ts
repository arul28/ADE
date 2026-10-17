import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectMoveAgentHistory } from "../../../../../desktop/src/shared/types/projectMove";
import { cursorProjectSlug } from "../../../../../desktop/src/shared/cursorProjectSlug";
import {
  claudeConfigHome,
  codexConfigHome,
  factoryConfigHome,
  grokSessionsDir,
  qwenConfigHome,
} from "../../../../../desktop/src/main/services/shared/providerConfigHomes";
import { piAgentDirectoryForEnvironment } from "../../../../../desktop/src/main/services/chat/piSessionStore";
import { resolveAdeOpenCodeStoreDir, resolveUserOpenCodeDataRoot } from "../../../../../desktop/src/shared/opencodeDataHome";
import { resolveMachineAdeDir } from "../machineLayout";
import { remapUnderRoot } from "./moveGitLinks";

/**
 * Other agents' history for this project, which most tools file under a
 * folder named after the project's path. After a move the tool looks under
 * the new path's name and finds nothing. ADE renames those folders to the new
 * name. It only renames: no file inside is edited, and an existing folder or
 * file at the new name is never overwritten.
 *
 * ADE's own Claude history (`<ADE_HOME>/provider-homes/claude/*`) is always
 * moved, because it holds ADE's chats. Everything else is opt-in.
 */

export type HistoryRename = {
  provider: string;
  label: string;
  adeOwned: boolean;
  from: string;
  to: string;
  /** Pi also checks the `cwd` in each session file's first line. */
  rewritePiHeaders?: { oldCwd: string; newCwd: string };
  /** An OpenCode snapshot repo names the lane and the project's objects by absolute path. */
  rewriteOpenCodeSnapshot?: { oldSpellings: string[]; newRoot: string };
};

const claudeSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/gu, "-");
const qwenSlug = claudeSlug;
const droidSlug = (cwd: string) => `-${cwd.replace(/^\/+/u, "").replace(/\/+/gu, "-")}`;
const piSlug = (cwd: string) => `--${cwd.replace(/^\/+/u, "").replace(/\/+/gu, "-")}--`;
const grokSlug = (cwd: string) => encodeURIComponent(cwd);
const cursorChatBucket = (cwd: string) => createHash("md5").update(cwd).digest("hex");
const openCodeSnapshotName = (cwd: string) => createHash("sha1").update(cwd).digest("hex");

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function adeClaudeHomes(): string[] {
  const root = path.join(resolveMachineAdeDir(), "provider-homes", "claude");
  return listDirs(root).map((name) => path.join(root, name));
}

/** The `cwd` recorded in a Claude project folder, from the first session line that has one. */
function claudeFolderCwd(folder: string): string | null {
  for (const name of listFilesSafe(folder)) {
    if (!name.endsWith(".jsonl")) continue;
    const head = readHead(path.join(folder, name), 64 * 1024);
    for (const line of head.split("\n")) {
      const match = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/u);
      if (match?.[1]) {
        try {
          return JSON.parse(`"${match[1]}"`) as string;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function listFilesSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readHead(file: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Plans every rename. `knownPaths` are the project root and every lane path
 * ADE knows (old spellings); each maps to the same place under `newRoot`.
 */
export function planAgentHistoryRenames(args: {
  oldSpellings: string[];
  newRoot: string;
  knownPaths: string[];
}): HistoryRename[] {
  const home = os.homedir();
  const plans: HistoryRename[] = [];
  const seen = new Set<string>();
  const add = (plan: HistoryRename) => {
    if (seen.has(plan.from) || plan.from === plan.to) return;
    seen.add(plan.from);
    plans.push(plan);
  };
  const mapToNew = (oldPath: string): string | null => remapUnderRoot(oldPath, args.oldSpellings, args.newRoot);
  const known = [...new Set(args.knownPaths)]
    .map((oldPath) => ({ oldPath, newPath: mapToNew(oldPath) }))
    .filter((entry): entry is { oldPath: string; newPath: string } => entry.newPath !== null);

  // Claude: folders named by slug. The recorded cwd tells which project a
  // folder belongs to, which also catches sessions started in a subfolder.
  const claudeHomes = [
    ...adeClaudeHomes().map((dir) => ({ dir, adeOwned: true })),
    { dir: claudeConfigHome({ homeDir: home }), adeOwned: false },
  ];
  for (const { dir, adeOwned } of claudeHomes) {
    const projectsDir = path.join(dir, "projects");
    const rootSlugs = args.oldSpellings.map(claudeSlug);
    for (const name of listDirs(projectsDir)) {
      if (!rootSlugs.some((slug) => name === slug || name.startsWith(`${slug}-`))) continue;
      const folder = path.join(projectsDir, name);
      // A folder named exactly after the project or one of its lanes is
      // theirs. The cwd recorded inside is only for sessions started in a
      // subfolder: it is the path when the session began, so after an earlier
      // move it names a folder the project has since left.
      const exact = known.find((entry) => claudeSlug(entry.oldPath) === name);
      let newName = exact ? claudeSlug(exact.newPath) : null;
      if (!newName) {
        const cwd = claudeFolderCwd(folder);
        if (cwd) {
          const newCwd = mapToNew(cwd);
          newName = newCwd ? claudeSlug(newCwd) : null;
        } else {
          // No session left to say where it ran (a lane ADE has since closed,
          // with only a backup file inside). ADE's lanes live at
          // `<root>/.ade/worktrees/<name>`, so a folder named after that is
          // this project's lane; the slug is lossy, so nothing looser counts.
          const lanePrefix = rootSlugs.map((slug) => `${slug}--ade-worktrees-`).find((prefix) => name.startsWith(prefix));
          newName = lanePrefix ? `${claudeSlug(path.join(args.newRoot, ".ade", "worktrees"))}-${name.slice(lanePrefix.length)}` : null;
        }
      }
      if (!newName) continue;
      add({
        provider: "claude",
        label: adeOwned ? "ADE chats (Claude)" : "Claude Code",
        adeOwned,
        from: folder,
        to: path.join(projectsDir, newName),
      });
    }
  }

  const exactRenames = (provider: string, label: string, dir: string, slug: (cwd: string) => string) => {
    for (const { oldPath, newPath } of known) {
      const from = path.join(dir, slug(oldPath));
      if (fs.existsSync(from)) add({ provider, label, adeOwned: false, from, to: path.join(dir, slug(newPath)) });
    }
  };
  exactRenames("cursor", "Cursor", path.join(home, ".cursor", "projects"), cursorProjectSlug);
  exactRenames("cursor", "Cursor", path.join(home, ".cursor", "chats"), cursorChatBucket);
  exactRenames("droid", "Droid", path.join(factoryConfigHome({ homeDir: home }), "sessions"), droidSlug);
  exactRenames("qwen", "Qwen Code", path.join(qwenConfigHome({ homeDir: home }), "projects"), qwenSlug);

  // Grok's folder name is the encoded path itself, so subfolders are exact too.
  const grokDir = grokSessionsDir({ homeDir: home });
  for (const name of listDirs(grokDir)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      continue;
    }
    const newCwd = mapToNew(decoded);
    if (newCwd) add({ provider: "grok", label: "Grok", adeOwned: false, from: path.join(grokDir, name), to: path.join(grokDir, grokSlug(newCwd)) });
  }

  // OpenCode keeps undo snapshots in `snapshot/<repo id>/<sha1 of the lane
  // path>`, a git dir whose `core.worktree` and `objects/info/alternates`
  // name the lane and the project's `.git`. After a move OpenCode looks under
  // the new path's hash and starts over, so the folder is renamed and its two
  // paths follow. ADE's own store always moves; the user's own is opt-in.
  const openCodeStores = [
    { dir: resolveAdeOpenCodeStoreDir(), adeOwned: true },
    ...(() => {
      const user = resolveUserOpenCodeDataRoot({ ...process.env, HOME: home });
      return user ? [{ dir: user, adeOwned: false }] : [];
    })(),
  ];
  for (const { dir, adeOwned } of openCodeStores) {
    const snapshots = path.join(dir, "snapshot");
    for (const repoId of listDirs(snapshots)) {
      for (const { oldPath, newPath } of known) {
        const from = path.join(snapshots, repoId, openCodeSnapshotName(oldPath));
        if (!fs.existsSync(from)) continue;
        add({
          provider: "opencode",
          label: adeOwned ? "ADE chats (OpenCode snapshots)" : "OpenCode snapshots",
          adeOwned,
          from,
          to: path.join(snapshots, repoId, openCodeSnapshotName(newPath)),
          rewriteOpenCodeSnapshot: { oldSpellings: args.oldSpellings, newRoot: args.newRoot },
        });
      }
    }
  }

  const piSessions = path.join(piAgentDirectoryForEnvironment({ ...process.env, HOME: home }), "sessions");
  for (const { oldPath, newPath } of known) {
    const from = path.join(piSessions, piSlug(oldPath));
    if (!fs.existsSync(from)) continue;
    add({
      provider: "pi",
      label: "Pi",
      adeOwned: false,
      from,
      to: path.join(piSessions, piSlug(newPath)),
      rewritePiHeaders: { oldCwd: oldPath, newCwd: newPath },
    });
  }
  return plans;
}

/** Whether Kimi Code has sessions for this project (its workspace list names the root). */
function kimiHasProject(oldSpellings: string[], home: string): boolean {
  try {
    const text = fs.readFileSync(path.join(process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code"), "workspaces.json"), "utf8");
    return oldSpellings.some((spelling) => text.includes(JSON.stringify(spelling).slice(1, -1)));
  } catch {
    return false;
  }
}

export function summarizeAgentHistory(plans: HistoryRename[], oldSpellings: string[]): ProjectMoveAgentHistory[] {
  const byLabel = new Map<string, ProjectMoveAgentHistory>();
  for (const plan of plans) {
    const current = byLabel.get(plan.label);
    if (current) {
      current.count += 1;
      continue;
    }
    byLabel.set(plan.label, {
      provider: plan.provider,
      label: plan.label,
      count: 1,
      handling: "move",
      adeOwned: plan.adeOwned,
      detail: plan.adeOwned
        ? "ADE's own chats for this project. Always moved, so they keep resuming."
        : "History for this project is filed under the old path. ADE renames those folders.",
    });
  }
  const summary = [...byLabel.values()];
  summary.push({
    provider: "others",
    label: "Codex, OpenCode, GitHub Copilot and Muse",
    count: 0,
    handling: "nothing",
    detail: "Their chats keep resuming. ADE carries Codex's trust over to the new folder; Copilot may ask you to trust it once.",
  });
  if (kimiHasProject(oldSpellings, os.homedir())) {
    summary.push({
      provider: "kimi",
      label: "Kimi Code",
      count: 0,
      handling: "report",
      detail: "Kimi files sessions under a hash of the path that ADE can't safely recreate. Old Kimi chats stay at the old location.",
    });
  }
  return summary;
}

/**
 * Applies the renames. A folder already at the new name gets the old folder's
 * entries moved in one by one; a name that exists in both is left in the old
 * folder and reported. Returns one line per thing it could not do.
 */
export function applyAgentHistoryRenames(plans: HistoryRename[]): { moved: number; problems: string[] } {
  let moved = 0;
  const problems: string[] = [];
  for (const plan of plans) {
    try {
      if (!fs.existsSync(plan.from)) continue;
      if (!fs.existsSync(plan.to)) {
        fs.renameSync(plan.from, plan.to);
      } else {
        let clashes = 0;
        for (const entry of fs.readdirSync(plan.from)) {
          const target = path.join(plan.to, entry);
          if (fs.existsSync(target)) {
            clashes += 1;
            continue;
          }
          fs.renameSync(path.join(plan.from, entry), target);
        }
        if (clashes) problems.push(`${plan.label}: ${clashes} item(s) already existed at the new location and were left at ${plan.from}.`);
        else fs.rmdirSync(plan.from);
      }
      if (plan.rewritePiHeaders) rewritePiHeaders(plan.to, plan.rewritePiHeaders.oldCwd, plan.rewritePiHeaders.newCwd);
      if (plan.rewriteOpenCodeSnapshot) rewriteOpenCodeSnapshot(plan.to, plan.rewriteOpenCodeSnapshot.oldSpellings, plan.rewriteOpenCodeSnapshot.newRoot);
      moved += 1;
    } catch (error) {
      problems.push(`${plan.label}: couldn't move ${plan.from} (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  return { moved, problems };
}

/** Pi refuses a session whose first-line `cwd` differs from where it runs; only that line is rewritten. */
function rewritePiHeaders(folder: string, oldCwd: string, newCwd: string): void {
  for (const name of listFilesSafe(folder)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(folder, name);
    const content = fs.readFileSync(file, "utf8");
    const newline = content.indexOf("\n");
    const first = newline < 0 ? content : content.slice(0, newline);
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(first) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (header.type !== "session" || header.cwd !== oldCwd) continue;
    header.cwd = newCwd;
    const temp = `${file}.ade-move-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(header) + (newline < 0 ? "" : content.slice(newline)));
    fs.renameSync(temp, file);
  }
}

/** Points a renamed OpenCode snapshot repo at the moved lane and the moved project's objects. */
function rewriteOpenCodeSnapshot(gitDir: string, oldSpellings: string[], newRoot: string): void {
  const rewriteLines = (file: string, remapLine: (line: string) => string | null) => {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    let changed = false;
    const next = content.split("\n").map((line) => {
      const remapped = remapLine(line);
      if (remapped === null || remapped === line) return line;
      changed = true;
      return remapped;
    }).join("\n");
    if (!changed) return;
    const temp = `${file}.ade-move-${process.pid}`;
    fs.writeFileSync(temp, next);
    fs.renameSync(temp, file);
  };
  const configFile = path.join(gitDir, "config");
  if (fs.existsSync(configFile)) {
    let worktree: string | null = null;
    try {
      worktree = execFileSync("git", ["config", "--file", configFile, "--get", "core.worktree"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trimEnd();
    } catch (error) {
      // Git exits with status 1 when the key is absent. Spawn and parse errors
      // must reach applyAgentHistoryRenames so they are reported to the caller.
      if ((error as NodeJS.ErrnoException & { status?: number }).status !== 1) throw error;
    }
    const remapped = worktree ? remapUnderRoot(worktree, oldSpellings, newRoot) : null;
    if (remapped !== null) {
      execFileSync("git", ["config", "--file", configFile, "--replace-all", "core.worktree", remapped], {
        stdio: "ignore",
      });
    }
  }
  rewriteLines(path.join(gitDir, "objects", "info", "alternates"), (line) => remapUnderRoot(line, oldSpellings, newRoot));
}

const TOML_ESCAPES: Record<string, string> = { "\\": "\\\\", "\"": "\\\"", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r" };

/** A TOML basic-string key, as Codex writes `[projects."<path>"]`. */
function tomlQuoted(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/gu, (char) =>
    TOML_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

const TOML_UNESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "\"": "\"", "\\": "\\" };

/**
 * The path a `[projects."<path>"]` header names, however it is spelled: a
 * basic or literal string key, spaces inside the brackets, a trailing comment.
 * Null for any other line.
 */
function projectsHeaderKey(line: string): string | null {
  const match = line.match(/^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/u);
  if (!match) return null;
  if (match[2] !== undefined) return match[2];
  return match[1]!.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gu, (_, code: string) =>
    code.length > 1 ? String.fromCodePoint(Number.parseInt(code.slice(1), 16)) : TOML_UNESCAPES[code] ?? code);
}

/**
 * Codex keeps folder trust in `config.toml` as `[projects."<path>"]` with a
 * `trust_level`. After a move the new path has no entry and Codex asks again,
 * so the old path's trust is added for the new one. Only appended: the old
 * entry stays (the old copy still exists), and an existing entry for the new
 * path is never touched. Returns whether it wrote anything.
 */
export function carryCodexTrust(args: { oldSpellings: string[]; newRoot: string }): boolean {
  const file = path.join(codexConfigHome(), "config.toml");
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/u);
  const headerIndex = (root: string) => lines.findIndex((line) => projectsHeaderKey(line) === root);
  if (headerIndex(args.newRoot) >= 0) return false;
  let trustLevel: string | null = null;
  for (const spelling of args.oldSpellings) {
    const start = headerIndex(spelling);
    if (start < 0) continue;
    for (let index = start + 1; index < lines.length && !lines[index]!.trim().startsWith("["); index += 1) {
      const match = lines[index]!.match(/^\s*trust_level\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/u);
      if (match) {
        trustLevel = match[1] ?? match[2]!;
        break;
      }
    }
    if (trustLevel) break;
  }
  if (!trustLevel) return false;
  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  const next = `${content}${separator}[projects.${tomlQuoted(args.newRoot)}]\ntrust_level = "${trustLevel}"\n`;
  const temp = `${file}.ade-move-${process.pid}`;
  fs.writeFileSync(temp, next, { mode: fs.statSync(file).mode & 0o777 });
  fs.renameSync(temp, file);
  return true;
}
