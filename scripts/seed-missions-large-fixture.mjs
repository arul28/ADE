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
  ?? "perf-large-mission-20260520";
const runId =
  args.find((arg) => arg.startsWith("--run-id="))?.slice("--run-id=".length)
  ?? "perf-large-run-20260520";
const rawStepCountTarget = args.find((arg) => arg.startsWith("--steps="))?.slice("--steps=".length) ?? "144";
const stepCountTarget = Number(rawStepCountTarget);

if (!Number.isInteger(stepCountTarget) || stepCountTarget <= 0) {
  console.error(`Invalid --steps value: ${rawStepCountTarget}`);
  process.exit(2);
}

if (!existsSync(dbPath)) {
  console.error(`ADE DB not found: ${dbPath}`);
  process.exit(2);
}

const backupPath = `${dbPath}.backup-missions-large-${new Date()
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

const nowBase = Date.parse("2026-05-20T12:10:00.000Z");
const iso = (offsetMs = 0) => new Date(nowBase + offsetMs).toISOString();
const json = (value) => JSON.stringify(value);

const project = db.prepare("select id from projects order by last_opened_at desc limit 1").get();
if (!project?.id) throw new Error("No project row found.");
const lane = db
  .prepare("select id from lanes where project_id = ? order by created_at asc limit 1")
  .get(project.id);
const projectId = project.id;
const laneId = lane?.id ?? null;

const phaseSpecs = [
  ["planning", "Planning", "Clarify scope, ask blocking questions, and split the work."],
  ["product_research", "Product research", "Map personas, critical flows, and launch risks."],
  ["architecture", "Architecture", "Design app structure, data contracts, and ownership boundaries."],
  ["data_layer", "Data layer", "Build mocked APIs, fixtures, and derived metrics."],
  ["experience", "Experience", "Build the primary product surfaces and states."],
  ["integration", "Integration", "Consolidate worker output into one result lane."],
  ["testing", "Testing", "Run logic, route, and build validation."],
  ["validation", "Validation", "Audit against user goals and risk register."],
  ["closeout", "Closeout", "Collect final evidence and summarize the result."],
];

function buildPhases() {
  return phaseSpecs.map(([phaseKey, name, instructions], position) => ({
    id: `perf:${phaseKey}`,
    phaseKey,
    name,
    description: instructions,
    instructions,
    model: { provider: "codex", modelId: "openai/gpt-5.5", thinkingLevel: "low" },
    budget: {},
    orderingConstraints: {
      mustBeFirst: position === 0,
      mustBeLast: position === phaseSpecs.length - 1,
      mustFollow: position === 0 ? [] : [phaseSpecs[position - 1][0]],
      mustPrecede: [],
      canLoop: false,
      loopTarget: null,
    },
    askQuestions: {
      enabled: phaseKey === "planning",
      requiredBeforeExit: phaseKey === "planning",
      maxQuestions: 3,
    },
    validationGate:
      phaseKey === "closeout"
        ? {
            tier: "self",
            required: true,
            criteria: "Final outcome, changed files, validation, and risk notes are present.",
            evidenceRequirements: ["final_outcome_summary", "changed_files_summary", "risk_notes"],
          }
        : phaseKey === "testing" || phaseKey === "validation" || phaseKey === "integration"
          ? {
              tier: "dedicated",
              required: true,
              criteria: `${name} output has been independently checked.`,
              evidenceRequirements: ["changed_files_summary", "risk_notes"],
            }
          : { tier: "none", required: false },
    requiresApproval: phaseKey === "planning" || phaseKey === "validation",
    isBuiltIn: ["planning", "integration", "testing", "validation", "closeout"].includes(phaseKey),
    isCustom: !["planning", "integration", "testing", "validation", "closeout"].includes(phaseKey),
    position,
    createdAt: iso(-60_000),
    updatedAt: iso(-60_000),
  }));
}

function buildRows(phases) {
  const stepRows = [];
  const attemptRows = [];
  const missionStepRows = [];
  const stepIdsByPhase = new Map();
  const basePerPhase = Math.max(8, Math.floor(stepCountTarget / phases.length));
  let globalIndex = 0;

  for (const phase of phases) {
    const phaseSteps = [];
    const count =
      phase.phaseKey === "planning"
        ? Math.max(10, Math.floor(basePerPhase * 0.75))
        : phase.phaseKey === "closeout"
          ? Math.max(8, Math.floor(basePerPhase * 0.55))
          : basePerPhase;
    for (let i = 0; i < count; i += 1) {
      const missionStepId = randomUUID();
      const stepId = randomUUID();
      const attemptId = randomUUID();
      const stepKey = `${phase.phaseKey}_${String(i + 1).padStart(2, "0")}`;
      const startAt = iso(globalIndex * 60_000);
      const doneAt = iso(globalIndex * 60_000 + 45_000);
      const dependencies =
        i === 0
          ? phases[phase.position - 1]
            ? (stepIdsByPhase.get(phases[phase.position - 1].phaseKey) ?? []).slice(-3)
            : []
          : phaseSteps.slice(Math.max(0, i - 3), i);

      missionStepRows.push({
        id: missionStepId,
        mission_id: missionId,
        project_id: projectId,
        step_index: globalIndex,
        title: `${phase.name}: work package ${i + 1}`,
        detail: `Synthetic ${phase.name} work package ${i + 1}; created to stress Missions plan, timeline, chat, and artifact views.`,
        kind: phase.phaseKey === "planning" ? "planning" : phase.phaseKey === "testing" ? "test" : "code",
        lane_id: laneId,
        status: "succeeded",
        metadata_json: json({
          phaseKey: phase.phaseKey,
          phaseName: phase.name,
          phasePosition: phase.position,
          syntheticFixture: true,
        }),
        created_at: startAt,
        updated_at: doneAt,
        started_at: startAt,
        completed_at: doneAt,
      });
      stepRows.push({
        id: stepId,
        run_id: runId,
        project_id: projectId,
        mission_step_id: missionStepId,
        step_key: stepKey,
        step_index: globalIndex,
        title: `${phase.name}: worker ${i + 1}`,
        lane_id: laneId,
        status: "succeeded",
        join_policy: "all_success",
        quorum_count: null,
        dependency_step_ids_json: json(dependencies),
        retry_limit: 1,
        retry_count: 0,
        last_attempt_id: attemptId,
        policy_json: json({ claimScopes: [`${phase.phaseKey}/**`] }),
        metadata_json: json({
          phaseKey: phase.phaseKey,
          phaseName: phase.name,
          phasePosition: phase.position,
          stepType: phase.phaseKey === "planning" ? "planning" : phase.phaseKey,
          phaseModel: phase.model,
          phaseInstructions: phase.instructions,
          phaseValidation: phase.validationGate,
          validationState: "pass",
          lastValidationReport: {
            verdict: "pass",
            summary: `${phase.name} worker ${i + 1} passed synthetic validation with no unresolved risk findings.`,
            findings: [],
          },
          lastResultReport: {
            summary: `${phase.name} worker ${i + 1} completed a bounded slice of the launch-control platform.`,
          },
          syntheticFixture: true,
        }),
        created_at: startAt,
        updated_at: doneAt,
        started_at: startAt,
        completed_at: doneAt,
      });
      attemptRows.push({
        id: attemptId,
        run_id: runId,
        step_id: stepId,
        project_id: projectId,
        attempt_number: 1,
        status: "succeeded",
        executor_kind: i % 5 === 0 ? "manual" : "codex",
        executor_session_id: `synthetic-session-${stepKey}`,
        tracked_session_enforced: 0,
        context_profile: "orchestrator_deterministic_v1",
        context_snapshot_id: null,
        error_class: "none",
        error_message: null,
        retry_backoff_ms: 0,
        result_envelope_json: json({
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: `${phase.name} worker ${i + 1} completed synthetic output.`,
          outputs: { filesChanged: [`src/${phase.phaseKey}/package-${i + 1}.ts`] },
          warnings: [],
          sessionId: `synthetic-session-${stepKey}`,
          trackedSession: false,
        }),
        metadata_json: json({
          syntheticFixture: true,
          model: "openai/gpt-5.5",
          workerCompletedAt: doneAt,
        }),
        created_at: startAt,
        started_at: startAt,
        completed_at: doneAt,
      });
      phaseSteps.push(stepId);
      globalIndex += 1;
    }
    stepIdsByPhase.set(phase.phaseKey, phaseSteps);
  }

  return { stepRows, attemptRows, missionStepRows };
}

function runStatement(sql, rows, map) {
  const stmt = db.prepare(sql);
  for (const row of rows) stmt.run(...map(row));
}

const phases = buildPhases();
const { stepRows, attemptRows, missionStepRows } = buildRows(phases);
const phaseRuntime = {
  currentPhaseKey: "closeout",
  currentPhaseName: "Closeout",
  currentPhaseModel: phases.at(-1).model,
  currentPhaseInstructions: phases.at(-1).instructions,
  currentPhaseValidation: phases.at(-1).validationGate,
  currentPhaseBudget: {},
  transitionedAt: iso(7_200_000),
  transitions: phases
    .slice()
    .reverse()
    .map((phase) => {
      const previous = phases[phase.position - 1] ?? null;
      return {
        fromPhaseKey: previous?.phaseKey ?? null,
        fromPhaseName: previous?.name ?? null,
        toPhaseKey: phase.phaseKey,
        toPhaseName: phase.name,
        at: iso(phase.position * 900_000),
        reason: phase.position === 0 ? "run_initialized" : "synthetic_large_fixture_phase_complete",
      };
    }),
  phaseBudgets: Object.fromEntries(
    phases.map((phase) => [
      phase.phaseKey,
      {
        enteredAt: iso(phase.position * 900_000),
        usedTokens: 12_000 + phase.position * 1500,
        usedCostUsd: 0.01 * phase.position,
      },
    ]),
  ),
};
const phaseConfiguration = {
  profileId: "synthetic:factory-scale",
  phaseKeys: phases.map((phase) => phase.phaseKey),
  phaseCount: phases.length,
  phases,
};
const missionMetadata = {
  source: "synthetic_perf_fixture",
  version: 1,
  fixture: {
    kind: "large_missions_read_side",
    generatedAt: iso(),
    stepCount: stepRows.length,
    timelineEventCount: 2200,
    chatMessageCount: 720,
  },
  launch: {
    autostart: false,
    runMode: "autopilot",
    autopilotExecutor: "codex",
    modelConfig: {
      orchestratorModel: { provider: "codex", modelId: "openai/gpt-5.5", thinkingLevel: "low" },
      smartBudget: { enabled: true, fiveHourThresholdUsd: 8, weeklyThresholdUsd: 40 },
    },
  },
  phaseConfiguration,
  plannerPlan: {
    missionSummary: {
      title: "Synthetic Atlas launch-control platform",
      objective: "Build and validate a multi-surface launch operations app with evidence workflows.",
      complexity: "high",
      strategy: "phased_parallel",
      parallelismCap: 5,
    },
    assumptions: [
      "Synthetic fixture only; no agents were launched.",
      "Workers represent plausible phase ownership for UI/perf testing.",
    ],
    risks: [
      "Large timelines can stress rendering.",
      "Worker chat history can stress transcript hydration.",
    ],
  },
};
const runMetadata = {
  missionGoal: "Synthetic large-scope mission fixture for Missions UI performance and functionality testing.",
  missionPrompt:
    "Build a launch-control platform with planning questions, custom phases, workers, validation, artifacts, and closeout evidence.",
  runMode: "autopilot",
  maxParallelWorkers: 5,
  planner: {
    source: "synthetic_perf_fixture",
    stepCount: stepRows.length,
    strategy: "phased_parallel",
    parallelismCap: 5,
  },
  autopilot: { enabled: false, executorKind: "codex", ownerId: "synthetic-fixture", parallelismCap: 5 },
  aiFirst: true,
  phaseConfiguration,
  phaseOverride: phases,
  phaseRuntime,
  runNarrative: stepRows
    .filter((_, index) => index % 9 === 0)
    .map((step) => ({
      stepKey: step.step_key,
      summary: `succeeded: ${step.title} completed.`,
      at: step.completed_at,
    })),
  completionDiagnostics: phases.map((phase) => ({
    phase: phase.phaseKey,
    code: "phase_succeeded",
    message: `Phase "${phase.name}" completed in synthetic fixture.`,
    blocking: false,
  })),
  completionRiskFactors: [],
  completionValidation: { canComplete: true, blockers: [], validatedAt: iso(8_000_000) },
  finalizedAt: iso(8_100_000),
};

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
    laneId,
    "Synthetic Atlas launch-control platform - large Missions UI fixture",
    "Synthetic large-scope mission: plan, build, test, validate, and close out a launch-control platform with many workers and artifacts. This row was inserted as a read-side UI/perf fixture and did not launch agents.",
    "completed",
    "normal",
    "local",
    null,
    null,
    null,
    `Synthetic fixture completed: ${stepRows.length} work packages, 24 worker channels, 720 chat messages, and 2200 timeline events.`,
    null,
    json(missionMetadata),
    iso(-120_000),
    iso(8_100_000),
    iso(0),
    iso(8_100_000),
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
    "succeeded",
    "orchestrator_deterministic_v1",
    "completed",
    json({ syntheticFixture: true, frontier: { terminal: stepRows.length } }),
    null,
    json(runMetadata),
    iso(0),
    iso(8_100_000),
    iso(0),
    iso(8_100_000),
  );

  runStatement(
    `insert into mission_steps(
      id, mission_id, project_id, step_index, title, detail, kind, lane_id, status,
      metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    missionStepRows,
    (row) => [
      row.id,
      row.mission_id,
      row.project_id,
      row.step_index,
      row.title,
      row.detail,
      row.kind,
      row.lane_id,
      row.status,
      row.metadata_json,
      row.created_at,
      row.updated_at,
      row.started_at,
      row.completed_at,
    ],
  );
  runStatement(
    `insert into orchestrator_steps(
      id, run_id, project_id, mission_step_id, step_key, step_index, title, lane_id, status,
      join_policy, quorum_count, dependency_step_ids_json, retry_limit, retry_count, last_attempt_id,
      policy_json, metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    stepRows,
    (row) => [
      row.id,
      row.run_id,
      row.project_id,
      row.mission_step_id,
      row.step_key,
      row.step_index,
      row.title,
      row.lane_id,
      row.status,
      row.join_policy,
      row.quorum_count,
      row.dependency_step_ids_json,
      row.retry_limit,
      row.retry_count,
      row.last_attempt_id,
      row.policy_json,
      row.metadata_json,
      row.created_at,
      row.updated_at,
      row.started_at,
      row.completed_at,
    ],
  );
  runStatement(
    `insert into orchestrator_attempts(
      id, run_id, step_id, project_id, attempt_number, status, executor_kind, executor_session_id,
      tracked_session_enforced, context_profile, context_snapshot_id, error_class, error_message,
      retry_backoff_ms, result_envelope_json, metadata_json, created_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    attemptRows,
    (row) => [
      row.id,
      row.run_id,
      row.step_id,
      row.project_id,
      row.attempt_number,
      row.status,
      row.executor_kind,
      row.executor_session_id,
      row.tracked_session_enforced,
      row.context_profile,
      row.context_snapshot_id,
      row.error_class,
      row.error_message,
      row.retry_backoff_ms,
      row.result_envelope_json,
      row.metadata_json,
      row.created_at,
      row.started_at,
      row.completed_at,
    ],
  );

  const eventStmt = db.prepare(
    `insert into orchestrator_timeline_events(
      id, project_id, run_id, step_id, attempt_id, claim_id, event_type, reason, detail_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 2200; i += 1) {
    const step = stepRows[i % stepRows.length];
    const attempt = attemptRows[i % attemptRows.length];
    const type =
      i % 11 === 0
        ? "phase_transition"
        : i % 7 === 0
          ? "attempt_completed"
          : i % 5 === 0
            ? "worker_progress"
            : "scheduler_tick";
    eventStmt.run(
      randomUUID(),
      projectId,
      runId,
      step.id,
      attempt.id,
      null,
      type,
      `synthetic_${type}`,
      json({ syntheticFixture: true, index: i, stepKey: step.step_key, summary: `${type} event ${i}` }),
      iso(i * 3500),
    );
  }

  const runtimeStmt = db.prepare(
    `insert into orchestrator_runtime_events(
      id, project_id, run_id, step_id, attempt_id, session_id, event_type, event_key,
      occurred_at, payload_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 300; i += 1) {
    const step = stepRows[i % stepRows.length];
    const attempt = attemptRows[i % attemptRows.length];
    runtimeStmt.run(
      randomUUID(),
      projectId,
      runId,
      step.id,
      attempt.id,
      attempt.executor_session_id,
      i % 13 === 0 ? "question" : i % 3 === 0 ? "progress" : "done",
      `synthetic:${i}`,
      iso(i * 12_000),
      json({ syntheticFixture: true, index: i, preview: `Runtime event ${i} for ${step.step_key}` }),
      iso(i * 12_000),
    );
  }

  const coordinatorThreadId = `mission:${missionId}`;
  const workerThreadIds = stepRows
    .filter((_, index) => index % 6 === 0)
    .map((step) => ({ threadId: `worker:${step.step_key}`, step }));
  const threadStmt = db.prepare(
    `insert into orchestrator_chat_threads(
      id, project_id, mission_id, thread_type, title, run_id, step_id, step_key, attempt_id,
      session_id, lane_id, status, unread_count, metadata_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  threadStmt.run(
    coordinatorThreadId,
    projectId,
    missionId,
    "coordinator",
    "Orchestrator",
    runId,
    null,
    null,
    null,
    `synthetic-coordinator-${runId}`,
    laneId,
    "closed",
    0,
    json({ syntheticFixture: true }),
    iso(0),
    iso(8_100_000),
  );
  for (const { threadId, step } of workerThreadIds) {
    const attempt = attemptRows.find((entry) => entry.step_id === step.id);
    threadStmt.run(
      threadId,
      projectId,
      missionId,
      "worker",
      step.title,
      runId,
      step.id,
      step.step_key,
      attempt?.id ?? null,
      attempt?.executor_session_id ?? null,
      laneId,
      "closed",
      0,
      json({ syntheticFixture: true, phaseKey: JSON.parse(step.metadata_json).phaseKey }),
      step.created_at,
      step.completed_at,
    );
  }

  const msgStmt = db.prepare(
    `insert into orchestrator_chat_messages(
      id, project_id, mission_id, thread_id, role, content, timestamp, step_key, target_json,
      visibility, delivery_state, source_session_id, attempt_id, lane_id, run_id, metadata_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const allThreads = [{ threadId: coordinatorThreadId, step: null }, ...workerThreadIds];
  for (let i = 0; i < 720; i += 1) {
    const pair = allThreads[i % allThreads.length];
    const step = pair.step;
    const attempt = step ? attemptRows.find((entry) => entry.step_id === step.id) : null;
    const role = !step ? (i % 4 === 0 ? "user" : "orchestrator") : i % 5 === 0 ? "orchestrator" : "worker";
    msgStmt.run(
      randomUUID(),
      projectId,
      missionId,
      pair.threadId,
      role,
      `Synthetic ${role} message ${i}: ${step ? step.title : "mission coordination"} discussed dependencies, evidence, validation status, and next actions.`,
      iso(i * 10_000),
      step?.step_key ?? null,
      json({
        kind: step ? "worker" : "coordinator",
        runId,
        stepId: step?.id ?? null,
        stepKey: step?.step_key ?? null,
        attemptId: attempt?.id ?? null,
      }),
      "full",
      "delivered",
      attempt?.executor_session_id ?? `synthetic-coordinator-${runId}`,
      attempt?.id ?? null,
      laneId,
      runId,
      json({ syntheticFixture: true }),
      iso(i * 10_000),
    );
  }

  const missionEventStmt = db.prepare(
    `insert into mission_events(
      id, mission_id, project_id, event_type, actor, summary, payload_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 180; i += 1) {
    missionEventStmt.run(
      randomUUID(),
      missionId,
      projectId,
      i % 6 === 0 ? "phase_completed" : "worker_update",
      i % 2 === 0 ? "orchestrator" : "worker",
      `Synthetic mission event ${i} for large fixture.`,
      json({ syntheticFixture: true, index: i }),
      iso(i * 45_000),
    );
  }

  const artifactStmt = db.prepare(
    `insert into mission_artifacts(
      id, mission_id, project_id, artifact_type, title, description, uri, lane_id,
      metadata_json, created_at, updated_at, created_by
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const orchArtifactStmt = db.prepare(
    `insert into orchestrator_artifacts(
      id, project_id, mission_id, run_id, step_id, attempt_id, artifact_key, kind,
      value, metadata_json, declared, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const checkpointStmt = db.prepare(
    `insert into orchestrator_worker_checkpoints(
      id, project_id, mission_id, run_id, step_id, attempt_id, step_key, content,
      file_path, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const digestStmt = db.prepare(
    `insert into orchestrator_worker_digests(
      id, project_id, mission_id, run_id, step_id, step_key, attempt_id, lane_id,
      session_id, status, summary, files_changed_json, tests_run_json, warnings_json,
      tokens_json, cost_usd, suggested_next_actions_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 90; i += 1) {
    const step = stepRows[(i * 3) % stepRows.length];
    const attempt = attemptRows.find((entry) => entry.step_id === step.id);
    const phaseKey = JSON.parse(step.metadata_json).phaseKey;
    artifactStmt.run(
      randomUUID(),
      missionId,
      projectId,
      i % 3 === 0 ? "test_result" : i % 3 === 1 ? "summary" : "proof",
      `Synthetic artifact ${i}: ${step.title}`,
      "Read-side fixture artifact for Missions UI grouping and preview stress.",
      `.ade/synthetic-large/artifact-${i}.md`,
      laneId,
      json({ syntheticFixture: true, stepKey: step.step_key, phaseKey }),
      iso(i * 80_000),
      iso(i * 80_000),
      step.step_key,
    );
    orchArtifactStmt.run(
      randomUUID(),
      projectId,
      missionId,
      runId,
      step.id,
      attempt.id,
      `artifact-${i}`,
      i % 2 === 0 ? "summary" : "test_result",
      `Synthetic artifact value ${i} for ${step.title}.`,
      json({ syntheticFixture: true }),
      1,
      iso(i * 80_000),
    );
    checkpointStmt.run(
      randomUUID(),
      projectId,
      missionId,
      runId,
      step.id,
      attempt.id,
      step.step_key,
      `# Checkpoint ${i}\n\n${step.title} reported progress, evidence, risks, and next action handoff.`,
      join(projectRoot, ".ade", "checkpoints", `synthetic-${i}.md`),
      iso(i * 80_000),
      iso(i * 80_000),
    );
    digestStmt.run(
      randomUUID(),
      projectId,
      missionId,
      runId,
      step.id,
      step.step_key,
      attempt.id,
      laneId,
      attempt.executor_session_id,
      "succeeded",
      `${step.title} completed synthetic slice ${i}; validation passed and no unresolved risks remain.`,
      json([`src/${step.step_key}.ts`, `tests/${step.step_key}.test.ts`]),
      json(["npm test -- --run synthetic", "npm run build"]),
      json([]),
      json({ input: 1000 + i, output: 500 + i }),
      0.002 * i,
      json(["Review evidence grouping", "Continue to closeout"]),
      iso(i * 80_000),
    );
  }

  const interventionStmt = db.prepare(
    `insert into mission_interventions(
      id, mission_id, project_id, intervention_type, status, resolution_kind, title, body,
      requested_action, resolution_note, lane_id, metadata_json, created_at, updated_at, resolved_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 6; i += 1) {
    interventionStmt.run(
      randomUUID(),
      missionId,
      projectId,
      i % 2 === 0 ? "manual_input" : "phase_approval",
      "resolved",
      "answer_provided",
      `Synthetic resolved intervention ${i}`,
      `Blocking question or approval ${i} was answered in this fixture.`,
      "Review and approve.",
      "Synthetic answer recorded.",
      laneId,
      json({
        syntheticFixture: true,
        runId,
        phaseKey: phases[i % phases.length].phaseKey,
        targetPhaseKey: phases[Math.min(phases.length - 1, i + 1)].phaseKey,
      }),
      iso(i * 600_000),
      iso(i * 600_000 + 60_000),
      iso(i * 600_000 + 60_000),
    );
  }
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
for (const [table, column, value] of [
  "mission_steps",
  "orchestrator_runs",
  "orchestrator_chat_threads",
  "orchestrator_chat_messages",
  "mission_artifacts",
  "orchestrator_artifacts",
  "orchestrator_worker_checkpoints",
  "orchestrator_worker_digests",
  "mission_interventions",
].map((table) => [table, "mission_id", missionId])) {
  counts[table] = db.prepare(`select count(*) as count from ${table} where ${column} = ?`).get(value).count;
}
counts.missions = db.prepare("select count(*) as count from missions where id = ?").get(missionId).count;
for (const [table, column, value] of [
  "orchestrator_steps",
  "orchestrator_attempts",
  "orchestrator_timeline_events",
  "orchestrator_runtime_events",
].map((table) => [table, "run_id", runId])) {
  counts[table] = db.prepare(`select count(*) as count from ${table} where ${column} = ?`).get(value).count;
}
db.close();

console.log(
  JSON.stringify(
    {
      projectRoot,
      dbPath,
      backupPath,
      missionId,
      runId,
      projectId,
      laneId,
      counts,
    },
    null,
    2,
  ),
);
