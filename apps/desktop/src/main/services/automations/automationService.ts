import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type {
  AutomationAction,
  AutomationActionResult,
  AutomationActionStatus,
  AutomationRule,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunStatus,
  AutomationTriggerType
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createPackService } from "../packs/packService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createHostedAgentService } from "../hosted/hostedAgentService";
import type { createTestService } from "../tests/testService";
import cron from "node-cron";

type CronTask = {
  stop: () => void;
};

type TriggerContext = {
  triggerType: AutomationTriggerType;
  laneId?: string;
  sessionId?: string;
  commitSha?: string;
  reason?: string;
  scheduledAt?: string;
};

type AutomationRunRow = {
  id: string;
  automation_id: string;
  trigger_type: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  actions_completed: number;
  actions_total: number;
  error_message: string | null;
  trigger_metadata: string | null;
};

type AutomationActionRow = {
  id: string;
  run_id: string;
  action_index: number;
  action_type: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  error_message: string | null;
  output: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonParseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clampText(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}\n...(truncated)...\n`;
}

function normalizeStatus(value: string, fallback: AutomationRunStatus): AutomationRunStatus {
  if (value === "running" || value === "succeeded" || value === "failed" || value === "cancelled") return value;
  return fallback;
}

function normalizeActionStatus(value: string, fallback: AutomationActionStatus): AutomationActionStatus {
  if (value === "running" || value === "succeeded" || value === "failed" || value === "skipped" || value === "cancelled") return value;
  return fallback;
}

function isWithinDir(root: string, candidate: string): boolean {
  const rootNorm = path.resolve(root) + path.sep;
  const candNorm = path.resolve(candidate) + path.sep;
  return candNorm.startsWith(rootNorm);
}

function toRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    triggerType: (row.trigger_type as AutomationTriggerType) ?? "manual",
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    status: normalizeStatus(row.status, "failed"),
    actionsCompleted: row.actions_completed ?? 0,
    actionsTotal: row.actions_total ?? 0,
    errorMessage: row.error_message ?? null,
    triggerMetadata: safeJsonParseRecord(row.trigger_metadata)
  };
}

function toAction(row: AutomationActionRow): AutomationActionResult {
  return {
    id: row.id,
    runId: row.run_id,
    actionIndex: row.action_index,
    actionType: row.action_type as AutomationAction["type"],
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    status: normalizeActionStatus(row.status, "failed"),
    errorMessage: row.error_message ?? null,
    output: row.output ?? null
  };
}

export function createAutomationService({
  db,
  logger,
  projectId,
  projectRoot,
  laneService,
  projectConfigService,
  packService,
  conflictService,
  hostedAgentService,
  testService,
  onEvent
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  packService: ReturnType<typeof createPackService>;
  conflictService?: ReturnType<typeof createConflictService>;
  hostedAgentService?: ReturnType<typeof createHostedAgentService>;
  testService?: ReturnType<typeof createTestService>;
  onEvent?: (payload: { type: "runs-updated"; automationId?: string; runId?: string }) => void;
}) {
  const inFlightByAutomationId = new Set<string>();
  const scheduleTasks = new Map<string, CronTask>();

  const listRules = (): AutomationRule[] => {
    return projectConfigService.get().effective.automations ?? [];
  };

  const findRule = (automationId: string): AutomationRule | null => {
    return listRules().find((rule) => rule.id === automationId) ?? null;
  };

  const emit = (payload: { type: "runs-updated"; automationId?: string; runId?: string }) => {
    try {
      onEvent?.(payload);
    } catch {
      // ignore
    }
  };

  const isHostedEnabled = (): boolean => {
    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    return providerMode === "hosted" && Boolean(hostedAgentService?.getStatus().enabled);
  };

  const isByokEnabled = (): boolean => {
    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    return providerMode === "byok";
  };

  const evaluateCondition = async (condition: string | undefined, ctx: TriggerContext): Promise<boolean> => {
    const raw = (condition ?? "").trim();
    if (!raw) return true;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "hosted-enabled") return isHostedEnabled();
    if (raw === "byok-enabled") return isByokEnabled();
    if (raw === "provider-enabled") return (projectConfigService.get().effective.providerMode ?? "guest") !== "guest";
    if (raw === "lane-present") return Boolean(ctx.laneId);
    // Unknown condition: default false, but log for visibility.
    logger.warn("automations.condition.unknown", { condition: raw });
    return false;
  };

  const insertRun = (rule: AutomationRule, trigger: TriggerContext): AutomationRun => {
    const runId = randomUUID();
    const startedAt = nowIso();
    const triggerMetadata: Record<string, unknown> = {
      ...(trigger.laneId ? { laneId: trigger.laneId } : {}),
      ...(trigger.sessionId ? { sessionId: trigger.sessionId } : {}),
      ...(trigger.commitSha ? { commitSha: trigger.commitSha } : {}),
      ...(trigger.reason ? { reason: trigger.reason } : {}),
      ...(trigger.scheduledAt ? { scheduledAt: trigger.scheduledAt } : {})
    };

    db.run(
      `
        insert into automation_runs(
          id,
          project_id,
          automation_id,
          trigger_type,
          started_at,
          ended_at,
          status,
          actions_completed,
          actions_total,
          error_message,
          trigger_metadata
        ) values (?, ?, ?, ?, ?, null, 'running', 0, ?, null, ?)
      `,
      [
        runId,
        projectId,
        rule.id,
        trigger.triggerType,
        startedAt,
        rule.actions.length,
        JSON.stringify(triggerMetadata)
      ]
    );

    return {
      id: runId,
      automationId: rule.id,
      triggerType: trigger.triggerType,
      startedAt,
      endedAt: null,
      status: "running",
      actionsCompleted: 0,
      actionsTotal: rule.actions.length,
      errorMessage: null,
      triggerMetadata
    };
  };

  const updateRunProgress = (runId: string, actionsCompleted: number) => {
    db.run(
      `
        update automation_runs
        set actions_completed = ?
        where id = ?
          and project_id = ?
      `,
      [actionsCompleted, runId, projectId]
    );
  };

  const finishRun = (runId: string, status: AutomationRunStatus, errorMessage: string | null) => {
    db.run(
      `
        update automation_runs
        set ended_at = ?,
            status = ?,
            error_message = ?
        where id = ?
          and project_id = ?
      `,
      [nowIso(), status, errorMessage, runId, projectId]
    );
  };

  const insertAction = (runId: string, actionIndex: number, actionType: string): string => {
    const id = randomUUID();
    db.run(
      `
        insert into automation_action_results(
          id,
          project_id,
          run_id,
          action_index,
          action_type,
          started_at,
          ended_at,
          status,
          error_message,
          output
        ) values (?, ?, ?, ?, ?, ?, null, 'running', null, null)
      `,
      [id, projectId, runId, actionIndex, actionType, nowIso()]
    );
    return id;
  };

  const finishAction = (args: {
    id: string;
    status: AutomationActionStatus;
    errorMessage?: string | null;
    output?: string | null;
  }) => {
    db.run(
      `
        update automation_action_results
        set ended_at = ?,
            status = ?,
            error_message = ?,
            output = ?
        where id = ?
          and project_id = ?
      `,
      [
        nowIso(),
        args.status,
        args.errorMessage ?? null,
        args.output ?? null,
        args.id,
        projectId
      ]
    );
  };

  const runCommand = async (args: { command: string; cwd: string; timeoutMs: number }): Promise<{ output: string; exitCode: number | null }> => {
    const startedAt = Date.now();
    const child = spawn(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/c", args.command] : ["-lc", args.command], {
      cwd: args.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const MAX = 80_000;

    const onChunk = (chunk: unknown, target: "stdout" | "stderr") => {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (!text) return;
      if (target === "stdout") stdout = clampText(stdout + text, MAX);
      else stderr = clampText(stderr + text, MAX);
    };

    child.stdout?.on("data", (c) => onChunk(c, "stdout"));
    child.stderr?.on("data", (c) => onChunk(c, "stderr"));

    const timeoutMs = Math.max(1000, args.timeoutMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    const durationMs = Date.now() - startedAt;
    const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
    return {
      output: clampText(`${output}\n\n(duration ${durationMs}ms)`, MAX),
      exitCode
    };
  };

  const runAction = async (action: AutomationAction, trigger: TriggerContext): Promise<{ status: AutomationActionStatus; output?: string }> => {
    if (!(await evaluateCondition(action.condition, trigger))) {
      return { status: "skipped", output: action.condition ? `Condition '${action.condition}' evaluated false.` : undefined };
    }

    const reason = trigger.reason ? `automation:${trigger.reason}` : "automation";
    if (action.type === "update-packs") {
      if (trigger.laneId) {
        await packService.refreshLanePack({
          laneId: trigger.laneId,
          reason,
          ...(trigger.sessionId ? { sessionId: trigger.sessionId } : {})
        });
      } else {
        const lanes = await laneService.list({ includeArchived: false });
        for (const lane of lanes) {
          await packService.refreshLanePack({
            laneId: lane.id,
            reason
          });
        }
      }

      // Project pack is cheap; refresh once per rule run.
      await packService.refreshProjectPack({ reason, ...(trigger.laneId ? { laneId: trigger.laneId } : {}) });
      return { status: "succeeded" };
    }

    if (action.type === "predict-conflicts") {
      if (!conflictService) throw new Error("Conflict service unavailable");
      await conflictService.runPrediction(trigger.laneId ? { laneId: trigger.laneId } : {});
      return { status: "succeeded" };
    }

    if (action.type === "run-tests") {
      const suiteId = (action.suiteId ?? "").trim();
      if (!suiteId) throw new Error("run-tests requires suiteId");
      if (!testService) throw new Error("Test service unavailable");

      const activeLanes = await laneService.list({ includeArchived: false });
      const laneId = trigger.laneId
        ? trigger.laneId
        : activeLanes.find((lane) => lane.laneType === "primary")?.id ?? activeLanes[0]?.id ?? null;

      if (!laneId) throw new Error("No lane available to run tests");
      await testService.run({ laneId, suiteId });
      return { status: "succeeded" };
    }

    if (action.type === "run-command") {
      const command = (action.command ?? "").trim();
      if (!command) throw new Error("run-command requires command");

      const laneId = trigger.laneId ?? null;
      const baseCwd = laneId ? laneService.getLaneWorktreePath(laneId) : projectRoot;
      const configuredCwd = (action.cwd ?? "").trim();
      const cwd = configuredCwd.length
        ? path.isAbsolute(configuredCwd)
          ? configuredCwd
          : path.resolve(baseCwd, configuredCwd)
        : baseCwd;

      // Safety: never allow escaping the lane/workspace base directory via ../ or absolute paths.
      if (!isWithinDir(baseCwd, cwd)) {
        throw new Error("Unsafe cwd: must be within the lane worktree (or project root when no lane is present).");
      }

      const { output, exitCode } = await runCommand({ command, cwd, timeoutMs: action.timeoutMs ?? 5 * 60_000 });
      if (exitCode !== 0) {
        return { status: "failed", output: output.length ? output : `Command exited with code ${exitCode}` };
      }
      return { status: "succeeded", output };
    }

    return { status: "skipped", output: `Unknown action type '${(action as any).type}'` };
  };

  const runRule = async (rule: AutomationRule, trigger: TriggerContext): Promise<AutomationRun> => {
    // Trust model: refuse to execute when shared config is untrusted.
    // (UI should surface a trust CTA, mirroring process/test blocking semantics.)
    if (projectConfigService.get().trust.requiresSharedTrust) {
      throw new Error("Shared config is untrusted. Confirm trust to run automations.");
    }

    if (inFlightByAutomationId.has(rule.id)) {
      logger.info("automations.dedup.skip", { automationId: rule.id, triggerType: trigger.triggerType });
      // Return the most recent run if possible.
      const existing = db.get<AutomationRunRow>(
        `
          select
            id,
            automation_id,
            trigger_type,
            started_at,
            ended_at,
            status,
            actions_completed,
            actions_total,
            error_message,
            trigger_metadata
          from automation_runs
          where project_id = ?
            and automation_id = ?
          order by started_at desc
          limit 1
        `,
        [projectId, rule.id]
      );
      if (existing) return toRun(existing);
    }

    inFlightByAutomationId.add(rule.id);
    const run = insertRun(rule, trigger);
    emit({ type: "runs-updated", automationId: rule.id, runId: run.id });

    let completed = 0;
    let runStatus: AutomationRunStatus = "succeeded";
    let runError: string | null = null;

    try {
      for (let idx = 0; idx < rule.actions.length; idx += 1) {
        const action = rule.actions[idx]!;
        const actionId = insertAction(run.id, idx, action.type);
        emit({ type: "runs-updated", automationId: rule.id, runId: run.id });

        let lastOutput: string | null = null;
        try {
          const maxRetry = Number.isFinite(action.retry) ? Math.max(0, Math.min(5, Math.floor(action.retry ?? 0))) : 0;
          let attempt = 0;
          let lastError: Error | null = null;
          for (; attempt <= maxRetry; attempt += 1) {
            try {
              const res = await runAction(action, trigger);
              lastOutput = res.output ?? null;
              if (res.status === "failed") {
                throw new Error(res.output ?? "Action failed");
              }
              finishAction({ id: actionId, status: res.status, output: res.output ?? null });
              break;
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err));
              if (attempt >= maxRetry) throw lastError;
              // Backoff a bit before retrying.
              const delayMs = 400 * Math.pow(2, attempt);
              await new Promise((r) => setTimeout(r, delayMs));
            }
          }

          completed += 1;
          updateRunProgress(run.id, completed);
          emit({ type: "runs-updated", automationId: rule.id, runId: run.id });
          void lastOutput;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finishAction({ id: actionId, status: "failed", errorMessage: message, output: lastOutput });
          completed += 1;
          updateRunProgress(run.id, completed);
          emit({ type: "runs-updated", automationId: rule.id, runId: run.id });

          runStatus = "failed";
          runError = message;
          if (!action.continueOnFailure) {
            break;
          }
        }
      }
    } finally {
      finishRun(run.id, runStatus, runError);
      inFlightByAutomationId.delete(rule.id);
      emit({ type: "runs-updated", automationId: rule.id, runId: run.id });
    }

    const updated = db.get<AutomationRunRow>(
      `
        select
          id,
          automation_id,
          trigger_type,
          started_at,
          ended_at,
          status,
          actions_completed,
          actions_total,
          error_message,
          trigger_metadata
        from automation_runs
        where id = ?
          and project_id = ?
        limit 1
      `,
      [run.id, projectId]
    );
    return updated ? toRun(updated) : run;
  };

  const dispatchTrigger = async (trigger: TriggerContext) => {
    const rules = listRules().filter((rule) => rule.enabled && rule.trigger.type === trigger.triggerType);
    if (rules.length === 0) return;

    for (const rule of rules) {
      // Branch filter (primarily for commit triggers).
      const branch = (rule.trigger.branch ?? "").trim();
      if (branch && trigger.laneId) {
        try {
          const lane = laneService.getLaneBaseAndBranch(trigger.laneId);
          if (lane.branchRef !== branch) continue;
        } catch {
          continue;
        }
      }

      void runRule(rule, trigger).catch((err) => {
        logger.warn("automations.run.failed", {
          automationId: rule.id,
          triggerType: trigger.triggerType,
          err: err instanceof Error ? err.message : String(err)
        });
      });
    }
  };

  const syncFromConfig = () => {
    const rules = listRules();
    const scheduleRules = rules.filter((rule) => rule.enabled && rule.trigger.type === "schedule");
    const desired = new Set(scheduleRules.map((rule) => rule.id));

    for (const [id, task] of scheduleTasks.entries()) {
      if (desired.has(id)) continue;
      try {
        task.stop();
      } catch {
        // ignore
      }
      scheduleTasks.delete(id);
    }

    for (const rule of scheduleRules) {
      if (scheduleTasks.has(rule.id)) continue;
      const cronExpr = (rule.trigger.cron ?? "").trim();
      if (!cronExpr) continue;
      if (!cron.validate(cronExpr)) {
        logger.warn("automations.schedule.invalid_cron", { automationId: rule.id, cron: cronExpr });
        continue;
      }
      const task = cron.schedule(cronExpr, () => {
        void runRule(rule, { triggerType: "schedule", scheduledAt: nowIso(), reason: rule.id }).catch(() => {});
      });
      scheduleTasks.set(rule.id, { stop: () => task.stop() });
    }
  };

  // Initialize schedule triggers immediately.
  syncFromConfig();

  return {
    syncFromConfig,

    list(): AutomationRuleSummary[] {
      const rules = listRules();
      return rules.map((rule) => {
        const row = db.get<{ started_at: string; status: string }>(
          `
            select started_at, status
            from automation_runs
            where project_id = ?
              and automation_id = ?
            order by started_at desc
            limit 1
          `,
          [projectId, rule.id]
        );
        const runningRow = db.get<{ cnt: number }>(
          `
            select count(*) as cnt
            from automation_runs
            where project_id = ?
              and automation_id = ?
              and status = 'running'
              and ended_at is null
          `,
          [projectId, rule.id]
        );
        return {
          ...rule,
          lastRunAt: row?.started_at ?? null,
          lastRunStatus: row ? normalizeStatus(row.status, "failed") : null,
          running: (runningRow?.cnt ?? 0) > 0
        };
      });
    },

    toggle(args: { id: string; enabled: boolean }): AutomationRuleSummary[] {
      const id = args.id.trim();
      if (!id) return this.list();
      const snapshot = projectConfigService.get();
      const local = { ...(snapshot.local ?? {}) };
      const automations = Array.isArray(local.automations) ? [...local.automations] : [];
      const idx = automations.findIndex((rule) => rule?.id === id);
      if (idx >= 0) {
        automations[idx] = { ...automations[idx], id, enabled: Boolean(args.enabled) };
      } else {
        automations.push({ id, enabled: Boolean(args.enabled) });
      }
      local.automations = automations;
      projectConfigService.save({ shared: snapshot.shared, local });
      syncFromConfig();
      emit({ type: "runs-updated", automationId: id });
      return this.list();
    },

    async triggerManually(args: { id: string; laneId?: string | null } ): Promise<AutomationRun> {
      const id = args.id.trim();
      if (!id) throw new Error("Automation id is required");
      const rule = findRule(id);
      if (!rule) throw new Error(`Automation not found: ${id}`);
      const laneId = typeof args.laneId === "string" && args.laneId.trim().length ? args.laneId.trim() : undefined;
      return await runRule(rule, { triggerType: "manual", laneId, reason: id, scheduledAt: nowIso() });
    },

    getHistory(args: { id: string; limit?: number }): AutomationRun[] {
      const id = args.id.trim();
      if (!id) return [];
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 80;
      const rows = db.all<AutomationRunRow>(
        `
          select
            id,
            automation_id,
            trigger_type,
            started_at,
            ended_at,
            status,
            actions_completed,
            actions_total,
            error_message,
            trigger_metadata
          from automation_runs
          where project_id = ?
            and automation_id = ?
          order by started_at desc
          limit ?
        `,
        [projectId, id, limit]
      );
      return rows.map(toRun);
    },

    getRunDetail(args: { runId: string }): AutomationRunDetail | null {
      const runId = args.runId.trim();
      if (!runId) return null;
      const runRow = db.get<AutomationRunRow>(
        `
          select
            id,
            automation_id,
            trigger_type,
            started_at,
            ended_at,
            status,
            actions_completed,
            actions_total,
            error_message,
            trigger_metadata
          from automation_runs
          where project_id = ?
            and id = ?
          limit 1
        `,
        [projectId, runId]
      );
      if (!runRow) return null;
      const actions = db.all<AutomationActionRow>(
        `
          select
            id,
            run_id,
            action_index,
            action_type,
            started_at,
            ended_at,
            status,
            error_message,
            output
          from automation_action_results
          where project_id = ?
            and run_id = ?
          order by action_index asc
        `,
        [projectId, runId]
      );
      const run = toRun(runRow);
      const rule = findRule(run.automationId);
      return {
        run,
        rule,
        actions: actions.map(toAction)
      };
    },

    onSessionEnded(args: { laneId: string; sessionId: string }) {
      void dispatchTrigger({
        triggerType: "session-end",
        laneId: args.laneId,
        sessionId: args.sessionId,
        reason: "session_end"
      });
    },

    onHeadChanged(args: { laneId: string; preHeadSha: string | null; postHeadSha: string | null; reason: string }) {
      if (!args.postHeadSha || args.postHeadSha === args.preHeadSha) return;
      void dispatchTrigger({
        triggerType: "commit",
        laneId: args.laneId,
        commitSha: args.postHeadSha,
        reason: args.reason
      });
    },

    dispose() {
      for (const task of scheduleTasks.values()) {
        try {
          task.stop();
        } catch {
          // ignore
        }
      }
      scheduleTasks.clear();
    }
  };
}
