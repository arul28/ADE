/**
 * Moving a tracked agent CLI session (Claude Code, Codex, OpenCode, … run in
 * a Work terminal) to another machine, the way a chat moves.
 *
 * The move itself is the chat move (crossMachineHandoffOrchestrator.ts): the
 * same record, outbox, lane import, retry and move lock. What differs is what
 * the capsule carries and what the destination starts:
 *
 * - The source stops the CLI (never mid-turn unless the person interrupts),
 *   then packs its own conversation file when the agent keeps one ADE can
 *   carry: Claude Code's `<home>/projects/<cwd slug>/<id>.jsonl` (plus its
 *   `<id>/` sidecar folder) and Codex's `<home>/sessions/…/rollout-…-<id>.jsonl`.
 * - The destination writes that file where the agent looks for it there,
 *   under the destination lane's own path (Claude: a new id in the project
 *   folder named after that path, with each record's `cwd` rewritten; Codex:
 *   the same thread id, its `session_meta` / `turn_context` cwd rewritten),
 *   makes the CLI row in the destination lane and resumes it.
 * - Every other agent (OpenCode keeps its sessions in its own server store,
 *   Cursor, Droid, …), a conversation ADE could not find, or a `--brief` move
 *   starts a fresh CLI there with the same launch settings and the handoff
 *   brief as its first prompt, and the result says so.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentChatCliLaunchProvider,
  AgentChatCrossMachineCliMove,
  AgentChatCrossMachineForkTransport,
  AgentChatPermissionMode,
} from "../../../shared/types/chat";
import { readAgentChatPermissionMode } from "../../../shared/types/chat";
import type { TerminalResumeMetadata, TerminalSessionSummary } from "../../../shared/types/sessions";
import { isLaunchProfile } from "../../../shared/cliLaunch";
import type { PermissionLevel } from "../../../shared/permissionLadder";
import { providerFromTool } from "../../utils/terminalSessionSignals";
import { placeClaudeForkFromTransport } from "../externalSessions/claudeSessionTransplant";
import { findCodexRolloutPathBySessionId } from "../externalSessions/discoverCodex";
import {
  CROSS_MACHINE_FORK_MAIN_MAX_UNCOMPRESSED,
  crossMachineForkOversizeError,
  gzipToBase64,
} from "./crossMachineForkTransport";

/** Agents whose own conversation is a file ADE can carry and the CLI resumes. */
const CARRIED_CONVERSATION_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);

const PROVIDER_NAME: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Droid",
  pi: "Pi",
  muse: "Muse",
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
  copilot: "Copilot",
  devin: "Devin",
};

export function cliProviderName(provider: string | null | undefined): string {
  return (provider && PROVIDER_NAME[provider]) || "This CLI";
}

/** The agent a tracked CLI row runs, as its launch names it; null when ADE can't tell. */
export function cliMoveProvider(row: TerminalSessionSummary): AgentChatCliLaunchProvider | null {
  const provider = row.resumeMetadata?.provider ?? providerFromTool(row.toolType ?? null);
  return provider && isLaunchProfile(provider) && (provider as string) !== "shell" ? provider as AgentChatCliLaunchProvider : null;
}


function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The CLI's launch permission mode, the word its launch and resume use. */
export function cliMovePermissionMode(metadata: TerminalResumeMetadata | null | undefined): AgentChatPermissionMode {
  return readAgentChatPermissionMode(metadata?.launch?.permissionMode) ?? readAgentChatPermissionMode(metadata?.permissionMode) ?? "default";
}

/** The CLI's permission mode on the unified ladder (an unknown word reads as ask). */
export function cliMovePermissionLevel(mode: AgentChatPermissionMode): PermissionLevel {
  switch (mode) {
    case "plan": return "plan";
    case "edit": return "auto-edit";
    case "full-auto": return "full-auto";
    default: return "ask";
  }
}

/**
 * The launch settings that travel. The machine-local ones stay: the account
 * id (it travels as its email), a stored API key, Codex's config file choice.
 */
