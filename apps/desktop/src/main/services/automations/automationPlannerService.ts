import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import {
  AUTOMATION_TRIGGER_TYPES,
  type AutomationAction,
  type AutomationActionType,
  type AutomationDraftAmbiguity,
  type AutomationDraftConfirmationRequirement,
  type AutomationDraftIssue,
  type AutomationDraftResolution,
  type AutomationDraftResolutionCandidate,
  type AutomationParseNaturalLanguageRequest,
  type AutomationParseNaturalLanguageResult,
  type AutomationRule,
  type AutomationRuleDraft,
  type AutomationRuleDraftNormalized,
  type AutomationSaveDraftRequest,
  type AutomationSaveDraftResult,
  type AutomationSimulateRequest,
  type AutomationSimulateResult,
  type AutomationSimulationAction,
  type AutomationValidateDraftRequest,
  type AutomationValidateDraftResult,
  type TestSuiteDefinition
} from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { Logger } from "../logging/logger";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createLaneService } from "../lanes/laneService";
import { getErrorMessage, quoteIfNeeded, resolvePathWithinRoot } from "../shared/utils";

function resolveAutomationCwdBase(
  projectRoot: string,
  laneService: ReturnType<typeof createLaneService>,
  laneId: string | null | undefined,
): string {
  return laneId ? laneService.getLaneWorktreePath(laneId) : projectRoot;
}

function validateAutomationCwd(baseCwd: string, cwdRaw: string): string | null {
  const candidate = path.isAbsolute(cwdRaw) ? cwdRaw : path.resolve(baseCwd, cwdRaw);
  let resolved: string;
  try {
    resolved = resolvePathWithinRoot(baseCwd, candidate, { allowMissing: true });
  } catch {
    return "cwd must stay within the target lane worktree or project root.";
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      return "cwd must point to an existing directory within the target lane worktree or project root.";
    }
  } catch {
    return "cwd must point to an existing directory within the target lane worktree or project root.";
  }
  return null;
}

function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length ? s : "automation";
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function safeTrim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractFirstJsonObject(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;

  // Strip fenced code blocks if present.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }

  // Best-effort: locate first {...} span.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1).trim();
    if (slice.startsWith("{") && slice.endsWith("}")) return slice;
  }
  return null;
}

function toResolutionCandidate(value: string, score: number, label?: string): AutomationDraftResolutionCandidate {
  return { value, score, ...(label ? { label } : {}) };
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function simpleFuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(q) || q.startsWith(c)) return 0.92;
  if (c.includes(q) || q.includes(c)) return 0.86;

  const qTok = new Set(tokenize(q));
  const cTok = new Set(tokenize(c));
  if (qTok.size === 0 || cTok.size === 0) return 0;
  let inter = 0;
  for (const t of qTok) {
    if (cTok.has(t)) inter += 1;
  }
  const union = qTok.size + cTok.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  return clampNumber(jaccard * 0.75, 0, 0.75);
}

function resolveTestSuite(query: string, suites: TestSuiteDefinition[]): {
  resolvedSuiteId: string | null;
  resolution: AutomationDraftResolution | null;
  ambiguity: AutomationDraftAmbiguity | null;
} {
  const input = query.trim();
  if (!input) {
    return {
      resolvedSuiteId: null,
      resolution: null,
      ambiguity: {
        path: "actions[].suite",
        kind: "test-suite",
        message: "Test suite is required for run-tests.",
        candidates: suites.slice(0, 12).map((s) => toResolutionCandidate(s.id, 0.5, s.name || s.id))
      }
    };
  }

  const candidates = suites
    .map((suite) => {
      const scoreById = simpleFuzzyScore(input, suite.id);
      const scoreByName = suite.name ? simpleFuzzyScore(input, suite.name) : 0;
      const score = Math.max(scoreById, scoreByName);
      return { suite, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = candidates[0];
  if (!top) {
    return {
      resolvedSuiteId: null,
      resolution: null,
      ambiguity: {
        path: "actions[].suite",
        kind: "test-suite",
        message: `No test suite matched '${input}'.`,
        candidates: suites.slice(0, 12).map((s) => toResolutionCandidate(s.id, 0.25, s.name || s.id))
      }
    };
  }

  const second = candidates[1];
  const topScore = top.score;
  const secondScore = second?.score ?? 0;
  const close = second && topScore - secondScore < 0.08;
  const low = topScore < 0.65;
  const candList: AutomationDraftResolutionCandidate[] = candidates
    .slice(0, 8)
    .map((c) => toResolutionCandidate(c.suite.id, c.score, c.suite.name || c.suite.id));

  const resolution: AutomationDraftResolution = {
    path: "actions[].suite",
    input,
    resolved: top.suite.id,
    confidence: clampNumber(topScore, 0, 1),
    reason: top.suite.name ? `Matched by suite name '${top.suite.name}'.` : "Matched by suite id.",
    candidates: candList
  };

  if (close || low) {
    return {
      resolvedSuiteId: top.suite.id,
      resolution,
      ambiguity: {
        path: "actions[].suite",
        kind: "test-suite",
        message: close
          ? `Multiple suites match '${input}'. Confirm the intended suite.`
          : `Low-confidence match for suite '${input}'. Confirm the intended suite.`,
        candidates: candList
      }
    };
  }

  return { resolvedSuiteId: top.suite.id, resolution, ambiguity: null };
}

function buildPlannerSchema(): Record<string, unknown> {
  // JSON Schema for strict, machine-readable draft output.
  const triggerTypes = [...AUTOMATION_TRIGGER_TYPES];
  const baseActionProps = {
    condition: { type: "string" },
    continueOnFailure: { type: "boolean" },
    timeoutMs: { type: "number" },
    retry: { type: "number" }
  };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      enabled: { type: "boolean" },
      trigger: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: triggerTypes },
          cron: { type: "string" },
          branch: { type: "string" },
          targetBranch: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          namePattern: { type: "string" },
          project: { type: "string" },
          team: { type: "string" },
          assignee: { type: "string" },
          stateTransition: { type: "string" },
          changedFields: { type: "array", items: { type: "string" } }
        },
        required: ["type"]
      },
      actions: {
        type: "array",
        minItems: 1,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: { type: { const: "predict-conflicts" }, ...baseActionProps },
              required: ["type"]
            },
            {
              type: "object",
              additionalProperties: false,
              properties: { type: { const: "run-tests" }, suite: { type: "string" }, ...baseActionProps },
              required: ["type", "suite"]
            },
            {
              type: "object",
              additionalProperties: false,
              properties: { type: { const: "run-command" }, command: { type: "string" }, cwd: { type: "string" }, ...baseActionProps },
              required: ["type", "command"]
            }
          ]
        }
      }
    },
    required: ["name", "trigger", "actions"]
  };
}

