import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderHistoryEntry } from "../../../shared/types/storage";
import {
  claudeConfigHome,
  codexConfigHome,
  copilotConfigHome,
  factoryConfigHome,
  grokSessionsDir,
  openCodeDataDirs,
} from "../shared/providerConfigHomes";
import { isEnoentError } from "../shared/utils";
import { machineProviderUsageHomes } from "../usage/providerUsageHomes";

/**
 * Every agent CLI keeps its own copy of the conversations it runs, in its own
 * folder, whether ADE started the session or not. Those folders belong to the
 * provider: ADE measures them so Settings can say where the space went, and
 * removes only one narrow kind of file (`listProviderCopiesOfChats`): the
 * Claude and Codex sessions that ADE itself started for chats that no longer
 * exist in ADE.
 */

const DIRECTORY_SCAN_MAX_ENTRIES = 200_000;
const DIRECTORY_SCAN_BUDGET_MS = 4_000;

type SizeWalk = { entries: number; deadline: number; partial: boolean };

async function directoryBytes(root: string, walk: SizeWalk): Promise<{ bytes: number; fileCount: number }> {
  let bytes = 0;
  let fileCount = 0;
  const pending = [root];
  while (pending.length > 0) {
    if (walk.entries >= DIRECTORY_SCAN_MAX_ENTRIES || Date.now() > walk.deadline) {
      walk.partial = true;
      break;
    }
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      walk.entries += 1;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        try {
          bytes += (await fs.promises.lstat(entryPath)).size;
          fileCount += 1;
        } catch {
          // removed while measuring
        }
      }
    }
  }
  return { bytes, fileCount };
}

const uniquePaths = (paths: string[]): string[] => [...new Set(paths.map((entry) => path.resolve(entry)))];

function claudeHomes(): string[] {
  return uniquePaths([claudeConfigHome(), ...machineProviderUsageHomes().claude]);
}

function codexHomes(): string[] {
  return uniquePaths([codexConfigHome(), ...machineProviderUsageHomes().codex]);
}

type ProviderHistorySource = Omit<ProviderHistoryEntry, "bytes" | "fileCount" | "partial">;

function providerHistorySources(): ProviderHistorySource[] {
  const home = os.homedir();
  return [
    {
      provider: "claude",
      label: "Claude",
      paths: claudeHomes().map((dir) => path.join(dir, "projects")),
      note: "Claude deletes its own sessions after 30 days unless its cleanupPeriodDays setting says otherwise.",
    },
    {
      provider: "codex",
      label: "Codex",
      paths: codexHomes().flatMap((dir) => [path.join(dir, "sessions"), path.join(dir, "archived_sessions")]),
      note: "Codex keeps every session until it is deleted.",
    },
    { provider: "opencode", label: "OpenCode", paths: openCodeDataDirs(), note: "One database plus file snapshots, managed by OpenCode." },
    { provider: "droid", label: "Droid", paths: [path.join(factoryConfigHome(), "sessions")], note: "Managed by Droid." },
    { provider: "cursor", label: "Cursor", paths: [path.join(home, ".cursor", "chats")], note: "Managed by Cursor." },
    { provider: "copilot", label: "Copilot", paths: [path.join(copilotConfigHome(), "session-state")], note: "Managed by Copilot." },
    { provider: "pi", label: "Pi", paths: [path.join(home, ".pi", "agent", "sessions")], note: "Managed by Pi." },
    { provider: "grok", label: "Grok", paths: [grokSessionsDir()], note: "Managed by Grok." },
  ];
}

/** Sizes of each provider's own session history on this machine; providers with nothing on disk are left out. */
export async function measureProviderHistory(): Promise<ProviderHistoryEntry[]> {
  const out: ProviderHistoryEntry[] = [];
  for (const source of providerHistorySources()) {
    const walk: SizeWalk = { entries: 0, deadline: Date.now() + DIRECTORY_SCAN_BUDGET_MS, partial: false };
    let bytes = 0;
    let fileCount = 0;
    const present: string[] = [];
    for (const dir of uniquePaths(source.paths)) {
      if (!fs.existsSync(dir)) continue;
      present.push(dir);
      const size = await directoryBytes(dir, walk);
      bytes += size.bytes;
      fileCount += size.fileCount;
    }
    if (present.length === 0 || bytes === 0) continue;
    out.push({ ...source, paths: present, bytes, fileCount, ...(walk.partial ? { partial: true } : {}) });
  }
  return out.sort((left, right) => right.bytes - left.bytes);
}

