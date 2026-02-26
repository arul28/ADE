/**
 * planningPipeline.ts
 *
 * Planning and evaluation: planWithAI, evaluateWorkerPlan, adjustPlanWithAI,
 * handleInterventionWithAI, getExecutionPlanPreview, planner session management.
 *
 * Extracted from aiOrchestratorService.ts — pure refactor, no behavior changes.
 */

import type {
  OrchestratorContext,
  MissionRuntimeProfile,
  PlannerAgentSessionState,
  PlannerTurnCompletion,
  PlannerTurnCompletionStatus,
  Deferred,
  OrchestratorChatMessage,
  OrchestratorChatThread,
  ResolvedOrchestratorConfig,
} from "./orchestratorContext";
import {
  nowIso,
  isRecord,
  createDeferred,
  plannerThreadId,
  PLANNER_THREAD_TITLE,
  PLANNER_THREAD_STEP_KEY,
  PLANNER_STREAM_FLUSH_CHARS,
  PLANNER_STREAM_FLUSH_INTERVAL_MS,
  PLANNER_STREAM_MIN_INTERVAL_FLUSH_CHARS,
  MAX_PLANNER_RAW_OUTPUT_CHARS,
  toOptionalString,
} from "./orchestratorContext";
import type {
  MissionExecutionPolicy,
  MissionDetail,
  OrchestratorRunGraph,
  ExecutionPlanPreview,
  ExecutionPlanPhase,
  ExecutionPlanStepPreview,
  OrchestratorWorkerRole,
  RecoveryLoopPolicy,
  IntegrationPrPolicy,
  TeamManifest,
  ModelConfig,
} from "../../../shared/types";
import {
  DEFAULT_RECOVERY_LOOP_POLICY,
  DEFAULT_INTEGRATION_PR_POLICY
} from "../../../shared/types";
import { buildExecutionPlanPreview } from "./executionPolicy";

// ── Planner Stream Functions ─────────────────────────────────────

export function flushPlannerStreamBuffer(
  state: PlannerAgentSessionState,
  force = false,
  deps: {
    appendPlannerWorkerMessage: (state: PlannerAgentSessionState, content: string, metadata?: Record<string, unknown> | null) => OrchestratorChatMessage | null;
  }
): void {
  if (!state.streamBuffer.length) return;
  if (!force) {
    const hasParagraphBreak = /\n{2,}/.test(state.streamBuffer);
    const trailingWindow = state.streamBuffer.slice(-200);
    const hasSentenceBoundary = /[.!?](?:\s|\n|$)/.test(trailingWindow);
    const exceededChunkThreshold = state.streamBuffer.length >= PLANNER_STREAM_FLUSH_CHARS;
    const exceededInterval =
      Date.now() - state.lastStreamFlushAtMs >= PLANNER_STREAM_FLUSH_INTERVAL_MS
      && state.streamBuffer.length >= PLANNER_STREAM_MIN_INTERVAL_FLUSH_CHARS;
    if (!hasParagraphBreak && !hasSentenceBoundary && !exceededChunkThreshold && !exceededInterval) {
      return;
    }
  }

  if (!force && state.streamBuffer.trim().length < 10) {
    return;
  }

  let chunk = state.streamBuffer;
  if (!force) {
    let boundary = Math.min(state.streamBuffer.length, PLANNER_STREAM_FLUSH_CHARS);
    const paragraphBoundary = state.streamBuffer.lastIndexOf("\n\n", boundary);
    if (paragraphBoundary >= 120) {
      boundary = paragraphBoundary + 2;
    } else {
      const lastNewline = state.streamBuffer.lastIndexOf("\n", boundary);
      if (lastNewline >= 120) {
        boundary = lastNewline + 1;
      } else {
        const sentenceSlice = state.streamBuffer.slice(0, boundary);
        const sentencePattern = /[.!?](?:\s|\n|$)/g;
        let sentenceBoundary = -1;
        let sentenceMatch: RegExpExecArray | null = null;
        while ((sentenceMatch = sentencePattern.exec(sentenceSlice)) !== null) {
          sentenceBoundary = sentenceMatch.index + sentenceMatch[0].length;
        }
        if (sentenceBoundary >= 160) {
          boundary = sentenceBoundary;
        }
      }
    }
    chunk = state.streamBuffer.slice(0, boundary);
    state.streamBuffer = state.streamBuffer.slice(boundary);
  } else {
    state.streamBuffer = "";
  }

  state.lastStreamFlushAtMs = Date.now();
  deps.appendPlannerWorkerMessage(state, chunk, {
    planner: {
      stream: true,
      sessionId: state.sessionId
    }
  });
}

export function appendPlannerTextDelta(
  state: PlannerAgentSessionState,
  rawDelta: string,
  deps: {
    appendPlannerWorkerMessage: (state: PlannerAgentSessionState, content: string, metadata?: Record<string, unknown> | null) => OrchestratorChatMessage | null;
  }
): void {
  let delta = String(rawDelta ?? "");
  if (delta.includes("<thinking>") || delta.includes("</thinking>")) {
    delta = delta.replace(/<\/?thinking>/g, "");
  }
  if (!delta.trim().length) return;
  if (state.rawOutput.length < MAX_PLANNER_RAW_OUTPUT_CHARS) {
    const remaining = MAX_PLANNER_RAW_OUTPUT_CHARS - state.rawOutput.length;
    const accepted = delta.slice(0, remaining);
    state.rawOutput += accepted;
    if (accepted.length < delta.length) {
      state.rawOutputTruncated = true;
    }
  } else {
    state.rawOutputTruncated = true;
  }
  state.streamBuffer += delta;
  flushPlannerStreamBuffer(state, false, deps);
}

