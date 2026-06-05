import type {
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
} from "../../shared/types";

type CacheEntry = {
  value?: AgentChatSlashCommand[];
  promise?: Promise<AgentChatSlashCommand[]>;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5_000;
const slashCommandCache = new Map<string, CacheEntry>();

function cacheKey(args: AgentChatSlashCommandsArgs): string {
  const projectRoot = args.projectRoot?.trim() || "__active_project__";
  if (args.sessionId?.trim()) {
    return `project:${projectRoot}:session:${args.sessionId.trim()}`;
  }
  const lane = args.laneId?.trim() || "__no_lane__";
  const provider = args.provider?.trim() || "__no_provider__";
  return `project:${projectRoot}:lane:${lane}:provider:${provider}`;
}

export async function getAgentChatSlashCommandsCached(
  args: AgentChatSlashCommandsArgs,
  options?: { force?: boolean; ttlMs?: number },
): Promise<AgentChatSlashCommand[]> {
  const key = cacheKey(args);
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const cached = slashCommandCache.get(key);

  if (cached?.promise) return cached.promise;
  if (!options?.force && cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  const promise = window.ade.agentChat.slashCommands(args).then((value) => {
    const current = slashCommandCache.get(key);
    if (current?.promise === promise) {
      slashCommandCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
    }
    return value;
  }).catch((error) => {
    const current = slashCommandCache.get(key);
    if (current?.promise === promise) slashCommandCache.delete(key);
    throw error;
  });

  slashCommandCache.set(key, {
    promise,
    expiresAt: now + ttlMs,
  });
  return promise;
}

export function invalidateAgentChatSlashCommandsCache(args?: AgentChatSlashCommandsArgs): void {
  if (!args) {
    slashCommandCache.clear();
    return;
  }
  slashCommandCache.delete(cacheKey(args));
}