export function cliMoveLaunch(metadata: TerminalResumeMetadata | null | undefined): AgentChatCrossMachineCliMove["launch"] {
  const launch = metadata?.launch ?? {};
  const presetId = text(metadata?.presetId) ?? text(launch.presetId);
  return {
    permissionMode: cliMovePermissionMode(metadata),
    ...(text(launch.model) ? { model: text(launch.model) } : {}),
    ...(text(launch.reasoningEffort) ? { reasoningEffort: text(launch.reasoningEffort) } : {}),
    ...(typeof launch.fastMode === "boolean" ? { fastMode: launch.fastMode } : {}),
    ...(launch.fastTier === "ultrafast" ? { fastTier: "ultrafast" as const } : {}),
    ...(launch.claudePermissionMode ? { claudePermissionMode: launch.claudePermissionMode } : {}),
    ...(launch.codexApprovalPolicy ? { codexApprovalPolicy: launch.codexApprovalPolicy } : {}),
    ...(launch.codexSandbox ? { codexSandbox: launch.codexSandbox } : {}),
    ...(launch.droidPermissionMode ? { droidPermissionMode: launch.droidPermissionMode } : {}),
    ...(launch.musePermissionMode ? { musePermissionMode: launch.musePermissionMode } : {}),
    ...(presetId ? { presetId } : {}),
  };
}

/** Why a CLI of this agent moves as a fresh CLI with a brief, or null when its conversation can travel. */
export function cliFreshReason(provider: string, conversationId: string | null): string | null {
  if (!CARRIED_CONVERSATION_PROVIDERS.has(provider)) {
    return provider === "opencode"
      ? "OpenCode keeps its sessions in its own store on this machine, so the CLI starts fresh there with a brief of the conversation."
      : `${cliProviderName(provider)} keeps its conversation on this machine, so the CLI starts fresh there with a brief of the conversation.`;
  }
  if (!conversationId) {
    return `ADE doesn't know this ${cliProviderName(provider)} CLI's conversation id, so it starts fresh there with a brief of the conversation.`;
  }
  return null;
}

/**
 * The CLI's own conversation, packed for the capsule; null with a reason
 * when it can't travel (not found, compressed, too large). The finders are
 * the service's own: they know every account's config home on this machine.
 */
export function packageCliConversation(args: {
  provider: string;
  conversationId: string;
  laneWorktreePath: string;
  /** The config home the CLI ran under (its account's), searched first. */
  configHome: string | null;
  findClaudeTranscript: (sessionId: string, cwd: string, preferredRoot: string | null) => { transcriptPath: string } | null;
  collectClaudeSideFiles: (sessionId: string, transcriptPath: string) => AgentChatCrossMachineForkTransport["sideFiles"];
  findCodexRollout: (threadId: string, codexHome: string | null) => string | null;
}): { conversation: AgentChatCrossMachineForkTransport; sourcePath: string } | { conversation: null; reason: string } {
  const name = cliProviderName(args.provider);
  const readMain = (filePath: string): Buffer => {
    const size = fs.statSync(filePath).size;
    if (size > CROSS_MACHINE_FORK_MAIN_MAX_UNCOMPRESSED) throw crossMachineForkOversizeError(size);
    return fs.readFileSync(filePath);
  };
  if (args.provider === "claude") {
    const found = args.findClaudeTranscript(args.conversationId, args.laneWorktreePath, args.configHome);
    if (!found) return { conversation: null, reason: `ADE couldn't find this ${name} conversation's file, so the CLI starts fresh there with a brief.` };
    const sideFiles = args.collectClaudeSideFiles(args.conversationId, found.transcriptPath);
    return {
      sourcePath: found.transcriptPath,
      conversation: {
        provider: "claude",
        nativeSessionId: args.conversationId,
        kind: "claude-jsonl",
        mainFile: { name: `${args.conversationId}.jsonl`, ...gzipToBase64(readMain(found.transcriptPath)) },
        ...(sideFiles ? { sideFiles } : {}),
      },
    };
  }
  if (args.provider === "codex") {
    const sourcePath = args.findCodexRollout(args.conversationId, args.configHome);
    if (!sourcePath) return { conversation: null, reason: `ADE couldn't find this ${name} conversation's file, so the CLI starts fresh there with a brief.` };
    if (sourcePath.endsWith(".zst")) {
      return { conversation: null, reason: `This ${name} conversation is stored compressed, so the CLI starts fresh there with a brief.` };
    }
    return {
      sourcePath,
      conversation: {
        provider: "codex",
        nativeSessionId: args.conversationId,
        kind: "codex-rollout",
        mainFile: { name: path.basename(sourcePath), ...gzipToBase64(readMain(sourcePath)) },
      },
    };
  }
  return { conversation: null, reason: cliFreshReason(args.provider, args.conversationId) ?? `${name} can't carry its conversation.` };
}

