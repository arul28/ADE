/**
 * How one ADE chat launch starts the user's MCP servers, for the chat
 * service: the machine login's servers an ADE account lacks, `npx` servers
 * without npm's launcher, and the registry's servers minus the ones a
 * provider would otherwise run twice. The rules live in
 * `mcpUserServersForLaunch.ts` and `npxDirectLaunch.ts`; this is the seam the
 * chat service calls, one function per launch step.
 */

import type { CallerMcpServers } from "../../../shared/callerMcpServers";
import { providerOwnMcpServerNames } from "./mcpProviderConfigScan";
import {
  claudeUserServersForLaunch,
  NPX_DIRECT_OWN_SERVER_PROVIDERS,
  prepareClaudeUserServers,
  prepareProviderUserNpxDirect,
  providerUserNpxDirectServers,
  resolveCodexUserServers,
} from "./mcpUserServersForLaunch";
import { sharedNpxDirectLauncher, withDirectLaunchEnv } from "./npxDirectLaunch";

type Logger = { info: (event: string, data: Record<string, unknown>) => void; warn: (event: string, data: Record<string, unknown>) => void };

/** The parts of a chat a launch step reads. */
export type ChatMcpLaunchTarget = {
  provider: string;
  /** The chat asked ADE to withhold the user's own MCP config, or runs the light profile. */
  ignoresUserMcp: boolean;
  cwd: string;
  /** The env the provider runs with (its account's config home included). */
  env: NodeJS.ProcessEnv;
};

/** The Claude query options the Claude step reads and extends. */
export type ClaudeMcpOptions = {
  strictMcpConfig?: boolean;
  settingSources?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  mcpServers?: Record<string, unknown>;
};

function servesOwnServers(provider: string): boolean {
  return (NPX_DIRECT_OWN_SERVER_PROVIDERS as readonly string[]).includes(provider);
}

export function createChatUserMcp(args: { projectRoot: string; logger?: Logger | null }) {
  const launcher = sharedNpxDirectLauncher(args.logger ?? null);

  return {
    /**
     * The registry's servers as this provider should get them: a name the
     * provider's own config also has is left to it when the provider cannot
     * drop its own copy (an imported server is a copy, not a move), and
     * `npx` servers start without npm's launcher. ADE hands these over itself,
     * so the rewrite cannot add a copy. Synchronous: a tag npx would check
     * online starts that check and is re-pointed from the next launch on.
     */
    registryServers(target: Pick<ChatMcpLaunchTarget, "provider" | "cwd">, registry: CallerMcpServers): CallerMcpServers | null {
      const ownNames = providerOwnMcpServerNames(target.provider, { cwd: target.cwd });
      const servers: CallerMcpServers = {};
      for (const [name, server] of Object.entries(registry)) {
        if (ownNames.has(name)) continue;
        if (server.type !== "stdio") {
          servers[name] = server;
          continue;
        }
        const resolved = launcher.resolve({
          command: server.command,
          args: server.args ?? [],
          cwd: target.cwd,
          env: { ...process.env, ...(server.env ?? {}) },
        });
        servers[name] = resolved
          ? { ...server, command: resolved.command, args: resolved.args, env: withDirectLaunchEnv(server.env, resolved) }
          : server;
      }
      return Object.keys(servers).length ? servers : null;
    },

    /** Copilot, Cursor, OpenCode: the user's own `npx` servers re-pointed; null for other providers. */
    providerServers(target: ChatMcpLaunchTarget): CallerMcpServers | null {
      if (!servesOwnServers(target.provider) || target.ignoresUserMcp) return null;
      const servers = providerUserNpxDirectServers(launcher, target);
      return Object.keys(servers).length ? servers : null;
    },

    /** The registry answers `providerServers` needs, fetched before the runtime starts. */
    async prepareProviderServers(target: ChatMcpLaunchTarget): Promise<void> {
      if (!servesOwnServers(target.provider) || target.ignoresUserMcp) return;
      await prepareProviderUserNpxDirect(launcher, target);
    },

    /** Codex: the thread config overlay entries for the user's own servers. */
    codexThreadServers(target: Omit<ChatMcpLaunchTarget, "provider">, skipNames: ReadonlySet<string>) {
      if (target.ignoresUserMcp) return Promise.resolve({});
      return resolveCodexUserServers(launcher, { env: target.env, cwd: target.cwd, skipNames });
    },

    /**
     * Claude, first half: the registry answers, fetched before the query's
     * options are built (for the superset of setting sources), so nothing is
     * awaited between building them and starting the query.
     */
    prepareClaude(target: Pick<ChatMcpLaunchTarget, "cwd" | "env">): Promise<void> {
      return prepareClaudeUserServers(launcher, {
        env: target.env,
        cwd: target.cwd,
        projectRoots: [args.projectRoot],
        settingSources: ["user", "local"],
      });
    },

    /**
     * Claude, second half: add the user's servers to the launch's MCP config.
     * A server named there replaces the same name from `.claude.json`; every
     * other server of the user's still loads. Nothing when the query ignores
     * the user's MCP config.
     */
    applyClaude(options: ClaudeMcpOptions): void {
      if (options.strictMcpConfig || !options.settingSources?.length || !options.cwd) return;
      const servers = claudeUserServersForLaunch(launcher, {
        env: (options.env ?? process.env) as NodeJS.ProcessEnv,
        cwd: options.cwd,
        projectRoots: [args.projectRoot],
        settingSources: options.settingSources,
        skipNames: new Set(Object.keys(options.mcpServers ?? {})),
      });
      if (Object.keys(servers).length) options.mcpServers = { ...servers, ...(options.mcpServers ?? {}) };
    },
  };
}
