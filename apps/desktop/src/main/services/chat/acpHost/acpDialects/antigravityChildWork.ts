/**
 * What Antigravity does outside a turn, read from agy's own session logs.
 *
 * `invoke_subagent` returns at once and the turn ends; the subagent runs on
 * in agy's process with its own conversation log. When it finishes it sends
 * the parent a message (a `101` step), and the parent carries on: it thinks,
 * replies, and calls tools. None of that comes over ACP (verified 1.5.6). A
 * tool that needs approval is held (status "waiting") until the next prompt,
 * which then opens with that tool call and its `session/request_permission`.
 * So:
 *
 * - When a turn ends, ADE reads the steps the turn added: each launch (a
 *   tool step named `invoke_subagent`, whose result names the child's
 *   conversation id) becomes a subagent card; a message from a child already
 *   finished settles its card.
 * - While a child is open, a poll (every 2 s, only then, skipped when neither
 *   log changed) reads the child's log for progress and the parent's for the
 *   result message and what the parent did next: thinking, text and finished
 *   tool calls, shown as a turn of their own, and a held tool call, shown as
 *   a note that it waits for the next message. A tool still running is read
 *   again until it finishes. A prompt about to start reads once more first;
 *   during a turn the agent streams over ACP and nothing is reported twice.
 * - While a tool is held, the chat counts as busy, so ADE does not close
 *   agy's process (which would cancel the tool) before the user answers. That
 *   lasts at most 30 minutes, as does a child that writes nothing.
 *
 * Every read is read-only and bounded (`antigravitySessionLog.ts`).
 */

import fs from "node:fs";

import type { AcpBackgroundEvent, AcpBackgroundItem, AcpBackgroundWork } from "../acpHostTypes";
import {
  antigravityConversationFile,
  antigravityLastStepIndex,
  antigravityLaunchedConversationIds,
  readAntigravitySteps,
  readAntigravityStepsAt,
  type AntigravityStep,
} from "./antigravitySessionLog";

const POLL_MS = 2_000;
/** After the last child settles and the parent's log goes quiet, how long to keep watching. */
const REPLY_GRACE_MS = 90_000;
/** A child with no new step, or a tool held for approval, this long is let go. */
const SILENCE_MS = 30 * 60_000;
const DESCRIPTION_LIMIT = 400;
const SUMMARY_LIMIT = 8_000;
const TOOL_OUTPUT_LIMIT = 16_000;
const TITLE_LIMIT = 200;
/** Steps per log read, and how many reads one pass may take (a turn of 5,000 steps). */
const READ_BATCH = 200;
const MAX_READ_BATCHES = 25;

type Launch = { role: string; prompt: string; typeName: string | null };

type Child = {
  taskId: string;
  file: string | null;
  cursor: number;
  lastTool: string | null;
  lastActivityAt: number;
  signature: string;
};

type ToolStep = Extract<AntigravityStep, { kind: "tool" }>;

