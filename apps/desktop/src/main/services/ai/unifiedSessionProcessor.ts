import type { Tool } from "ai";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import type { PermissionMode } from "./tools/universalTools";
import {
  createUnifiedToolLoopGovernor,
  wrapToolsWithUnifiedLoopGovernor,
  type UnifiedLoopStepSummary,
  type UnifiedToolPolicyDecision,
} from "./unifiedToolLoopGovernor";

type StreamPartLike = {
  type?: unknown;
};

type RawStreamPart = StreamPartLike & Record<string, unknown>;
type ToolChoice = "none" | "required" | { type: "tool"; toolName: string };

const STOP_PART_TYPES = new Set(["tool-call", "tool-result", "tool-error", "start-step"]);

export type UnifiedProcessedStreamEvent =
  | {
      type: "start-step";
      part: RawStreamPart;
      stepCount: number;
      providerStepNumber?: number;
    }
  | {
      type: "source";
      part: RawStreamPart;
      detail: string;
    }
  | {
      type: "reasoning-start";
      part: RawStreamPart;
    }
  | {
      type: "reasoning-delta";
      part: RawStreamPart;
      delta: string;
    }
  | {
      type: "reasoning-end";
      part: RawStreamPart;
    }
  | {
      type: "text-delta";
      part: RawStreamPart;
      text: string;
      assistantText: string;
    }
  | {
      type: "tool-call";
      part: RawStreamPart;
      toolName: string;
      input: unknown;
      toolCallId?: string;
    }
  | {
      type: "tool-result";
      part: RawStreamPart;
      toolName: string;
      output: unknown;
      preliminary: boolean;
      toolCallId?: string;
    }
  | {
      type: "tool-error";
      part: RawStreamPart;
      toolName: string;
      error: unknown;
      toolCallId?: string;
    }
  | {
      type: "tool-approval-request";
      part: RawStreamPart;
      toolName: string;
    }
  | {
      type: "finish";
      part: RawStreamPart;
      assistantText: string;
      usage: unknown;
    }
  | {
      type: "error";
      part: RawStreamPart;
      error: unknown;
    }
  | {
      type: "break";
      part: RawStreamPart;
    }
  | {
      type: "blocked-summary";
      text: string;
      assistantText: string;
    }
  | {
      type: "stream-end";
      assistantText: string;
      stepCount: number;
      finishSeen: boolean;
      blockedByStopTools: boolean;
    };

function asRawStreamPart(part: StreamPartLike): RawStreamPart {
  return part as RawStreamPart;
}

function readSourceDetail(part: RawStreamPart): string {
  return typeof part.title === "string" && part.title.trim().length
    ? part.title
    : part.sourceType === "url" && typeof part.url === "string" && part.url.trim().length
      ? part.url
      : "Gathering sources";
}

function readReasoningDelta(part: RawStreamPart): string {
  for (const value of [part.text, part.textDelta, part.delta]) {
    if (typeof value === "string" && value.length) return value;
  }
  return "";
}

function readTextDelta(part: RawStreamPart): string {
  for (const value of [part.text, part.textDelta]) {
    if (typeof value === "string" && value.length) return value;
  }
  return "";
}

function readToolCallId(part: RawStreamPart): string | undefined {
  return typeof part.toolCallId === "string" ? part.toolCallId : undefined;
}

// Owns per-turn tool-loop state and stream processing so callers stay close to
// OpenCode's session-processor model instead of duplicating loop glue.
export class UnifiedSessionProcessor {
  private governor: ReturnType<typeof createUnifiedToolLoopGovernor> | null = null;
  private stopTriggered = false;
  private blockedSummaryInjected = false;

  startTurn(args: {
    cwd: string;
    modelDescriptor: Pick<ModelDescriptor, "authTypes" | "harnessProfile">;
    permissionMode: PermissionMode;
    initialTodoItems?: Array<{ id?: string; description?: string; status?: string }>;
  }): void {
    this.governor = createUnifiedToolLoopGovernor(args);
    this.stopTriggered = false;
    this.blockedSummaryInjected = false;
  }

  shouldApply(): boolean {
    return this.governor?.shouldApply() ?? false;
  }

  shouldStopFurtherToolUse(): boolean {
    return this.governor?.shouldStopFurtherToolUse() ?? false;
  }

  wrapTools(
    tools: Record<string, Tool>,
    onDecision?: (decision: UnifiedToolPolicyDecision) => void,
  ): Record<string, Tool> {
    if (!this.governor || !this.governor.shouldApply()) {
      return tools;
    }

    return wrapToolsWithUnifiedLoopGovernor(tools, this.governor, (decision) => {
      if (decision.decision === "stop_tools") {
        this.stopTriggered = true;
      }
      onDecision?.(decision);
    });
  }

