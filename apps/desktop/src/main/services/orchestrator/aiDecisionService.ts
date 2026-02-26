import { randomUUID } from "node:crypto";

export type SqlValue = string | number | null | Uint8Array;

export type AiDecisionName =
  | "decideLaneStrategy"
  | "decideParallelism"
  | "decideTransition"
  | "decideRetry"
  | "decideTimeoutBudget"
  | "decideStepPriority"
  | "evaluateStagnation"
  | "evaluateQualityGate"
  | "decideRecovery"
  | "replanMission";

export type AiDecisionCallType =
  | "lane_strategy"
  | "parallelism_decision"
  | "step_transition"
  | "retry_decision"
  | "timeout_estimation"
  | "step_priority"
  | "stagnation_evaluation"
  | "quality_gate"
  | "recovery_decision"
  | "plan_adjustment";

const CALL_TYPE_BY_DECISION_NAME: Record<AiDecisionName, AiDecisionCallType> = {
  decideLaneStrategy: "lane_strategy",
  decideParallelism: "parallelism_decision",
  decideTransition: "step_transition",
  decideRetry: "retry_decision",
  decideTimeoutBudget: "timeout_estimation",
  decideStepPriority: "step_priority",
  evaluateStagnation: "stagnation_evaluation",
  evaluateQualityGate: "quality_gate",
  decideRecovery: "recovery_decision",
  replanMission: "plan_adjustment"
};

function toDecisionCallType(decisionName: AiDecisionName): AiDecisionCallType {
  return CALL_TYPE_BY_DECISION_NAME[decisionName];
}

export type DecisionTaskType = "planning" | "review" | "implementation";

export type DecisionContext = {
  missionId: string;
  projectId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  laneId?: string | null;
  attemptId?: string | null;
};

export type DecisionFailureCode = "DECISION_FAILURE";

export class DecisionFailure extends Error {
  public readonly code: DecisionFailureCode = "DECISION_FAILURE";
  public readonly decisionName: AiDecisionName;
  public readonly context: DecisionContext;
  public readonly input: unknown;

