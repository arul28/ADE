import path from "node:path";
import type {
  AgentChatPermissionMode,
  EffectiveProjectConfig,
  ProjectConfigFile,
} from "../../../shared/types";
import { ADE_OPENCODE_LAUNCH_ENV, readOpenCodeLaunchIntent } from "../../../shared/cliLaunch";
import { decodeOpenCodeRegistryId, getModelById, resolveOpenCodeFastEffortSelection } from "../../../shared/modelRegistry";
import { commandArrayToLine, parseCommandLine } from "../../../shared/shell";
import type { Logger } from "../logging/logger";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";
import { adePromptAgentSkillRoots } from "../skills/agentSkillRuntimeService";
import {
  adeOpenCodeMode,
  buildOpenCodeConfig,
  openCodeAgentFor,
  openCodeSessionRulesFor,
  resolveOpenCodeModelRef,
  sharedOpenCodeProfileFor,
} from "./openCodeConfig";
import { readOpenCodeDb, resolveAdeOpenCodeDbPath } from "./openCodeCredentials";
import { lastOpenCodeDiscoveredLocalModels } from "./openCodeInventory";
import {
  applyOpenCodeSessionContext,
  isOpenCodeNotFoundError,
  openCodeSessionEnvironment,
  type OpenCodeModelRef,
} from "./openCodeSession";
import { acquireOpenCodeServer, type OpenCodeServerLease } from "./openCodeServer";

/**
 * A tracked OpenCode TUI in an ADE terminal, attached to ADE's shared server.
 *
 * By default the 2.0 TUI connects to OpenCode's shared background service,
 * which runs on the user's default data home and migrates their v1 store in
 * place. ADE instead launches `opencode --server <ADE url> --session <id>`
 * with `OPENCODE_SERVER_PASSWORD` in the PTY environment (verified on 2.0.18:
 * without it the TUI refuses the server instead of falling back).
 *
 * The TUI takes no `--agent` or `--model` flag, and ADE's agents and rules
 * live on the server, so ADE creates the session itself — with the ADE agent
 * for the permission mode, the model, ADE's instructions as an instruction
 * entry, and the terminal's environment for the agent's shell commands — and
 * the TUI opens that session. The server URL and password change on every
 * server start, so neither is ever persisted: the stored command stays a plain
 * `opencode --session <id>`.
 */

/**
 * The ADE instruction contract a tracked OpenCode terminal session receives.
 *
 * Built from the same `buildCodingAgentSystemPrompt` the OpenCode chat runtime
 * uses, with the same `runtime: "opencode"` descriptor, so chat and terminal
 * agree on one ADE base prompt. Only the framing header is terminal-specific.
 */
export function buildOpenCodeAdeInstructions(args: {
  laneWorktreePath: string;
  permissionMode: AgentChatPermissionMode | null | undefined;
  sessionActivityGuidance?: string | null;
}): string {
  // `config-toml` means "use my own OpenCode configuration": ADE sets no agent
  // for it, so claiming edit mode would assert a policy ADE did not set. The
  // shared builder has no "defer to the provider" tier, so it borrows edit's
  // shape and the permission sentence is superseded below.
  const providerConfig = args.permissionMode === "config-toml";
  const harnessMode = adeOpenCodeMode(args.permissionMode) ?? "edit";
  return [
    "# ADE session instructions",
    "",
    buildCodingAgentSystemPrompt({
      cwd: args.laneWorktreePath,
      mode: harnessMode === "plan" ? "planning" : "coding",
      permissionMode: harnessMode,
      interactive: true,
      runtime: "opencode",
      adeSkillRoots: adePromptAgentSkillRoots({ cwd: args.laneWorktreePath }),
    }),
    ...(providerConfig
      ? [
          "",
          "## Permission policy",
          "This session runs under your own OpenCode configuration. ADE sets no permission policy for it, so ignore any permission tier named above: follow your configuration's rules, and treat it as authoritative wherever it is more restrictive.",
        ]
      : []),
    ...(args.sessionActivityGuidance?.trim()
      ? ["", "## Session activity", args.sessionActivityGuidance.trim()]
      : []),
    "",
  ].join("\n");
}

const OPENCODE_EXECUTABLE_NAMES = new Set(["opencode", "opencode.exe", "opencode.cmd", "opencode.bat"]);

function isOpenCodeExecutable(command: string | null | undefined): boolean {
  const trimmed = command?.trim();
  if (!trimmed) return false;
  return OPENCODE_EXECUTABLE_NAMES.has(path.basename(trimmed.replace(/\\/g, "/")).toLowerCase());
}

type SessionSelector = { kind: "session"; id: string } | { kind: "continue" } | null;

