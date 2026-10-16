/**
 * Devin Cloud session directory over the ACP relay.
 *
 * `devin acp --cloud` answers `session/list` with every cloud session the
 * signed-in account can see, and each row carries what the fleet needs: title,
 * status, unread, repos, pull requests with their head branch, model and
 * platform. It rides the CLI's own `devin auth login`, so listing needs no API
 * token. A list is one short-lived relay process: spawn, initialize, list,
 * exit — about a second — so nothing stays running while no panel is open.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "../logging/logger";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import {
  AcpConnectionClosedError,
  AcpRpcError,
  createAcpConnection,
  initializeAcpConnection,
  type AcpConnection,
} from "./acpHost/acpConnection";
import { devinCloudAcpSessionId, devinCloudDialect, devinCloudBareSessionId } from "./acpHost/acpDialects/devinCloud";
import type { CloudAgentPullRequest, CloudAgentStatus } from "../../../shared/types/cloudAgents";
import { pullRequestNumber } from "../../../shared/cursorCloudRepoMatch";

export type DevinCloudDirectoryEntry = {
  /** Bare id (`<hex>`), the form app.devin.ai uses. */
  id: string;
  title: string;
  status: CloudAgentStatus;
  statusText: string | null;
  unread: boolean;
  url: string | null;
  repos: string[];
  pullRequests: CloudAgentPullRequest[];
  model: string | null;
  platform: string | null;
  origin: string | null;
  excerpt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const RELAY_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 4_000;

const ORIGIN_LABELS: Record<string, string> = {
  api: "API",
  webapp: "Web",
  slack: "Slack",
  teams: "Teams",
  linear: "Linear",
  jira: "Jira",
  cli: "CLI",
  desktop: "Desktop",
  automation: "Automation",
  code_scan: "Code scan",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The number in a GitHub pull request URL (`…/pull/123`). */
function readPullRequests(value: unknown): CloudAgentPullRequest[] {
  if (!Array.isArray(value)) return [];
  const out: CloudAgentPullRequest[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const url = text(record.url);
    if (!url) continue;
    const state = text(record.state)?.toLowerCase() ?? null;
    out.push({
      url,
      number: pullRequestNumber(url),
      state: state === "open" || state === "merged" || state === "closed" || state === "draft" ? state : null,
      title: text(record.title),
      headRef: text(record.headRef),
      baseRef: text(record.baseRef),
      additions: num(record.additions),
      deletions: num(record.deletions),
    });
  }
  return out;
}

/** Map the relay's status fields onto the shared cloud-agent status. */
export function devinDirectoryStatus(meta: Record<string, unknown>): { status: CloudAgentStatus; statusText: string | null } {
  if (meta["cognition.ai/isArchived"] === true) return { status: "archived", statusText: "Archived" };
  const statusEnum = text(meta["cognition.ai/statusEnum"])?.toLowerCase() ?? null;
  const sessionStatus = text(meta["cognition.ai/sessionStatus"])?.toLowerCase() ?? null;
  const outcome = text(meta["cognition.ai/finishedOutcome"])?.toLowerCase() ?? null;
  if (statusEnum === "error" || sessionStatus === "error") return { status: "failed", statusText: "Errored" };
  if (statusEnum === "working") return { status: "working", statusText: "Working" };
  if (statusEnum === "blocked") {
    if (meta["cognition.ai/userActionRequired"] != null || meta["cognition.ai/pendingRequest"] != null) {
      return { status: "needs_you", statusText: "Needs your approval" };
    }
    return { status: "idle", statusText: "Waiting for your reply" };
  }
  if (statusEnum === "finished" || sessionStatus === "exit" || sessionStatus === "suspended") {
    return {
      status: "finished",
      statusText: outcome === "stopped" ? "Stopped" : sessionStatus === "suspended" ? "Asleep" : "Finished",
    };
  }
  return { status: "starting", statusText: "Starting" };
}

function readEntry(raw: unknown): DevinCloudDirectoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const acpId = text(record.sessionId);
  if (!acpId) return null;
  const meta = (record._meta && typeof record._meta === "object" ? record._meta : {}) as Record<string, unknown>;
  const { status, statusText } = devinDirectoryStatus(meta);
  const repos = Array.isArray(meta["cognition.ai/sessionRepos"])
    ? (meta["cognition.ai/sessionRepos"] as unknown[])
      .map((repo) => (repo && typeof repo === "object" ? text((repo as Record<string, unknown>).name) : null))
      .filter((repo): repo is string => Boolean(repo))
    : [];
  const origin = text(meta["cognition.ai/sessionOrigin"]);
  const excerpt = text(meta["cognition.ai/messageExcerpts"]);
  return {
    id: devinCloudBareSessionId(acpId),
    title: text(record.title) ?? excerpt?.slice(0, 80) ?? "Devin session",
    status,
    statusText,
    unread: meta["cognition.ai/isUnread"] === true,
    url: text(meta["cognition.ai/url"]),
    repos,
    pullRequests: readPullRequests(meta["cognition.ai/sessionPRs"]),
    model: text(meta["cognition.ai/devinVersionOverride"]),
    platform: text(meta["cognition.ai/platform"]),
    origin: origin ? ORIGIN_LABELS[origin] ?? origin : null,
    excerpt: excerpt ? excerpt.slice(0, 240) : null,
    createdAt: text(meta["cognition.ai/createdAt"]),
    updatedAt: text(record.updatedAt) ?? text(meta["cognition.ai/sortUpdatedAt"]),
  };
}