export function beginPlannerTurn(state: PlannerAgentSessionState): Deferred<PlannerTurnCompletion> {
  if (state.turn && !state.turn.settled) {
    state.turn.resolve({
      status: "interrupted",
      rawOutput: state.rawOutput,
      error: "Planner turn was interrupted by a newer turn."
    });
  }
  state.rawOutput = "";
  state.rawOutputTruncated = false;
  state.streamBuffer = "";
  state.lastStreamFlushAtMs = 0;
  state.activeTurnId = null;
  const turn = createDeferred<PlannerTurnCompletion>();
  state.turn = turn;
  return turn;
}

export function completePlannerTurn(
  state: PlannerAgentSessionState,
  status: PlannerTurnCompletionStatus,
  error: string | null,
  deps: {
    appendPlannerWorkerMessage: (state: PlannerAgentSessionState, content: string, metadata?: Record<string, unknown> | null) => OrchestratorChatMessage | null;
  }
): void {
  flushPlannerStreamBuffer(state, true, deps);
  if (state.rawOutputTruncated) {
    deps.appendPlannerWorkerMessage(
      state,
      "Planner output exceeded capture limit; response was truncated in-thread.",
      {
        planner: {
          truncated: true,
          sessionId: state.sessionId
        }
      }
    );
  }
  const turn = state.turn;
  if (!turn || turn.settled) return;
  turn.resolve({
    status,
    rawOutput: state.rawOutput,
    error
  });
  state.turn = null;
}

export function registerPlannerSession(ctx: OrchestratorContext, state: PlannerAgentSessionState, deps: {
  completePlannerTurn: (state: PlannerAgentSessionState, status: PlannerTurnCompletionStatus, error: string | null) => void;
}): void {
  const existingByMission = ctx.plannerSessionByMissionId.get(state.missionId);
  if (existingByMission && existingByMission.sessionId !== state.sessionId) {
    deps.completePlannerTurn(
      existingByMission,
      "interrupted",
      "Planner session was replaced by a newer planning run."
    );
    ctx.plannerSessionBySessionId.delete(existingByMission.sessionId);
  }
  ctx.plannerSessionByMissionId.set(state.missionId, state);
  ctx.plannerSessionBySessionId.set(state.sessionId, state);
}

// ── Intervention Prompt Builder ──────────────────────────────────

export function buildInterventionResolverPrompt(args: {
  missionTitle: string;
  missionPrompt: string;
  interventionDescription: string;
  runContext: string;
  steeringContext: string;
  confidenceThreshold: number;
}): string {
  return [
    `You are an AI orchestrator deciding how to handle an intervention during a mission.`,
    ``,
    `Mission: ${args.missionTitle}`,
    `Prompt: ${args.missionPrompt.slice(0, 300)}`,
    ``,
    `Intervention: ${args.interventionDescription}`,
    ``,
    `Run context: ${args.runContext}`,
    args.steeringContext.length > 0 ? `\nSteering context:\n${args.steeringContext}` : "",
    ``,
    `Confidence threshold for auto-resolution: ${args.confidenceThreshold}`,
    ``,
    `Respond with a JSON object:`,
    `{`,
    `  "autoResolvable": boolean,`,
    `  "confidence": number (0-1),`,
    `  "suggestedAction": "retry" | "skip" | "add_workaround" | "escalate",`,
    `  "reasoning": string,`,
    `  "retryInstructions": string (if action is retry)`,
    `}`
  ].join("\n");
}

// ── Failure Diagnosis Prompt ─────────────────────────────────────

export function buildFailureDiagnosisPrompt(args: {
  stepTitle: string;
  stepKey: string;
  missionTitle: string;
  missionObjective: string;
  stepInstructions: string;
  errorClass: string;
  errorMessage: string;
  attemptSummary: string;
  retryCount: number;
  retryLimit: number;
  tier: string;
  peerField: string;
}): string {
  return `You are the orchestrator's failure diagnosis engine. An agent working on a mission step has failed. Analyze the failure and provide recovery guidance.

Step: "${args.stepTitle}" (key: ${args.stepKey})
Mission: "${args.missionTitle}"
Objective: "${args.missionObjective}"
Step Instructions: ${args.stepInstructions.slice(0, 2000)}

Failure Details:
- Error class: ${args.errorClass}
- Error message: ${args.errorMessage.slice(0, 1500)}
- Attempt output: ${args.attemptSummary.slice(0, 2000)}
- Retry: ${args.retryCount}/${args.retryLimit}
- Tier: ${args.tier}

Respond with JSON only:
{
  "classification": "1-sentence diagnosis of root cause",
  "adjustedHint": "specific instruction for the retry agent on what to do differently (be concrete: which file, which approach, what to avoid)",
  ${args.peerField},
  "suggestedModel": null
}`;
}
