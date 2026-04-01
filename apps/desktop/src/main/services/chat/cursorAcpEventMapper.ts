import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentChatEvent } from "../../../shared/types";

export function simplePathDiff(path: string, oldText: string | null | undefined, newText: string): string {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");
  const out: string[] = [`--- ${path}`, `+++ ${path}`, "@@"];
  for (const line of oldLines) out.push(`-${line}`);
  for (const line of newLines) out.push(`+${line}`);
  return out.join("\n");
}

function toolNameFromKind(kind: string | undefined, title: string): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length) {
    if (
      trimmedTitle.startsWith("mcp__")
      || trimmedTitle.startsWith("functions.")
      || trimmedTitle.startsWith("multi_tool_use.")
      || trimmedTitle.startsWith("web.")
      || /^[A-Za-z][A-Za-z0-9_.-]{1,127}$/.test(trimmedTitle)
    ) {
      return trimmedTitle;
    }
  }
  const k = (kind ?? "other").toLowerCase();
  if (k === "execute") return "bash";
  if (k === "read") return "read_file";
  if (k === "edit" || k === "delete" || k === "move") return "str_replace";
  if (k === "search") return "grep";
  if (k === "fetch") return "fetch";
  if (k === "think") return "think";
  if (trimmedTitle.length) {
    return trimmedTitle.length > 96 ? `${trimmedTitle.slice(0, 93).trimEnd()}...` : trimmedTitle;
  }
  return k || "tool";
}

function normalizeToolName(value: string | undefined | null): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonTextPayload(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore invalid JSON-ish tool text
  }
  return null;
}

function extractToolPayload(
  update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>,
): Record<string, unknown> | null {
  const rawOutput = readObject(update.rawOutput);
  if (rawOutput) return rawOutput;
  for (const block of update.content ?? []) {
    if (block.type !== "content" || !("text" in block) || typeof block.text !== "string") continue;
    const parsed = parseJsonTextPayload(block.text);
    if (parsed) return parsed;
  }
  return null;
}

function buildToolArgs(args: {
  rawInput: unknown;
  title?: string | null;
  kind?: string | null;
  locations?: ReadonlyArray<{ path?: string | null } | null> | null;
}): Record<string, unknown> {
  const parsed = readObject(args.rawInput);
  const base = parsed ? { ...parsed } : {};
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const kind = typeof args.kind === "string" ? args.kind.trim() : "";
  if (title.length && typeof base.title !== "string") {
    base.title = title;
  }
  if (kind.length && typeof base.kind !== "string") {
    base.kind = kind;
  }
  const paths = (args.locations ?? [])
    .map((location) => typeof location?.path === "string" ? location.path.trim() : "")
    .filter(Boolean);
  if (paths.length === 1 && typeof base.path !== "string") {
    base.path = paths[0]!;
  } else if (paths.length > 1 && !Array.isArray(base.paths)) {
    base.paths = paths;
  }
  return base;
}

function buildCursorMemoryNotice(toolName: string, payload: Record<string, unknown> | null): AgentChatEvent | null {
  const normalizedTool = normalizeToolName(toolName);
  if (normalizedTool.includes("memory_pin")) {
    const pinned = payload?.pinned;
    const id = typeof payload?.id === "string" ? payload.id.trim() : "";
    return {
      type: "system_notice",
      noticeKind: "memory",
      message: id.length
        ? `Pinned memory entry${pinned === false ? " update failed" : ""}: ${id}`
        : "Pinned memory entry",
    };
  }
  if (!normalizedTool.includes("memory_add")) return null;

  const saved = payload?.saved;
  const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
  const durability = typeof payload?.durability === "string" ? payload.durability.trim() : "";
  const deduped = payload?.deduped === true;
  const mergedIntoId = typeof payload?.mergedIntoId === "string" ? payload.mergedIntoId.trim() : "";

  if (saved !== true) {
    return {
      type: "system_notice",
      noticeKind: "memory",
      message: `Skipped memory write: ${reason || "write rejected"}`,
    };
  }

  const detailLines = [
    durability.length ? `Durability: ${durability}` : null,
    deduped ? "Merged with existing memory." : null,
    mergedIntoId.length ? `Merged into: ${mergedIntoId}` : null,
    reason.length ? `Reason: ${reason}` : null,
  ].filter((line): line is string => Boolean(line));

  return {
    type: "system_notice",
    noticeKind: "memory",
    message: durability === "candidate"
      ? "Saved to memory as candidate, not promoted"
      : "Saved to memory as promoted knowledge",
    ...(detailLines.length ? { detail: detailLines.join("\n") } : {}),
  };
}