  constructor(args: {
    decisionName: AiDecisionName;
    context: DecisionContext;
    message: string;
    input: unknown;
    cause?: unknown;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = "DecisionFailure";
    this.decisionName = args.decisionName;
    this.context = args.context;
    this.input = args.input;
  }
}

export type AiDecisionExecuteTaskArgs = {
  feature: "orchestrator";
  taskType: DecisionTaskType;
  prompt: string;
  cwd: string;
  provider?: "claude" | "codex";
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  oneShot?: boolean;
  jsonSchema?: unknown;
  tools?: AiDecisionToolsPayload;
};

export type AiDecisionExecuteTaskResult = {
  text: string;
  structuredOutput: unknown;
  provider: "claude" | "codex";
  model: string | null;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
};

export type ComplexAiDecisionName = Extract<
  AiDecisionName,
  "decideLaneStrategy" | "decideTransition" | "decideRecovery" | "replanMission"
>;

export type ComplexDecisionToolsPayload =
  | {
      decisionName: "decideLaneStrategy";
      context: DecisionContext;
      input: Pick<DecideLaneStrategyArgs, "missionObjective" | "laneSignals" | "constraints">;
    }
  | {
      decisionName: "decideTransition";
      context: DecisionContext;
      input: Pick<
        DecideTransitionArgs,
        "currentStatus"
        | "unresolvedDependencies"
        | "retryCount"
        | "retryLimit"
        | "missionModelConfig"
        | "requestedTimeoutMs"
        | "recentFailureSummary"
      >;
    }
  | {
      decisionName: "decideRecovery";
      context: DecisionContext;
      input: Pick<
        DecideRecoveryArgs,
        "failureClass" | "failureMessage" | "retryCount" | "retryLimit" | "qualityGateFailed"
      >;
    }
  | {
      decisionName: "replanMission";
      context: DecisionContext;
      input: Pick<ReplanMissionArgs, "missionObjective" | "currentPlanSummary" | "failureDigest">;
    };

export type AiDecisionToolsPayload = {
  mode: "if_available";
  deterministicFallback: "none";
  toolset: "orchestrator_complex_decision_v1";
  payload: ComplexDecisionToolsPayload;
};

type AiDecisionExecuteTaskWithToolsArgs = AiDecisionExecuteTaskArgs & {
  tools: AiDecisionToolsPayload;
};

export type AiDecisionIntegrationService = {
  executeTask: (args: AiDecisionExecuteTaskArgs) => Promise<AiDecisionExecuteTaskResult>;
  executeTaskWithTools?: (args: AiDecisionExecuteTaskWithToolsArgs) => Promise<AiDecisionExecuteTaskResult>;
};

export type AiDecisionDb = {
  run: (sql: string, params?: SqlValue[]) => void;
  all?: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T[];
};

export type AiDecisionLogger = {
  debug?: (event: string, meta?: Record<string, unknown>) => void;
  info?: (event: string, meta?: Record<string, unknown>) => void;
  warn?: (event: string, meta?: Record<string, unknown>) => void;
  error?: (event: string, meta?: Record<string, unknown>) => void;
};

export type MissionModelConfigLike = {
  decisionTimeoutCapHours?: TimeoutCapHours | null;
  timeoutCapWindow?: TimeoutCapWindow | null;
  timeoutBudgetCap?: TimeoutCapWindow | null;
  maxTimeoutWindow?: TimeoutCapWindow | null;
};

export type TimeoutCapWindow = "6h" | "12h" | "24h" | "48h";
export type TimeoutCapHours = 6 | 12 | 24 | 48;

const TIMEOUT_CAP_MS_BY_WINDOW: Record<TimeoutCapWindow, number> = {
  "6h": 6 * 60 * 60 * 1_000,
  "12h": 12 * 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
  "48h": 48 * 60 * 60 * 1_000
};

const TIMEOUT_CAP_MS_BY_HOURS: Record<TimeoutCapHours, number> = {
  6: 6 * 60 * 60 * 1_000,
  12: 12 * 60 * 60 * 1_000,
  24: 24 * 60 * 60 * 1_000,
  48: 48 * 60 * 60 * 1_000
};

function asTimeoutCapHours(value: unknown): TimeoutCapHours | null {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const normalized = Math.floor(raw);
  if (normalized === 6 || normalized === 12 || normalized === 24 || normalized === 48) {
    return normalized;
  }
  return null;
}

export function resolveTimeoutCapMs(missionModelConfig?: MissionModelConfigLike | null): number {
  const timeoutCapHours = asTimeoutCapHours(missionModelConfig?.decisionTimeoutCapHours);
  if (timeoutCapHours !== null) {
    return TIMEOUT_CAP_MS_BY_HOURS[timeoutCapHours];
  }
  const raw =
    missionModelConfig?.timeoutCapWindow
    ?? missionModelConfig?.timeoutBudgetCap
    ?? missionModelConfig?.maxTimeoutWindow
    ?? "24h";

  return TIMEOUT_CAP_MS_BY_WINDOW[raw] ?? TIMEOUT_CAP_MS_BY_WINDOW["24h"];
}

export type LaneStrategyDecision = {
  strategy: "single_lane" | "dependency_parallel" | "phase_parallel";
  maxParallelLanes: number;
  rationale: string;
  confidence: number;
  stepAssignments: LaneStrategyStepAssignment[];
};

export type LaneStrategyStepDescriptor = {
  stepKey: string;
  title: string;
  stepType: string;
  dependencyStepKeys: string[];
  laneId: string | null;
};

export type LaneStrategyStepAssignment = {
  stepKey: string;
  laneLabel: string;
  rationale?: string;
};

export type DecideLaneStrategyArgs = {
  context: DecisionContext;
  missionObjective: string;
  laneSignals: {
    candidateSteps: number;
    blockedSteps: number;
    dependencyEdges: number;
    currentParallelLanes: number;
  };
  stepDescriptors: LaneStrategyStepDescriptor[];
  constraints?: {
    maxParallelLanes?: number;
  };
};

export type TransitionActionType = "continue" | "retry" | "pause" | "replan" | "abort";

export type ParallelismDecision = {
  parallelismCap: number;
  rationale: string;
  confidence: number;
};

export type DecideParallelismArgs = {
  context: DecisionContext;
  missionObjective: string;
  plannerParallelismCap: number | null;
  laneStrategyParallelismCap: number | null;
  runMode: "manual" | "autopilot";
  stepCount: number;
  laneCount: number;
};

export type TransitionAction = {
  type: TransitionActionType;
  reason: string;
  nextStatus: string | null;
  retryDelayMs: number | null;
  timeoutBudgetMs: number | null;
};

export type TransitionDecision = {
  action: TransitionAction;
  rationale: string;
  confidence: number;
  validationNotes: string[];
};

export type DecideTransitionArgs = {
  context: DecisionContext;
  currentStatus: string;
  unresolvedDependencies?: string[];
  retryCount: number;
  retryLimit: number;
  missionModelConfig?: MissionModelConfigLike | null;
  requestedTimeoutMs?: number | null;
  recentFailureSummary?: string | null;
};

export type RetryDecision = {
  shouldRetry: boolean;
  delayMs: number;
  reason: string;
  adjustedHint: string | null;
  confidence: number;
};

export type DecideRetryArgs = {
  context: DecisionContext;
  errorClass: string;
  errorMessage: string;
  retryCount: number;
  retryLimit: number;
  lastAttemptSummary?: string | null;
};

export type TimeoutBudgetDecision = {
  timeoutMs: number;
  capMs: number;
  capped: boolean;
  rationale: string;
  confidence: number;
};

export type DecideTimeoutBudgetArgs = {
  context: DecisionContext;
  missionModelConfig?: MissionModelConfigLike | null;
  stepKind: string;
  complexityScore: number;
  historicalDurationMs?: number | null;
};

export type StepPriorityDecision = {
  priority: number;
  laneHint: string | null;
  rationale: string;
  confidence: number;
};

export type DecideStepPriorityArgs = {
  context: DecisionContext;
  stepKey: string;
  stepType: string;
  urgency: "low" | "medium" | "high" | "critical";
  blockedByCount: number;
  dependencyDepth: number;
};

export type StagnationEvaluation = {
  isStagnating: boolean;
  severity: "none" | "low" | "medium" | "high";
  recommendedAction: "continue" | "nudge" | "replan" | "pause";
  rationale: string;
  confidence: number;
};

export type EvaluateStagnationArgs = {
  context: DecisionContext;
  noProgressMs: number;
  retryCount: number;
  runtimeDigest: string;
};

export type QualityGateEvaluation = {
  passed: boolean;
  reason: string;
  blockingFindings: string[];
  confidence: number;
};

export type EvaluateQualityGateArgs = {
  context: DecisionContext;
  missionObjective: string;
  stepTitle: string;
  stepType: string;
  stepOutput: string;
};

export type RecoveryDecision = {
  action: "retry_with_hint" | "escalate" | "replan" | "pause";
  reason: string;
  retryHint: string | null;
  confidence: number;
};

export type DecideRecoveryArgs = {
  context: DecisionContext;
  failureClass: string;
  failureMessage: string;
  retryCount: number;
  retryLimit: number;
  qualityGateFailed?: boolean;
};

export type MissionReplanDecision = {
  shouldReplan: boolean;
  summary: string;
  planDelta: string[];
  confidence: number;
};

export type ReplanMissionArgs = {
  context: DecisionContext;
  missionObjective: string;
  currentPlanSummary: string;
  failureDigest: string;
};

export type DecisionFailurePause = {
  shouldPause: true;
  code: "decision_failure";
  reason: string;
  metadata: {
    decisionName: AiDecisionName;
    missionId: string;
    runId: string | null;
    stepId: string | null;
    message: string;
  };
};

export type PauseForDecisionFailureArgs = {
  failure: DecisionFailure;
  reasonPrefix?: string;
};

export type AiDecisionService = {
  decideLaneStrategy: (args: DecideLaneStrategyArgs) => Promise<LaneStrategyDecision>;
  decideParallelism: (args: DecideParallelismArgs) => Promise<ParallelismDecision>;
  decideTransition: (args: DecideTransitionArgs) => Promise<TransitionDecision>;
  decideRetry: (args: DecideRetryArgs) => Promise<RetryDecision>;
  decideTimeoutBudget: (args: DecideTimeoutBudgetArgs) => Promise<TimeoutBudgetDecision>;
  decideStepPriority: (args: DecideStepPriorityArgs) => Promise<StepPriorityDecision>;
  evaluateStagnation: (args: EvaluateStagnationArgs) => Promise<StagnationEvaluation>;
  evaluateQualityGate: (args: EvaluateQualityGateArgs) => Promise<QualityGateEvaluation>;
  decideRecovery: (args: DecideRecoveryArgs) => Promise<RecoveryDecision>;
  replanMission: (args: ReplanMissionArgs) => Promise<MissionReplanDecision>;
  pauseForDecisionFailure: (args: PauseForDecisionFailureArgs) => DecisionFailurePause;
};

export type CreateAiDecisionServiceArgs = {
  aiIntegrationService: AiDecisionIntegrationService;
  projectRoot: string;
  db?: AiDecisionDb;
  logger?: AiDecisionLogger;
  now?: () => Date;
  createId?: () => string;
  defaultProvider?: "claude" | "codex";
  defaultModel?: string;
  defaultReasoningEffort?: string;
  defaultTimeoutMs?: number | null;
  resolveModel?: (ctx: { missionId: string; decisionName: AiDecisionName }) => {
    provider: "claude" | "codex";
    model: string;
    reasoningEffort?: string;
  } | null;
};

type DecisionLogRecord = {
  decisionName: AiDecisionName;
  context: DecisionContext;
  request: unknown;
  response: unknown;
  validation: unknown;
  rationale: string | null;
  errorMessage: string | null;
  provider: string | null;
  model: string | null;
  timeoutCapMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  createdAt: string;
};

type RunStructuredDecisionArgs<TOutput> = {
  decisionName: AiDecisionName;
  taskType: DecisionTaskType;
  context: DecisionContext;
  input: unknown;
  prompt: string;
  schema: Record<string, unknown>;
  parse: (value: unknown) => TOutput;
  timeoutMs?: number;
  tools?: AiDecisionToolsPayload;
};

const LANE_STRATEGY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["strategy", "maxParallelLanes", "rationale", "confidence", "stepAssignments"],
  properties: {
    strategy: { type: "string", enum: ["single_lane", "dependency_parallel", "phase_parallel"] },
    maxParallelLanes: { type: "integer", minimum: 1, maximum: 16 },
    rationale: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    stepAssignments: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stepKey", "laneLabel"],
        properties: {
          stepKey: { type: "string", minLength: 1 },
          laneLabel: { type: "string", minLength: 1 },
          rationale: { type: "string" }
        }
      }
    }
  }
};

const TRANSITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["actionType", "reason", "rationale", "confidence"],
  properties: {
    actionType: { type: "string", enum: ["continue", "retry", "pause", "replan", "abort"] },
    reason: { type: "string", minLength: 1 },
    rationale: { type: "string", minLength: 1 },
    nextStatus: { type: ["string", "null"] },
    retryDelayMs: { type: ["integer", "null"], minimum: 0 },
    timeoutBudgetMs: { type: ["integer", "null"], minimum: 1000 },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const PARALLELISM_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["parallelismCap", "rationale", "confidence"],
  properties: {
    parallelismCap: { type: "integer", minimum: 1, maximum: 32 },
    rationale: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const RETRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["shouldRetry", "delayMs", "reason", "confidence"],
  properties: {
    shouldRetry: { type: "boolean" },
    delayMs: { type: "integer", minimum: 0 },
    reason: { type: "string", minLength: 1 },
    adjustedHint: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const TIMEOUT_BUDGET_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["timeoutMs", "rationale", "confidence"],
  properties: {
    timeoutMs: { type: "integer", minimum: 1000 },
    rationale: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const STEP_PRIORITY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["priority", "rationale", "confidence"],
  properties: {
    priority: { type: "number", minimum: 0, maximum: 100 },
    laneHint: { type: ["string", "null"] },
    rationale: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const STAGNATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["isStagnating", "severity", "recommendedAction", "rationale", "confidence"],
  properties: {
    isStagnating: { type: "boolean" },
    severity: { type: "string", enum: ["none", "low", "medium", "high"] },
    recommendedAction: { type: "string", enum: ["continue", "nudge", "replan", "pause"] },
    rationale: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const QUALITY_GATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    reason: { type: "string", minLength: 1 },
    blockingFindings: {
      type: "array",
      items: { type: "string" },
      maxItems: 12
    },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const RECOVERY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason", "confidence"],
  properties: {
    action: { type: "string", enum: ["retry_with_hint", "escalate", "replan", "pause"] },
    reason: { type: "string", minLength: 1 },
    retryHint: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const REPLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["shouldReplan", "summary", "planDelta", "confidence"],
  properties: {
    shouldReplan: { type: "boolean" },
    summary: { type: "string", minLength: 1 },
    planDelta: {
      type: "array",
      items: { type: "string" },
      maxItems: 20
    },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toIso(now: () => Date): string {
  return now().toISOString();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ fallback: String(value) });
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function asInteger(value: unknown): number | null {
  const num = asFiniteNumber(value);
  if (num === null) return null;
  return Math.floor(num);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = asString(entry);
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function parseLaneStrategyDecision(value: unknown): LaneStrategyDecision {
  const obj = expectRecord(value, "lane strategy decision");
  const strategy = expectEnum(obj, "strategy", ["single_lane", "dependency_parallel", "phase_parallel"]);
  const maxParallelLanes = clampNumber(expectInteger(obj, "maxParallelLanes"), 1, 16);
  const rationale = expectString(obj, "rationale");
  const confidence = clampNumber(expectNumber(obj, "confidence"), 0, 1);
  const assignmentsValue = obj.stepAssignments;
  if (!Array.isArray(assignmentsValue) || assignmentsValue.length === 0) {
    throw new Error("Expected non-empty array at 'stepAssignments'");
  }
  const stepAssignments: LaneStrategyStepAssignment[] = assignmentsValue.map((entry, index) => {
    const assignment = expectRecord(entry, `lane strategy decision.stepAssignments[${index}]`);
    return {
      stepKey: expectString(assignment, "stepKey"),
      laneLabel: expectString(assignment, "laneLabel"),
      ...(asString(assignment.rationale) ? { rationale: asString(assignment.rationale)! } : {})
    };
  });
  return {
    strategy,
    maxParallelLanes,
    rationale,
    confidence,
    stepAssignments
  };
}

function parseTransitionDecision(value: unknown): TransitionDecision {
  const obj = expectRecord(value, "transition decision");
  const actionType = expectEnum(obj, "actionType", ["continue", "retry", "pause", "replan", "abort"]);
  const reason = expectString(obj, "reason");
  const rationale = expectString(obj, "rationale");
  const confidence = clampNumber(expectNumber(obj, "confidence"), 0, 1);

  return {
    action: {
      type: actionType,
      reason,
      nextStatus: asString(obj.nextStatus),
      retryDelayMs: toNullableInteger(obj.retryDelayMs),
      timeoutBudgetMs: toNullableInteger(obj.timeoutBudgetMs)
    },
    rationale,
    confidence,
    validationNotes: []
  };
}

function parseParallelismDecision(value: unknown): ParallelismDecision {
  const obj = expectRecord(value, "parallelism decision");
  return {
    parallelismCap: Math.floor(clampNumber(expectInteger(obj, "parallelismCap"), 1, 32)),
    rationale: expectString(obj, "rationale"),
    confidence: clampNumber(expectNumber(obj, "confidence"), 0, 1)
  };
}

function parseRetryDecision(value: unknown): RetryDecision {
  const obj = expectRecord(value, "retry decision");
  const shouldRetry = expectBoolean(obj, "shouldRetry");
  const delayMs = Math.max(0, expectInteger(obj, "delayMs"));
  const reason = expectString(obj, "reason");
  const confidence = clampNumber(expectNumber(obj, "confidence"), 0, 1);
  return {
    shouldRetry,
    delayMs,
    reason,
    adjustedHint: asString(obj.adjustedHint),
    confidence
  };
}

function parseTimeoutBudgetDecision(value: unknown): { timeoutMs: number; rationale: string; confidence: number } {
  const obj = expectRecord(value, "timeout budget decision");
  return {
    timeoutMs: Math.max(1_000, expectInteger(obj, "timeoutMs")),
    rationale: expectString(obj, "rationale"),
    confidence: clampNumber(expectNumber(obj, "confidence"), 0, 1)
  };
}

function parseStepPriorityDecision(value: unknown): StepPriorityDecision {
  const obj = expectRecord(value, "step priority decision");
  return {
    priority: clampNumber(expectNumber(obj, "priority"), 0, 100),
    laneHint: asString(obj.laneHint),
    rationale: expectString(obj, "rationale"),
    confidence: clampNumber(expectNumber(obj, "confidence"), 0, 1)
  };
}

function parseStagnationEvaluation(value: unknown): StagnationEvaluation {
  const obj = expectRecord(value, "stagnation evaluation");
  return {
    isStagnating: expectBoolean(obj, "isStagnating"),
    severity: expectEnum(obj, "severity", ["none", "low", "medium", "high"]),
    recommendedAction: expectEnum(obj, "recommendedAction", ["continue", "nudge", "replan", "pause"]),
    rationale: expectString(obj, "rationale"),
    confidence: clampNumber(expectNumber(obj, "confidence"), 0, 1)
  };
}

function parseQualityGateEvaluation(value: unknown): QualityGateEvaluation {
  const obj = expectRecord(value, "quality gate evaluation");
  const verdict = expectEnum(obj, "verdict", ["pass", "fail"]);
  return {
    passed: verdict === "pass",
    reason: expectString(obj, "reason"),
    blockingFindings: asStringArray(obj.blockingFindings),
    confidence: clampNumber(expectNumber(obj, "confidence"), 0, 1)
  };
}

function parseRecoveryDecision(value: unknown): RecoveryDecision {
  const obj = expectRecord(value, "recovery decision");
  return {
    action: expectEnum(obj, "action", ["retry_with_hint", "escalate", "replan", "pause"]),
    reason: expectString(obj, "reason"),
    retryHint: asString(obj.retryHint),
    confidence: clampNumber(expectNumber(obj, "confidence"), 0, 1)
  };
}

function parseMissionReplanDecision(value: unknown): MissionReplanDecision {
  const obj = expectRecord(value, "mission replan decision");
  return {
    shouldReplan: expectBoolean(obj, "shouldReplan"),
    summary: expectString(obj, "summary"),
    planDelta: asStringArray(obj.planDelta),
    confidence: clampNumber(expectNumber(obj, "confidence"), 0, 1)
  };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function expectString(record: Record<string, unknown>, key: string): string {
  const value = asString(record[key]);
  if (!value) {
    throw new Error(`Expected non-empty string at '${key}'`);
  }
  return value;
}

function expectBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== "boolean") {
    throw new Error(`Expected boolean at '${key}'`);
  }
  return record[key] as boolean;
}

function expectNumber(record: Record<string, unknown>, key: string): number {
  const value = asFiniteNumber(record[key]);
  if (value === null) {
    throw new Error(`Expected number at '${key}'`);
  }
  return value;
}

function expectInteger(record: Record<string, unknown>, key: string): number {
  const value = asInteger(record[key]);
  if (value === null) {
    throw new Error(`Expected integer at '${key}'`);
  }
  return value;
}

function toNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = asInteger(value);
  return parsed === null ? null : parsed;
}

function expectEnum<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = asString(record[key]);
  if (!value || !allowed.includes(value as T)) {
    throw new Error(`Expected one of [${allowed.join(", ")}] at '${key}'`);
  }
  return value as T;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sanitizeContext(context: DecisionContext): DecisionContext {
  return {
    missionId: context.missionId,
    projectId: context.projectId ?? null,
    runId: context.runId ?? null,
    stepId: context.stepId ?? null,
    laneId: context.laneId ?? null,
    attemptId: context.attemptId ?? null
  };
}

function buildPrompt(args: { title: string; guidance: string; input: unknown }): string {
  return [
    "You are an orchestrator control-plane decision engine.",
    args.title,
    args.guidance,
    "Return structured output only. Do not include prose outside the schema.",
    `Input JSON:\n${truncate(safeJson(args.input), 16_000)}`
  ].join("\n\n");
}

function createToolsPayload(payload: ComplexDecisionToolsPayload): AiDecisionToolsPayload {
  return {
    mode: "if_available",
    deterministicFallback: "none",
    toolset: "orchestrator_complex_decision_v1",
    payload: {
      ...payload,
      context: sanitizeContext(payload.context)
    }
  };
}

function createLaneStrategyToolsPayload(args: DecideLaneStrategyArgs): AiDecisionToolsPayload {
  return createToolsPayload({
    decisionName: "decideLaneStrategy",
    context: args.context,
    input: {
      missionObjective: args.missionObjective,
      laneSignals: args.laneSignals,
      constraints: args.constraints
    }
  });
}

function createTransitionToolsPayload(args: DecideTransitionArgs): AiDecisionToolsPayload {
  return createToolsPayload({
    decisionName: "decideTransition",
    context: args.context,
    input: {
      currentStatus: args.currentStatus,
      unresolvedDependencies: args.unresolvedDependencies,
      retryCount: args.retryCount,
      retryLimit: args.retryLimit,
      missionModelConfig: args.missionModelConfig,
      requestedTimeoutMs: args.requestedTimeoutMs,
      recentFailureSummary: args.recentFailureSummary
    }
  });
}

function createRecoveryToolsPayload(args: DecideRecoveryArgs): AiDecisionToolsPayload {
  return createToolsPayload({
    decisionName: "decideRecovery",
    context: args.context,
    input: {
      failureClass: args.failureClass,
      failureMessage: args.failureMessage,
      retryCount: args.retryCount,
      retryLimit: args.retryLimit,
      qualityGateFailed: args.qualityGateFailed
    }
  });
}

function createReplanToolsPayload(args: ReplanMissionArgs): AiDecisionToolsPayload {
  return createToolsPayload({
    decisionName: "replanMission",
    context: args.context,
    input: {
      missionObjective: args.missionObjective,
      currentPlanSummary: args.currentPlanSummary,
      failureDigest: args.failureDigest
    }
  });
}

function validateTransitionAction(args: {
  decision: TransitionDecision;
  unresolvedDependencies: string[];
  retryCount: number;
  retryLimit: number;
  timeoutCapMs: number;
}): TransitionDecision {
  // Validation is intentionally conservative: it enforces dependency safety
  // and timeout cap compliance before execution wiring happens elsewhere.
  const action: TransitionAction = { ...args.decision.action };
  const validationNotes = [...args.decision.validationNotes];

  if (args.unresolvedDependencies.length > 0 && action.type === "continue") {
    action.type = "pause";
    action.reason = `Blocked by unresolved dependencies (${args.unresolvedDependencies.join(", ")}).`;
    action.nextStatus = "blocked";
    action.retryDelayMs = null;
    validationNotes.push("dependency_safe_override:blocking_dependencies");
  }

  if (action.type === "retry" && args.retryCount >= args.retryLimit) {
    action.type = "replan";
    action.reason = `Retry cap reached (${args.retryCount}/${args.retryLimit}).`;
    action.retryDelayMs = null;
    validationNotes.push("dependency_safe_override:retry_cap_reached");
  }

  if (typeof action.timeoutBudgetMs === "number") {
    const clamped = Math.floor(clampNumber(action.timeoutBudgetMs, 1_000, args.timeoutCapMs));
    if (clamped !== action.timeoutBudgetMs) {
      action.timeoutBudgetMs = clamped;
      validationNotes.push("cap_safe_override:timeout_clamped");
    }
  }

  return {
    ...args.decision,
    action,
    validationNotes
  };
}

const DEFAULT_DECISION_LOG_COLUMNS = [
  "id",
  "project_id",
  "mission_id",
  "run_id",
  "step_id",
  "attempt_id",
  "call_type",
  "provider",
  "model",
  "timeout_cap_ms",
  "decision_json",
  "action_trace_json",
  "validation_json",
  "rationale",
  "failure_reason",
  "duration_ms",
  "prompt_tokens",
  "completion_tokens",
  "created_at"
] as const;

function extractDecisionRationale(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return asString(value.rationale) ?? asString(value.reason);
}

function extractDecisionValidation(value: unknown): unknown {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.validationNotes)) return value.validationNotes;
  return null;
}

export function createAiDecisionService(args: CreateAiDecisionServiceArgs): AiDecisionService {
  const now = args.now ?? (() => new Date());
  const createId = args.createId ?? randomUUID;
  const configuredDefaultTimeout = Number(args.defaultTimeoutMs);
  const defaultTimeoutMs =
    Number.isFinite(configuredDefaultTimeout) && configuredDefaultTimeout > 0
      ? Math.max(1_000, Math.floor(configuredDefaultTimeout))
      : null;
  const defaultModel = asString(args.defaultModel);
  const defaultReasoningEffort = asString(args.defaultReasoningEffort);

  let cachedDecisionColumns: Set<string> | null | undefined;

  const getDecisionColumns = (): Set<string> | null => {
    if (!args.db?.all) return null;
    if (cachedDecisionColumns !== undefined) return cachedDecisionColumns;
    try {
      const rows = args.db.all<{ name?: unknown }>("pragma table_info(orchestrator_ai_decisions)");
      const columns = new Set<string>();
      for (const row of rows) {
        const name = asString(row.name);
        if (name) columns.add(name);
      }
      cachedDecisionColumns = columns.size > 0 ? columns : null;
    } catch {
      cachedDecisionColumns = null;
    }
    return cachedDecisionColumns;
  };

  const writeDecisionLog = (record: DecisionLogRecord): void => {
    if (!args.db) return;

    const id = createId();
    const payloadByColumn: Record<string, SqlValue> = {
      id,
      project_id: record.context.projectId ?? null,
      mission_id: record.context.missionId,
      run_id: record.context.runId ?? null,
      step_id: record.context.stepId ?? null,
      attempt_id: record.context.attemptId ?? null,
      call_type: toDecisionCallType(record.decisionName),
      provider: record.provider,
      model: record.model,
      timeout_cap_ms: record.timeoutCapMs,
      decision_json: safeJson(record.response),
      action_trace_json: safeJson(record.request),
      validation_json: safeJson(record.validation),
      rationale: record.rationale,
      failure_reason: record.errorMessage,
      duration_ms: Math.max(0, Math.floor(record.latencyMs)),
      prompt_tokens: record.promptTokens,
      completion_tokens: record.completionTokens,
      created_at: record.createdAt
    };

    try {
      const knownColumns = getDecisionColumns();
      const columns = knownColumns
        ? Object.keys(payloadByColumn).filter((column) => knownColumns.has(column))
        : [...DEFAULT_DECISION_LOG_COLUMNS];

      if (columns.length === 0) return;

      const placeholders = columns.map(() => "?").join(", ");
      const sql = `insert into orchestrator_ai_decisions (${columns.join(", ")}) values (${placeholders})`;
      const params = columns.map((column) => payloadByColumn[column] ?? null);
      args.db.run(sql, params);
    } catch (error) {
      args.logger?.warn?.("ai_decision.log_write_failed", {
        decisionName: record.decisionName,
        missionId: record.context.missionId,
        error: toErrorMessage(error)
      });
    }
  };

  const runStructuredDecision = async <TOutput>(runArgs: RunStructuredDecisionArgs<TOutput>): Promise<TOutput> => {
    const context = sanitizeContext(runArgs.context);
    const startedAt = Date.now();
    let selectedProvider: "claude" | "codex" | undefined = args.defaultProvider;
    let selectedModel: string | null = defaultModel;
    let timeoutMs: number | null = defaultTimeoutMs;

    try {
      const resolvedModel = args.resolveModel?.({
        missionId: context.missionId,
        decisionName: runArgs.decisionName
      }) ?? null;
      const resolvedModelName = resolvedModel ? asString(resolvedModel.model) : null;
      if (resolvedModel && !resolvedModelName) {
        throw new Error(
          `resolveModel returned an invalid model for '${runArgs.decisionName}' (missionId=${context.missionId})`
        );
      }
      selectedProvider = resolvedModel?.provider ?? args.defaultProvider;
      selectedModel = resolvedModelName ?? defaultModel;
      const requestedTimeoutMs = Number(runArgs.timeoutMs);
      timeoutMs =
        Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
          ? Math.max(1_000, Math.floor(requestedTimeoutMs))
          : defaultTimeoutMs;

      const executeTaskArgs: AiDecisionExecuteTaskArgs = {
        feature: "orchestrator",
        taskType: runArgs.taskType,
        cwd: args.projectRoot,
        prompt: runArgs.prompt,
        jsonSchema: runArgs.schema,
        oneShot: true,
        provider: selectedProvider,
        model: selectedModel ?? undefined,
        reasoningEffort: asString(resolvedModel?.reasoningEffort) ?? defaultReasoningEffort ?? undefined,
        ...(runArgs.tools ? { tools: runArgs.tools } : {}),
        ...(timeoutMs != null ? { timeoutMs } : {})
      };

      const result = runArgs.tools && typeof args.aiIntegrationService.executeTaskWithTools === "function"
        ? await args.aiIntegrationService.executeTaskWithTools({
            ...executeTaskArgs,
            tools: runArgs.tools
          })
        : await args.aiIntegrationService.executeTask(executeTaskArgs);

      const parsed = runArgs.parse(result.structuredOutput);

      writeDecisionLog({
        decisionName: runArgs.decisionName,
        context,
        request: runArgs.input,
        response: parsed,
        validation: extractDecisionValidation(parsed),
        rationale: extractDecisionRationale(parsed),
        errorMessage: null,
        provider: result.provider,
        model: result.model,
        timeoutCapMs: timeoutMs,
        promptTokens: result.inputTokens,
        completionTokens: result.outputTokens,
        latencyMs: Date.now() - startedAt,
        createdAt: toIso(now)
      });

      args.logger?.debug?.("ai_decision.success", {
        decisionName: runArgs.decisionName,
        missionId: context.missionId,
        runId: context.runId,
        stepId: context.stepId,
        latencyMs: Date.now() - startedAt,
        provider: result.provider,
        model: result.model
      });

      return parsed;
    } catch (error) {
      const failure = error instanceof DecisionFailure
        ? error
        : new DecisionFailure({
            decisionName: runArgs.decisionName,
            context,
            message: `Decision '${runArgs.decisionName}' failed: ${toErrorMessage(error)}`,
            input: runArgs.input,
            cause: error
          });

      writeDecisionLog({
        decisionName: runArgs.decisionName,
        context,
        request: runArgs.input,
        response: null,
        validation: null,
        rationale: null,
        errorMessage: failure.message,
        provider: selectedProvider ?? null,
        model: selectedModel,
        timeoutCapMs: timeoutMs,
        promptTokens: null,
        completionTokens: null,
        latencyMs: Date.now() - startedAt,
        createdAt: toIso(now)
      });

      args.logger?.warn?.("ai_decision.failed", {
        decisionName: runArgs.decisionName,
        missionId: context.missionId,
        runId: context.runId,
        stepId: context.stepId,
        message: failure.message
      });

      throw failure;
    }
  };

  const decideLaneStrategy = async (laneArgs: DecideLaneStrategyArgs): Promise<LaneStrategyDecision> => {
    const hardMax = clampNumber(Math.floor(laneArgs.constraints?.maxParallelLanes ?? 8), 1, 16);

    const raw = await runStructuredDecision({
      decisionName: "decideLaneStrategy",
      taskType: "planning",
      context: laneArgs.context,
      input: laneArgs,
      schema: LANE_STRATEGY_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: lane strategy",
        guidance: `Choose a lane strategy and max parallel lanes (must be <= ${hardMax}). You must also assign every stepKey to a laneLabel (use "base" for the base mission lane).`,
        input: laneArgs
      }),
      parse: parseLaneStrategyDecision,
      tools: createLaneStrategyToolsPayload(laneArgs)
    });

    return {
      ...raw,
      maxParallelLanes: Math.floor(clampNumber(raw.maxParallelLanes, 1, hardMax))
    };
  };

  const decideParallelism = async (parallelismArgs: DecideParallelismArgs): Promise<ParallelismDecision> => {
    const raw = await runStructuredDecision({
      decisionName: "decideParallelism",
      taskType: "planning",
      context: parallelismArgs.context,
      input: parallelismArgs,
      schema: PARALLELISM_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: parallelism cap",
        guidance: "Select the safest mission-wide parallelism cap for execution. Must be between 1 and 32.",
        input: parallelismArgs
      }),
      parse: parseParallelismDecision
    });

    return {
      parallelismCap: Math.floor(clampNumber(raw.parallelismCap, 1, 32)),
      rationale: raw.rationale,
      confidence: raw.confidence
    };
  };

  const decideTransition = async (transitionArgs: DecideTransitionArgs): Promise<TransitionDecision> => {
    const timeoutCapMs = resolveTimeoutCapMs(transitionArgs.missionModelConfig);

    const raw = await runStructuredDecision({
      decisionName: "decideTransition",
      taskType: "review",
      context: transitionArgs.context,
      input: {
        ...transitionArgs,
        timeoutCapMs
      },
      schema: TRANSITION_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: state transition",
        guidance: `Pick the safest transition action. Respect timeout cap (${timeoutCapMs} ms).`,
        input: transitionArgs
      }),
      parse: parseTransitionDecision,
      tools: createTransitionToolsPayload(transitionArgs)
    });

    return validateTransitionAction({
      decision: raw,
      unresolvedDependencies: transitionArgs.unresolvedDependencies ?? [],
      retryCount: transitionArgs.retryCount,
      retryLimit: transitionArgs.retryLimit,
      timeoutCapMs
    });
  };

  const decideRetry = async (retryArgs: DecideRetryArgs): Promise<RetryDecision> => {
    return runStructuredDecision({
      decisionName: "decideRetry",
      taskType: "review",
      context: retryArgs.context,
      input: retryArgs,
      schema: RETRY_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: retry policy",
        guidance: "Decide whether to retry now. Keep delayMs conservative and explicit.",
        input: retryArgs
      }),
      parse: parseRetryDecision
    });
  };

  const decideTimeoutBudget = async (timeoutArgs: DecideTimeoutBudgetArgs): Promise<TimeoutBudgetDecision> => {
    const capMs = resolveTimeoutCapMs(timeoutArgs.missionModelConfig);

    const raw = await runStructuredDecision({
      decisionName: "decideTimeoutBudget",
      taskType: "planning",
      context: timeoutArgs.context,
      input: {
        ...timeoutArgs,
        timeoutCapMs: capMs
      },
      schema: TIMEOUT_BUDGET_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: timeout budget",
        guidance: `Choose a timeout budget in milliseconds. Must not exceed ${capMs}.`,
        input: timeoutArgs
      }),
      parse: parseTimeoutBudgetDecision
    });

    const boundedTimeout = Math.floor(clampNumber(raw.timeoutMs, 1_000, capMs));

    return {
      timeoutMs: boundedTimeout,
      capMs,
      capped: boundedTimeout !== raw.timeoutMs,
      rationale: raw.rationale,
      confidence: raw.confidence
    };
  };

  const decideStepPriority = async (priorityArgs: DecideStepPriorityArgs): Promise<StepPriorityDecision> => {
    return runStructuredDecision({
      decisionName: "decideStepPriority",
      taskType: "planning",
      context: priorityArgs.context,
      input: priorityArgs,
      schema: STEP_PRIORITY_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: step priority",
        guidance: "Score priority from 0-100 and include rationale.",
        input: priorityArgs
      }),
      parse: parseStepPriorityDecision
    });
  };

  const evaluateStagnation = async (stagnationArgs: EvaluateStagnationArgs): Promise<StagnationEvaluation> => {
    return runStructuredDecision({
      decisionName: "evaluateStagnation",
      taskType: "review",
      context: stagnationArgs.context,
      input: {
        ...stagnationArgs,
        runtimeDigest: truncate(stagnationArgs.runtimeDigest, 6_000)
      },
      schema: STAGNATION_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: stagnation evaluation",
        guidance: "Assess if progress has stalled and recommend the next action.",
        input: {
          ...stagnationArgs,
          runtimeDigest: truncate(stagnationArgs.runtimeDigest, 6_000)
        }
      }),
      parse: parseStagnationEvaluation
    });
  };

  const evaluateQualityGate = async (qualityArgs: EvaluateQualityGateArgs): Promise<QualityGateEvaluation> => {
    return runStructuredDecision({
      decisionName: "evaluateQualityGate",
      taskType: "review",
      context: qualityArgs.context,
      input: {
        ...qualityArgs,
        stepOutput: truncate(qualityArgs.stepOutput, 10_000)
      },
      schema: QUALITY_GATE_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: quality gate",
        guidance: "Evaluate whether output is acceptable for downstream execution.",
        input: {
          ...qualityArgs,
          stepOutput: truncate(qualityArgs.stepOutput, 10_000)
        }
      }),
      parse: parseQualityGateEvaluation
    });
  };

  const decideRecovery = async (recoveryArgs: DecideRecoveryArgs): Promise<RecoveryDecision> => {
    return runStructuredDecision({
      decisionName: "decideRecovery",
      taskType: "review",
      context: recoveryArgs.context,
      input: recoveryArgs,
      schema: RECOVERY_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: recovery action",
        guidance: "Pick the safest recovery action for the current failure.",
        input: recoveryArgs
      }),
      parse: parseRecoveryDecision,
      tools: createRecoveryToolsPayload(recoveryArgs)
    });
  };

  const replanMission = async (replanArgs: ReplanMissionArgs): Promise<MissionReplanDecision> => {
    return runStructuredDecision({
      decisionName: "replanMission",
      taskType: "planning",
      context: replanArgs.context,
      input: replanArgs,
      schema: REPLAN_SCHEMA,
      prompt: buildPrompt({
        title: "Decision: mission replan",
        guidance: "Decide whether mission replanning is required and provide concise plan deltas.",
        input: replanArgs
      }),
      parse: parseMissionReplanDecision,
      tools: createReplanToolsPayload(replanArgs)
    });
  };

  const pauseForDecisionFailure = (pauseArgs: PauseForDecisionFailureArgs): DecisionFailurePause => {
    const reasonPrefix = asString(pauseArgs.reasonPrefix) ?? "AI decision engine failed";
    const pause: DecisionFailurePause = {
      shouldPause: true,
      code: "decision_failure",
      reason: `${reasonPrefix}: ${pauseArgs.failure.message}`,
      metadata: {
        decisionName: pauseArgs.failure.decisionName,
        missionId: pauseArgs.failure.context.missionId,
        runId: pauseArgs.failure.context.runId ?? null,
        stepId: pauseArgs.failure.context.stepId ?? null,
        message: pauseArgs.failure.message
      }
    };

    writeDecisionLog({
      decisionName: pauseArgs.failure.decisionName,
      context: sanitizeContext(pauseArgs.failure.context),
      request: pauseArgs.failure.input,
      response: pause,
      validation: null,
      rationale: extractDecisionRationale(pause),
      errorMessage: pauseArgs.failure.message,
      provider: null,
      model: null,
      timeoutCapMs: null,
      promptTokens: null,
      completionTokens: null,
      latencyMs: 0,
      createdAt: toIso(now)
    });

    return pause;
  };

  return {
    decideLaneStrategy,
    decideParallelism,
    decideTransition,
    decideRetry,
    decideTimeoutBudget,
    decideStepPriority,
    evaluateStagnation,
    evaluateQualityGate,
    decideRecovery,
    replanMission,
    pauseForDecisionFailure
  };
}