export type ProviderSessionRef = {
  provider: "claude" | "codex";
  /** Claude's SDK session id, or Codex's thread id. */
  sessionId: string;
};

export type ProviderCopyFile = { path: string; bytes: number; isDirectory: boolean };

export type ProviderCopy = ProviderSessionRef & { files: ProviderCopyFile[]; bytes: number };

async function readdirOrEmpty(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if (isEnoentError(error)) return null;
    throw error;
  }
}

/** Claude session id → its `projects/<cwd>/<id>.jsonl` file(s) and `<id>/` side folder(s), across every Claude home. */
async function indexClaudeSessions(wanted: ReadonlySet<string>): Promise<Map<string, ProviderCopyFile[]>> {
  const found = new Map<string, ProviderCopyFile[]>();
  for (const home of claudeHomes()) {
    const projectsDir = path.join(home, "projects");
    for (const projectEntry of await readdirOrEmpty(projectsDir)) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = path.join(projectsDir, projectEntry.name);
      for (const entry of await readdirOrEmpty(projectDir)) {
        const id = entry.isFile() && entry.name.endsWith(".jsonl") ? entry.name.slice(0, -".jsonl".length) : entry.isDirectory() ? entry.name : null;
        if (!id || !wanted.has(id)) continue;
        const entryPath = path.join(projectDir, entry.name);
        const bytes = entry.isDirectory()
          ? (await directoryBytes(entryPath, { entries: 0, deadline: Date.now() + DIRECTORY_SCAN_BUDGET_MS, partial: false })).bytes
          : (await lstatOrNull(entryPath))?.size ?? 0;
        const list = found.get(id) ?? [];
        list.push({ path: entryPath, bytes, isDirectory: entry.isDirectory() });
        found.set(id, list);
      }
    }
  }
  return found;
}

const CODEX_ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/iu;

/** Codex thread id → its rollout file(s) under `sessions/YYYY/MM/DD` and `archived_sessions`, across every Codex home. */
async function indexCodexRollouts(wanted: ReadonlySet<string>): Promise<Map<string, ProviderCopyFile[]>> {
  const found = new Map<string, ProviderCopyFile[]>();
  const consider = async (filePath: string) => {
    const id = CODEX_ROLLOUT_ID.exec(path.basename(filePath))?.[1];
    if (!id || !wanted.has(id)) return;
    const stat = await lstatOrNull(filePath);
    if (!stat?.isFile()) return;
    const list = found.get(id) ?? [];
    list.push({ path: filePath, bytes: stat.size, isDirectory: false });
    found.set(id, list);
  };
  for (const home of codexHomes()) {
    const pending = [path.join(home, "sessions")];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      for (const entry of await readdirOrEmpty(dir)) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile()) await consider(entryPath);
      }
    }
    for (const entry of await readdirOrEmpty(path.join(home, "archived_sessions"))) {
      if (entry.isFile()) await consider(path.join(home, "archived_sessions", entry.name));
    }
  }
  return found;
}

/**
 * The provider's own files for the given ADE-started sessions. Ids missing on
 * disk (Claude already pruned them, another machine ran them) are left out.
 */
export async function listProviderCopiesOfChats(refs: readonly ProviderSessionRef[]): Promise<ProviderCopy[]> {
  const claudeIds = new Set(refs.filter((ref) => ref.provider === "claude").map((ref) => ref.sessionId));
  const codexIds = new Set(refs.filter((ref) => ref.provider === "codex").map((ref) => ref.sessionId));
  const claude = claudeIds.size > 0 ? await indexClaudeSessions(claudeIds) : new Map<string, ProviderCopyFile[]>();
  const codex = codexIds.size > 0 ? await indexCodexRollouts(codexIds) : new Map<string, ProviderCopyFile[]>();
  const copies: ProviderCopy[] = [];
  for (const ref of refs) {
    const files = (ref.provider === "claude" ? claude : codex).get(ref.sessionId);
    if (!files?.length) continue;
    copies.push({ ...ref, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) });
  }
  return copies;
}
