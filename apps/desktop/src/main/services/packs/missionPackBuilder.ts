/**
 * Mission / Plan / Feature pack builder — generates context packs for
 * missions, plans (lane-linked), and feature aggregations.
 */

import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type {
  TestRunStatus
} from "../../../shared/types";
import {
  CONTEXT_HEADER_SCHEMA_V1,
  CONTEXT_CONTRACT_VERSION,
  ADE_INTENT_START,
  ADE_INTENT_END,
  ADE_TASK_SPEC_START,
  ADE_TASK_SPEC_END
} from "../../../shared/contextContract";
import type { PackRelation } from "../../../shared/contextContract";
import { runGit } from "../git/git";
import {
  asString,
  extractSection,
  extractSectionByHeading,
  humanToolLabel,
  isRecord,
  parseRecord,
  readFileIfExists,
  statusFromCode,
  type ConflictPredictionPackFile
} from "./packUtils";

// ── Deps ─────────────────────────────────────────────────────────────────────

export type MissionPackBuilderDeps = {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectId: string;
  packsDir: string;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  /** Helpers from the main service that the builder calls back into */
  getLanePackPath: (laneId: string) => string;
  readConflictPredictionPack: (laneId: string) => ConflictPredictionPackFile | null;
  getHeadSha: (worktreePath: string) => Promise<string | null>;
  getPackIndexRow: (packKey: string) => {
    pack_type: string;
    lane_id: string | null;
    pack_path: string;
    deterministic_updated_at: string | null;
    narrative_updated_at: string | null;
    last_head_sha: string | null;
    metadata_json: string | null;
  } | null;
};

// ── Mission Pack ─────────────────────────────────────────────────────────────