function buildPlannerPrompt(args: {
  intent: string;
  suites: TestSuiteDefinition[];
  laneBranches: string[];
}): string {
  const suiteList = args.suites.slice(0, 80).map((s) => `- ${s.id}${s.name ? `: ${s.name}` : ""}`).join("\n");
  const branchList = args.laneBranches.slice(0, 40).map((b) => `- ${b}`).join("\n");

  return [
    "You are generating an automation rule draft for ADE Desktop.",
    "Return ONLY a JSON object that conforms to the provided JSON Schema.",
    "",
    "Policy:",
    "- If user intent implies running commands, prefer built-in actions when possible.",
    "- For schedules, output a 5-field cron expression (minute hour day-of-month month day-of-week).",
    "- Prefer the docs-style trigger names for git, file, lane, and Linear events.",
    "",
    "Available triggers:",
    "- session-end",
    "- commit",
    "- git.commit",
    "- git.push",
    "- git.pr_opened",
    "- git.pr_updated",
    "- git.pr_merged",
    "- git.pr_closed",
    "- file.change",
    "- lane.created",
    "- lane.archived",
    "- schedule (requires cron)",
    "- manual",
    "- linear.issue_created",
    "- linear.issue_updated",
    "- linear.issue_assigned",
    "- linear.issue_status_changed",
    "",
    "Available actions:",
    "- predict-conflicts",
    "- run-tests (requires suite string; use a suite id or name below)",
    "- run-command (requires command string; keep it a single shell command)",
    "",
    "Known test suites:",
    suiteList || "(none)",
    "",
    "Known lane branches:",
    branchList || "(none)",
    "",
    "User intent:",
    args.intent.trim()
  ].join("\n");
}

