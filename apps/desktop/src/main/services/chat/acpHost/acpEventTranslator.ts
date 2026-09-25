/**
 * Translate ACP `session/update` notifications into `AgentChatEvent` values.
 *
 * Two rules govern this file.
 *
 * 1. **Stable row identity.** A text row is keyed by `messageId`, a tool row by
 *    `toolCallId`. When the agent sends no `messageId`, the translator mints one
 *    and keeps using it until the agent starts a new message. A row that
 *    changes identity between chunks renders twice.
 *
 * 2. **Cap nothing.** Live IPC publishes an uncompacted envelope. Trimming here
 *    would remove text the user can see in the live stream and never get back.
 *    Storage compaction is the host application's job, not the translator's.
 *
 * The translator holds per-session state, so create one instance per ACP
 * session and feed every update for that session through it in arrival order.
 */

import { hasNonEmptyRecord } from "../../../../shared/agentObservationNormalizers";
import type { AgentChatEvent, AgentChatPlanStep, ChatSourceRef } from "../../../../shared/types";
import { boundChatSourceRefs } from "../../../../shared/chatSources";
import { acpResourceLinkSourceRef, acpToolSourceRefs } from "../chatSourceAdapters";
import {
  assertNever,
  type AcpSlashCommand,
  type AcpTelemetrySignal,
  type AcpUsageSample,
} from "./acpHostTypes";
import { liveContextUsageEvent } from "../liveContextUsageEvent";
import {
  acpContextBreakdown,
  hasTokenCounts,
  readAcpCompactionUpdate,
  tokenSplitFields,
} from "./acpTelemetryReaders";
import {
  normalizeAcpConfigOptions,
  type AcpAvailableCommand,
  type AcpContentBlock,
  type AcpPlanEntry,
  type AcpSessionConfigOption,
  type AcpSessionUpdate,
  type AcpToolCallContent,
  type AcpToolCallStatus,
  type AcpToolKind,
} from "./acpProtocolTypes";

/**
 * How ADE renders one tool call. The classification is made once, when the tool
 * call first appears, and never changes. A tool call that produced a `command`
 * row must not later also produce a `tool_call` row for the same work.
 */
export type AcpToolRowKind = "command" | "file_change" | "tool";

type TrackedToolCall = {
  rowKind: AcpToolRowKind;
  toolName: string;
  title: string;
  kind: AcpToolKind;
  status: AcpToolCallStatus;
  /** Set once a `tool_call` (or `command`/`file_change`) row was emitted. */
  opened: boolean;
  /**
   * The command text an execute row opened with. The close reuses it: the
   * transcript keys command rows by their text, so a close that fell back to
   * the title split one command into a stuck "running" row and a finished one.
   */
  command?: string;
  /** Whether a `tool_call` row has gone out with a non-empty `rawInput`. */
  emittedArgsJson?: string;
  /** Working directory reported for an execute tool, when it reported one. */
  cwd: string;
  /** Text collected from tool content, newest wins for terminal output. */
  lastOutput: string;
  /** Latest structured result, retained when a later update omits rawOutput. */
  rawOutput?: unknown;
  hasRawOutput: boolean;
  /** Paths already announced for an edit tool, to keep row ids stable. */
  diffIndexByPath: Map<string, number>;
  /** Latest `rawInput` / `locations`, read when the row closes to find web sources. */
  rawInput?: unknown;
  locations?: unknown;
  /** `resource_link` blocks the tool returned, as sources. */
  resourceLinks?: ChatSourceRef[];
};

export type AcpTranslatorCallbacks = {
  /** Fired when the advertised slash command list actually changes. */
  onSlashCommands?: (commands: AcpSlashCommand[]) => void;
  /** Fired when the agent reports session config options or a mode change. */
  onConfigOptions?: (snapshot: {
    options: AcpSessionConfigOption[];
    currentModeId: string | null;
  }) => void;
  /** Fired for `session_info_update`. Carries the agent's own session title. */
  onSessionInfo?: (info: { title: string | null; updatedAt: string | null }) => void;
  /** Fired for every usage sample the dialect could read. */
  onUsage?: (sample: AcpUsageSample) => void;
  /**
   * Fired for a standard update that is telemetry, not a row (compaction).
   * Returns the chat events the session's telemetry produced for it.
   */
  onTelemetry?: (signal: AcpTelemetrySignal) => AgentChatEvent[];
};