export async function buildMissionPackBody(
  deps: MissionPackBuilderDeps,
  args: {
    missionId: string;
    reason: string;
    deterministicUpdatedAt: string;
    runId?: string | null;
  }
): Promise<{ body: string; laneId: string | null }> {
  const { db, projectId } = deps;

  const mission = db.get<{
    id: string;
    title: string;
    prompt: string;
    lane_id: string | null;
    status: string;
    priority: string;
    execution_mode: string;
    target_machine_id: string | null;
    outcome_summary: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>(
    `
      select
        id,
        title,
        prompt,
        lane_id,
        status,
        priority,
        execution_mode,
        target_machine_id,
        outcome_summary,
        last_error,
        created_at,
        updated_at,
        started_at,
        completed_at
      from missions
      where id = ?
        and project_id = ?
      limit 1
    `,
    [args.missionId, projectId]
  );
  if (!mission?.id) throw new Error(`Mission not found: ${args.missionId}`);

  const steps = db.all<{
    id: string;
    step_index: number;
    title: string;
    detail: string | null;
    kind: string;
    status: string;
    lane_id: string | null;
    metadata_json: string | null;
    started_at: string | null;
    completed_at: string | null;
    updated_at: string;
  }>(
    `
      select
        id,
        step_index,
        title,
        detail,
        kind,
        status,
        lane_id,
        metadata_json,
        started_at,
        completed_at,
        updated_at
      from mission_steps
      where mission_id = ?
        and project_id = ?
      order by step_index asc
    `,
    [args.missionId, projectId]
  );

  const artifactRows = db.all<{
    id: string;
    artifact_type: string;
    title: string;
    description: string | null;
    lane_id: string | null;
    created_at: string;
  }>(
    `
      select id, artifact_type, title, description, lane_id, created_at
      from mission_artifacts
      where mission_id = ? and project_id = ?
      order by created_at desc
      limit 40
    `,
    [args.missionId, projectId]
  );

  const interventionRows = db.all<{
    id: string;
    intervention_type: string;
    status: string;
    title: string;
    body: string;
    requested_action: string | null;
    resolution_note: string | null;
    created_at: string;
    resolved_at: string | null;
  }>(
    `
      select id, intervention_type, status, title, body, requested_action, resolution_note, created_at, resolved_at
      from mission_interventions
      where mission_id = ? and project_id = ?
      order by created_at desc
      limit 40
    `,
    [args.missionId, projectId]
  );

  const handoffs = db.all<{
    handoff_type: string;
    producer: string;
    created_at: string;
    payload_json: string | null;
  }>(
    `
      select handoff_type, producer, created_at, payload_json
      from mission_step_handoffs
      where mission_id = ?
        and project_id = ?
      order by created_at desc
      limit 40
    `,
    [args.missionId, projectId]
  );

  const runs = db.all<{
    id: string;
    status: string;
    context_profile: string;
    last_error: string | null;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>(
    `
      select id, status, context_profile, last_error, created_at, updated_at, started_at, completed_at
      from orchestrator_runs
      where mission_id = ?
        and project_id = ?
      order by created_at desc
      limit 20
    `,
    [args.missionId, projectId]
  );

  const lines: string[] = [];

  // JSON header
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        schema: CONTEXT_HEADER_SCHEMA_V1,
        contractVersion: CONTEXT_CONTRACT_VERSION,
        projectId,
        packType: "mission",
        missionId: mission.id,
        laneId: mission.lane_id,
        status: mission.status,
        deterministicUpdatedAt: args.deterministicUpdatedAt,
        stepCount: steps.length,
        runId: args.runId ?? null
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");

  lines.push(`# Mission Pack: ${mission.title}`);
  lines.push(`> Status: ${mission.status} | Priority: ${mission.priority} | Mode: ${mission.execution_mode}`);
  lines.push("");

  lines.push("## Original Prompt");
  lines.push("```");
  lines.push(mission.prompt.trim());
  lines.push("```");
  lines.push("");

  lines.push("## Mission Metadata");
  lines.push(`- Mission ID: ${mission.id}`);
  lines.push(`- Updated: ${args.deterministicUpdatedAt}`);
  lines.push(`- Trigger: ${args.reason}`);
  lines.push(`- Status: ${mission.status}`);
  lines.push(`- Priority: ${mission.priority}`);
  lines.push(`- Execution mode: ${mission.execution_mode}`);
  if (mission.target_machine_id) lines.push(`- Target machine: ${mission.target_machine_id}`);
  if (args.runId) lines.push(`- Orchestrator run: ${args.runId}`);
  lines.push(`- Created: ${mission.created_at}`);
  lines.push(`- Updated: ${mission.updated_at}`);
  if (mission.started_at) lines.push(`- Started: ${mission.started_at}`);
  if (mission.completed_at) lines.push(`- Completed: ${mission.completed_at}`);
  if (mission.outcome_summary) lines.push(`- Outcome summary: ${mission.outcome_summary}`);
  if (mission.last_error) lines.push(`- Last error: ${mission.last_error}`);
  lines.push("");

  // Mission duration
  if (mission.started_at) {
    const endTime = mission.completed_at ?? args.deterministicUpdatedAt;
    lines.push("## Mission Duration");
    lines.push(`- Start: ${mission.started_at}`);
    lines.push(`- End: ${mission.completed_at ?? "(in progress)"}`);
    const startMs = new Date(mission.started_at).getTime();
    const endMs = new Date(endTime).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      const durationMin = Math.round((endMs - startMs) / 60_000);
      lines.push(`- Duration: ${durationMin}m`);
    }
    lines.push("");
  }

  // Step Progress
  const completedSteps = steps.filter((s) => s.status === "completed").length;
  lines.push("## Step Progress");
  lines.push(`Progress: ${completedSteps}/${steps.length} completed`);
  lines.push("");
  if (!steps.length) {
    lines.push("- No mission steps.");
    lines.push("");
  } else {
    lines.push("| # | Step | Status | Kind | Lane | Started | Completed |");
    lines.push("|---|------|--------|------|------|---------|-----------|");
    for (const step of steps) {
      const detail = step.detail ? ` - ${step.detail.slice(0, 60).replace(/\|/g, "\\|")}` : "";
      lines.push(
        `| ${Number(step.step_index) + 1} | ${step.title.replace(/\|/g, "\\|")}${detail} | ${step.status} | ${step.kind} | ${step.lane_id ?? "-"} | ${step.started_at ?? "-"} | ${step.completed_at ?? "-"} |`
      );
    }
    lines.push("");

    // Per-step error history from metadata
    const stepErrors: string[] = [];
    for (const step of steps) {
      const meta = parseRecord(step.metadata_json);
      if (!meta) continue;
      const errors = Array.isArray(meta.errors) ? meta.errors : [];
      const lastError = typeof meta.last_error === "string" ? meta.last_error : null;
      if (errors.length) {
        for (const err of errors.slice(-5)) {
          stepErrors.push(`- Step ${Number(step.step_index) + 1} (${step.title}): ${String(err).slice(0, 200)}`);
        }
      } else if (lastError) {
        stepErrors.push(`- Step ${Number(step.step_index) + 1} (${step.title}): ${lastError.slice(0, 200)}`);
      }
    }
    if (stepErrors.length) {
      lines.push("### Step Error History");
      for (const se of stepErrors.slice(0, 20)) lines.push(se);
      lines.push("");
    }
  }

  // Step Timeline
  const timelineSteps = steps.filter((s) => s.started_at || s.completed_at);
  if (timelineSteps.length) {
    lines.push("## Step Timeline");
    const timelineEvents: Array<{ time: string; label: string }> = [];
    for (const step of timelineSteps) {
      if (step.started_at) {
        timelineEvents.push({ time: step.started_at, label: `Step ${Number(step.step_index) + 1} (${step.title}) started` });
      }
      if (step.completed_at) {
        timelineEvents.push({ time: step.completed_at, label: `Step ${Number(step.step_index) + 1} (${step.title}) completed [${step.status}]` });
      }
    }
    timelineEvents.sort((a, b) => a.time.localeCompare(b.time));
    for (const ev of timelineEvents) {
      lines.push(`- ${ev.time}: ${ev.label}`);
    }
    lines.push("");
  }

  // Per-step session references
  lines.push("## Step Sessions");
  let hasStepSessions = false;
  for (const step of steps) {
    if (!step.lane_id) continue;
    const stepSessions = db.all<{
      id: string;
      title: string;
      tool_type: string | null;
      started_at: string;
      ended_at: string | null;
      status: string;
      exit_code: number | null;
    }>(
      `
        select id, title, tool_type, started_at, ended_at, status, exit_code
        from terminal_sessions
        where lane_id = ?
          and started_at >= ?
        order by started_at asc
        limit 8
      `,
      [step.lane_id, step.started_at ?? step.updated_at]
    );
    if (stepSessions.length) {
      hasStepSessions = true;
      lines.push(`### Step ${Number(step.step_index) + 1}: ${step.title}`);
      for (const sess of stepSessions) {
        const tool = humanToolLabel(sess.tool_type);
        const outcome = sess.status === "running" ? "RUNNING" : sess.exit_code === 0 ? "OK" : sess.exit_code != null ? `EXIT ${sess.exit_code}` : "ENDED";
        lines.push(`- ${sess.started_at} | ${tool} | ${(sess.title ?? "").slice(0, 60)} | ${outcome}`);
      }
      lines.push("");
    }
  }
  if (!hasStepSessions) {
    lines.push("- No per-step sessions recorded.");
    lines.push("");
  }

  // Artifacts
  lines.push("## Artifacts");
  if (!artifactRows.length) {
    lines.push("- No artifacts recorded.");
  } else {
    lines.push(`Total: ${artifactRows.length}`);
    lines.push("");
    for (const art of artifactRows) {
      const desc = art.description ? ` - ${art.description.slice(0, 100)}` : "";
      lines.push(`- [${art.artifact_type}] ${art.title}${desc} (${art.created_at})`);
    }
  }
  lines.push("");

  // Interventions
  lines.push("## Interventions");
  const openInterventions = interventionRows.filter((i) => i.status === "open").length;
  if (!interventionRows.length) {
    lines.push("- No interventions recorded.");
  } else {
    lines.push(`Total: ${interventionRows.length} (${openInterventions} open)`);
    lines.push("");
    for (const intv of interventionRows) {
      lines.push(`- [${intv.status}] ${intv.intervention_type}: ${intv.title}`);
      if (intv.body.trim()) lines.push(`  ${intv.body.trim().slice(0, 200)}`);
      if (intv.requested_action) lines.push(`  Requested: ${intv.requested_action.slice(0, 150)}`);
      if (intv.resolution_note) lines.push(`  Resolution: ${intv.resolution_note.slice(0, 150)}`);
    }
  }
  lines.push("");

  // Orchestrator Runs
  lines.push("## Orchestrator Runs");
  if (!runs.length) {
    lines.push("- No orchestrator runs linked yet.");
  } else {
    for (const run of runs) {
      const duration = run.started_at && run.completed_at
        ? `${Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 60_000)}m`
        : run.started_at ? "in progress" : "-";
      lines.push(`- ${run.id} | ${run.status} | profile=${run.context_profile} | duration=${duration} | updated=${run.updated_at}`);
      if (run.last_error) lines.push(`  error: ${run.last_error.slice(0, 200)}`);
    }
  }
  lines.push("");

  // Step Handoffs
  lines.push("## Step Handoffs");
  if (!handoffs.length) {
    lines.push("- No step handoffs recorded.");
  } else {
    for (const handoff of handoffs) {
      const payload = parseRecord(handoff.payload_json);
      const summary = payload?.result && typeof payload.result === "object"
        ? String((payload.result as Record<string, unknown>).summary ?? "")
        : "";
      lines.push(
        `- ${handoff.created_at} | ${handoff.handoff_type} | producer=${handoff.producer}${summary ? ` | ${summary}` : ""}`
      );
    }
  }
  lines.push("");

  if (mission.lane_id) {
    const lanePack = readFileIfExists(deps.getLanePackPath(mission.lane_id));
    if (lanePack.trim().length) {
      lines.push("## Lane Pack Reference");
      lines.push(`- Lane pack key: lane:${mission.lane_id}`);
      lines.push(`- Lane pack path: ${deps.getLanePackPath(mission.lane_id)}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(`*Mission pack: deterministic context snapshot. Updated: ${args.deterministicUpdatedAt}*`);
  lines.push("");

  return {
    body: `${lines.join("\n")}\n`,
    laneId: mission.lane_id ?? null
  };
}

// ── Plan Pack ────────────────────────────────────────────────────────────────

export async function buildPlanPackBody(
  deps: MissionPackBuilderDeps,
  args: {
    laneId: string;
    reason: string;
    deterministicUpdatedAt: string;
  }
): Promise<{ body: string; headSha: string | null }> {
  const { db, projectId } = deps;
  const lanes = await deps.laneService.list({ includeArchived: true });
  const lane = lanes.find((l) => l.id === args.laneId);
  if (!lane) throw new Error(`Lane not found: ${args.laneId}`);

  const { worktreePath } = deps.laneService.getLaneBaseAndBranch(args.laneId);
  const headSha = await deps.getHeadSha(worktreePath);

  const lines: string[] = [];

  // JSON header
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        schema: CONTEXT_HEADER_SCHEMA_V1,
        contractVersion: CONTEXT_CONTRACT_VERSION,
        projectId,
        packType: "plan",
        laneId: args.laneId,
        headSha,
        deterministicUpdatedAt: args.deterministicUpdatedAt
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");

  // Check if a mission is linked to this lane
  const mission = db.get<{
    id: string;
    title: string;
    prompt: string;
    status: string;
    priority: string;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>(
    `
      select id, title, prompt, status, priority, created_at, updated_at, started_at, completed_at
      from missions
      where lane_id = ? and project_id = ?
      order by updated_at desc
      limit 1
    `,
    [args.laneId, projectId]
  );

  if (mission?.id) {
    lines.push(`# Plan: ${mission.title}`);
    lines.push(`> Lane: ${lane.name} | Mission: ${mission.id} | Status: ${mission.status} | Priority: ${mission.priority}`);
    lines.push("");

    lines.push("## Original Prompt");
    lines.push("```");
    lines.push(mission.prompt.trim());
    lines.push("```");
    lines.push("");

    lines.push("## Mission Metadata");
    lines.push(`- Mission ID: ${mission.id}`);
    lines.push(`- Status: ${mission.status}`);
    lines.push(`- Priority: ${mission.priority}`);
    lines.push(`- Created: ${mission.created_at}`);
    lines.push(`- Updated: ${mission.updated_at}`);
    if (mission.started_at) lines.push(`- Started: ${mission.started_at}`);
    if (mission.completed_at) lines.push(`- Completed: ${mission.completed_at}`);
    lines.push("");

    const steps = db.all<{
      id: string;
      step_index: number;
      title: string;
      detail: string | null;
      kind: string;
      status: string;
      lane_id: string | null;
      metadata_json: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>(
      `
        select id, step_index, title, detail, kind, status, lane_id, metadata_json, started_at, completed_at
        from mission_steps
        where mission_id = ? and project_id = ?
        order by step_index asc
      `,
      [mission.id, projectId]
    );

    const completedSteps = steps.filter((s) => s.status === "completed").length;
    lines.push("## Steps");
    lines.push(`Progress: ${completedSteps}/${steps.length} completed`);
    lines.push("");

    if (steps.length === 0) {
      lines.push("- No steps defined yet.");
    } else {
      lines.push("| # | Step | Status | Kind | Started | Completed |");
      lines.push("|---|------|--------|------|---------|-----------|");
      for (const step of steps) {
        const desc = step.detail ? ` - ${step.detail.slice(0, 80).replace(/\|/g, "\\|")}` : "";
        lines.push(
          `| ${Number(step.step_index) + 1} | ${step.title.replace(/\|/g, "\\|")}${desc} | ${step.status} | ${step.kind} | ${step.started_at ?? "-"} | ${step.completed_at ?? "-"} |`
        );
      }

      const depsLines: string[] = [];
      for (const step of steps) {
        const meta = parseRecord(step.metadata_json);
        const stepDeps = meta && Array.isArray(meta.dependencies) ? meta.dependencies : [];
        if (stepDeps.length) {
          depsLines.push(`- Step ${Number(step.step_index) + 1} (${step.title}): depends on ${stepDeps.join(", ")}`);
        }
      }
      if (depsLines.length) {
        lines.push("");
        lines.push("### Step Dependencies");
        for (const dl of depsLines) lines.push(dl);
      }
    }
    lines.push("");

    // Timeline
    const timelineEntries = steps
      .filter((s) => s.started_at || s.completed_at)
      .sort((a, b) => (a.started_at ?? a.completed_at ?? "").localeCompare(b.started_at ?? b.completed_at ?? ""));
    if (timelineEntries.length) {
      lines.push("## Timeline");
      for (const step of timelineEntries) {
        const start = step.started_at ?? "-";
        const end = step.completed_at ?? "-";
        lines.push(`- Step ${Number(step.step_index) + 1} (${step.title}): started=${start}, completed=${end}`);
      }
      lines.push("");
    }

    // Handoff and retry policies from mission metadata
    const missionMeta = db.get<{ metadata_json: string | null }>(
      "select metadata_json from missions where id = ? and project_id = ?",
      [mission.id, projectId]
    );
    const missionMetaParsed = parseRecord(missionMeta?.metadata_json);
    if (missionMetaParsed) {
      const policies: string[] = [];
      if (missionMetaParsed.handoffPolicy) policies.push(`- Handoff policy: ${JSON.stringify(missionMetaParsed.handoffPolicy)}`);
      if (missionMetaParsed.retryPolicy) policies.push(`- Retry policy: ${JSON.stringify(missionMetaParsed.retryPolicy)}`);
      if (policies.length) {
        lines.push("## Policies");
        for (const p of policies) lines.push(p);
        lines.push("");
      }
    }
  } else {
    // No mission linked: structured template
    const lanePackBody = readFileIfExists(deps.getLanePackPath(args.laneId));
    const intent = extractSection(lanePackBody, ADE_INTENT_START, ADE_INTENT_END, "");
    const taskSpec = extractSection(lanePackBody, ADE_TASK_SPEC_START, ADE_TASK_SPEC_END, "");

    lines.push(`# Plan: ${lane.name}`);
    lines.push(`> Lane: ${lane.name} | Branch: \`${lane.branchRef}\` | No mission linked`);
    lines.push("");

    lines.push("## Objective");
    lines.push(intent.trim().length ? intent.trim() : "Not yet defined");
    lines.push("");

    lines.push("## Current State");
    const keyFilesMatch = /## Key Files \((\d+) files touched\)/.exec(lanePackBody);
    const fileCount = keyFilesMatch ? keyFilesMatch[1] : "0";
    lines.push(`- Files changed: ${fileCount}`);
    lines.push(`- Branch status: ${lane.status.dirty ? "dirty" : "clean"}, ahead ${lane.status.ahead}, behind ${lane.status.behind}`);

    const latestTest = db.get<{ status: string; suite_name: string | null; suite_key: string }>(
      `
        select r.status as status, s.name as suite_name, r.suite_key as suite_key
        from test_runs r
        left join test_suites s on s.project_id = r.project_id and s.id = r.suite_key
        where r.project_id = ? and r.lane_id = ?
        order by r.started_at desc limit 1
      `,
      [projectId, args.laneId]
    );
    if (latestTest) {
      const testLabel = (latestTest.suite_name ?? latestTest.suite_key).trim();
      lines.push(`- Latest test: ${statusFromCode(latestTest.status as TestRunStatus)} (${testLabel})`);
    } else {
      lines.push("- Latest test: NOT RUN");
    }
    lines.push("");

    lines.push("## Steps");
    lines.push("- (define steps for this lane's work)");
    lines.push("");

    lines.push("## Dependencies");
    const packKey = `lane:${args.laneId}`;
    const packRow = deps.getPackIndexRow(packKey);
    if (packRow?.metadata_json) {
      const packMeta = parseRecord(packRow.metadata_json);
      if (packMeta?.graph && isRecord(packMeta.graph)) {
        const graphRelations = Array.isArray((packMeta.graph as Record<string, unknown>).relations)
          ? ((packMeta.graph as Record<string, unknown>).relations as PackRelation[])
          : [];
        const blockingRels = graphRelations.filter(
          (r) => r.relationType === "blocked_by" || r.relationType === "depends_on"
        );
        if (blockingRels.length) {
          for (const rel of blockingRels) {
            lines.push(`- ${rel.relationType}: ${rel.targetPackKey}`);
          }
        } else {
          lines.push("- No blocking dependencies detected.");
        }
      } else {
        lines.push("- No blocking dependencies detected.");
      }
    } else {
      lines.push("- No blocking dependencies detected.");
    }
    if (lane.parentLaneId) {
      const parentLane = lanes.find((l) => l.id === lane.parentLaneId);
      if (parentLane) lines.push(`- Parent lane: ${parentLane.name} (\`${parentLane.branchRef}\`)`);
    }
    lines.push("");

    lines.push("## Acceptance Criteria");
    if (taskSpec.trim().length) {
      lines.push(taskSpec.trim());
    } else {
      lines.push("- (add acceptance criteria here)");
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Plan pack: auto-generated for lane ${lane.name}. Updated: ${args.deterministicUpdatedAt}*`);
  lines.push("");

  return { body: `${lines.join("\n")}\n`, headSha };
}

// ── Feature Pack ─────────────────────────────────────────────────────────────

export async function buildFeaturePackBody(
  deps: MissionPackBuilderDeps,
  args: {
    featureKey: string;
    reason: string;
    deterministicUpdatedAt: string;
  }
): Promise<{ body: string; laneIds: string[] }> {
  const { db, projectId, projectRoot } = deps;
  const lanes = await deps.laneService.list({ includeArchived: false });
  const matching = lanes.filter((lane) => lane.tags.includes(args.featureKey));
  const lines: string[] = [];

  // JSON header
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        schema: CONTEXT_HEADER_SCHEMA_V1,
        contractVersion: CONTEXT_CONTRACT_VERSION,
        projectId,
        packType: "feature",
        featureKey: args.featureKey,
        deterministicUpdatedAt: args.deterministicUpdatedAt,
        laneCount: matching.length,
        laneIds: matching.map((l) => l.id)
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");

  lines.push(`# Feature Pack: ${args.featureKey}`);
  lines.push(`> Updated: ${args.deterministicUpdatedAt} | Trigger: ${args.reason} | Lanes: ${matching.length}`);
  lines.push("");

  if (matching.length === 0) {
    lines.push("No lanes are tagged with this feature key yet.");
    lines.push("");
    lines.push("## How To Use");
    lines.push(`- Add the tag '${args.featureKey}' to one or more lanes (Workspace Graph -> right click lane -> Customize).`);
    lines.push("");
    return { body: `${lines.join("\n")}\n`, laneIds: [] };
  }

  // Feature Progress Summary
  const dirtyCount = matching.filter((l) => l.status.dirty).length;
  const cleanCount = matching.length - dirtyCount;
  const totalAhead = matching.reduce((sum, l) => sum + l.status.ahead, 0);
  const totalBehind = matching.reduce((sum, l) => sum + l.status.behind, 0);

  lines.push("## Feature Progress Summary");
  lines.push(`- Lanes: ${matching.length} (${dirtyCount} dirty, ${cleanCount} clean)`);
  lines.push(`- Total ahead: ${totalAhead} | Total behind: ${totalBehind}`);
  lines.push("");

  // Combined File Changes
  lines.push("## Combined File Changes");
  type FeatureFileDelta = { insertions: number | null; deletions: number | null };
  const featureDeltas = new Map<string, FeatureFileDelta>();

  for (const lane of matching) {
    const { worktreePath } = deps.laneService.getLaneBaseAndBranch(lane.id);
    const headSha = await deps.getHeadSha(worktreePath);
    const mergeBaseRes = await runGit(
      ["merge-base", headSha ?? "HEAD", lane.baseRef?.trim() || "HEAD"],
      { cwd: projectRoot, timeoutMs: 12_000 }
    );
    const mergeBaseSha = mergeBaseRes.exitCode === 0 ? mergeBaseRes.stdout.trim() : null;

    if (mergeBaseSha && (headSha ?? "HEAD") !== mergeBaseSha) {
      const diff = await runGit(
        ["diff", "--numstat", `${mergeBaseSha}..${headSha ?? "HEAD"}`],
        { cwd: projectRoot, timeoutMs: 20_000 }
      );
      if (diff.exitCode === 0) {
        for (const diffLine of diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
          const parts = diffLine.split("\t");
          if (parts.length < 3) continue;
          const insRaw = parts[0] ?? "0";
          const delRaw = parts[1] ?? "0";
          const filePath = parts.slice(2).join("\t").trim();
          if (!filePath) continue;
          const ins = insRaw === "-" ? null : Number(insRaw);
          const del = delRaw === "-" ? null : Number(delRaw);
          const prev = featureDeltas.get(filePath);
          if (!prev) {
            featureDeltas.set(filePath, {
              insertions: Number.isFinite(ins as number) ? ins : null,
              deletions: Number.isFinite(del as number) ? del : null
            });
          } else {
            featureDeltas.set(filePath, {
              insertions: prev.insertions == null || ins == null ? null : prev.insertions + (ins as number),
              deletions: prev.deletions == null || del == null ? null : prev.deletions + (del as number)
            });
          }
        }
      }
    }
  }

  if (featureDeltas.size === 0) {
    lines.push("No file changes detected across feature lanes.");
  } else {
    const sorted = [...featureDeltas.entries()]
      .sort((a, b) => {
        const aTotal = (a[1].insertions ?? 0) + (a[1].deletions ?? 0);
        const bTotal = (b[1].insertions ?? 0) + (b[1].deletions ?? 0);
        return bTotal - aTotal;
      })
      .slice(0, 40);

    lines.push("| File | Change |");
    lines.push("|------|--------|");
    for (const [file, delta] of sorted) {
      const change = delta.insertions == null || delta.deletions == null ? "binary" : `+${delta.insertions}/-${delta.deletions}`;
      lines.push(`| \`${file}\` | ${change} |`);
    }
    if (featureDeltas.size > 40) {
      lines.push(`| ... | ${featureDeltas.size - 40} more files |`);
    }
  }
  lines.push("");

  // Rolled-up Test Results
  lines.push("## Rolled-up Test Results");
  let totalPassed = 0;
  let totalFailed = 0;
  let totalOtherTests = 0;
  const failingTests: string[] = [];

  for (const lane of matching) {
    const testRows = db.all<{
      run_id: string;
      suite_name: string | null;
      suite_key: string;
      status: string;
    }>(
      `
        select
          r.id as run_id,
          s.name as suite_name,
          r.suite_key as suite_key,
          r.status as status
        from test_runs r
        left join test_suites s on s.project_id = r.project_id and s.id = r.suite_key
        where r.project_id = ?
          and r.lane_id = ?
        order by r.started_at desc
        limit 3
      `,
      [projectId, lane.id]
    );
    for (const tr of testRows) {
      if (tr.status === "passed") totalPassed++;
      else if (tr.status === "failed") {
        totalFailed++;
        failingTests.push(`${lane.name}: ${(tr.suite_name ?? tr.suite_key).trim()}`);
      } else {
        totalOtherTests++;
      }
    }
  }

  if (totalPassed + totalFailed + totalOtherTests === 0) {
    lines.push("- No test runs recorded across feature lanes.");
  } else {
    lines.push(`- Passed: ${totalPassed} | Failed: ${totalFailed} | Other: ${totalOtherTests}`);
    if (failingTests.length) {
      lines.push("- Failing tests:");
      for (const ft of failingTests.slice(0, 20)) {
        lines.push(`  - ${ft}`);
      }
    }
  }
  lines.push("");

  // Cross-Lane Conflict Predictions
  lines.push("## Cross-Lane Conflict Predictions");
  const conflictEntries: string[] = [];
  const matchingIds = new Set(matching.map((l) => l.id));
  for (const lane of matching) {
    const conflictPack = deps.readConflictPredictionPack(lane.id);
    if (!conflictPack) continue;
    const overlaps = Array.isArray(conflictPack.overlaps) ? conflictPack.overlaps : [];
    for (const ov of overlaps) {
      if (!ov || !ov.peerId) continue;
      if (!matchingIds.has(ov.peerId)) continue;
      const peerName = asString(ov.peerName).trim() || ov.peerId;
      const riskLevel = asString(ov.riskLevel).trim() || "unknown";
      const fileCount = Array.isArray(ov.files) ? ov.files.length : 0;
      conflictEntries.push(`- ${lane.name} <-> ${peerName}: risk=\`${riskLevel}\`, ${fileCount} overlapping files`);
    }
  }
  if (conflictEntries.length === 0) {
    lines.push("- No cross-lane conflict predictions within this feature.");
  } else {
    for (const entry of conflictEntries.slice(0, 20)) {
      lines.push(entry);
    }
  }
  lines.push("");

  // Combined Session Timeline
  lines.push("## Combined Session Timeline");
  const featureSessions = db.all<{
    id: string;
    lane_id: string;
    title: string;
    tool_type: string | null;
    started_at: string;
    ended_at: string | null;
    status: string;
    exit_code: number | null;
  }>(
    `
      select
        s.id, s.lane_id, s.title, s.tool_type, s.started_at, s.ended_at, s.status, s.exit_code
      from terminal_sessions s
      where s.lane_id in (${matching.map(() => "?").join(",")})
      order by s.started_at desc
      limit 30
    `,
    matching.map((l) => l.id)
  );

  if (featureSessions.length === 0) {
    lines.push("- No sessions recorded across feature lanes.");
  } else {
    lines.push("| When | Lane | Tool | Title | Status |");
    lines.push("|------|------|------|-------|--------|");
    const laneNameById = new Map(matching.map((l) => [l.id, l.name]));
    for (const sess of featureSessions) {
      const when = sess.started_at.length >= 16 ? sess.started_at.slice(0, 16) : sess.started_at;
      const laneName = laneNameById.get(sess.lane_id) ?? sess.lane_id;
      const tool = humanToolLabel(sess.tool_type);
      const title = (sess.title ?? "").replace(/\|/g, "\\|").slice(0, 60);
      const status = sess.status === "running" ? "RUNNING" : sess.exit_code === 0 ? "OK" : sess.exit_code != null ? `EXIT ${sess.exit_code}` : "ENDED";
      lines.push(`| ${when} | ${laneName} | ${tool} | ${title} | ${status} |`);
    }
  }
  lines.push("");

  // Combined Errors
  lines.push("## Combined Errors");
  const allErrors: string[] = [];
  for (const lane of matching) {
    const lanePackBody = readFileIfExists(deps.getLanePackPath(lane.id));
    const errSection = extractSectionByHeading(lanePackBody, "## Errors & Issues");
    if (errSection && errSection.trim() !== "No errors detected.") {
      for (const errLine of errSection.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const cleaned = errLine.startsWith("- ") ? errLine.slice(2) : errLine;
        if (cleaned.length) allErrors.push(`[${lane.name}] ${cleaned}`);
      }
    }
  }
  if (allErrors.length === 0) {
    lines.push("No errors detected across feature lanes.");
  } else {
    for (const err of allErrors.slice(0, 30)) {
      lines.push(`- ${err}`);
    }
  }
  lines.push("");

  // Per-Lane Details
  for (const lane of matching.sort((a, b) => a.stackDepth - b.stackDepth || a.name.localeCompare(b.name))) {
    const lanePackBody = readFileIfExists(deps.getLanePackPath(lane.id));
    const intent = extractSection(lanePackBody, ADE_INTENT_START, ADE_INTENT_END, "");

    const laneTest = db.get<{ status: string; suite_name: string | null; suite_key: string }>(
      `
        select r.status as status, s.name as suite_name, r.suite_key as suite_key
        from test_runs r
        left join test_suites s on s.project_id = r.project_id and s.id = r.suite_key
        where r.project_id = ? and r.lane_id = ?
        order by r.started_at desc limit 1
      `,
      [projectId, lane.id]
    );

    const laneFileCount = (() => {
      try {
        const lanePackContent = readFileIfExists(deps.getLanePackPath(lane.id));
        const keyFilesMatch = /## Key Files \((\d+) files touched\)/.exec(lanePackContent);
        if (keyFilesMatch) return Number(keyFilesMatch[1]);
      } catch { /* fall through */ }
      return 0;
    })();

    lines.push(`### Lane: ${lane.name}`);
    lines.push(`- Branch: \`${lane.branchRef}\` | Status: ${lane.status.dirty ? "dirty" : "clean"} | Ahead: ${lane.status.ahead} | Behind: ${lane.status.behind}`);
    if (intent.trim().length) {
      lines.push(`- Intent: ${intent.trim().slice(0, 200)}`);
    }
    lines.push(`- Files changed: ${laneFileCount}`);
    if (laneTest) {
      const testLabel = (laneTest.suite_name ?? laneTest.suite_key).trim();
      lines.push(`- Latest test: ${statusFromCode(laneTest.status as TestRunStatus)} (${testLabel})`);
    } else {
      lines.push("- Latest test: NOT RUN");
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Feature pack: deterministic aggregation across ${matching.length} lanes. Updated: ${args.deterministicUpdatedAt}*`);
  lines.push("");

  return { body: `${lines.join("\n")}\n`, laneIds: matching.map((lane) => lane.id) };
}
