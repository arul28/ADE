/**
 * Antigravity's background subagents, read from agy's own session logs.
 *
 * `invoke_subagent` returns at once and the turn ends; the subagent runs on
 * in agy's process with its own conversation log. When it finishes it sends
 * the parent a message (a `101` step), the parent writes a reply, and none of
 * that comes over ACP (verified 1.5.6). So:
 *
 * - When a turn ends, ADE reads the steps the turn added: each launch (a
 *   tool step named `invoke_subagent`, whose result names the child's
 *   conversation id) becomes a subagent card; a message from a child already
 *   finished settles its card.
 * - While a child is open, a poll (every 2 s, only then, skipped when neither
 *   log changed) reads the child's log for progress and the parent's for the
 *   result message and the parent's reply, which ADE shows as a turn of its
 *   own. A prompt about to start reads once more first; during a turn the
 *   agent streams over ACP and nothing is reported twice.
 * - A child that sends nothing for 30 minutes is reported stopped.
 *
 * Every read is read-only and bounded (`antigravitySessionLog.ts`).
 */

import fs from "node:fs";

import type { AcpBackgroundEvent, AcpBackgroundWork } from "../acpHostTypes";
import {
  antigravityConversationFile,
  antigravityLastStepIndex,
  antigravityLaunchedConversationIds,
  readAntigravitySteps,
  type AntigravityStep,
} from "./antigravitySessionLog";

const POLL_MS = 2_000;
/** After the last child settles and the parent's log goes quiet, how long to keep watching. */
const REPLY_GRACE_MS = 90_000;
/** A child with no new step for this long is reported stopped. */
const CHILD_SILENCE_MS = 30 * 60_000;
const DESCRIPTION_LIMIT = 400;
const SUMMARY_LIMIT = 8_000;

type Launch = { role: string; prompt: string; typeName: string | null };

type Child = {
  taskId: string;
  file: string | null;
  cursor: number;
  lastTool: string | null;
  lastActivityAt: number;
  signature: string;
};

function parseLaunch(args: string): Launch {
  try {
    const value = JSON.parse(args) as Record<string, unknown>;
    const str = (key: string) => (typeof value[key] === "string" ? (value[key] as string).trim() : "");
    return { role: str("Role") || "Subagent", prompt: str("Prompt"), typeName: str("TypeName") || null };
  } catch {
    return { role: "Subagent", prompt: "", typeName: null };
  }
}

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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

  const readParent = (reportReplies: boolean, events: AcpBackgroundEvent[]) => {
    if (!parentFile) return;
    const steps: AntigravityStep[] = readAntigravitySteps(parentFile, cursor) ?? [];
    for (const step of steps) {
      cursor = Math.max(cursor, step.idx);
      if (step.kind === "reply") {
        for (const call of step.toolCalls) {
          if (call.name === "invoke_subagent" && call.id) launches.set(call.id, parseLaunch(call.args));
        }
        if (reportReplies && (step.text.trim() || step.thinking.trim())) {
          events.push({ kind: "agent_reply", text: step.text, thinking: step.thinking });
        }
        continue;
      }
      if (step.kind === "tool" && step.toolCall.name === "invoke_subagent") {
        const launch = launches.get(step.toolCall.id) ?? parseLaunch(step.toolCall.args);
        const ids = antigravityLaunchedConversationIds(step.text);
        ids.forEach((childId, index) => {
          if (children.has(childId)) return;
          const file = antigravityConversationFile(childId, args.cliDir);
          children.set(childId, {
            taskId: childId,
            file,
            cursor: -1,
            lastTool: null,
            lastActivityAt: now(),
            signature: "",
          });
          events.push({
            kind: "subagent_started",
            taskId: childId,
            label: ids.length > 1 ? `${launch.role} ${index + 1}` : launch.role,
            description: bounded(launch.prompt || launch.role, DESCRIPTION_LIMIT),
            agentType: launch.typeName,
            parentToolUseId: step.toolCall.id || null,
          });
        });
        continue;
      }
      if (step.kind === "message" && step.senderId && children.has(step.senderId)) {
        settle(step.senderId, "completed", step.content || step.title, events);
      }
    }
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
      if (now() - child.lastActivityAt > CHILD_SILENCE_MS) {
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
        readParent(true, events);
      }
    }
    if (events.length) args.emit(events);
    if (!children.size && now() - lastSettledAt > REPLY_GRACE_MS) stopTimer();
  }

  return {
    turnStarting() {
      if (disposed) return;
      // Anything written while idle is reported before the turn's own stream.
      const events: AcpBackgroundEvent[] = [];
      readParent(true, events);
      if (events.length) args.emit(events);
      inTurn = true;
    },
    turnEnded() {
      if (disposed) return;
      inTurn = false;
      // The turn's own replies were streamed; only launches and results count.
      const events: AcpBackgroundEvent[] = [];
      readParent(false, events);
      parentSignature = logSignature(parentFile);
      if (events.length) args.emit(events);
      if (children.size) startTimer();
    },
    hasOpenWork: () => !disposed && children.size > 0,
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