export type AcpEventTranslatorOptions = {
  /** Reads a `usage_update` payload. Absent when the dialect reports no usage. */
  readUsage?: ((update: Extract<AcpSessionUpdate, { sessionUpdate: "usage_update" }>) => AcpUsageSample | null) | null;
  /** Keeps only the slash commands ADE should offer in its picker. */
  includeSlashCommand?: (command: AcpAvailableCommand) => boolean;
  callbacks?: AcpTranslatorCallbacks;
};

export type AcpEventTranslator = {
  /** Current turn id. Every emitted event carries it. */
  turnId: string | null;
  beginTurn(turnId: string): void;
  endTurn(): void;
  /** Translate one update. Returns the events to publish, in order. */
  translate(update: AcpSessionUpdate): AgentChatEvent[];
  /** Row kind chosen for a tool call. Test and diagnostics seam. */
  rowKindFor(toolCallId: string): AcpToolRowKind | null;
  /** Forget per-turn state. Session-scoped state (slash dedupe) survives. */
  resetTurnState(): void;
};

function textOfContentBlock(block: AcpContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "";
    case "audio":
      return "";
    case "resource_link": {
      // A link, not text: render it as one, instead of dropping it. The source
      // itself is reported separately (see `resourceLinkSources`).
      const label = block.title?.trim() || block.name.trim() || block.uri;
      const uri = block.uri.replace(/[<>\r\n]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
      );
      return `[${label.replace(/[[\]]/g, "")}](<${uri}>)`;
    }
    case "resource":
      return typeof block.resource.text === "string" ? block.resource.text : "";
    default:
      return assertNever(block, "acp content block");
  }
}

function planStatusToAde(status: AcpPlanEntry["status"]): AgentChatPlanStep["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    default:
      return assertNever(status, "acp plan entry status");
  }
}

function toolStatusToAde(status: AcpToolCallStatus): "running" | "completed" | "failed" {
  switch (status) {
    case "pending":
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return assertNever(status, "acp tool call status");
  }
}

function classifyRowKind(kind: AcpToolKind): AcpToolRowKind {
  switch (kind) {
    case "execute":
      return "command";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "read":
    case "search":
    case "think":
    case "fetch":
    case "switch_mode":
    case "other":
      return "tool";
    default:
      return assertNever(kind, "acp tool kind");
  }
}

function readRawInputString(rawInput: unknown, keys: readonly string[]): string {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return "";
  const record = rawInput as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length) return value;
  }
  return "";
}

/**
 * Build a unified diff for one file from the before and after text.
 *
 * ACP sends whole texts, not a patch. The renderers accept patch text, so the
 * translator produces one hunk that covers the changed region. Identical lines
 * at the start and the end are trimmed first, which keeps a one-line edit to a
 * one-line hunk instead of a whole-file rewrite.
 */
