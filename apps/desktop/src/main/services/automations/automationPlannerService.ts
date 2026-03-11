import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import type {
  AutomationAction,
  AutomationActionType,
  AutomationDraftAmbiguity,
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationDraftResolution,
  AutomationDraftResolutionCandidate,
  AutomationParseNaturalLanguageRequest,
  AutomationParseNaturalLanguageResult,
  AutomationRule,
  AutomationRuleDraft,
  AutomationRuleDraftNormalized,
  AutomationSaveDraftRequest,
  AutomationSaveDraftResult,
  AutomationSimulateRequest,
  AutomationSimulateResult,
  AutomationSimulationAction,
  AutomationValidateDraftRequest,
  AutomationValidateDraftResult,
  TestSuiteDefinition
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createLaneService } from "../lanes/laneService";
import { isWithinDir } from "../shared/utils";

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
          type: { type: "string", enum: ["session-end", "commit", "schedule", "manual"] },
          cron: { type: "string" },
          branch: { type: "string" }
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
              properties: { type: { const: "update-packs" }, ...baseActionProps },
              required: ["type"]
            },
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
    "",
    "Available triggers:",
    "- session-end",
    "- commit",
    "- schedule (requires cron)",
    "- manual",
    "",
    "Available actions:",
    "- update-packs",
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
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  askForApproval: "untrusted" | "on-failure" | "on-request" | "never";
  webSearch: boolean;
  additionalWritableDirs: string[];
}): Promise<{ jsonText: string; commandPreview: string }> {
  const tmpRoot = path.join(path.resolve(args.cwd), ".ade", "tmp");
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

  const commandPreview = ["codex", ...cliArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");

  const child = spawn("codex", cliArgs, {
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

  const commandPreview = ["claude", ...cliArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");

  const child = spawn("claude", cliArgs, {
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
  const triggers = inputTriggers.map((raw, index) => {
    const triggerType = safeTrim(raw?.type) as any;
    const trigger: Record<string, unknown> = { type: triggerType };
    if (
      triggerType !== "session-end" &&
      triggerType !== "commit" &&
      triggerType !== "schedule" &&
      triggerType !== "manual" &&
      triggerType !== "github-webhook" &&
      triggerType !== "webhook"
    ) {
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
      type !== "update-packs" &&
      type !== "predict-conflicts" &&
      type !== "run-tests" &&
      type !== "run-command"
    ) {
      issues.push({ level: "error", path: `actions[${idx}].type`, message: `Unknown action type '${safeTrim(action?.type)}'.` });
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
        if (path.isAbsolute(cwdRaw)) {
          if (!isWithinDir(args.projectRoot, cwdRaw)) {
            issues.push({
              level: "error",
              path: `actions[${idx}].cwd`,
              message: "Absolute cwd must be within the project root."
            });
          } else {
            next.cwd = cwdRaw;
          }
        } else {
          // Require relative cwd to stay within the project root (runtime also enforces lane/base cwd bounds).
          const resolved = path.resolve(args.projectRoot, cwdRaw);
          if (!isWithinDir(args.projectRoot, resolved)) {
            issues.push({
              level: "error",
              path: `actions[${idx}].cwd`,
              message: "cwd must not escape the project root."
            });
          } else {
            next.cwd = cwdRaw;
          }
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

  const normalized: AutomationRuleDraftNormalized = {
    ...(args.draft.id ? { id: safeTrim(args.draft.id) } : {}),
    name,
    description: safeTrim(args.draft.description),
    enabled,
    mode: args.draft.mode === "fix" || args.draft.mode === "monitor" ? args.draft.mode : "review",
    triggers,
    trigger: triggers[0],
    executor:
      args.draft.executor?.mode === "employee" ||
      args.draft.executor?.mode === "cto-route" ||
      args.draft.executor?.mode === "night-shift"
        ? {
            mode: args.draft.executor.mode,
            ...(args.draft.executor.targetId ? { targetId: safeTrim(args.draft.executor.targetId) } : {}),
            ...(args.draft.executor.routingHints ? { routingHints: args.draft.executor.routingHints } : {}),
          }
        : { mode: "automation-bot" },
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
    contextSources: Array.isArray(args.draft.contextSources) && args.draft.contextSources.length
      ? args.draft.contextSources.map((source) => ({
          type: source.type,
          ...(safeTrim(source.path) ? { path: safeTrim(source.path) } : {}),
          ...(safeTrim(source.repoId) ? { repoId: safeTrim(source.repoId) } : {}),
          ...(safeTrim(source.label) ? { label: safeTrim(source.label) } : {}),
          ...(typeof source.required === "boolean" ? { required: source.required } : {}),
        }))
      : [{ type: "project-memory" }, { type: "procedures" }],
    memory: args.draft.memory?.mode
      ? {
          mode: args.draft.memory.mode,
          ...(safeTrim(args.draft.memory.ruleScopeKey) ? { ruleScopeKey: safeTrim(args.draft.memory.ruleScopeKey) } : {}),
        }
      : { mode: "automation-plus-project", ruleScopeKey: safeTrim(args.draft.id) || slugify(name) },
    guardrails: {
      ...(typeof args.draft.guardrails?.budgetUsd === "number" ? { budgetUsd: args.draft.guardrails.budgetUsd } : {}),
      ...(typeof args.draft.guardrails?.maxDurationMin === "number" ? { maxDurationMin: args.draft.guardrails.maxDurationMin } : {}),
      ...(typeof args.draft.guardrails?.confidenceThreshold === "number" ? { confidenceThreshold: args.draft.guardrails.confidenceThreshold } : {}),
      ...(typeof args.draft.guardrails?.maxFindings === "number" ? { maxFindings: Math.floor(args.draft.guardrails.maxFindings) } : {}),
      ...(typeof args.draft.guardrails?.reserveBudget === "boolean" ? { reserveBudget: args.draft.guardrails.reserveBudget } : {}),
      ...(args.draft.guardrails?.activeHours ? { activeHours: args.draft.guardrails.activeHours } : {}),
    },
    outputs: {
      disposition: args.draft.outputs?.disposition ?? "comment-only",
      ...(typeof args.draft.outputs?.createArtifact === "boolean" ? { createArtifact: args.draft.outputs.createArtifact } : { createArtifact: true }),
      ...(safeTrim(args.draft.outputs?.notificationChannel) ? { notificationChannel: safeTrim(args.draft.outputs?.notificationChannel) } : {}),
    },
    verification: {
      verifyBeforePublish: Boolean(args.draft.verification?.verifyBeforePublish),
      mode: args.draft.verification?.mode === "dry-run" ? "dry-run" : "intervention",
    },
    billingCode: safeTrim(args.draft.billingCode) || `auto:${slugify(name)}`,
    ...(args.draft.queueStatus ? { queueStatus: args.draft.queueStatus } : {}),
    ...(normalizedActions.length > 0
      ? {
          actions: normalizedActions,
          legacy: {
            trigger: triggers[0],
            actions: normalizedActions,
          }
        }
      : {}),
  };

  if (!normalized.prompt && normalizedActions.length === 0) {
    issues.push({
      level: "warning",
      path: "prompt",
      message: "No custom prompt or legacy actions provided. The default mode prompt will be used."
    });
  }

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

  if (draft.verification.verifyBeforePublish) {
    reqs.push({
      key: "confirm.verify-before-publish",
      severity: "warning",
      title: "Verification gate enabled",
      message: "This automation will stop for intervention before publishing external side effects."
    });
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

      const draft: AutomationRuleDraft = {
        ...createEmptyDraft(),
        name: safeTrim(parsed?.name) || "New automation",
        enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : true,
        mode: safeTrim(parsed?.mode) === "fix" || safeTrim(parsed?.mode) === "monitor" ? safeTrim(parsed.mode) as any : "review",
        triggers: [{
          type: safeTrim(parsed?.trigger?.type) as any || "manual",
          ...(safeTrim(parsed?.trigger?.cron) ? { cron: safeTrim(parsed.trigger.cron) } : {}),
          ...(safeTrim(parsed?.trigger?.branch) ? { branch: safeTrim(parsed.trigger.branch) } : {}),
        }],
        trigger: {
          type: safeTrim(parsed?.trigger?.type) as any || "manual",
          ...(safeTrim(parsed?.trigger?.cron) ? { cron: safeTrim(parsed.trigger.cron) } : {}),
          ...(safeTrim(parsed?.trigger?.branch) ? { branch: safeTrim(parsed.trigger.branch) } : {}),
        },
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

      const normalizedRes = normalizeDraft({ draft, suites, projectRoot });
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
      const { normalized, issues } = normalizeDraft({ draft: req.draft, suites, projectRoot });
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
        executor: normalized.executor,
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
        ...(normalized.queueStatus ? { queueStatus: normalized.queueStatus } : {})
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
      const { normalized, issues } = normalizeDraft({ draft: req.draft, suites, projectRoot });
      if (!normalized) {
        return { normalized: null, actions: [], notes: [], issues };
      }

      const actions: AutomationSimulationAction[] = (normalized.legacy?.actions ?? []).map((action, index): AutomationSimulationAction => {
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
        if (action.type === "update-packs") {
          return { index, type: action.type, summary: "Refresh packs (lane packs + project pack)", warnings };
        }
        if (action.type === "predict-conflicts") {
          return { index, type: action.type, summary: "Run conflict prediction", warnings };
        }
        return { index, type: action.type, summary: action.type, warnings };
      });

      actions.unshift({
        index: -1,
        type: "mission-dispatch",
        summary: `Dispatch ${normalized.mode} mission as ${normalized.executor.mode}`,
        warnings: normalized.verification.verifyBeforePublish ? ["External publish actions will require intervention approval."] : [],
      });
      actions.push({
        index: actions.length,
        type: normalized.outputs.disposition === "queue-overnight" ? "queue-result" : "review-summary",
        summary:
          normalized.outputs.disposition === "queue-overnight"
            ? "Queue result for Night Shift review"
            : `Produce ${normalized.outputs.disposition} output`,
        warnings: [],
      });

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

      return { normalized, actions, notes, issues };
    }
  };
}
