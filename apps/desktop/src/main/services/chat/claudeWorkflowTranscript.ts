import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SessionMessage as ClaudeSdkSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeSdkTranscriptPath } from "./claudeThinkingTranscriptRepair";

/**
 * Claude Code writes a dynamic Workflow's agent transcripts under
 * `<session>/subagents/workflows/<runId>/agent-<id>.jsonl`. The SDK's
 * `getSubagentMessages` only searches `<session>/subagents/agent-<id>.jsonl`,
 * so a workflow agent's drill-in reads its file here instead.
 */

const AGENT_ID_PATTERN = /^a[0-9a-z-]{6,240}$/i;
const RUN_DIR_PATTERN = /^wf_[a-z0-9-]{6,}$/i;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 500;
const MAX_OFFSET = 10_000;

/** The transcript lines this reader accepts: a user or assistant turn. */
type WorkflowTranscriptRecord = {
  type: "user" | "assistant";
  uuid?: unknown;
  sessionId?: unknown;
  message?: unknown;
  parent_tool_use_id?: unknown;
  parentToolUseId?: unknown;
  parent_agent_id?: unknown;
  parentAgentId?: unknown;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(line: string): WorkflowTranscriptRecord | null {
  // Most of a transcript is request blobs and attachments; skip them unparsed.
  if (!line.includes('"type"') || (!line.includes('"assistant"') && !line.includes('"user"'))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A torn tail line is normal while Claude Code is still appending.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return record.type === "user" || record.type === "assistant"
    ? record as WorkflowTranscriptRecord
    : null;
}

function toSessionMessage(
  record: WorkflowTranscriptRecord,
  fallback: { claudeSessionId: string; uuid: string },
): ClaudeSdkSessionMessage {
  const message = record.message !== null && typeof record.message === "object"
    ? record.message as Record<string, unknown>
    : null;
  return {
    type: record.type,
    uuid: text(record.uuid) ?? text(message?.id) ?? fallback.uuid,
    session_id: text(record.sessionId) ?? fallback.claudeSessionId,
    message: record.message ?? record,
    parent_tool_use_id: text(record.parent_tool_use_id) ?? text(record.parentToolUseId),
    parent_agent_id: text(record.parent_agent_id) ?? text(record.parentAgentId),
  };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readAgentFile(
  filePath: string,
  args: { agentId: string; claudeSessionId: string; limit: number; offset: number; byteBudget: number },
): Promise<ClaudeSdkSessionMessage[]> {
  // `end` caps the bytes the stream yields, so readline can never buffer a
  // line past the budget however long one record is.
  const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024, end: args.byteBudget - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const page: ClaudeSdkSessionMessage[] = [];
  let seen = 0;
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      const record = readRecord(line);
      if (!record) continue;
      if (seen++ < args.offset) continue;
      page.push(toSessionMessage(record, {
        claudeSessionId: args.claudeSessionId,
        uuid: `workflow-${args.agentId}-${lineNumber}`,
      }));
      if (page.length >= args.limit) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return page;
}

/**
 * Find and read one workflow agent's transcript. Returns null when no workflow
 * run of this Claude session holds the agent. `configHomes` are tried in
 * order; `null` means the process default (`$CLAUDE_CONFIG_DIR` or `~/.claude`).
 */
export async function readClaudeWorkflowAgentMessages(args: {
  configHomes: ReadonlyArray<string | null>;
  cwd: string | null | undefined;
  claudeSessionId: string;
  agentId: string;
  limit?: number;
  offset?: number;
  onUnexpectedError?: (stage: "scan" | "read", error: unknown) => void;
}): Promise<ClaudeSdkSessionMessage[] | null> {
  if (!AGENT_ID_PATTERN.test(args.agentId)) return null;
  const limit = Math.min(args.limit ?? MAX_MESSAGES, MAX_MESSAGES);
  const offset = Math.min(args.offset ?? 0, MAX_OFFSET);
  const fileName = `agent-${args.agentId}.jsonl`;

  for (const configHome of args.configHomes) {
    const parentTranscript = resolveClaudeSdkTranscriptPath(args.claudeSessionId, args.cwd, configHome);
    if (!parentTranscript) continue;
    const workflowsRoot = path.join(parentTranscript.slice(0, -".jsonl".length), "subagents", "workflows");
    let runDirs: string[];
    try {
      runDirs = (await fs.promises.readdir(workflowsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && RUN_DIR_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (!isMissing(error)) args.onUnexpectedError?.("scan", error);
      continue;
    }
    for (const runDir of runDirs) {
      const filePath = path.join(workflowsRoot, runDir, fileName);
      let size: number;
      try {
        size = (await fs.promises.stat(filePath)).size;
      } catch (error) {
        if (!isMissing(error)) args.onUnexpectedError?.("read", error);
        continue;
      }
      if (size === 0) continue;
      try {
        return await readAgentFile(filePath, {
          agentId: args.agentId,
          claudeSessionId: args.claudeSessionId,
          limit,
          offset,
          byteBudget: MAX_READ_BYTES,
        });
      } catch (error) {
        args.onUnexpectedError?.("read", error);
        return null;
      }
    }
  }
  return null;
}
