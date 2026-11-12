import type {
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
  OpenProjectBinding,
} from "../../shared/types";
import { cacheScopePin } from "./tabBindingKey";

type CacheEntry = {
  value?: AgentChatSlashCommand[];
  promise?: Promise<AgentChatSlashCommand[]>;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5_000;
const slashCommandCache = new Map<string, CacheEntry>();

function cacheScope(args: AgentChatSlashCommandsArgs): string {
  const projectRoot = args.projectRoot?.trim() || "__active_project__";
  if (args.sessionId?.trim()) {
    return `project:${projectRoot}:session:${args.sessionId.trim()}`;
  }
  const lane = args.laneId?.trim() || "__no_lane__";
  const provider = args.provider?.trim() || "__no_provider__";
  return `project:${projectRoot}:lane:${lane}:provider:${provider}`;
}

function cacheKey(args: AgentChatSlashCommandsArgs, pin?: OpenProjectBinding | null): string {
  return `binding:${cacheScopePin(pin)?.key ?? "__active_binding__"}:${cacheScope(args)}`;
}

export async function getAgentChatSlashCommandsCached(
  args: AgentChatSlashCommandsArgs,
  /** `pin`: the chat's machine. Null: none is online, so there are no commands. */
  options: { force?: boolean; ttlMs?: number; pin: OpenProjectBinding | null },
): Promise<AgentChatSlashCommand[]> {
  const pin = options.pin;
  if (!pin) return [];
  const key = cacheKey(args, pin);
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const cached = slashCommandCache.get(key);

  if (cached?.promise) return cached.promise;
  if (!options?.force && cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  const promise = window.ade.agentChat.slashCommands(args, pin).then((value) => {
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
    // The last list stays readable (`peekAgentChatSlashCommandsCache`) while
    // the new one is read.
    value: cached?.value,
    promise,
    expiresAt: now + ttlMs,
  });
  return promise;
}

/**
 * The last list read for this scope, even an expired one, or undefined. A
 * chat switch shows it at once while the new read is in flight.
 */
export function peekAgentChatSlashCommandsCache(
  args: AgentChatSlashCommandsArgs,
  pin?: OpenProjectBinding | null,
): AgentChatSlashCommand[] | undefined {
  return slashCommandCache.get(cacheKey(args, pin))?.value;
}

export function invalidateAgentChatSlashCommandsCache(args?: AgentChatSlashCommandsArgs): void {
  if (!args) {
    slashCommandCache.clear();
    return;
  }
  const suffix = `:${cacheScope(args)}`;
  for (const key of slashCommandCache.keys()) {
    if (key.endsWith(suffix)) slashCommandCache.delete(key);
  }
}
