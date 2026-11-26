import fs from "node:fs";
import path from "node:path";
import type { ExternalSessionProvider } from "../../../shared/types/externalSessions";
import { PROVIDER_INSTANCE_ENV_KEY, isProviderInstanceProvider } from "../../../shared/types/providerInstances";
import { discoverExternalSessionRecord } from "../externalSessions/events";
import { machineProviderUsageHomes } from "../usage/providerUsageHomes";
import { providerThreadIsInHome } from "./providerThreadMove";

/**
 * Where the agent's own copy of a deleted chat is. Recently deleted keeps
 * only a note of each chat; this finds the conversation in the agent's
 * folders, so a chat whose copy is gone leaves the list.
 */

export type DeletedChatSource = {
  /** The account folder holding the copy (Claude / Codex); null for the others. */
  configHome: string | null;
  /** The env the session readers need to look in that folder. */
  env: NodeJS.ProcessEnv | undefined;
};

/** Every Claude transcript on this machine by session id, built once per list. */
type ClaudeIndex = Map<string, { configHome: string; mtimeMs: number }>;

async function buildClaudeIndex(homes: readonly string[]): Promise<ClaudeIndex> {
  const index: ClaudeIndex = new Map();
  for (const home of homes) {
    const projectsDir = path.join(home, "projects");
    let projects: fs.Dirent[];
    try {
      projects = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (project) => {
      let files: string[];
      try {
        files = await fs.promises.readdir(path.join(projectsDir, project.name));
      } catch {
        return;
      }
      for (const name of files) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -".jsonl".length);
        let mtimeMs = 0;
        try {
          mtimeMs = (await fs.promises.stat(path.join(projectsDir, project.name, name))).mtimeMs;
        } catch {
          continue;
        }
        // A moved chat leaves its old copy behind; the newest one is the live one.
        const existing = index.get(id);
        if (!existing || existing.mtimeMs < mtimeMs) index.set(id, { configHome: home, mtimeMs });
      }
    }));
  }
  return index;
}

function accountEnv(provider: ExternalSessionProvider, configHome: string | null): NodeJS.ProcessEnv | undefined {
  if (!configHome || !isProviderInstanceProvider(provider)) return undefined;
  return { ...process.env, [PROVIDER_INSTANCE_ENV_KEY[provider]]: configHome };
}

export type LoggerLike = { warn: (message: string, fields?: Record<string, unknown>) => void };

/** What the locator needs of a Recently deleted row. */
export type LocatableChat = {
  externalProvider: ExternalSessionProvider;
  externalId: string;
  /** The account folder the chat ran in, when ADE knows it. */
  configHome: string | null;
};

/** Rows whose copy no agent folder holds still exist; this reports them as gone. */
export function createDeletedChatLocator(logger: LoggerLike) {
  let claudeIndex: { builtAt: number; index: Promise<ClaudeIndex> } | null = null;
  const CLAUDE_INDEX_TTL_MS = 5_000;
  const otherCache = new Map<string, { at: number; found: boolean }>();
  const OTHER_TTL_MS = 30_000;

  const homesFor = (provider: "claude" | "codex", preferred: string | null): string[] => {
    const machine = machineProviderUsageHomes()[provider];
    const ordered = preferred ? [preferred, ...machine] : machine;
    return [...new Set(ordered.map((home) => path.resolve(home)))];
  };

  const claude = (): Promise<ClaudeIndex> => {
    const now = Date.now();
    if (!claudeIndex || now - claudeIndex.builtAt > CLAUDE_INDEX_TTL_MS) {
      claudeIndex = { builtAt: now, index: buildClaudeIndex(homesFor("claude", null)) };
    }
    return claudeIndex.index;
  };

  const locate = async (row: LocatableChat): Promise<DeletedChatSource | null> => {
    if (row.externalProvider === "claude") {
      const hit = (await claude()).get(row.externalId);
      return hit ? { configHome: hit.configHome, env: accountEnv("claude", hit.configHome) } : null;
    }
    if (row.externalProvider === "codex") {
      const home = homesFor("codex", row.configHome)
        .find((candidate) => providerThreadIsInHome("codex", row.externalId, candidate));
      return home ? { configHome: home, env: accountEnv("codex", home) } : null;
    }
    const key = `${row.externalProvider}:${row.externalId}`;
    const cached = otherCache.get(key);
    if (cached && Date.now() - cached.at < OTHER_TTL_MS) {
      return cached.found ? { configHome: null, env: undefined } : null;
    }
    const record = await discoverExternalSessionRecord(row.externalProvider, row.externalId, { includeAdeOwned: true })
      .catch((error: unknown) => {
        // Reported as gone (the row stays hidden), but said, so a reader
        // failure is not mistaken for the agent clearing its copy.
        logger.warn("deleted_chats.locate_failed", {
          provider: row.externalProvider,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    otherCache.set(key, { at: Date.now(), found: record != null });
    return record ? { configHome: null, env: undefined } : null;
  };

  return {
    locate,
    /** After a reopen or a Claude thread move, look again instead of trusting the cache. */
    invalidate: () => {
      claudeIndex = null;
      otherCache.clear();
    },
  };
}
