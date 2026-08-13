import type {
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
  OpenProjectBinding,
} from "../../shared/types";
import { subscribeToPluginChanges } from "./pluginRuntimeBridge";

type CacheEntry = {
  value?: AgentChatSlashCommand[];
  promise?: Promise<AgentChatSlashCommand[]>;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5_000;
const slashCommandCache = new Map<string, CacheEntry>();

/**
 * A plugin's commands come from the same host list as the runtime's, so
 * uninstalling or disabling one has to drop its commands from the menu now
 * rather than whenever the TTL happens to lapse — otherwise a command the user
 * just removed stays selectable, and selecting it invokes a plugin that is no
 * longer installed.
 *
 * Subscribed lazily on first use so a build with no plugin namespace, and a
 * test that never touches this module, pay nothing.
 */
let pluginChangeUnsubscribe: (() => void) | null = null;

function ensurePluginChangeInvalidation(): void {
  if (pluginChangeUnsubscribe) return;
  // Returns a no-op unsubscribe on a build with no plugin namespace, which is
  // the right answer there: nothing contributes commands, so nothing can
  // invalidate them either.
  pluginChangeUnsubscribe = subscribeToPluginChanges((event) => {
    // `status` is child-process health; it cannot add or remove a command.
    if (event.kind === "status") return;
    slashCommandCache.clear();
  });
}

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
  return `binding:${pin?.key ?? "__active_binding__"}:${cacheScope(args)}`;
}

export async function getAgentChatSlashCommandsCached(
  args: AgentChatSlashCommandsArgs,
  options?: { force?: boolean; ttlMs?: number; pin?: OpenProjectBinding | null },
): Promise<AgentChatSlashCommand[]> {
  ensurePluginChangeInvalidation();
  const key = cacheKey(args, options?.pin);
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const cached = slashCommandCache.get(key);

  if (cached?.promise) return cached.promise;
  if (!options?.force && cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  const promise = (
    options?.pin
      ? window.ade.agentChat.slashCommands(args, options.pin)
      : window.ade.agentChat.slashCommands(args)
  ).then((value) => {
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
  const suffix = `:${cacheScope(args)}`;
  for (const key of slashCommandCache.keys()) {
    if (key.endsWith(suffix)) slashCommandCache.delete(key);
  }
}