export type CursorAcpMapperMeta = {
  turnId: string;
  previousModeId?: string | null;
};

export type CursorAcpTerminalSnapshot = {
  output: string;
  cwd: string;
  commandLine: string;
  exited: boolean;
  exitCode: number | null;
  truncated: boolean;
};

/** Command item ids look like `${toolCallId}:term:${terminalId}`. */
export function parseAcpTerminalIdFromCommandItemId(itemId: string): string | null {
  const marker = ":term:";
  const i = itemId.lastIndexOf(marker);
  if (i < 0) return null;
  const id = itemId.slice(i + marker.length).trim();
  return id.length ? id : null;
}

export function mapAcpSessionNotificationToChatEvents(
  note: SessionNotification,
  meta: CursorAcpMapperMeta,
  resolveTerminal?: (terminalId: string) => CursorAcpTerminalSnapshot | null | undefined,
): AgentChatEvent[] {
  const { sessionId: _s, update } = note;
  const turnId = meta.turnId;
  const out: AgentChatEvent[] = [];

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const c = update.content;
      if (c?.type === "text" && typeof c.text === "string" && c.text.length) {
        out.push({ type: "text", text: c.text, turnId });
      }
      break;
    }
    case "tool_call": {
      const u = update;
      out.push({
        type: "tool_call",
        tool: toolNameFromKind(u.kind ?? undefined, u.title ?? ""),
        args: buildToolArgs({
          rawInput: u.rawInput,
          title: u.title,
          kind: u.kind ?? undefined,
          locations: u.locations,
        }),
        itemId: u.toolCallId,
        turnId,
      });
      break;
    }
    case "tool_call_update": {
      const u = update;
      const itemId = u.toolCallId;
      const tool = toolNameFromKind(u.kind ?? undefined, u.title ?? "");
      const status = u.status ?? "pending";
      if (status === "pending" || status === "in_progress") {
        out.push({
          type: "tool_call",
          tool,
          args: buildToolArgs({
            rawInput: u.rawInput,
            title: u.title,
            kind: u.kind ?? undefined,
            locations: u.locations,
          }),
          itemId,
          turnId,
        });
      }
      if (u.content) {
        for (const block of u.content) {
          if (block.type === "diff") {
            const path = block.path ?? "file";
            const diff = simplePathDiff(path, block.oldText, block.newText);
            const kind = block.oldText == null || block.oldText === "" ? "create" : "modify";
            out.push({
              type: "file_change",
              path,
              diff,
              kind,
              itemId,
              turnId,
              status: status === "failed" ? "failed" : status === "completed" ? "completed" : "running",
            });
          } else if (block.type === "terminal" && typeof block.terminalId === "string") {
            const snap = resolveTerminal?.(block.terminalId);
            const truncatedNote = snap?.truncated ? "\n…(output truncated)" : "";
            const output = snap
              ? `${snap.output}${truncatedNote}`
              : `(terminal ${block.terminalId})`;
            const commandLine = snap?.commandLine ?? u.title ?? "shell";
            const cwd = snap?.cwd ?? "";
            let cmdStatus: "running" | "completed" | "failed" = "running";
            if (status === "failed") cmdStatus = "failed";
            else if (status === "completed") cmdStatus = "completed";
            else if (snap?.exited) cmdStatus = snap.exitCode === 0 ? "completed" : "failed";
            out.push({
              type: "command",
              command: commandLine,
              cwd,
              output,
              itemId: `${itemId}:term:${block.terminalId}`,
              turnId,
              status: cmdStatus,
              ...(snap?.exited ? { exitCode: snap.exitCode } : {}),
            });
          } else if (block.type === "content" && "text" in block && typeof (block as { text?: string }).text === "string") {
            out.push({
              type: "tool_result",
              tool,
              result: { text: (block as { text: string }).text },
              itemId: `${itemId}:c`,
              logicalItemId: itemId,
              turnId,
              status: status === "failed" ? "failed" : "completed",
            });
          }
        }
      }
      if (status === "completed" || status === "failed") {
        if (!u.content?.length) {
          out.push({
            type: "tool_result",
            tool,
            result: u.rawOutput ?? { title: u.title },
            itemId,
            turnId,
            status: status === "failed" ? "failed" : "completed",
          });
        }
        const memoryNotice = buildCursorMemoryNotice(
          [u.title, tool].filter(Boolean).join(" "),
          extractToolPayload(u),
        );
        if (memoryNotice) {
          out.push({
            ...memoryNotice,
            turnId,
          });
        }
      }
      break;
    }
    case "plan": {
      const steps: Extract<AgentChatEvent, { type: "plan" }>["steps"] = [];
      for (const entry of update.entries ?? []) {
        const text = typeof entry?.content === "string" ? entry.content.trim() : "";
        if (!text.length) continue;
        const mappedStatus: Extract<AgentChatEvent, { type: "plan" }>["steps"][number]["status"] =
          entry?.status === "completed" || entry?.status === "in_progress" || entry?.status === "pending"
            ? entry.status
            : "pending";
        steps.push({
          text,
          status: mappedStatus,
        });
      }
      const isTrivialSingleStepPlan = steps.length === 1
        && steps[0]!.status === "pending"
        && steps[0]!.text.length <= 80
        && !steps[0]!.text.includes("\n");
      if (steps.length && !isTrivialSingleStepPlan) {
        out.push({ type: "plan", steps, turnId });
      }
      break;
    }
    case "current_mode_update": {
      const mode = typeof update.currentModeId === "string" ? update.currentModeId.trim() : "";
      const previousMode = typeof meta.previousModeId === "string" ? meta.previousModeId.trim() : "";
      if (mode.length && mode !== previousMode) {
        out.push({
          type: "system_notice",
          noticeKind: "info",
          message: `Agent mode: ${mode}`,
          turnId,
        });
      }
      break;
    }
    case "usage_update": {
      // Token usage sometimes streamed — final usage also on PromptResponse
      break;
    }
    default:
      break;
  }

  return out;
}

export function mapStopReasonToTerminalEvents(args: {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  turnId: string;
  model?: string;
  modelId?: import("../../../shared/types").ModelId;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
  };
}): AgentChatEvent[] {
  const { stopReason, turnId, model, modelId, usage } = args;
  const out: AgentChatEvent[] = [];

  if (stopReason === "refusal") {
    out.push({ type: "error", message: "The model refused this request.", turnId });
  }

  if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
    out.push({
      type: "system_notice",
      noticeKind: "info",
      message:
        stopReason === "max_tokens"
          ? "Context or output limit reached for this turn."
          : "Maximum agent turns reached for this prompt.",
      turnId,
    });
  }

  let doneStatus: "interrupted" | "failed" | "completed";
  if (stopReason === "cancelled") {
    doneStatus = "interrupted";
  } else if (stopReason === "refusal") {
    doneStatus = "failed";
  } else {
    doneStatus = "completed";
  }

  out.push({
    type: "done",
    turnId,
    status: doneStatus,
    ...(model ? { model } : {}),
    ...(modelId ? { modelId } : {}),
    ...(usage ? { usage } : {}),
  });

  return out;
}