/**
 * A Codex rollout with its recorded working folder set to `targetCwd`: the
 * `session_meta` header and each `turn_context` record carry the folder the
 * thread ran in, and the resumed CLI runs in the destination lane. Other
 * lines (and lines that are not JSON) stay byte for byte.
 */
export function rewriteCodexRolloutCwd(content: Buffer, targetCwd: string): Buffer {
  const raw = content.toString("utf8");
  const lines = raw.split(/\r?\n/);
  const hadTrailingNewline = /\r?\n$/.test(raw);
  if (hadTrailingNewline) lines.pop();
  const rewritten = lines.map((line) => {
    if (!line.includes("\"cwd\"")) return line;
    try {
      const record = JSON.parse(line) as { type?: unknown; payload?: unknown };
      if (
        (record.type === "session_meta" || record.type === "turn_context")
        && record.payload
        && typeof record.payload === "object"
        && typeof (record.payload as { cwd?: unknown }).cwd === "string"
      ) {
        return JSON.stringify({ ...record, payload: { ...(record.payload as object), cwd: targetCwd } });
      }
    } catch {
      // Not JSON: keep it as it is; Codex reads its own rollouts tolerantly.
    }
    return line;
  });
  return Buffer.from(`${rewritten.join("\n")}${hadTrailingNewline ? "\n" : ""}`, "utf8");
}

async function writeFileReplacing(targetPath: string, content: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  // A sibling first, then rename: a CLI that starts meanwhile never reads half a file.
  const staging = `${targetPath}.ade-move-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.writeFile(staging, content);
    await fs.promises.rename(staging, targetPath);
  } finally {
    await fs.promises.rm(staging, { force: true });
  }
}


/**
 * Writes a moved CLI's conversation where its agent looks on this machine,
 * for a CLI that runs in `targetCwd` under `configHome` (the account's home,
 * else the default). Returns the conversation id the CLI resumes.
 */
export async function placeCliConversation(args: {
  conversation: AgentChatCrossMachineForkTransport;
  mainContent: Buffer;
  sideFiles: Array<{ relPath: string; content: Buffer }>;
  targetCwd: string;
  /** Claude: `CLAUDE_CONFIG_DIR` of the account; Codex: its `CODEX_HOME`. */
  configHome: string;
  /** For tests of a fixed day; the rollout goes under today's date folder. */
  now?: Date;
}): Promise<{ conversationId: string; targetPath: string }> {
  const { conversation } = args;
  if (conversation.provider === "claude" && conversation.kind === "claude-jsonl") {
    // A new id in the project folder named after the destination lane's path,
    // with each record's cwd set to it: `claude --resume <id>` looks there.
    const placed = await placeClaudeForkFromTransport({
      mainContent: args.mainContent,
      mainSessionIdHint: conversation.nativeSessionId,
      sideFiles: args.sideFiles,
      targetCwd: args.targetCwd,
      configDir: args.configHome,
    });
    return { conversationId: placed.newSessionId, targetPath: placed.targetPath };
  }
  if (conversation.provider === "codex" && conversation.kind === "codex-rollout") {
    const threadId = conversation.nativeSessionId;
    const content = rewriteCodexRolloutCwd(args.mainContent, args.targetCwd);
    // A thread that was here before (moved away and back) is replaced where it
    // is: Codex resumes the first file named for the id, and this one is newer.
    const existing = findCodexRolloutPathBySessionId(threadId, { env: { CODEX_HOME: args.configHome } });
    const day = args.now ?? new Date();
    const targetPath = existing ?? path.join(
      args.configHome,
      "sessions",
      String(day.getFullYear()).padStart(4, "0"),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
      conversation.mainFile.name,
    );
    await writeFileReplacing(targetPath, content);
    return { conversationId: threadId, targetPath };
  }
  throw new Error(`${cliProviderName(conversation.provider)} conversations can't be carried between machines.`);
}