/**
 * Flags ADE owns or that 2.0 rejects, with whether each takes a value. A
 * persisted 1.x resume command still carries `--agent`, `--model`, or the
 * `--mini --replay-limit` shape, and the 2.0 TUI exits on any of them.
 */
const STRIPPED_FLAGS: ReadonlyMap<string, boolean> = new Map([
  ["--server", true],
  ["--standalone", false],
  ["--agent", true],
  ["--model", true],
  ["-m", true],
  ["--variant", true],
  ["--mini", false],
  ["--replay", false],
  ["--no-replay", false],
  ["--replay-limit", true],
]);

/** Split the TUI argv into its session selector and the arguments ADE keeps. */
function splitOpenCodeArgs(argv: readonly string[]): { selector: SessionSelector; rest: string[] } {
  let selector: SessionSelector = null;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, null];
    if (flag === "--session" || flag === "-s") {
      const value = inline ?? argv[index + 1];
      if (inline == null) index += 1;
      if (value?.trim()) selector = { kind: "session", id: value.trim() };
      continue;
    }
    if (flag === "--continue" || flag === "-c") {
      if (!selector) selector = { kind: "continue" };
      continue;
    }
    const takesValue = STRIPPED_FLAGS.get(flag);
    if (takesValue !== undefined) {
      if (takesValue && inline == null) index += 1;
      continue;
    }
    rest.push(arg);
  }
  return { selector, rest };
}

const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&"]);

/** The `opencode …` invocation of a command line, past any leading assignments. */
function parseOpenCodeCommandLine(startupCommand: string): { command: string; args: string[] } | null {
  if (!startupCommand.trim()) return null;
  const tokens = parseCommandLine(startupCommand, { platform: "linux" });
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1;
  const command = tokens[index];
  if (!command || !isOpenCodeExecutable(command)) return null;
  const args = tokens.slice(index + 1);
  if (args.some((token) => SHELL_OPERATORS.has(token))) {
    // Only a plain invocation can be pointed at ADE's server. Anything else
    // would run the TUI against OpenCode's own background service.
    throw new Error("ADE cannot attach this OpenCode command to its server: run `opencode` on its own in this terminal.");
  }
  return { command, args };
}

/**
 * The terminal's model and effort as an OpenCode model reference. A registry
 * model resolves its effort variant exactly as a chat does; a bare
 * `provider/model` the registry does not know sends the effort as its variant.
 */
function modelRefFor(model: string | null | undefined, reasoningEffort: string | null | undefined): OpenCodeModelRef | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  const effort = reasoningEffort?.trim() || null;
  const descriptor = getModelById(trimmed);
  if (descriptor) {
    const base = resolveOpenCodeModelRef(descriptor);
    const selection = resolveOpenCodeFastEffortSelection(descriptor, { fastMode: false, reasoningEffort: effort });
    return {
      providerID: base.providerID,
      id: selection.modelId ?? base.id,
      ...(selection.variant ? { variant: selection.variant } : {}),
    };
  }
  let ref: { providerID: string; id: string } | null = null;
  const decoded = decodeOpenCodeRegistryId(trimmed);
  if (decoded) ref = { providerID: decoded.openCodeProviderId, id: decoded.openCodeModelId };
  if (!ref) {
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) return null;
    ref = { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
  }
  return { ...ref, ...(effort ? { variant: effort } : {}) };
}

export type OpenCodeTerminalAttachment = {
  /** Held for the terminal's lifetime; release it when the PTY exits. */
  lease: OpenCodeServerLease;
  sessionId: string;
  /** The session existed before this launch. */
  resumed: boolean;
  directArgs: string[];
  startupCommand: string;
  env: NodeJS.ProcessEnv;
};

/**
 * Point a terminal's OpenCode launch at ADE's shared server. Returns null when
 * the launch does not run `opencode`.
 */
