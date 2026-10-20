/**
 * The user's own MCP servers for one tracked Claude or Codex CLI (a Work
 * terminal ADE launches or resumes), the same set a chat on that account
 * gets (`mcpUserServersForLaunch.ts`), minus any server whose definition
 * carries env or header values: a tracked CLI's command line can be typed
 * into the terminal as text, and a secret must not be.
 */

import fs from "node:fs";
import path from "node:path";

import { providerInstanceLaunchEnv, type ProviderInstanceLaunchTarget, type TrackedCliUserMcp } from "../../../shared/cliLaunch";
import {
  claudeUserServersForLaunch,
  codexUserServerOverlay,
  prepareClaudeUserServers,
  prepareCodexUserServers,
} from "./mcpUserServersForLaunch";
import { createNpxDirectLauncher } from "./npxDirectLaunch";

const launcher = createNpxDirectLauncher();

/**
 * The main checkout of a git worktree (its `.git` file reads
 * `gitdir: <main>/.git/worktrees/<name>`), which Claude keys a project's
 * local-scope servers by. Null for a main checkout or anything unreadable.
 */
function mainCheckoutOf(cwd: string): string | null {
  try {
    const text = fs.readFileSync(path.join(cwd, ".git"), "utf8");
    const gitdir = text.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!gitdir) return null;
    const resolved = path.resolve(cwd, gitdir);
    const worktrees = path.dirname(resolved);
    if (path.basename(worktrees) !== "worktrees") return null;
    return path.dirname(path.dirname(worktrees));
  } catch {
    return null;
  }
}

function hasValues(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && Object.keys(value as object).length > 0;
}

export async function resolveTrackedCliUserMcp(args: {
  provider: string;
  cwd: string | null | undefined;
  projectRoot?: string | null;
  instance?: ProviderInstanceLaunchTarget | null;
  /** A harness preset's env, which can name its own config home. */
  presetEnv?: Record<string, string> | null;
}): Promise<TrackedCliUserMcp | null> {
  const cwd = args.cwd?.trim();
  if (!cwd || (args.provider !== "claude" && args.provider !== "codex")) return null;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...providerInstanceLaunchEnv(args.provider, args.instance),
    ...(args.presetEnv ?? {}),
  };
  try {
    if (args.provider === "codex") {
      const codexArgs = { env, cwd, skipNames: new Set(["computer_use"]) };
      await prepareCodexUserServers(launcher, codexArgs);
      const overlay = Object.fromEntries(
        Object.entries(codexUserServerOverlay(launcher, codexArgs))
          .filter(([, entry]) => !hasValues(entry.env) && !hasValues(entry.http_headers)),
      );
      return Object.keys(overlay).length ? { codex: overlay } : null;
    }
    const claudeArgs = {
      env,
      cwd,
      projectRoots: [args.projectRoot ?? mainCheckoutOf(cwd)].filter((root): root is string => Boolean(root)),
      settingSources: ["user", "local"],
    };
    await prepareClaudeUserServers(launcher, claudeArgs);
    const servers = Object.fromEntries(
      Object.entries(claudeUserServersForLaunch(launcher, claudeArgs))
        .filter(([, server]) => !("env" in server && hasValues(server.env)) && !("headers" in server && hasValues(server.headers))),
    );
    return Object.keys(servers).length ? { claude: servers } : null;
  } catch {
    // Reading the user's configs is best-effort; the CLI still starts with its own.
    return null;
  }
}
