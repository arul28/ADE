#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const projectRoot =
  args.find((arg) => arg.startsWith("--project="))?.slice("--project=".length)
  ?? process.env.ADE_PERF_PASS_DIR
  ?? join(homedir(), "Projects", "perf pass");
const dbPath = join(projectRoot, ".ade", "ade.db");
const missionId =
  args.find((arg) => arg.startsWith("--mission-id="))?.slice("--mission-id=".length)
  ?? "perf-steer-mission-20260520";
const runId =
  args.find((arg) => arg.startsWith("--run-id="))?.slice("--run-id=".length)
  ?? "perf-steer-run-20260520";

if (!existsSync(dbPath)) {
  console.error(`ADE DB not found: ${dbPath}`);
  process.exit(2);
}

const backupPath = `${dbPath}.backup-missions-steer-${new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+$/, "")
  .replace("T", "-")}`;
copyFileSync(dbPath, backupPath);

const db = new DatabaseSync(dbPath, { allowExtension: true });
const crsqliteExtension = (() => {
  const extensionName =
    process.platform === "win32" ? "crsqlite.dll" : process.platform === "darwin" ? "crsqlite.dylib" : "crsqlite.so";
  const platformArch =
    process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin"
        ? "darwin-x64"
        : process.platform === "win32"
          ? "win32-x64"
          : "linux-x64";
  const candidate = join(process.cwd(), "apps", "desktop", "vendor", "crsqlite", platformArch, extensionName);
  return existsSync(candidate) ? candidate : null;
})();

if (crsqliteExtension) {
  db.enableLoadExtension(true);
  db.loadExtension(crsqliteExtension);
  db.enableLoadExtension(false);
  db.prepare("select crsql_internal_sync_bit() as sync_bit").get();
}

const nowBase = Date.parse("2026-05-20T12:45:00.000Z");
const iso = (offsetMs = 0) => new Date(nowBase + offsetMs).toISOString();
const json = (value) => JSON.stringify(value);

const project = db.prepare("select id from projects order by last_opened_at desc limit 1").get();
if (!project?.id) throw new Error("No project row found.");
const lane = db
  .prepare("select id from lanes where project_id = ? order by created_at asc limit 1")
  .get(project.id);
const projectId = project.id;
const laneId = lane?.id ?? null;

const steps = [
  {
    key: "planning-baseline",
    title: "Planning baseline",
    detail: "Capture the initial broad launch-dashboard plan.",
    status: "succeeded",
    missionStatus: "succeeded",
    phaseKey: "planning",
    startedAt: iso(0),
    completedAt: iso(180_000),
    deps: [],
  },
  {
    key: "legacy-dashboard",
    title: "Superseded broad dashboard build",
    detail: "Original broad dashboard slice superseded after operator steering.",
    status: "superseded",
    missionStatus: "skipped",
    phaseKey: "implementation",
    startedAt: iso(240_000),
    completedAt: iso(420_000),
    deps: ["planning-baseline"],
  },
  {
    key: "schedule-risk-console",
    title: "Schedule-risk console replacement",
    detail: "Replacement slice created by the replan to focus on schedule risk evidence.",
    status: "ready",
    missionStatus: "pending",
    phaseKey: "implementation",
    startedAt: null,
    completedAt: null,
    deps: ["planning-baseline"],
  },
  {
    key: "operator-review-copy",
    title: "Operator review copy",
    detail: "Add concrete recovery language and scope-change notes.",
    status: "blocked",
    missionStatus: "blocked",
    phaseKey: "experience",
    startedAt: null,
    completedAt: null,
    deps: ["schedule-risk-console"],
  },
  {
    key: "focused-validation",
    title: "Focused validation",
    detail: "Validate the narrowed console and record risk evidence.",
    status: "pending",
    missionStatus: "pending",
    phaseKey: "validation",
    startedAt: null,
    completedAt: null,
    deps: ["schedule-risk-console", "operator-review-copy"],
  },
];