export async function attachOpenCodeTerminal(args: {
  directCommand: string | null;
  directArgs: readonly string[];
  startupCommand: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  laneWorktreePath: string;
  permissionMode: AgentChatPermissionMode | null;
  model: string | null;
  reasoningEffort: string | null;
  sessionActivityGuidance: string | null;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  ownerId: string;
  logger: Logger;
}): Promise<OpenCodeTerminalAttachment | null> {
  const direct = isOpenCodeExecutable(args.directCommand) ? { args: [...args.directArgs] } : null;
  const line = parseOpenCodeCommandLine(args.startupCommand);
  if (!direct && !line) return null;
  const intent = readOpenCodeLaunchIntent(args.startupCommand, args.env as Record<string, string | undefined>);
  const permissionMode = args.permissionMode ?? intent?.permissionMode ?? null;
  const agent = openCodeAgentFor(permissionMode);
  // With no ADE mode the TUI's own agent rules apply, so the session keeps none.
  const sessionRules = agent ? openCodeSessionRulesFor(permissionMode).rules : null;
  const model = modelRefFor(args.model ?? intent?.model, args.reasoningEffort ?? intent?.reasoningEffort);
  const { selector, rest } = splitOpenCodeArgs(direct?.args ?? line!.args);
  const lineRest = direct && line ? splitOpenCodeArgs(line.args).rest : rest;

  const lease = await acquireOpenCodeServer({
    profile: sharedOpenCodeProfileFor(args.projectConfig),
    config: buildOpenCodeConfig({
      projectConfig: args.projectConfig,
      discoveredLocalModels: lastOpenCodeDiscoveredLocalModels(),
    }),
    // A running server keeps the chats' config; this one only seeds a new server.
    configMode: "if-starting",
    ownerKind: "terminal",
    ownerId: args.ownerId,
    logger: args.logger,
  });
  try {
    const client = lease.client;
    let sessionId: string | null = null;
    let resumed = false;
    // A resumed session takes the launch's mode, whichever way it was found.
    const applyMode = async (existing: { id: string; agent?: string }): Promise<void> => {
      if (agent && existing.agent !== agent) {
        await client.session.switchAgent({ sessionID: existing.id, agent });
      }
      if (sessionRules) await client.session.update({ sessionID: existing.id, permissions: sessionRules });
    };
    if (selector?.kind === "session") {
      try {
        const existing = await client.session.get({ sessionID: selector.id });
        sessionId = existing.id;
        resumed = true;
        await applyMode(existing);
      } catch (error) {
        if (!isOpenCodeNotFoundError(error)) throw error;
        // A 1.x terminal session lived in the user's own store, which ADE's
        // server never opens. A fresh session beats a TUI that exits on launch.
        args.logger.warn("opencode.terminal_session_missing", { sessionId: selector.id });
      }
    } else if (selector?.kind === "continue") {
      const listed = await client.session.list({ directory: args.cwd, parentID: null, limit: 1, order: "desc" });
      const latest = listed.data[0];
      if (latest) {
        sessionId = latest.id;
        resumed = true;
        await applyMode(latest);
      }
    }
    if (!sessionId) {
      const created = await client.session.create({
        location: { directory: args.cwd },
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(sessionRules ? { permissions: sessionRules } : {}),
      });
      sessionId = created.id;
    }
    try {
      await applyOpenCodeSessionContext({ client, sessionId }, {
        instructions: buildOpenCodeAdeInstructions({
          laneWorktreePath: args.laneWorktreePath,
          permissionMode,
          sessionActivityGuidance: args.sessionActivityGuidance,
        }),
        // The agent's shell commands run in the server process, not in the TUI,
        // so the terminal's own environment (ADE identity, lane context, PATH)
        // is handed to the session explicitly.
        environment: openCodeSessionEnvironment(args.env),
      });
    } catch (error) {
      // The TUI still works without ADE's context; say so rather than fail the launch.
      args.logger.warn("opencode.terminal_context_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const attachArgs = ["--server", lease.url, "--session", sessionId];
    const env: NodeJS.ProcessEnv = { ...args.env, OPENCODE_SERVER_PASSWORD: lease.password };
    delete env.OPENCODE_PASSWORD;
    delete env[ADE_OPENCODE_LAUNCH_ENV];
    return {
      lease,
      sessionId,
      resumed,
      directArgs: direct ? [...attachArgs, ...rest] : [...args.directArgs],
      // Leading assignments are dropped: the environment carries what the TUI
      // needs, and a bare argv re-renders cleanly for Windows shells.
      startupCommand: line
        ? commandArrayToLine([line.command, ...attachArgs, ...lineRest], { platform: "linux" })
        : args.startupCommand,
      env,
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

/**
 * Top-level sessions in ADE's own OpenCode store, newest first, read-only. A
 * terminal that lost its resume target finds it here; asking a CLI instead
 * would reach OpenCode's background service and the user's store.
 */
export function listAdeOpenCodeSessions(limit = 80): Array<{
  id: string;
  directory: string;
  createdAt: number | null;
  updatedAt: number | null;
}> {
  return readOpenCodeDb(resolveAdeOpenCodeDbPath(), [], (db) => {
    const rows = db.prepare(`
      SELECT id AS id, directory AS directory, time_created AS createdAt, time_updated AS updatedAt
        FROM session_v2
       WHERE parent_id IS NULL
       ORDER BY time_created DESC
       LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      if (typeof row.id !== "string" || typeof row.directory !== "string") return [];
      return [{
        id: row.id,
        directory: row.directory,
        createdAt: typeof row.createdAt === "number" ? row.createdAt : null,
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
      }];
    });
  });
}