async function runCodexExec(args: {
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  logger: Logger;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  askForApproval: "untrusted" | "on-failure" | "on-request" | "never";
  webSearch: boolean;
  additionalWritableDirs: string[];
}): Promise<{ jsonText: string; commandPreview: string }> {
  const tmpRoot = resolveAdeLayout(path.resolve(args.cwd)).tmpDir;
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, "automation-planner-codex-"));
  const schemaPath = path.join(tmpDir, "schema.json");
  const outPath = path.join(tmpDir, "out.txt");
  fs.writeFileSync(schemaPath, JSON.stringify(args.schema, null, 2), "utf8");

  const cliArgs: string[] = [
    "exec",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outPath,
    "--sandbox",
    args.sandbox,
    "--ask-for-approval",
    args.askForApproval,
    "--cd",
    args.cwd,
    "--skip-git-repo-check"
  ];

  if (args.webSearch) cliArgs.push("--search");
  for (const dir of args.additionalWritableDirs) {
    const trimmed = dir.trim();
    if (trimmed) {
      cliArgs.push("--add-dir", trimmed);
    }
  }

  cliArgs.push(args.prompt);

  let codexExecutable: string;
  try {
    const resolvedCodexExecutable = resolveCodexExecutable();
    if (!resolvedCodexExecutable) {
      throw new Error("Codex executable could not be resolved.");
    }
    codexExecutable = resolvedCodexExecutable.path;
  } catch (error) {
    args.logger.error("automations.planner.codex_executable_resolution_failed", {
      cwd: args.cwd,
      error: getErrorMessage(error),
    });
    throw error;
  }
  const commandPreview = [quoteIfNeeded(codexExecutable), ...cliArgs.map(quoteIfNeeded)].join(" ");

  const child = spawn(codexExecutable, cliArgs, {
    cwd: args.cwd,
    env: {
      ...process.env,
      // Keep output parseable.
      NO_COLOR: "1",
      TERM: "dumb"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr?.on("data", (c) => {
    const text = Buffer.isBuffer(c) ? c.toString("utf8") : String(c);
    stderr = (stderr + text).slice(-120_000);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  try {
    const out = fs.readFileSync(outPath, "utf8");
    const jsonText = extractFirstJsonObject(out) ?? out.trim();
    if (!jsonText) throw new Error("Codex produced empty output");
    if (exitCode !== 0) {
      throw new Error(`Codex exited with code ${exitCode}${stderr ? `\n\n${stderr}` : ""}`);
    }
    return { jsonText, commandPreview };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function runClaudeHeadless(args: {
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  permissionMode: "default" | "plan" | "acceptEdits" | "dontAsk" | "delegate" | "bypassPermissions";
  dangerouslySkipPermissions: boolean;
  allowedTools: string[];
  additionalAllowedDirs: string[];
}): Promise<{ jsonText: string; commandPreview: string }> {
  const schemaJson = JSON.stringify(args.schema);
  const cliArgs: string[] = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    schemaJson,
    "--permission-mode",
    args.permissionMode,
    "--no-session-persistence"
  ];

  if (args.dangerouslySkipPermissions) {
    cliArgs.push("--dangerously-skip-permissions");
  }

  if (args.allowedTools.length > 0) {
    // Claude expects a comma/space-separated list; we join with commas for predictability.
    cliArgs.push("--allowedTools", args.allowedTools.join(","));
  }

  for (const dir of args.additionalAllowedDirs) {
    const trimmed = dir.trim();
    if (trimmed) {
      cliArgs.push("--add-dir", trimmed);
    }
  }

  cliArgs.push(args.prompt);

  const claudeExecutable = resolveClaudeCodeExecutable().path;
  const commandPreview = [quoteIfNeeded(claudeExecutable), ...cliArgs.map(quoteIfNeeded)].join(" ");

  const child = spawn(claudeExecutable, cliArgs, {
    cwd: args.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      TERM: "dumb"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (c) => {
    const text = Buffer.isBuffer(c) ? c.toString("utf8") : String(c);
    stdout = (stdout + text).slice(-240_000);
  });
  child.stderr?.on("data", (c) => {
    const text = Buffer.isBuffer(c) ? c.toString("utf8") : String(c);
    stderr = (stderr + text).slice(-120_000);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    throw new Error(`Claude exited with code ${exitCode}${stderr ? `\n\n${stderr}` : ""}`);
  }

  // Claude --output-format json returns a wrapper object; we want the raw JSON payload.
  // When --json-schema is provided, Claude's "result" field should conform to schema, but
  // some versions may emit schema output directly. We support both.
  const trimmed = stdout.trim();
  const direct = extractFirstJsonObject(trimmed);
  if (!direct) {
    throw new Error("Claude produced no JSON output");
  }

  try {
    const parsed = JSON.parse(direct) as any;
    if (parsed && typeof parsed === "object" && parsed.type === "result" && parsed.result != null) {
      const inner = parsed.result;
      if (typeof inner === "string") {
        const innerJson = extractFirstJsonObject(inner) ?? inner.trim();
        if (!innerJson) throw new Error("Claude result was empty");
        return { jsonText: innerJson, commandPreview };
      }
      return { jsonText: JSON.stringify(inner), commandPreview };
    }
  } catch {
    // fall through
  }

  return { jsonText: direct, commandPreview };
}

function normalizeDraft(args: {
  draft: AutomationRuleDraft;
  suites: TestSuiteDefinition[];
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
}): {
  normalized: AutomationRuleDraftNormalized | null;
  issues: AutomationDraftIssue[];
  ambiguities: AutomationDraftAmbiguity[];
  resolutions: AutomationDraftResolution[];
} {
  const issues: AutomationDraftIssue[] = [];
  const ambiguities: AutomationDraftAmbiguity[] = [];
  const resolutions: AutomationDraftResolution[] = [];

  const name = safeTrim(args.draft.name) || "New automation";
  const enabled = Boolean(args.draft.enabled);
  const inputTriggers = Array.isArray(args.draft.triggers) && args.draft.triggers.length > 0
    ? args.draft.triggers
    : ((args.draft as any).trigger ? [(args.draft as any).trigger] : [{ type: "manual" }]);
  if (inputTriggers.length > 1) {
    issues.push({
      level: "warning",
      path: "triggers",
      message: "Automations now support a single trigger. Only the first trigger will be saved."
    });
  }
  const triggers = inputTriggers.slice(0, 1).map((raw, index) => {
    const triggerType = safeTrim(raw?.type) as any;
    const trigger: Record<string, unknown> = { type: triggerType };
    if (!AUTOMATION_TRIGGER_TYPES.includes(triggerType)) {
      issues.push({ level: "error", path: `triggers[${index}].type`, message: "Invalid trigger type." });
    }
    const cronExpr = safeTrim(raw?.cron);
    if (triggerType === "schedule") {
      if (!cronExpr) {
        issues.push({ level: "error", path: `triggers[${index}].cron`, message: "Schedule trigger requires cron." });
      } else if (!cron.validate(cronExpr)) {
        issues.push({ level: "error", path: `triggers[${index}].cron`, message: `Invalid cron expression '${cronExpr}'.` });
      } else {
        trigger.cron = cronExpr;
      }
    }
    const branch = safeTrim(raw?.branch);
    if (branch) trigger.branch = branch;
    const targetBranch = safeTrim(raw?.targetBranch);
    if (targetBranch) trigger.targetBranch = targetBranch;
    const event = safeTrim(raw?.event);
    if (event) trigger.event = event;
    const author = safeTrim(raw?.author);
    if (author) trigger.author = author;
    const labels = Array.isArray(raw?.labels) ? raw.labels.map((value: unknown) => safeTrim(value)).filter(Boolean) : [];
    if (labels.length) trigger.labels = labels;
    const paths = Array.isArray(raw?.paths) ? raw.paths.map((value: unknown) => safeTrim(value)).filter(Boolean) : [];
    if (paths.length) trigger.paths = paths;
    const keywords = Array.isArray(raw?.keywords) ? raw.keywords.map((value: unknown) => safeTrim(value)).filter(Boolean) : [];
    if (keywords.length) trigger.keywords = keywords;
    const authors = Array.isArray(raw?.authors) ? raw.authors.map((value: unknown) => safeTrim(value)).filter(Boolean) : [];
    if (authors.length) trigger.authors = authors;
    const titleRegex = safeTrim(raw?.titleRegex);
    if (titleRegex) trigger.titleRegex = titleRegex;
    const bodyRegex = safeTrim(raw?.bodyRegex);
    if (bodyRegex) trigger.bodyRegex = bodyRegex;
    const repo = safeTrim(raw?.repo);
    if (repo) trigger.repo = repo;
    const namePattern = safeTrim(raw?.namePattern);
    if (namePattern) trigger.namePattern = namePattern;
    const project = safeTrim(raw?.project);
    if (project) trigger.project = project;
    const team = safeTrim(raw?.team);
    if (team) trigger.team = team;
    const assignee = safeTrim(raw?.assignee);
    if (assignee) trigger.assignee = assignee;
    const stateTransition = safeTrim(raw?.stateTransition);
    if (stateTransition) trigger.stateTransition = stateTransition;
    const changedFields = Array.isArray(raw?.changedFields) ? raw.changedFields.map((value: unknown) => safeTrim(value)).filter(Boolean) : [];
    if (changedFields.length) trigger.changedFields = changedFields;
    const secretRef = safeTrim(raw?.secretRef);
    if ((triggerType === "webhook" || triggerType === "github-webhook") && !secretRef) {
      issues.push({ level: "error", path: `triggers[${index}].secretRef`, message: "Webhook triggers require secretRef." });
    } else if (secretRef) {
      trigger.secretRef = secretRef;
    }
    return trigger as AutomationRuleDraftNormalized["triggers"][number];
  });

  const normalizedActions: AutomationAction[] = [];
  const MAX_TIMEOUT_MS = 30 * 60_000;
  const DEFAULT_TIMEOUT_MS = 5 * 60_000;
  const draftActions = Array.isArray(args.draft.legacyActions)
    ? args.draft.legacyActions
    : Array.isArray((args.draft as any).actions)
      ? (args.draft as any).actions
      : [];

  for (let idx = 0; idx < draftActions.length; idx += 1) {
    const action = draftActions[idx] as any;
    const type = safeTrim(action?.type) as AutomationActionType;
    const condition = safeTrim(action?.condition);
    const base = {
      type,
      ...(condition ? { condition } : {}),
      ...(typeof action?.continueOnFailure === "boolean" ? { continueOnFailure: action.continueOnFailure } : {}),
      ...(action?.timeoutMs != null ? { timeoutMs: clampNumber(Number(action.timeoutMs), 1000, MAX_TIMEOUT_MS) } : {}),
      ...(action?.retry != null ? { retry: clampNumber(Number(action.retry), 0, 5) } : {})
    } satisfies Partial<AutomationAction>;

    if (
      type !== "predict-conflicts" &&
      type !== "run-tests" &&
      type !== "run-command" &&
      type !== "ade-action" &&
      type !== "agent-session" &&
      type !== "launch-mission"
    ) {
      issues.push({ level: "error", path: `actions[${idx}].type`, message: `Unknown action type '${safeTrim(action?.type)}'.` });
      continue;
    }

    if (type === "ade-action") {
      const adeAction = action?.adeAction;
      const domain = safeTrim(adeAction?.domain);
      const actionName = safeTrim(adeAction?.action);
      if (!domain || !actionName) {
        issues.push({ level: "error", path: `actions[${idx}].adeAction`, message: "ade-action requires domain and action." });
        continue;
      }
      normalizedActions.push({
        ...(base as AutomationAction),
        adeAction: {
          domain,
          action: actionName,
          ...(adeAction?.args !== undefined ? { args: adeAction.args } : {}),
          ...(adeAction?.resolvers && typeof adeAction.resolvers === "object" ? { resolvers: adeAction.resolvers } : {}),
        },
      });
      continue;
    }

    if (type === "agent-session") {
      const prompt = safeTrim(action?.prompt);
      normalizedActions.push({
        ...(base as AutomationAction),
        ...(prompt ? { prompt } : {}),
        ...(safeTrim(action?.sessionTitle) ? { sessionTitle: safeTrim(action?.sessionTitle) } : {}),
      });
      continue;
    }

    if (type === "launch-mission") {
      normalizedActions.push({
        ...(base as AutomationAction),
        ...(safeTrim(action?.sessionTitle) ? { sessionTitle: safeTrim(action?.sessionTitle) } : {}),
      });
      continue;
    }

    if (type === "run-tests") {
      const suiteQuery = safeTrim(action?.suite);
      if (!suiteQuery) {
        issues.push({ level: "error", path: `actions[${idx}].suite`, message: "run-tests requires a suite." });
        continue;
      }
      const { resolvedSuiteId, resolution, ambiguity } = resolveTestSuite(suiteQuery, args.suites);
      if (resolution) {
        resolutions.push({ ...resolution, path: `actions[${idx}].suite` });
      }
      if (ambiguity) {
        ambiguities.push({ ...ambiguity, path: `actions[${idx}].suite` });
      }
      if (!resolvedSuiteId) {
        issues.push({ level: "error", path: `actions[${idx}].suite`, message: `No matching test suite for '${suiteQuery}'.` });
        continue;
      }
      normalizedActions.push({ ...(base as AutomationAction), suiteId: resolvedSuiteId });
      continue;
    }

    if (type === "run-command") {
      const command = safeTrim(action?.command);
      if (!command) {
        issues.push({ level: "error", path: `actions[${idx}].command`, message: "run-command requires command." });
        continue;
      }

      const timeoutMs = base.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const next: AutomationAction = { ...(base as AutomationAction), command, timeoutMs };

      const cwdRaw = safeTrim(action?.cwd);
      if (cwdRaw) {
        const executionLaneId = safeTrim(args.draft.execution?.targetLaneId) || null;
        const baseCwd = resolveAutomationCwdBase(args.projectRoot, args.laneService, executionLaneId);
        const cwdIssue = validateAutomationCwd(baseCwd, cwdRaw);
        if (cwdIssue) {
          issues.push({
            level: "error",
            path: `actions[${idx}].cwd`,
            message: cwdIssue
          });
        } else {
          next.cwd = cwdRaw;
        }
      }

      normalizedActions.push(next);
      continue;
    }

    normalizedActions.push(base as AutomationAction);
  }

  if (issues.some((i) => i.level === "error")) {
    return { normalized: null, issues, ambiguities, resolutions };
  }

  const requestedExecution = args.draft.execution;
  const execution =
    requestedExecution?.kind === "agent-session" || requestedExecution?.kind === "mission" || requestedExecution?.kind === "built-in"
      ? {
          kind: requestedExecution.kind,
          ...(safeTrim(requestedExecution.targetLaneId) ? { targetLaneId: safeTrim(requestedExecution.targetLaneId) } : {}),
          ...(requestedExecution.kind === "agent-session"
            ? {
                session: {
                  ...(safeTrim(requestedExecution.session?.title) ? { title: safeTrim(requestedExecution.session?.title) } : {}),
                  ...(safeTrim(requestedExecution.session?.reasoningEffort)
                    ? { reasoningEffort: safeTrim(requestedExecution.session?.reasoningEffort) }
                    : {}),
                },
              }
            : {}),
          ...(requestedExecution.kind === "mission"
            ? {
                mission: {
                  ...(safeTrim(requestedExecution.mission?.title) ? { title: safeTrim(requestedExecution.mission?.title) } : {}),
                },
              }
            : {}),
          ...(requestedExecution.kind === "built-in" ? { builtIn: { actions: normalizedActions } } : {}),
        }
      : normalizedActions.length > 0
        ? { kind: "built-in" as const, builtIn: { actions: normalizedActions } }
        : { kind: "agent-session" as const, session: {} };

  if (execution.kind === "built-in" && normalizedActions.length === 0) {
    issues.push({
      level: "error",
      path: "execution.builtIn.actions",
      message: "Built-in automations require at least one task.",
    });
  }

  if (execution.kind !== "built-in" && !safeTrim(args.draft.prompt)) {
    issues.push({
      level: "error",
      path: "prompt",
      message: `${execution.kind} automations require a prompt.`,
    });
  }

  if (issues.some((i) => i.level === "error")) {
    return { normalized: null, issues, ambiguities, resolutions };
  }

  const includeProjectContext = typeof args.draft.includeProjectContext === "boolean"
    ? args.draft.includeProjectContext
    : Boolean(args.draft.memory?.mode && args.draft.memory.mode !== "none")
      || Boolean(args.draft.contextSources?.length);

  const normalized: AutomationRuleDraftNormalized = {
    ...(args.draft.id ? { id: safeTrim(args.draft.id) } : {}),
    name,
    description: safeTrim(args.draft.description),
    enabled,
    mode: args.draft.mode === "fix" || args.draft.mode === "monitor" ? args.draft.mode : "review",
    triggers,
    trigger: triggers[0],
    execution,
    executor: { mode: "automation-bot" },
    ...(args.draft.modelConfig ? { modelConfig: args.draft.modelConfig } : {}),
    ...(args.draft.permissionConfig ? { permissionConfig: args.draft.permissionConfig } : {}),
    ...(safeTrim(args.draft.templateId) ? { templateId: safeTrim(args.draft.templateId) } : {}),
    ...(safeTrim(args.draft.prompt) ? { prompt: safeTrim(args.draft.prompt) } : {}),
    reviewProfile:
      args.draft.reviewProfile === "incremental" ||
      args.draft.reviewProfile === "full" ||
      args.draft.reviewProfile === "security" ||
      args.draft.reviewProfile === "release-risk" ||
      args.draft.reviewProfile === "cross-repo-contract"
        ? args.draft.reviewProfile
        : "quick",
    toolPalette: Array.isArray(args.draft.toolPalette) && args.draft.toolPalette.length
      ? [...new Set(args.draft.toolPalette)]
      : ["repo", "memory", "mission"],
    contextSources: includeProjectContext && Array.isArray(args.draft.contextSources) && args.draft.contextSources.length
      ? args.draft.contextSources.map((source) => ({
          type: source.type,
          ...(safeTrim(source.path) ? { path: safeTrim(source.path) } : {}),
          ...(safeTrim(source.repoId) ? { repoId: safeTrim(source.repoId) } : {}),
          ...(safeTrim(source.label) ? { label: safeTrim(source.label) } : {}),
          ...(typeof source.required === "boolean" ? { required: source.required } : {}),
        }))
      : includeProjectContext
        ? [{ type: "project-memory" }, { type: "procedures" }]
        : [],
    memory: includeProjectContext && args.draft.memory?.mode
      ? {
          mode: args.draft.memory.mode,
          ...(safeTrim(args.draft.memory.ruleScopeKey) ? { ruleScopeKey: safeTrim(args.draft.memory.ruleScopeKey) } : {}),
        }
      : includeProjectContext
        ? { mode: "automation-plus-project", ruleScopeKey: safeTrim(args.draft.id) || slugify(name) }
        : { mode: "none" },
    guardrails: {
      ...(typeof args.draft.guardrails?.budgetUsd === "number" ? { budgetUsd: args.draft.guardrails.budgetUsd } : {}),
      ...(typeof args.draft.guardrails?.maxDurationMin === "number" ? { maxDurationMin: args.draft.guardrails.maxDurationMin } : {}),
      ...(typeof args.draft.guardrails?.confidenceThreshold === "number" ? { confidenceThreshold: args.draft.guardrails.confidenceThreshold } : {}),
      ...(typeof args.draft.guardrails?.maxFindings === "number" ? { maxFindings: Math.floor(args.draft.guardrails.maxFindings) } : {}),
      ...(typeof args.draft.guardrails?.reserveBudget === "boolean" ? { reserveBudget: args.draft.guardrails.reserveBudget } : {}),
      ...(args.draft.guardrails?.activeHours ? { activeHours: args.draft.guardrails.activeHours } : {}),
    },
    outputs: {
      disposition: "comment-only",
      ...(typeof args.draft.outputs?.createArtifact === "boolean" ? { createArtifact: args.draft.outputs.createArtifact } : { createArtifact: true }),
      ...(safeTrim(args.draft.outputs?.notificationChannel) ? { notificationChannel: safeTrim(args.draft.outputs?.notificationChannel) } : {}),
    },
    verification: {
      verifyBeforePublish: false,
      mode: "intervention",
    },
    billingCode: safeTrim(args.draft.billingCode) || `auto:${slugify(name)}`,
    includeProjectContext,
    actions: execution.kind === "built-in" ? normalizedActions : [],
    legacy: {
      trigger: triggers[0],
      actions: normalizedActions,
    },
  };

  return { normalized, issues, ambiguities, resolutions };
}

function requiredConfirmationsForDraft(draft: AutomationRuleDraftNormalized): AutomationDraftConfirmationRequirement[] {
  const reqs: AutomationDraftConfirmationRequirement[] = [];

  // Confirmations gate execution risk. Disabled rules can be saved without acknowledging
  // these prompts; the confirmations will be required once the rule is enabled.
  if (!draft.enabled) return reqs;

  const runCommands = (draft.legacy?.actions ?? []).filter((a) => a.type === "run-command");
  if (runCommands.length > 0) {
    reqs.push({
      key: "confirm.run-command",
      severity: "danger",
      title: "Confirm command execution",
      message: "This automation runs shell commands. Review the command preview(s) before saving."
    });
  }

  for (const action of runCommands) {
    const cmd = (action.command ?? "").trim();
    if (/\bclaude\b/.test(cmd) && /\-\-dangerously-skip-permissions\b/.test(cmd)) {
      reqs.push({
        key: "confirm.claude.dangerously-skip-permissions",
        severity: "danger",
        title: "Claude: dangerously skip permissions",
        message:
          "This command bypasses Claude Code permission checks (--dangerously-skip-permissions). Only use this in an externally sandboxed environment."
      });
    }
    if (/\bcodex\b/.test(cmd) && /\-\-dangerously-bypass-approvals-and-sandbox\b/.test(cmd)) {
      reqs.push({
        key: "confirm.codex.dangerously-bypass-approvals-and-sandbox",
        severity: "danger",
        title: "Codex: bypass approvals and sandbox",
        message:
          "This command bypasses Codex approvals and sandboxing (--dangerously-bypass-approvals-and-sandbox). Only use this in an externally sandboxed environment."
      });
    }
  }

  return reqs;
}

function missingConfirmations(required: AutomationDraftConfirmationRequirement[], provided: string[] | undefined): AutomationDraftConfirmationRequirement[] {
  const set = new Set((provided ?? []).map((k) => k.trim()).filter(Boolean));
  return required.filter((r) => !set.has(r.key));
}

function createEmptyDraft(): AutomationRuleDraft {
  return {
    name: "New automation",
    enabled: true,
    mode: "review",
    triggers: [{ type: "manual" }],
    trigger: { type: "manual" },
    execution: { kind: "agent-session", session: {} },
    executor: { mode: "automation-bot" },
    reviewProfile: "quick",
    toolPalette: ["repo", "memory", "mission"],
    contextSources: [{ type: "project-memory" }, { type: "procedures" }],
    memory: { mode: "automation-plus-project" },
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:new-automation",
    actions: [],
    legacyActions: [],
  };
}

export function createAutomationPlannerService({
  logger,
  projectRoot,
  projectConfigService,
  laneService,
  automationService
}: {
  logger: Logger;
  projectRoot: string;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  laneService: ReturnType<typeof createLaneService>;
  automationService: { list: () => { id: string }[]; syncFromConfig: () => void };
}) {
  const readSuites = (): TestSuiteDefinition[] => {
    try {
      return projectConfigService.get().effective.testSuites ?? [];
    } catch {
      return [];
    }
  };

  return {
    async parseNaturalLanguage(req: AutomationParseNaturalLanguageRequest): Promise<AutomationParseNaturalLanguageResult> {
      const intent = safeTrim(req?.intent);
      const issues: AutomationDraftIssue[] = [];
      if (!intent) {
        return {
          draft: createEmptyDraft(),
          normalized: null,
          confidence: 0,
          ambiguities: [],
          resolutions: [],
          issues: [{ level: "error", path: "intent", message: "Intent is required." }],
          plannerCommandPreview: ""
        };
      }

      const suites = readSuites();
      const laneBranches = await laneService.list({ includeArchived: false }).then((lanes) => lanes.map((l) => l.branchRef)).catch(() => []);

      const schema = buildPlannerSchema();
      const prompt = buildPlannerPrompt({ intent, suites, laneBranches });

      let jsonText = "";
      let plannerCommandPreview = "";
      try {
        if (req.planner.provider === "codex") {
          const cfg = req.planner.codex;
          const res = await runCodexExec({
            cwd: projectRoot,
            prompt,
            schema,
            logger,
            sandbox: cfg.sandbox,
            askForApproval: cfg.askForApproval,
            webSearch: cfg.webSearch,
            additionalWritableDirs: cfg.additionalWritableDirs
          });
          jsonText = res.jsonText;
          plannerCommandPreview = res.commandPreview;
        } else if (req.planner.provider === "claude") {
          const cfg = req.planner.claude;
          const res = await runClaudeHeadless({
            cwd: projectRoot,
            prompt,
            schema,
            permissionMode: cfg.permissionMode,
            dangerouslySkipPermissions: cfg.dangerouslySkipPermissions,
            allowedTools: cfg.allowedTools,
            additionalAllowedDirs: cfg.additionalAllowedDirs
          });
          jsonText = res.jsonText;
          plannerCommandPreview = res.commandPreview;
        } else {
          throw new Error(`Unsupported planner provider '${(req.planner as any).provider}'`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("automations.planner.parse_failed", { err: message });
        return {
          draft: createEmptyDraft(),
          normalized: null,
          confidence: 0,
          ambiguities: [],
          resolutions: [],
          issues: [{ level: "error", path: "planner", message }],
          plannerCommandPreview
        };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(extractFirstJsonObject(jsonText) ?? jsonText);
      } catch {
        issues.push({ level: "error", path: "planner.output", message: "Planner did not return valid JSON." });
        return {
          draft: createEmptyDraft(),
          normalized: null,
          confidence: 0,
          ambiguities: [],
          resolutions: [],
          issues,
          plannerCommandPreview
        };
      }

      const parsedTrigger = {
        type: safeTrim(parsed?.trigger?.type) as any || "manual",
        ...(safeTrim(parsed?.trigger?.cron) ? { cron: safeTrim(parsed.trigger.cron) } : {}),
        ...(safeTrim(parsed?.trigger?.branch) ? { branch: safeTrim(parsed.trigger.branch) } : {}),
        ...(safeTrim(parsed?.trigger?.targetBranch) ? { targetBranch: safeTrim(parsed.trigger.targetBranch) } : {}),
        ...(Array.isArray(parsed?.trigger?.paths) && parsed.trigger.paths.length ? { paths: parsed.trigger.paths.map((value: unknown) => safeTrim(value)).filter(Boolean) } : {}),
        ...(safeTrim(parsed?.trigger?.namePattern) ? { namePattern: safeTrim(parsed.trigger.namePattern) } : {}),
        ...(safeTrim(parsed?.trigger?.project) ? { project: safeTrim(parsed.trigger.project) } : {}),
        ...(safeTrim(parsed?.trigger?.team) ? { team: safeTrim(parsed.trigger.team) } : {}),
        ...(safeTrim(parsed?.trigger?.assignee) ? { assignee: safeTrim(parsed.trigger.assignee) } : {}),
        ...(safeTrim(parsed?.trigger?.stateTransition) ? { stateTransition: safeTrim(parsed.trigger.stateTransition) } : {}),
        ...(Array.isArray(parsed?.trigger?.changedFields) && parsed.trigger.changedFields.length ? { changedFields: parsed.trigger.changedFields.map((value: unknown) => safeTrim(value)).filter(Boolean) } : {}),
      };

      const draft: AutomationRuleDraft = {
        ...createEmptyDraft(),
        name: safeTrim(parsed?.name) || "New automation",
        enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : true,
        mode: safeTrim(parsed?.mode) === "fix" || safeTrim(parsed?.mode) === "monitor" ? safeTrim(parsed.mode) as any : "review",
        triggers: [parsedTrigger],
        trigger: parsedTrigger,
        ...(safeTrim(parsed?.prompt) ? { prompt: safeTrim(parsed.prompt) } : {}),
        ...(safeTrim(parsed?.templateId) ? { templateId: safeTrim(parsed.templateId) } : {}),
        ...(safeTrim(parsed?.reviewProfile) ? { reviewProfile: safeTrim(parsed.reviewProfile) as any } : {}),
      };

      // Basic guardrails for action shapes coming from the planner.
      // Treat as untrusted JSON and coerce into our draft-action union.
      draft.actions = (Array.isArray(parsed?.actions) ? parsed.actions : [])
        .filter((a: any) => a && typeof a === "object" && typeof a.type === "string")
        .map((a: any) => {
          const type = safeTrim(a.type) as AutomationActionType;
          if (type === "run-tests") {
            return {
              type,
              suite: safeTrim(a.suite),
              ...(safeTrim(a.condition) ? { condition: safeTrim(a.condition) } : {}),
              ...(typeof a.continueOnFailure === "boolean" ? { continueOnFailure: a.continueOnFailure } : {}),
              ...(a.timeoutMs != null ? { timeoutMs: Number(a.timeoutMs) } : {}),
              ...(a.retry != null ? { retry: Number(a.retry) } : {})
            };
          }
          if (type === "run-command") {
            return {
              type,
              command: safeTrim(a.command),
              ...(safeTrim(a.cwd) ? { cwd: safeTrim(a.cwd) } : {}),
              ...(safeTrim(a.condition) ? { condition: safeTrim(a.condition) } : {}),
              ...(typeof a.continueOnFailure === "boolean" ? { continueOnFailure: a.continueOnFailure } : {}),
              ...(a.timeoutMs != null ? { timeoutMs: Number(a.timeoutMs) } : {}),
              ...(a.retry != null ? { retry: Number(a.retry) } : {})
            };
          }

          return {
            type,
            ...(safeTrim(a.condition) ? { condition: safeTrim(a.condition) } : {}),
            ...(typeof a.continueOnFailure === "boolean" ? { continueOnFailure: a.continueOnFailure } : {}),
            ...(a.timeoutMs != null ? { timeoutMs: Number(a.timeoutMs) } : {}),
            ...(a.retry != null ? { retry: Number(a.retry) } : {})
          };
        }) as any;
      draft.legacyActions = draft.actions;
      draft.execution = draft.actions.length > 0
        ? { kind: "built-in", builtIn: { actions: [] } }
        : { kind: "agent-session", session: {} };

      const normalizedRes = normalizeDraft({ draft, suites, projectRoot, laneService });
      const confidence = clampNumber(1 - normalizedRes.ambiguities.length * 0.18 - normalizedRes.issues.filter((i) => i.level === "warning").length * 0.08, 0, 1);

      return {
        draft,
        normalized: normalizedRes.normalized,
        confidence,
        ambiguities: normalizedRes.ambiguities,
        resolutions: normalizedRes.resolutions,
        issues: [...issues, ...normalizedRes.issues],
        plannerCommandPreview
      };
    },

    validateDraft(req: AutomationValidateDraftRequest): AutomationValidateDraftResult {
      const suites = readSuites();
      const { normalized, issues } = normalizeDraft({ draft: req.draft, suites, projectRoot, laneService });
      const required = normalized ? requiredConfirmationsForDraft(normalized) : [];
      const missing = normalized ? missingConfirmations(required, req.confirmations) : [];

      const mergedIssues = [...issues];
      if (missing.length > 0) {
        for (const m of missing) {
          mergedIssues.push({ level: "error", path: "confirmations", message: `Missing confirmation: ${m.title}` });
        }
      }

      return {
        ok: Boolean(normalized) && mergedIssues.every((i) => i.level !== "error"),
        normalized,
        issues: mergedIssues,
        requiredConfirmations: required
      };
    },

    saveDraft(req: AutomationSaveDraftRequest): AutomationSaveDraftResult {
      const validation = this.validateDraft({ draft: req.draft, confirmations: req.confirmations });
      if (!validation.ok || !validation.normalized) {
        const first = validation.issues.find((i) => i.level === "error");
        throw new Error(first?.message ?? "Draft is invalid");
      }

      const normalized = validation.normalized;
      const execution = normalized.execution ?? {
        kind: normalized.actions.length ? "built-in" : "agent-session",
        ...(normalized.actions.length ? { builtIn: { actions: normalized.actions } } : { session: {} }),
      };
      const idRaw = safeTrim(normalized.id);
      const existing = new Set((automationService.list() ?? []).map((r) => r.id));
      const baseId = idRaw || slugify(normalized.name);
      let id = baseId;
      if (!idRaw) {
        let counter = 1;
        while (existing.has(id)) {
          counter += 1;
          id = `${baseId}-${counter}`;
        }
      }

      const snapshot = projectConfigService.get();
      const local = { ...(snapshot.local ?? {}) };
      const rules = Array.isArray(local.automations) ? [...local.automations] : [];
      const idx = rules.findIndex((r) => r?.id === id);
      const nextRule = {
        id,
        name: normalized.name,
        ...(safeTrim(normalized.description) ? { description: safeTrim(normalized.description) } : {}),
        enabled: normalized.enabled,
        mode: normalized.mode,
        triggers: normalized.triggers,
        execution,
        executor: normalized.executor,
        ...(normalized.modelConfig ? { modelConfig: normalized.modelConfig } : {}),
        ...(normalized.permissionConfig ? { permissionConfig: normalized.permissionConfig } : {}),
        ...(safeTrim(normalized.templateId) ? { templateId: safeTrim(normalized.templateId) } : {}),
        ...(safeTrim(normalized.prompt) ? { prompt: safeTrim(normalized.prompt) } : {}),
        reviewProfile: normalized.reviewProfile,
        toolPalette: normalized.toolPalette,
        contextSources: normalized.contextSources,
        memory: normalized.memory,
        guardrails: normalized.guardrails,
        outputs: normalized.outputs,
        verification: normalized.verification,
        billingCode: normalized.billingCode,
        ...(normalized.queueStatus ? { queueStatus: normalized.queueStatus } : {}),
        includeProjectContext: normalized.includeProjectContext,
        ...(execution.kind === "built-in" && normalized.actions.length ? { actions: normalized.actions } : {}),
      };
      if (idx >= 0) rules[idx] = nextRule;
      else rules.push(nextRule);
      local.automations = rules;

      projectConfigService.save({ shared: snapshot.shared, local });
      automationService.syncFromConfig();

      const effectiveRule = projectConfigService.get().effective.automations.find((r) => r.id === id) ?? null;
      if (!effectiveRule) {
        throw new Error("Failed to save automation rule");
      }

      return {
        rule: effectiveRule as AutomationRule,
        rules: automationService.list() as any
      };
    },

    simulate(req: AutomationSimulateRequest): AutomationSimulateResult {
      const suites = readSuites();
      const { normalized, issues } = normalizeDraft({ draft: req.draft, suites, projectRoot, laneService });
      if (!normalized) {
        return { normalized: null, actions: [], notes: [], issues };
      }

      const execution = normalized.execution ?? {
        kind: normalized.actions.length ? "built-in" : "agent-session",
        ...(normalized.actions.length ? { builtIn: { actions: normalized.actions } } : { session: {} }),
      };
      const builtInActions = execution.kind === "built-in"
        ? execution.builtIn?.actions ?? []
        : (normalized.legacy?.actions ?? []);
      const actions: AutomationSimulationAction[] = builtInActions.map((action, index): AutomationSimulationAction => {
        const warnings: string[] = [];
        if (action.type === "run-command") {
          warnings.push("Shell command execution is potentially dangerous. Review command and cwd.");
          return {
            index,
            type: action.type,
            summary: "Run shell command",
            commandPreview: action.command ?? "",
            cwdPreview: action.cwd ?? "(lane worktree / project root)",
            warnings
          };
        }
        if (action.type === "run-tests") {
          const suite = suites.find((s) => s.id === action.suiteId);
          if (!suite) warnings.push("Suite id does not match a known suite.");
          return {
            index,
            type: action.type,
            summary: suite ? `Run tests: ${suite.name || suite.id} (${suite.id})` : `Run tests: ${action.suiteId}`,
            warnings
          };
        }
        if (action.type === "predict-conflicts") {
          return { index, type: action.type, summary: "Run conflict prediction", warnings };
        }
        return { index, type: action.type, summary: action.type, warnings };
      });

      if (execution.kind === "agent-session") {
        actions.unshift({
          index: -1,
          type: "agent-session",
          summary: "Send the prompt to an automation-only agent thread",
          warnings: [],
        });
      } else if (execution.kind === "mission") {
        actions.unshift({
          index: -1,
          type: "launch-mission",
          summary: "Launch a mission run with the selected model and permissions",
          warnings: [],
        });
      }

      const notes: string[] = [];
      const firstTrigger = normalized.triggers[0];
      if (firstTrigger?.type === "schedule") {
        notes.push(`Schedule: ${firstTrigger.cron ?? ""}`);
      }
      if (firstTrigger?.type === "commit" && firstTrigger.branch) {
        notes.push(`Branch filter: ${firstTrigger.branch}`);
      }
      notes.push(`Tool palette: ${normalized.toolPalette.join(", ")}`);
      notes.push(`Context sources: ${normalized.contextSources.map((source) => source.type).join(", ")}`);
      if (execution.kind === "agent-session") {
        notes.push("Run output stays in Automations history and does not appear in Work chat.");
      }
      if (execution.kind === "mission") {
        notes.push("Mission runs stay visible from the Missions tab.");
      }
      if (execution.kind === "built-in") {
        notes.push("Built-in tasks run directly without launching a mission or chat thread.");
      }

      return { normalized, actions, notes, issues };
    }
  };
}