const missionStepRows = steps.map((step, index) => ({
  id: randomUUID(),
  step,
  index,
}));
const orchestratorStepRows = missionStepRows.map((row) => ({
  id: randomUUID(),
  missionStepId: row.id,
  step: row.step,
  index: row.index,
}));
const stepIdByKey = new Map(orchestratorStepRows.map((row) => [row.step.key, row.id]));
const attempts = orchestratorStepRows
  .filter((row) => row.step.status === "succeeded" || row.step.status === "superseded")
  .map((row, index) => ({
    id: randomUUID(),
    row,
    status: row.step.status === "succeeded" ? "succeeded" : "failed",
    attemptNumber: 1,
    createdAt: iso(index * 240_000),
    completedAt: row.step.completedAt ?? iso(index * 240_000 + 120_000),
  }));

const interventionId = "perf-steer-intervention-20260520";
const coordinatorThreadId = `mission:${missionId}`;
const workerThreadId = `worker:${missionId}:schedule-risk-console`;
const directive = "Prioritize the schedule-risk console, keep the dashboard replacement narrow, and resume after I approve this revised plan.";
const replanReason = "Operator narrowed the mission from broad dashboard polish to schedule-risk proof.";

function runStatement(sql, rows, map) {
  const stmt = db.prepare(sql);
  for (const row of rows) stmt.run(...map(row));
}

