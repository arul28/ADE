import type { AgentChatEventEnvelope } from "../../../../shared/types";
import type { ExternalChatHistoryImportOptions } from "../../chat/externalChatHistoryImport";
import { resolveOpenCodeBinaryPath } from "../../opencode/openCodeBinaryManager";
import { runOpenCodeToFile } from "../openCodeCliOutput";
import { EnvelopeSink, isRecord, str, toIso } from "./common";

export const OPENCODE_EXPORT_TIMEOUT_MS = 15_000;
/** A long session with screenshots exports tens of MB; past this, fall back. */
export const OPENCODE_EXPORT_MAX_BYTES = 96 * 1024 * 1024;

/**
 * `opencode export <id>` prints `{ info, messages: [{ info, parts }] }` on
 * stdout (a progress line goes to stderr). Returns null on any failure — the
 * caller falls back to the sampled messages. See `runOpenCodeToFile` for why
 * stdout is read from a file.
 */
export async function runOpenCodeExport(args: {
  sessionId: string;
  cwd?: string | null;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<unknown | null> {
  const executable = resolveOpenCodeBinaryPath();
  if (!executable) return null;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(args.env ?? {}), NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  try {
    const result = await runOpenCodeToFile({
      executable,
      argv: ["export", "--pure", args.sessionId],
      cwd: args.cwd?.trim() || args.homeDir || null,
      env,
      timeoutMs: OPENCODE_EXPORT_TIMEOUT_MS,
      maxBytes: OPENCODE_EXPORT_MAX_BYTES,
    });
    if (!result.ok || !result.stdout.trim()) return null;
    const start = result.stdout.indexOf("{");
    return start < 0 ? null : JSON.parse(result.stdout.slice(start));
  } catch {
    return null;
  }
}

/**
 * An OpenCode export as content events. User and assistant `text` parts,
 * `reasoning` parts, and `tool` parts (`callID`, `tool`, `state { status,
 * input, output, error }`) map one to one; step markers, patches, snapshots
 * and synthetic user parts are dropped.
 */
export function openCodeExportToEvents(
  exported: unknown,
  options: ExternalChatHistoryImportOptions,
  fallbackBaseMs: number,
): AgentChatEventEnvelope[] | null {
  if (!isRecord(exported) || !Array.isArray(exported.messages)) return null;
  const sink = new EnvelopeSink(options);
  let tick = 0;
  for (const entry of exported.messages) {
    if (!isRecord(entry) || !isRecord(entry.info)) continue;
    const info = entry.info;
    const role = str(info.role);
    const messageId = str(info.id) ?? `opencode:${tick}`;
    const created = isRecord(info.time) ? info.time.created : null;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const userTexts: string[] = [];
    parts.forEach((part, partIndex) => {
      tick += 1;
      if (!isRecord(part)) return;
      const partTime = isRecord(part.time) ? part.time.start : null;
      const timestamp = toIso(partTime ?? created, fallbackBaseMs + tick);
      const partId = str(part.id) ?? `${messageId}:${partIndex}`;
      const type = str(part.type);
      if (role === "user") {
        if (type === "text" && part.synthetic !== true && part.ignored !== true) userTexts.push(str(part.text) ?? "");
        return;
      }
      if (role !== "assistant") return;
      if (type === "text" && part.synthetic !== true) {
        sink.text(str(part.text) ?? "", timestamp, partId);
      } else if (type === "reasoning") {
        sink.reasoning(str(part.text) ?? "", timestamp, partId);
      } else if (type === "tool") {
        const state = isRecord(part.state) ? part.state : {};
        const itemId = str(part.callID) ?? partId;
        const tool = str(part.tool) ?? "tool";
        sink.toolCall(tool, state.input ?? {}, timestamp, itemId);
        const status = str(state.status);
        if (status === "completed" || status === "error") {
          const endTime = isRecord(state.time) ? state.time.end : null;
          sink.toolResult(
            tool,
            status === "error" ? state.error ?? "" : state.output ?? "",
            toIso(endTime ?? partTime ?? created, fallbackBaseMs + tick),
            itemId,
            status === "error",
          );
        }
      }
    });
    if (role === "user" && userTexts.length) {
      sink.user(userTexts.join("\n"), toIso(created, fallbackBaseMs + tick), messageId);
    }
  }
  return sink.out;
}