function parseArgs(args: string): Record<string, unknown> {
  try {
    const value = JSON.parse(args) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseLaunch(args: string): Launch {
  const value = parseArgs(args);
  const str = (key: string) => (typeof value[key] === "string" ? (value[key] as string).trim() : "");
  return { role: str("Role") || "Subagent", prompt: str("Prompt"), typeName: str("TypeName") || null };
}

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** What a held tool would do, in the words of its own arguments. */
function toolTitle(step: ToolStep): string {
  const args = parseArgs(step.toolCall.args);
  for (const key of ["CommandLine", "Path", "TargetFile", "AbsolutePath", "Url"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return bounded(value.trim(), TITLE_LIMIT);
  }
  return step.toolCall.name;
}

function finishedItem(step: ToolStep): AcpBackgroundItem {
  return {
    kind: "tool",
    toolCallId: step.toolCall.id || `agy-step-${step.idx}`,
    name: step.toolCall.name,
    input: parseArgs(step.toolCall.args),
    status: step.status === "done" ? "completed" : step.status === "failed" ? "failed" : "interrupted",
    output: bounded(step.text, TOOL_OUTPUT_LIMIT),
  };
}

/** Size and mtime of a log and its WAL: a cheap "did anything change" key. */
function logSignature(file: string | null): string {
  if (!file) return "";
  const part = (target: string) => {
    try {
      const stat = fs.statSync(target);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return "-";
    }
  };
  return `${part(file)}|${part(`${file}-wal`)}`;
}

export function createAntigravityBackgroundWork(args: {
  sessionId: string;
  emit: (events: AcpBackgroundEvent[]) => void;
  cliDir?: string;
  now?: () => number;
}): AcpBackgroundWork {
  const now = args.now ?? Date.now;
  const parentFile = antigravityConversationFile(args.sessionId, args.cliDir);
  // History before this runtime opened is not news.
  let cursor = parentFile ? antigravityLastStepIndex(parentFile) ?? -1 : -1;
  let parentSignature = logSignature(parentFile);
  const launches = new Map<string, Launch>();
  const children = new Map<string, Child>();
  /** Background tool steps not finished yet, by step index: read again each tick. */
  const runningTools = new Set<number>();
  /** When a background tool started waiting for approval; null when none waits. */
  let waitingSince: number | null = null;
  let inTurn = false;
  /** The last time a child settled or the parent's log changed outside a turn. */
  let lastSettledAt = 0;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const startTimer = () => {
    if (timer || disposed) return;
    timer = setInterval(tick, POLL_MS);
    timer.unref?.();
  };

  const settle = (childId: string, status: "completed" | "stopped", summary: string, events: AcpBackgroundEvent[]) => {
    const child = children.get(childId);
    if (!child) return;
    children.delete(childId);
    lastSettledAt = now();
    events.push({ kind: "subagent_result", taskId: child.taskId, status, summary: bounded(summary, SUMMARY_LIMIT) });
  };

  /** A background tool's step, as an item once it has an outcome. */
  const toolOutcome = (step: ToolStep, items: AcpBackgroundItem[]) => {
    if (step.status === "running") {
      runningTools.add(step.idx);
      return;
    }
    runningTools.delete(step.idx);
    if (step.status === "waiting") {
      waitingSince ??= now();
      items.push({ kind: "waiting", toolCallId: step.toolCall.id, name: step.toolCall.name, title: toolTitle(step) });
      return;
    }
    items.push(finishedItem(step));
  };

  const launch = (step: ToolStep, events: AcpBackgroundEvent[]) => {
    const info = launches.get(step.toolCall.id) ?? parseLaunch(step.toolCall.args);
    const ids = antigravityLaunchedConversationIds(step.text);
    ids.forEach((childId, index) => {
      if (children.has(childId)) return;
      children.set(childId, {
        taskId: childId,
        file: antigravityConversationFile(childId, args.cliDir),
        cursor: -1,
        lastTool: null,
        lastActivityAt: now(),
        signature: "",
      });
      events.push({
        kind: "subagent_started",
        taskId: childId,
        label: ids.length > 1 ? `${info.role} ${index + 1}` : info.role,
        description: bounded(info.prompt || info.role, DESCRIPTION_LIMIT),
        agentType: info.typeName,
        parentToolUseId: step.toolCall.id || null,
      });
    });
  };

  /**
   * New parent steps. `outsideTurn`: they were written while no prompt ran,
   * so ADE reports what the agent did; otherwise the turn already streamed it.
   */
  const readParent = (outsideTurn: boolean, events: AcpBackgroundEvent[]) => {
    if (!parentFile) return;
    // Every unread step, a batch at a time: a long turn can add more than
    // one batch, and a launch past the first must not be missed.
    const steps: AntigravityStep[] = [];
    for (let batch = 0; batch < MAX_READ_BATCHES; batch++) {
      const read = readAntigravitySteps(parentFile, steps.at(-1)?.idx ?? cursor, READ_BATCH) ?? [];
      steps.push(...read);
      if (read.length < READ_BATCH) break;
    }
    const items: AcpBackgroundItem[] = [];
    for (const step of steps) {
      cursor = Math.max(cursor, step.idx);
      if (step.kind === "reply") {
        for (const call of step.toolCalls) {
          if (call.name === "invoke_subagent" && call.id) launches.set(call.id, parseLaunch(call.args));
        }
        if (outsideTurn && step.thinking.trim()) items.push({ kind: "thinking", text: step.thinking });
        if (outsideTurn && step.text.trim()) items.push({ kind: "text", text: step.text });
        continue;
      }
      if (step.kind === "tool") {
        if (step.toolCall.name === "invoke_subagent") launch(step, events);
        else if (outsideTurn) toolOutcome(step, items);
        continue;
      }
      if (step.kind === "message" && step.senderId && children.has(step.senderId)) {
        settle(step.senderId, "completed", step.content || step.title, events);
      }
    }
    if (items.length) events.push({ kind: "agent_activity", items });
  };

  /** Background tools that were still running: report the ones that finished. */
  const readRunningTools = (events: AcpBackgroundEvent[]) => {
    if (!parentFile || !runningTools.size) return;
    const items: AcpBackgroundItem[] = [];
    for (const step of readAntigravityStepsAt(parentFile, [...runningTools]) ?? []) {
      if (step.kind === "tool") toolOutcome(step, items);
    }
    if (items.length) events.push({ kind: "agent_activity", items });
  };

  const readChildren = (events: AcpBackgroundEvent[]) => {
    for (const [childId, child] of children) {
      const signature = logSignature(child.file);
      if (signature !== child.signature && child.file) {
        child.signature = signature;
        const steps = readAntigravitySteps(child.file, child.cursor) ?? [];
        let lastTool = child.lastTool;
        for (const step of steps) {
          child.cursor = Math.max(child.cursor, step.idx);
          child.lastActivityAt = now();
          if (step.kind === "reply") {
            const call = step.toolCalls.at(-1);
            if (call) lastTool = call.name;
          }
        }
        if (lastTool && lastTool !== child.lastTool) {
          child.lastTool = lastTool;
          events.push({ kind: "subagent_progress", taskId: child.taskId, summary: `Running ${lastTool}`, lastToolName: lastTool });
        }
      }
      if (now() - child.lastActivityAt > SILENCE_MS) {
        settle(childId, "stopped", "No result came back from the subagent.", events);
      }
    }
  };

  function tick(): void {
    if (disposed) return;
    const events: AcpBackgroundEvent[] = [];
    readChildren(events);
    if (!inTurn) {
      const signature = logSignature(parentFile);
      if (signature !== parentSignature) {
        parentSignature = signature;
        // The parent is still working on a result: keep watching.
        lastSettledAt = now();
        readRunningTools(events);
        readParent(true, events);
      }
    }
    if (events.length) args.emit(events);
    if (!children.size && !runningTools.size && now() - lastSettledAt > REPLY_GRACE_MS) stopTimer();
  }

  return {
    turnStarting() {
      if (disposed) return;
      // Anything written while idle is reported before the turn's own stream.
      const events: AcpBackgroundEvent[] = [];
      readRunningTools(events);
      readParent(true, events);
      if (events.length) args.emit(events);
      // The prompt resumes a held or running tool over ACP; it is the turn's now.
      runningTools.clear();
      waitingSince = null;
      inTurn = true;
    },
    turnEnded() {
      if (disposed) return;
      inTurn = false;
      // The turn's own replies were streamed; only launches and results count.
      const events: AcpBackgroundEvent[] = [];
      const settledBefore = lastSettledAt;
      readParent(false, events);
      parentSignature = logSignature(parentFile);
      if (events.length) args.emit(events);
      // A child that already reported still gets agy's reply to it, which can
      // come after the turn.
      if (children.size || lastSettledAt !== settledBefore) startTimer();
    },
    hasOpenWork: () => !disposed && (
      children.size > 0
      || runningTools.size > 0
      || (waitingSince !== null && now() - waitingSince < SILENCE_MS)
    ),
    runningCount: () => (disposed ? 0 : children.size + runningTools.size),
    dispose() {
      if (disposed) return;
      // agy's process is going away, and its subagents with it.
      const events: AcpBackgroundEvent[] = [];
      for (const childId of [...children.keys()]) {
        settle(childId, "stopped", "The chat's Antigravity process closed before the subagent reported back.", events);
      }
      disposed = true;
      stopTimer();
      if (events.length) args.emit(events);
    },
  };
}