function seed() {
  const missionScopedTables = [
    "orchestrator_worker_digests",
    "orchestrator_worker_checkpoints",
    "orchestrator_artifacts",
    "orchestrator_chat_messages",
    "orchestrator_chat_threads",
    "orchestrator_runs",
    "mission_interventions",
    "mission_artifacts",
    "mission_events",
    "mission_steps",
  ];
  for (const table of ["orchestrator_runtime_events", "orchestrator_timeline_events", "orchestrator_attempts", "orchestrator_steps"]) {
    db.prepare(`delete from ${table} where run_id = ?`).run(runId);
  }
  for (const table of missionScopedTables) {
    db.prepare(`delete from ${table} where mission_id = ?`).run(missionId);
  }
  db.prepare("delete from missions where id = ?").run(missionId);
  db.prepare("delete from orchestrator_runs where id = ?").run(runId);

  db.prepare(
    `insert into missions(
      id, project_id, lane_id, mission_lane_id, result_lane_id, title, prompt, status, priority,
      execution_mode, target_machine_id, queue_claim_token, queue_claimed_at, outcome_summary,
      last_error, metadata_json, created_at, updated_at, started_at, completed_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    missionId,
    projectId,
    laneId,
    laneId,
    null,
    "Operator steering + replan fixture",
    "Synthetic paused mission for proving the Missions steer/replan/intervention UI without launching agents.",
    "intervention_required",
    "high",
    "local",
    null,
    null,
    null,
    "Mission paused after operator steering revised the plan; one intervention is waiting for approval.",
    null,
    json({
      source: "synthetic_steer_fixture",
      version: 1,
      steeringDirectives: [{
        missionId,
        directive,
        priority: "instruction",
        targetStepKey: "schedule-risk-console",
        appliedAt: iso(560_000),
      }],
      plannerPlan: {
        missionSummary: {
          title: "Operator steering + replan fixture",
          objective: "Show a paused mission with a revised plan, active steering, and an open intervention.",
          complexity: "medium",
          strategy: "sequential",
          parallelismCap: 1,
        },
        assumptions: ["Synthetic fixture only; no workers are launched."],
        risks: ["Resume is intentionally left to the operator."],
      },
    }),
    iso(-60_000),
    iso(620_000),
    iso(0),
    null,
    null,
  );

  db.prepare(
    `insert into orchestrator_runs(
      id, project_id, mission_id, status, context_profile, scheduler_state, runtime_cursor_json,
      last_error, metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    projectId,
    missionId,
    "paused",
    "orchestrator_deterministic_v1",
    "paused",
    json({ syntheticFixture: true, waitingOn: interventionId }),
    "Waiting for operator approval after replan.",
    json({
      missionGoal: "Prove pause, steering, and replan UI behavior.",
      autopilot: { enabled: false, executorKind: "codex", ownerId: "synthetic-steer", parallelismCap: 1 },
      aiFirst: true,
      pendingReplanApproval: interventionId,
      runNarrative: [
        { stepKey: "planning-baseline", summary: "Initial plan completed.", at: iso(180_000) },
        { stepKey: "schedule-risk-console", summary: "Replacement step is ready after operator steering.", at: iso(560_000) },
      ],
    }),
    iso(0),
    iso(620_000),
    iso(0),
    null,
  );

  runStatement(
    `insert into mission_steps(
      id, mission_id, project_id, step_index, title, detail, kind, lane_id, status,
      metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    missionStepRows,
    (row) => [
      row.id,
      missionId,
      projectId,
      row.index,
      row.step.title,
      row.step.detail,
      row.step.phaseKey === "planning" ? "planning" : row.step.phaseKey === "validation" ? "test" : "code",
      laneId,
      row.step.missionStatus,
      json({ syntheticFixture: true, phaseKey: row.step.phaseKey, stepKey: row.step.key }),
      iso(row.index * 120_000),
      row.step.completedAt ?? iso(620_000),
      row.step.startedAt,
      row.step.completedAt,
    ],
  );

  runStatement(
    `insert into orchestrator_steps(
      id, run_id, project_id, mission_step_id, step_key, step_index, title, lane_id, status,
      join_policy, quorum_count, dependency_step_ids_json, retry_limit, retry_count, last_attempt_id,
      policy_json, metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    orchestratorStepRows,
    (row) => {
      const attempt = attempts.find((entry) => entry.row.id === row.id) ?? null;
      return [
        row.id,
        runId,
        projectId,
        row.missionStepId,
        row.step.key,
        row.index,
        row.step.title,
        laneId,
        row.step.status,
        "all_success",
        null,
        json(row.step.deps.map((key) => stepIdByKey.get(key)).filter(Boolean)),
        1,
        row.step.status === "superseded" ? 1 : 0,
        attempt?.id ?? null,
        json({ claimScopes: [`${row.step.phaseKey}/**`] }),
        json({
          syntheticFixture: true,
          phaseKey: row.step.phaseKey,
          stepType: row.step.phaseKey,
          replacementFor: row.step.key === "schedule-risk-console" ? "legacy-dashboard" : null,
          steeringDirectives: row.step.status === "ready" || row.step.status === "blocked"
            ? [{
                directive,
                priority: "instruction",
                targetStepKey: "schedule-risk-console",
                appliedAt: iso(560_000),
              }]
            : [],
        }),
        iso(row.index * 120_000),
        row.step.completedAt ?? iso(620_000),
        row.step.startedAt,
        row.step.completedAt,
      ];
    },
  );

  runStatement(
    `insert into orchestrator_attempts(
      id, run_id, step_id, project_id, attempt_number, status, executor_kind, executor_session_id,
      tracked_session_enforced, context_profile, context_snapshot_id, error_class, error_message,
      retry_backoff_ms, result_envelope_json, metadata_json, created_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    attempts,
    (attempt) => [
      attempt.id,
      runId,
      attempt.row.id,
      projectId,
      attempt.attemptNumber,
      attempt.status,
      attempt.row.step.status === "superseded" ? "codex" : "manual",
      `synthetic-${attempt.row.step.key}`,
      0,
      "orchestrator_deterministic_v1",
      null,
      attempt.status === "failed" ? "operator_replan" : "none",
      attempt.status === "failed" ? "Superseded by operator scope change." : null,
      0,
      json({
        schema: "ade.orchestratorAttempt.v1",
        success: attempt.status === "succeeded",
        summary: attempt.status === "succeeded" ? "Initial planning completed." : "Superseded by revised plan.",
        warnings: [],
      }),
      json({ syntheticFixture: true }),
      attempt.createdAt,
      attempt.createdAt,
      attempt.completedAt,
    ],
  );

  const timelineStmt = db.prepare(
    `insert into orchestrator_timeline_events(
      id, project_id, run_id, step_id, attempt_id, claim_id, event_type, reason, detail_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const legacyStep = orchestratorStepRows.find((row) => row.step.key === "legacy-dashboard");
  const replacementStep = orchestratorStepRows.find((row) => row.step.key === "schedule-risk-console");
  const timelineEvents = [
    ["run_created", "Mission execution started", null, null, { syntheticFixture: true }, iso(0)],
    ["step_status_changed", "succeeded", stepIdByKey.get("planning-baseline") ?? null, attempts[0]?.id ?? null, { stepKey: "planning-baseline" }, iso(180_000)],
    ["coordinator_steering", directive, replacementStep?.id ?? null, null, { directive, priority: "instruction", targetStepKey: "schedule-risk-console", projectedStepCount: 2 }, iso(560_000)],
    ["plan_revised", "operator_scope_change", replacementStep?.id ?? null, null, { reason: replanReason, replacedStepKeys: ["legacy-dashboard"], newStepKeys: ["schedule-risk-console"], dependencyPatchesApplied: 2 }, iso(570_000)],
    ["intervention_opened", "replan_approval_required", replacementStep?.id ?? null, null, { interventionId, interventionType: "manual_input" }, iso(590_000)],
    ["run_status_changed", "paused", replacementStep?.id ?? null, null, { reason: "waiting_for_operator_replan_approval" }, iso(600_000)],
  ];
  for (const [eventType, reason, stepId, attemptId, detail, createdAt] of timelineEvents) {
    timelineStmt.run(randomUUID(), projectId, runId, stepId, attemptId, null, eventType, reason, json(detail), createdAt);
  }

  const runtimeStmt = db.prepare(
    `insert into orchestrator_runtime_events(
      id, project_id, run_id, step_id, attempt_id, session_id, event_type, event_key,
      occurred_at, payload_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const runtimeEvents = [
    ["coordinator_steering", "steer:operator-scope-change", replacementStep?.id ?? null, null, { directive, priority: "instruction", targetStepKey: "schedule-risk-console", projectedStepCount: 2 }, iso(560_000)],
    ["plan_revised", "plan:operator-scope-change", replacementStep?.id ?? null, null, { reason: replanReason, replacedStepKeys: ["legacy-dashboard"], newStepKeys: ["schedule-risk-console"], dependencyPatchesApplied: 2 }, iso(570_000)],
    ["intervention_opened", `intervention_opened:${interventionId}`, replacementStep?.id ?? null, null, { interventionId, reasonCode: "scope_change_replan" }, iso(590_000)],
  ];
  for (const [eventType, eventKey, stepId, attemptId, payload, occurredAt] of runtimeEvents) {
    runtimeStmt.run(randomUUID(), projectId, runId, stepId, attemptId, null, eventType, eventKey, occurredAt, json(payload), occurredAt);
  }

  const threadStmt = db.prepare(
    `insert into orchestrator_chat_threads(
      id, project_id, mission_id, thread_type, title, run_id, step_id, step_key, attempt_id,
      session_id, lane_id, status, unread_count, metadata_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  threadStmt.run(coordinatorThreadId, projectId, missionId, "coordinator", "Orchestrator", runId, null, null, null, `synthetic-coordinator-${runId}`, laneId, "active", 0, json({ syntheticFixture: true }), iso(0), iso(620_000));
  threadStmt.run(workerThreadId, projectId, missionId, "worker", "Schedule-risk console replacement", runId, replacementStep?.id ?? null, "schedule-risk-console", null, null, laneId, "active", 0, json({ syntheticFixture: true }), iso(560_000), iso(620_000));

  const messageStmt = db.prepare(
    `insert into orchestrator_chat_messages(
      id, project_id, mission_id, thread_id, role, content, timestamp, step_key, target_json,
      visibility, delivery_state, source_session_id, attempt_id, lane_id, run_id, metadata_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const messages = [
    ["orchestrator", "Initial plan completed. The broad dashboard slice is ready to start.", iso(220_000), null],
    ["user", directive, iso(560_000), { coordinatorChatMode: "instruction" }],
    ["orchestrator", "Directive received. I revised the plan and paused for approval before resuming workers.", iso(580_000), null],
    ["orchestrator", "Open intervention: approve the revised schedule-risk console plan or provide new steering.", iso(600_000), { interventionId }],
  ];
  for (const [role, content, timestamp, metadata] of messages) {
    messageStmt.run(
      randomUUID(),
      projectId,
      missionId,
      coordinatorThreadId,
      role,
      content,
      timestamp,
      null,
      json({ kind: "coordinator", runId }),
      "full",
      "delivered",
      role === "user" ? null : `synthetic-coordinator-${runId}`,
      null,
      laneId,
      runId,
      json({ syntheticFixture: true, ...(metadata ?? {}) }),
      timestamp,
    );
  }

  db.prepare(
    `insert into mission_events(
      id, mission_id, project_id, event_type, actor, summary, payload_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    missionId,
    projectId,
    "mission_intervention_added",
    "orchestrator",
    "Mission paused for operator replan approval.",
    json({ interventionId, reasonCode: "scope_change_replan" }),
    iso(590_000),
  );

  db.prepare(
    `insert into mission_interventions(
      id, mission_id, project_id, intervention_type, status, resolution_kind, title, body,
      requested_action, resolution_note, lane_id, metadata_json, created_at, updated_at, resolved_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    interventionId,
    missionId,
    projectId,
    "manual_input",
    "open",
    null,
    "Approve revised plan after steering",
    "The operator changed scope from broad dashboard polish to a focused schedule-risk console. Review the revised plan before resuming.",
    "Approve the revised plan, or type a replacement steering directive before resuming.",
    null,
    laneId,
    json({
      syntheticFixture: true,
      runId,
      stepId: replacementStep?.id ?? null,
      stepKey: "schedule-risk-console",
      reasonCode: "scope_change_replan",
      canProceedWithoutAnswer: false,
      threadId: coordinatorThreadId,
    }),
    iso(590_000),
    iso(590_000),
    null,
  );

  if (!legacyStep || !replacementStep) throw new Error("Fixture steps were not initialized.");
}

try {
  mkdirSync(dirname(dbPath), { recursive: true });
  db.exec("begin immediate");
  seed();
  db.exec("commit");
} catch (error) {
  try {
    db.exec("rollback");
  } catch {
    // Ignore rollback failure.
  }
  db.close();
  throw error;
}

const counts = {};
for (const table of [
  "mission_steps",
  "orchestrator_runs",
  "orchestrator_chat_threads",
  "orchestrator_chat_messages",
  "mission_interventions",
  "mission_events",
]) {
  counts[table] = db.prepare(`select count(*) as count from ${table} where mission_id = ?`).get(missionId).count;
}
counts.missions = db.prepare("select count(*) as count from missions where id = ?").get(missionId).count;
for (const table of [
  "orchestrator_steps",
  "orchestrator_attempts",
  "orchestrator_timeline_events",
  "orchestrator_runtime_events",
]) {
  counts[table] = db.prepare(`select count(*) as count from ${table} where run_id = ?`).get(runId).count;
}
db.close();

console.log(JSON.stringify({
  projectRoot,
  dbPath,
  backupPath,
  missionId,
  runId,
  projectId,
  laneId,
  counts,
}, null, 2));