  buildStepHooks(args: {
    allToolNames: string[];
    canForwardToolChoice: (toolChoice: ToolChoice | undefined) => boolean;
    buildSystemPrompt: (toolNames: string[]) => string | undefined;
    onStepSummary?: (summary: UnifiedLoopStepSummary, step: unknown) => void;
    onStepFinish?: (step: unknown) => void;
  }): {
    prepareStep?: () => Promise<{
      activeTools?: string[];
      toolChoice?: ToolChoice;
      system?: string;
    }>;
    onStepFinish?: (step: unknown) => Promise<void>;
  } {
    if (!this.governor || !this.governor.shouldApply()) {
      return args.onStepFinish ? { onStepFinish: async (step: unknown) => args.onStepFinish?.(step) } : {};
    }

    return {
      prepareStep: async () => {
        const policy = this.governor!.buildStepPolicy(args.allToolNames);
        const toolChoice = args.canForwardToolChoice(policy.toolChoice) ? policy.toolChoice : undefined;
        const system = args.buildSystemPrompt(policy.activeTools ?? args.allToolNames);
        return {
          ...(policy.activeTools !== undefined ? { activeTools: policy.activeTools } : {}),
          ...(toolChoice ? { toolChoice } : {}),
          ...(system ? { system } : {}),
        };
      },
      onStepFinish: async (step: unknown) => {
        const record = step as { toolCalls?: unknown[]; toolResults?: unknown[] } | null;
        const summary = this.governor!.recordStep({
          toolCalls: Array.isArray(record?.toolCalls) ? record.toolCalls as any[] : [],
          toolResults: Array.isArray(record?.toolResults) ? record.toolResults as any[] : [],
        });
        args.onStepSummary?.(summary, step);
        args.onStepFinish?.(step);
      },
    };
  }

  shouldBreakStream(part: StreamPartLike | null | undefined): boolean {
    return this.stopTriggered && STOP_PART_TYPES.has(String(part?.type ?? ""));
  }

  async *processStream(args: {
    fullStream: AsyncIterable<StreamPartLike>;
    shouldStop?: () => boolean;
    onPartSeen?: (kind: string) => void;
  }): AsyncGenerator<UnifiedProcessedStreamEvent> {
    let assistantText = "";
    let stepCount = 0;
    let finishSeen = false;

    for await (const part of args.fullStream) {
      if (args.shouldStop?.()) break;
      if (!part || typeof part !== "object") continue;

      const rawPart = asRawStreamPart(part);
      if (this.shouldBreakStream(rawPart)) {
        yield { type: "break", part: rawPart };
        break;
      }

      args.onPartSeen?.(String(rawPart.type ?? "unknown"));

      switch (String(rawPart.type ?? "")) {
        case "start-step":
          stepCount += 1;
          yield {
            type: "start-step",
            part: rawPart,
            stepCount,
            ...(typeof rawPart.stepNumber === "number" ? { providerStepNumber: rawPart.stepNumber } : {}),
          };
          break;
        case "source":
          yield {
            type: "source",
            part: rawPart,
            detail: readSourceDetail(rawPart),
          };
          break;
        case "reasoning-start":
          yield {
            type: "reasoning-start",
            part: rawPart,
          };
          break;
        case "reasoning":
        case "reasoning-delta": {
          const delta = readReasoningDelta(rawPart);
          if (!delta.length) break;
          yield {
            type: "reasoning-delta",
            part: rawPart,
            delta,
          };
          break;
        }
        case "reasoning-end":
          yield {
            type: "reasoning-end",
            part: rawPart,
          };
          break;
        case "text-delta": {
          const text = readTextDelta(rawPart);
          if (!text.length) break;
          assistantText += text;
          yield {
            type: "text-delta",
            part: rawPart,
            text,
            assistantText,
          };
          break;
        }
        case "tool-call":
          yield {
            type: "tool-call",
            part: rawPart,
            toolName: String(rawPart.toolName ?? "tool"),
            input: rawPart.input ?? rawPart.args ?? rawPart.arguments,
            ...(readToolCallId(rawPart) ? { toolCallId: readToolCallId(rawPart) } : {}),
          };
          break;
        case "tool-result":
          yield {
            type: "tool-result",
            part: rawPart,
            toolName: String(rawPart.toolName ?? "tool"),
            output: rawPart.output ?? rawPart.result,
            preliminary: rawPart.preliminary === true,
            ...(readToolCallId(rawPart) ? { toolCallId: readToolCallId(rawPart) } : {}),
          };
          break;
        case "tool-error":
          yield {
            type: "tool-error",
            part: rawPart,
            toolName: String(rawPart.toolName ?? "tool"),
            error: rawPart.error,
            ...(readToolCallId(rawPart) ? { toolCallId: readToolCallId(rawPart) } : {}),
          };
          break;
        case "tool-approval-request":
          yield {
            type: "tool-approval-request",
            part: rawPart,
            toolName: String((rawPart.toolCall as { toolName?: unknown } | undefined)?.toolName ?? "tool"),
          };
          break;
        case "finish":
          finishSeen = true;
          yield {
            type: "finish",
            part: rawPart,
            assistantText,
            usage: rawPart.totalUsage ?? rawPart.usage,
          };
          break;
        case "error":
          yield {
            type: "error",
            part: rawPart,
            error: rawPart.error,
          };
          break;
        default:
          break;
      }
    }

    const blockedSummary = this.consumeBlockedSummary(assistantText);
    if (blockedSummary) {
      assistantText += blockedSummary;
      yield {
        type: "blocked-summary",
        text: blockedSummary,
        assistantText,
      };
    }

    yield {
      type: "stream-end",
      assistantText,
      stepCount,
      finishSeen,
      blockedByStopTools: !finishSeen && this.shouldStopFurtherToolUse(),
    };
  }

  consumeBlockedSummary(assistantText: string): string | null {
    if (
      !this.governor
      || !this.governor.shouldApply()
      || !this.governor.shouldStopFurtherToolUse()
      || this.blockedSummaryInjected
    ) {
      return null;
    }

    const blockedSummary = this.governor.buildBlockedToolSummary();
    if (!blockedSummary.trim().length) {
      return null;
    }
    this.blockedSummaryInjected = true;
    return `${assistantText.trim().length ? "\n\n" : ""}${blockedSummary}`;
  }
}