type RelayClient = Pick<AcpConnection, "request" | "notify">;

/** The relay's own words for an ACP error, without the host's prefix. */
function relayErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^ACP \S+ failed \(-?\d+\): /, "");
}

/**
 * One scripted relay session: spawn `devin acp --cloud`, initialize, run
 * `script`, exit. It rides the ACP host's connection, so framing, the
 * handshake and the process-tree kill are the chat's own. Session updates the
 * relay streams meanwhile (a load's replay) are ignored. Rejects on timeout, a
 * JSON-RPC error, or the process dying first.
 */
async function withRelay<T>(
  args: { binaryPath: string; env: NodeJS.ProcessEnv; cwd: string },
  script: (client: RelayClient) => Promise<T>,
): Promise<T> {
  const spawnPlan = devinCloudDialect.buildSpawnPlan({ binaryPath: args.binaryPath, cwd: args.cwd, baseEnv: args.env });
  let stderrTail = "";
  const connection = createAcpConnection({
    dialect: devinCloudDialect,
    spawnPlan,
    // Spawned here rather than by the connection so stdin gets an error
    // listener: a relay that dies mid-write raises EPIPE on the pipe, and an
    // unheard stream error is an uncaught exception in the main process.
    spawnOverride: (plan) => {
      const invocation = resolveCliSpawnInvocation(plan.command, plan.args, plan.env);
      const child = spawn(invocation.command, invocation.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["pipe", "pipe", "pipe"],
        // A process group on POSIX so the tree kill reaches the relay's
        // children; Windows uses `taskkill /T /F` instead.
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      }) as ChildProcessWithoutNullStreams;
      child.stdin.on("error", (error) => connection.dispose(`relay stdin failed: ${error.message}`));
      return child;
    },
  });
  connection.onExit((exit) => {
    stderrTail = exit.stderrTail;
  });
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      (async () => {
        await initializeAcpConnection({ connection, dialect: devinCloudDialect, timeoutMs: RELAY_TIMEOUT_MS });
        return await script(connection);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Devin Cloud did not answer in time.")), RELAY_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof AcpConnectionClosedError) {
      const hint = /not logged in|auth login|unauthori/i.test(stderrTail) ? " Run `devin auth login`." : "";
      throw new Error(`Devin Cloud relay exited.${hint}`);
    }
    if (error instanceof AcpRpcError) throw new Error(relayErrorText(error) || "Devin Cloud rejected the request.");
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    // Ends stdin, then SIGTERM to the tree with a SIGKILL after the grace.
    connection.dispose("devin cloud directory done");
  }
}

export function createDevinCloudDirectory(deps: {
  logger: Logger;
  cwd: string;
  /** Resolves the `devin` binary and the env to run it with; null when absent. */
  resolveBinary: () => Promise<{ path: string; env: NodeJS.ProcessEnv } | null>;
}) {
  let cache: { at: number; entries: DevinCloudDirectoryEntry[] } | null = null;

  const relay = async <T>(script: (client: RelayClient) => Promise<T>): Promise<T> => {
    const binary = await deps.resolveBinary();
    if (!binary) throw new Error("Install the devin CLI and run `devin auth login` to use Devin Cloud.");
    return await withRelay({ binaryPath: binary.path, env: binary.env, cwd: deps.cwd }, script);
  };

  /** Join a session long enough to run `action` on it. */
  const withSession = async (id: string, action: (client: RelayClient, acpId: string) => Promise<void>) => {
    const acpId = devinCloudAcpSessionId(id);
    await relay(async (client) => {
      await client.request("session/load", { sessionId: acpId, cwd: deps.cwd, mcpServers: [] });
      await action(client, acpId);
    });
    cache = null;
  };

  /** Stop what the session is doing. It stays resumable. */
  const cancel = async (id: string): Promise<void> => {
    await withSession(id, async (client, acpId) => {
      client.notify("session/cancel", { sessionId: acpId });
      // A notification has no answer; give the relay a beat to forward it
      // before the process goes away.
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
  };

  /** Archive (and suspend) the session: the relay's own `/archive` command. */
  const archive = async (id: string): Promise<void> => {
    await withSession(id, async (client, acpId) => {
      await client.request("session/prompt", { sessionId: acpId, prompt: [{ type: "text", text: "/archive" }] });
    });
  };
  let inflight: Promise<DevinCloudDirectoryEntry[]> | null = null;

  const list = async (options?: { force?: boolean }): Promise<DevinCloudDirectoryEntry[]> => {
    if (!options?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
    if (inflight) return await inflight;
    inflight = (async () => {
      const result = await relay((client) => client.request<{ sessions?: unknown[] }>("session/list", {}));
      const entries = (result?.sessions ?? []).map(readEntry).filter((entry): entry is DevinCloudDirectoryEntry => entry !== null);
      cache = { at: Date.now(), entries };
      return entries;
    })().finally(() => {
      inflight = null;
    });
    try {
      return await inflight;
    } catch (error) {
      deps.logger.warn("devin_cloud_directory.list_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const find = async (id: string, options?: { force?: boolean }): Promise<DevinCloudDirectoryEntry | null> => {
    const bare = devinCloudBareSessionId(id);
    const entries = await list(options);
    return entries.find((entry) => entry.id === bare) ?? null;
  };

  const invalidate = () => {
    cache = null;
  };

  return { list, find, invalidate, cancel, archive };
}

export type DevinCloudDirectory = ReturnType<typeof createDevinCloudDirectory>;