export function buildUnifiedDiff(path: string, oldText: string, newText: string): string {
  if (oldText === newText) return "";
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const header = [`--- a/${path}`, `+++ b/${path}`];
  const hunk = `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`;
  const body = [
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  return [...header, hunk, ...body].join("\n");
}

function diffKind(oldText: string | null | undefined, newText: string): "create" | "modify" | "delete" {
  if (oldText === null || oldText === undefined || oldText === "") return "create";
  if (newText === "") return "delete";
  return "modify";
}

function slashSignature(commands: AcpSlashCommand[]): string {
  return commands.map((command) => `${command.name}\u0000${command.description}`).join("\u0001");
}

export function createAcpEventTranslator(options: AcpEventTranslatorOptions = {}): AcpEventTranslator {
  const toolCalls = new Map<string, TrackedToolCall>();
  let turnId: string | null = null;
  let syntheticMessageCounter = 0;
  let activeTextMessageId: string | null = null;
  let activeThoughtMessageId: string | null = null;
  const textByMessageId = new Map<string, string>();
  let lastSlashSignature: string | null = null;

  const withTurn = <T extends object>(event: T): T & { turnId?: string } =>
    (turnId ? { ...event, turnId } : event) as T & { turnId?: string };

  const messageIdFor = (kind: "text" | "thought", chunkMessageId: string | null | undefined): string => {
    if (typeof chunkMessageId === "string" && chunkMessageId.length) {
      if (kind === "text") activeTextMessageId = chunkMessageId;
      else activeThoughtMessageId = chunkMessageId;
      return chunkMessageId;
    }
    const current = kind === "text" ? activeTextMessageId : activeThoughtMessageId;
    if (current) return current;
    syntheticMessageCounter += 1;
    const minted = `acp-${kind}-${turnId ?? "no-turn"}-${syntheticMessageCounter}`;
    if (kind === "text") activeTextMessageId = minted;
    else activeThoughtMessageId = minted;
    return minted;
  };

  const emitToolContent = (
    tracked: TrackedToolCall,
    toolCallId: string,
    content: AcpToolCallContent[],
    status: AcpToolCallStatus,
  ): AgentChatEvent[] => {
    const events: AgentChatEvent[] = [];
    for (const item of content) {
      if (item.type === "content") {
        const text = textOfContentBlock(item.content);
        const link = acpResourceLinkSourceRef(item.content);
        if (text.length && !link) {
          tracked.lastOutput = tracked.lastOutput
            ? `${tracked.lastOutput}\n${text}`
            : text;
        }
        if (link) {
          // Returned by a tool, not cited by the answer.
          const { cited: _cited, ...ref } = link;
          (tracked.resourceLinks ??= []).push(ref);
        }
        continue;
      }
      if (item.type === "terminal") {
        // The terminal id is only useful with the `terminal` client capability,
        // which ADE does not advertise. Record it so the row is not empty.
        if (!tracked.lastOutput.length) tracked.lastOutput = `terminal ${item.terminalId}`;
        continue;
      }
      if (item.type === "diff") {
        if (tracked.rowKind !== "file_change") {
          // A non-edit tool produced a diff. Keep the text so the tool result
          // row still shows what changed.
          tracked.lastOutput = buildUnifiedDiff(item.path, item.oldText ?? "", item.newText);
          continue;
        }
        let index = tracked.diffIndexByPath.get(item.path);
        if (index === undefined) {
          index = tracked.diffIndexByPath.size;
          tracked.diffIndexByPath.set(item.path, index);
        }
        events.push(
          withTurn({
            type: "file_change" as const,
            path: item.path,
            diff: buildUnifiedDiff(item.path, item.oldText ?? "", item.newText),
            kind: diffKind(item.oldText, item.newText),
            itemId: `${toolCallId}:${index}`,
            logicalItemId: toolCallId,
            status: toolStatusToAde(status),
          }),
        );
        tracked.opened = true;
        continue;
      }
      assertNever(item, "acp tool call content");
    }
    return events;
  };

  const commandRow = (tracked: TrackedToolCall, toolCallId: string): AgentChatEvent => withTurn({
    type: "command" as const,
    command: tracked.command ?? tracked.title,
    cwd: tracked.cwd,
    output: tracked.lastOutput,
    itemId: toolCallId,
    status: toolStatusToAde(tracked.status),
  });

  const openRow = (tracked: TrackedToolCall, toolCallId: string, rawInput: unknown): AgentChatEvent[] => {
    switch (tracked.rowKind) {
      case "command": {
        const inputCommand = readRawInputString(rawInput, ["command", "cmd", "script", "input"]);
        // `pending` means the input is still streaming or awaiting approval
        // (ACP tool-calls spec). Opening now would fix the row's text to the
        // title ("bash") before the real command arrives on an update.
        if (!inputCommand && tracked.status !== "completed" && tracked.status !== "failed") return [];
        tracked.opened = true;
        tracked.command = inputCommand || tracked.title;
        tracked.cwd = readRawInputString(rawInput, ["cwd", "workdir", "directory"]) || tracked.cwd;
        return [commandRow(tracked, toolCallId)];
      }
      case "file_change":
        // The edit row cannot open until a diff arrives; the diff carries the
        // path. `emitToolContent` opens it.
        return [];
      case "tool":
        tracked.opened = true;
        return [toolCallRow(tracked, toolCallId, rawInput)];
      default:
        return assertNever(tracked.rowKind, "acp tool row kind");
    }
  };

  const toolCallRow = (tracked: TrackedToolCall, toolCallId: string, rawInput: unknown): AgentChatEvent => {
    if (hasNonEmptyRecord(rawInput)) tracked.emittedArgsJson = JSON.stringify(rawInput);
    return withTurn({
      type: "tool_call" as const,
      tool: tracked.toolName,
      args: rawInput ?? {},
      toolKind: tracked.kind,
      itemId: toolCallId,
    });
  };

  const closeRow = (
    tracked: TrackedToolCall,
    toolCallId: string,
    rawOutput: unknown,
  ): AgentChatEvent[] => {
    switch (tracked.rowKind) {
      case "command":
        return [commandRow(tracked, toolCallId)];
      case "file_change":
        // Every file row already carries its own status from the diff pass.
        return [];
      case "tool": {
        const sources = tracked.status === "completed"
          ? boundChatSourceRefs([
            ...acpToolSourceRefs({
              kind: tracked.kind,
              rawInput: tracked.rawInput,
              rawOutput,
              locations: tracked.locations,
            }),
            ...(tracked.resourceLinks ?? []),
          ])
          : [];
        return [
          withTurn({
            type: "tool_result" as const,
            tool: tracked.toolName,
            result: rawOutput ?? tracked.lastOutput,
            ...(sources.length ? { sources } : {}),
            itemId: toolCallId,
            status: toolStatusToAde(tracked.status),
          }),
        ];
      }
      default:
        return assertNever(tracked.rowKind, "acp tool row kind");
    }
  };

  const translate = (update: AcpSessionUpdate): AgentChatEvent[] => {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        // ADE already owns the user's message. Echoing it would duplicate the
        // bubble on every replay.
        return [];

      case "agent_message_chunk": {
        const messageId = messageIdFor("text", update.messageId);
        let text = textOfContentBlock(update.content);
        if (!text.length) return [];
        if (acpResourceLinkSourceRef(update.content)) {
          const previousText = textByMessageId.get(messageId) ?? "";
          if (previousText && !/\s$/u.test(previousText)) text = `\n${text}`;
        }
        textByMessageId.set(messageId, `${textByMessageId.get(messageId) ?? ""}${text}`);
        const events: AgentChatEvent[] = [withTurn({ type: "text" as const, text, messageId, itemId: messageId })];
        const link = acpResourceLinkSourceRef(update.content);
        if (link) events.push(withTurn({ type: "sources" as const, sources: [link], itemId: messageId }));
        return events;
      }

      case "agent_thought_chunk": {
        const text = textOfContentBlock(update.content);
        if (!text.length) return [];
        const messageId = messageIdFor("thought", update.messageId);
        return [withTurn({ type: "reasoning" as const, text, itemId: messageId })];
      }

      case "tool_call": {
        const kind = update.kind ?? "other";
        const tracked: TrackedToolCall = {
          rowKind: classifyRowKind(kind),
          toolName: update.name?.length ? update.name : update.title,
          title: update.title,
          kind,
          status: update.status ?? "pending",
          opened: false,
          cwd: "",
          lastOutput: "",
          rawOutput: update.rawOutput,
          hasRawOutput: Object.prototype.hasOwnProperty.call(update, "rawOutput"),
          diffIndexByPath: new Map(),
          rawInput: update.rawInput,
          locations: update.locations,
        };
        toolCalls.set(update.toolCallId, tracked);
        const events = openRow(tracked, update.toolCallId, update.rawInput);
        events.push(...emitToolContent(tracked, update.toolCallId, update.content ?? [], tracked.status));
        if (tracked.status === "completed" || tracked.status === "failed") {
          events.push(...closeRow(tracked, update.toolCallId, tracked.hasRawOutput ? tracked.rawOutput : undefined));
        }
        return events;
      }

      case "tool_call_update": {
        const tracked = toolCalls.get(update.toolCallId);
        if (!tracked) {
          // An update for a tool call ADE never saw. Adopt it rather than drop
          // it: an agent that restarts mid-turn can skip the opening frame.
          const kind = update.kind ?? "other";
          const adopted: TrackedToolCall = {
            rowKind: classifyRowKind(kind),
            toolName: update.name?.length ? update.name : update.title ?? update.toolCallId,
            title: update.title ?? update.toolCallId,
            kind,
            status: update.status ?? "in_progress",
            opened: false,
            cwd: "",
            lastOutput: "",
            rawOutput: update.rawOutput,
            hasRawOutput: Object.prototype.hasOwnProperty.call(update, "rawOutput"),
            diffIndexByPath: new Map(),
            rawInput: update.rawInput ?? undefined,
            locations: update.locations ?? undefined,
          };
          toolCalls.set(update.toolCallId, adopted);
          const adoptedEvents = openRow(adopted, update.toolCallId, update.rawInput);
          adoptedEvents.push(
            ...emitToolContent(adopted, update.toolCallId, update.content ?? [], adopted.status),
          );
          if (adopted.status === "completed" || adopted.status === "failed") {
            adoptedEvents.push(...closeRow(adopted, update.toolCallId, adopted.hasRawOutput ? adopted.rawOutput : undefined));
          }
          return adoptedEvents;
        }

        if (update.title?.length) tracked.title = update.title;
        if (update.name?.length) tracked.toolName = update.name;
        if (update.rawInput != null) tracked.rawInput = update.rawInput;
        if (Object.prototype.hasOwnProperty.call(update, "rawOutput")) {
          tracked.rawOutput = update.rawOutput;
          tracked.hasRawOutput = true;
        }
        if (update.locations != null) tracked.locations = update.locations;
        // The row type is fixed once a row is out; before that, a late `kind`
        // still decides it.
        if (update.kind && !tracked.opened) {
          tracked.kind = update.kind;
          tracked.rowKind = classifyRowKind(update.kind);
        }
        const previousStatus = tracked.status;
        if (update.status) tracked.status = update.status;

        const terminalStatus = tracked.status === "completed" || tracked.status === "failed";
        let commandDetailsChanged = false;
        if (tracked.opened && tracked.rowKind === "command" && update.rawInput != null) {
          const previousCommand = tracked.command;
          const previousCwd = tracked.cwd;
          const inputCommand = readRawInputString(update.rawInput, ["command", "cmd", "script", "input"]);
          if (inputCommand) tracked.command = inputCommand;
          tracked.cwd = readRawInputString(update.rawInput, ["cwd", "workdir", "directory"]) || tracked.cwd;
          commandDetailsChanged = previousCommand !== tracked.command || previousCwd !== tracked.cwd;
        }
        const toolInputChanged = tracked.opened
          && tracked.rowKind === "tool"
          && hasNonEmptyRecord(update.rawInput)
          && JSON.stringify(update.rawInput) !== tracked.emittedArgsJson;

        const events: AgentChatEvent[] = [];
        if (!tracked.opened) {
          events.push(...openRow(tracked, update.toolCallId, tracked.rawInput));
        } else if (toolInputChanged) {
          // Input that arrived after the opening frame. Same item id, so the
          // row merges. A terminal result follows below when this update arrives
          // after completion, so the final transcript state stays closed.
          events.push(toolCallRow(tracked, update.toolCallId, update.rawInput));
        } else if (tracked.rowKind === "command" && commandDetailsChanged && !terminalStatus) {
          // Execute tools may refine their partial command after the row opens.
          events.push(commandRow(tracked, update.toolCallId));
        }
        events.push(...emitToolContent(tracked, update.toolCallId, update.content ?? [], tracked.status));
        const becameTerminal =
          (tracked.status === "completed" || tracked.status === "failed")
          && previousStatus !== tracked.status;
        if (
          becameTerminal
          || (terminalStatus && (toolInputChanged || commandDetailsChanged))
        ) {
          events.push(...closeRow(tracked, update.toolCallId, tracked.hasRawOutput ? tracked.rawOutput : undefined));
        }
        return events;
      }

      case "plan":
      case "plan_update": {
        const steps: AgentChatPlanStep[] = update.entries.map((entry) => ({
          text: entry.content,
          status: planStatusToAde(entry.status),
          ...(entry.priority === "high" || entry.priority === "medium" || entry.priority === "low"
            ? { priority: entry.priority }
            : {}),
        }));
        return [withTurn({ type: "plan" as const, steps })];
      }

      case "plan_removed":
        return [withTurn({ type: "plan" as const, steps: [] })];

      case "available_commands_update": {
        const filter = options.includeSlashCommand ?? (() => true);
        const commands: AcpSlashCommand[] = update.availableCommands.filter(filter).map((command) => ({
          name: command.name,
          description: command.description,
          inputHint: command.input?.hint ?? null,
        }));
        const signature = slashSignature(commands);
        // Grok re-sends this list on almost every turn. Fire the callback only
        // when the content actually changed.
        if (signature !== lastSlashSignature) {
          lastSlashSignature = signature;
          options.callbacks?.onSlashCommands?.(commands);
        }
        return [];
      }

      case "current_mode_update":
        options.callbacks?.onConfigOptions?.({ options: [], currentModeId: update.currentModeId });
        return [];

      case "config_option_update":
        options.callbacks?.onConfigOptions?.({
          options: normalizeAcpConfigOptions(update.configOptions),
          currentModeId: null,
        });
        return [];

      case "session_info_update":
        options.callbacks?.onSessionInfo?.({
          title: update.title ?? null,
          updatedAt: update.updatedAt ?? null,
        });
        return [];

      case "usage_update": {
        const read = options.readUsage;
        if (!read) return [];
        const sample = read(update);
        if (!sample) return [];
        options.callbacks?.onUsage?.(sample);
        return usageSampleToEvents(sample, turnId);
      }

      case "compaction_update": {
        const signal = readAcpCompactionUpdate(update);
        if (!signal) return [];
        return options.callbacks?.onTelemetry?.(signal) ?? [];
      }

      case "compaction_summary_chunk":
        // The streamed summary text has no home in ADE's compaction divider.
        // The `compaction_update` around it carries the lifecycle.
        return [];

      default:
        return assertNever(update, "acp session update");
    }
  };

  return {
    get turnId() {
      return turnId;
    },
    set turnId(value: string | null) {
      turnId = value;
    },
    beginTurn: (nextTurnId: string) => {
      turnId = nextTurnId;
      activeTextMessageId = null;
      activeThoughtMessageId = null;
      textByMessageId.clear();
    },
    endTurn: () => {
      turnId = null;
      activeTextMessageId = null;
      activeThoughtMessageId = null;
      textByMessageId.clear();
    },
    translate,
    rowKindFor: (toolCallId: string) => toolCalls.get(toolCallId)?.rowKind ?? null,
    resetTurnState: () => {
      toolCalls.clear();
      activeTextMessageId = null;
      activeThoughtMessageId = null;
      textByMessageId.clear();
    },
  };
}

/**
 * Turn a usage sample into chat events.
 *
 * A sample with token counts produces a `tokens` event. A sample with context
 * occupancy produces a `context_usage` event. A sample can produce both.
 */
export function usageSampleToEvents(sample: AcpUsageSample, turnId: string | null): AgentChatEvent[] {
  const events: AgentChatEvent[] = [];
  if (hasTokenCounts(sample) && turnId) {
    events.push({
      type: "tokens",
      turnId,
      ...tokenSplitFields(sample),
      ...(sample.contextWindowTokens !== undefined ? { contextWindow: sample.contextWindowTokens } : {}),
    });
  }
  if (sample.contextUsedTokens !== undefined && sample.contextWindowTokens) {
    events.push(liveContextUsageEvent({
      used: sample.contextUsedTokens,
      max: sample.contextWindowTokens,
      breakdown: acpContextBreakdown(sample),
      turnId,
    }));
  }
  return events;
}
