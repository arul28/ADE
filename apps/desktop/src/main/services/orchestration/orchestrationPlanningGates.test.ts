/* @vitest-environment node */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOrchestrationService } from "./orchestrationService";
import {
  isPlanningReadyForApproval,
  isPlanningReadyForModelSelection,
} from "./runtimeProfile";
import { checkPatchOp } from "./patchPolicy";
import { assessPlanReadiness } from "../ai/tools/orchestrationPlanQuality";
import type {
  ManifestPatchOp,
  OrchestrationManifest,
  PlanningRoundKind,
} from "../../../shared/types/orchestration";

const FULL_PLAN_MD = `
# Plan

## Goal
Make remote CLI image paste work end to end.

## In scope
Work-tab CLI launch attachments and running-PTY paste.

## Out of scope
No remote OS clipboard sync; no provider-specific image APIs.

## Alternatives
Considered base64 PTY payloads but chose runtime temp attachments.

## Implementation order
First the desktop path, then the ADE CLI parity check.

## Agent plan
One worker (tag prompt-tools) and one validator. Models picked during planning.

## Validation plan
Re-verify changes, run vitest, and confirm remote path semantics.

## UI decisions
Inline thumbnail in the composer; no other UI.

## Coordination
plan.md and the manifest stay synced via planAppend and recordValidationRun.
`.trim();

type Setup = {
  laneRoot: string;
  svc: ReturnType<typeof createOrchestrationService>;
  runId: string;
  bundlePath: string;
};

async function makeSetup(): Promise<Setup> {
  const laneRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-orch-gates-"));
  const svc = createOrchestrationService({ resolveLaneWorktree: () => laneRoot });
  const created = await svc.runCreate({
    laneId: "L-test",
    leadSessionId: "S-lead",
    bundleRoot: laneRoot,
    title: "gates test",
    goalSummary: "test the gates",
  });
  return { laneRoot, svc, runId: created.runId, bundlePath: created.manifest.bundlePath };
}

async function recordIntake(s: Setup) {
  return s.svc.recordPlanningIntake(s.runId, s.bundlePath, {
    recordedAt: new Date().toISOString(),
    projectShape: "monorepo · TS",
    testStack: "vitest",
    inFlightWork: "fresh lane",
    ancillarySurfaces: [],
    ciGates: ["npm run typecheck"],
  });
}

async function recordRound(s: Setup, kind: PlanningRoundKind) {
  return s.svc.recordPlanningRound(s.runId, s.bundlePath, {
    id: "",
    kind,
    askedAt: new Date().toISOString(),
    question: `Round ${kind}?`,
    lockedSummary: `${kind} locked`,
    selectedOptionIds: ["a"],
    answeredAt: new Date().toISOString(),
  });
}

async function patchManifest(s: Setup, patches: ManifestPatchOp[]) {
  const m = s.svc.getManifestForRun(s.runId)!;
  const res = await s.svc.manifestPatch(
    { runId: s.runId, ifMatchEtag: m.etag, actorRole: "lead", actorSessionId: "S-lead", patches },
    s.bundlePath,
  );
  expect(res.ok).toBe(true);
  return res;
}

async function addValidationStep(s: Setup) {
  await patchManifest(s, [{
    op: "add",
    path: "/validationStrategy/steps/-",
    value: { id: "VS-1", concern: "reverify_changes", scope: "per_worker", required: true, prompt: "re-verify", evidenceRequired: ["plan_md_section"] },
  }]);
}

async function addModelRouting(s: Setup) {
  await patchManifest(s, [
    { op: "add", path: "/modelRouting/byRoleTag", value: { "worker:prompt-tools": { provider: "codex", modelId: "gpt-5.4" } } },
  ]);
}

async function addValidationStepAndRouting(s: Setup) {
  await addValidationStep(s);
  await addModelRouting(s);
}

function manifestOf(s: Setup): OrchestrationManifest {
  return s.svc.getManifestForRun(s.runId)!;
}

describe("planning state machine gates", () => {
  let s: Setup;
  beforeEach(async () => {
    s = await makeSetup();
  });
  afterEach(async () => {
    await s.svc.dispose();
    await fsp.rm(s.laneRoot, { recursive: true, force: true });
  });

  it("seeds planning at intake and a drafting planSpec", () => {
    const m = manifestOf(s);
    expect(m.leadState.planning?.stage).toBe("intake");
    expect(m.planSpec?.approval.state).toBe("drafting");
    expect(isPlanningReadyForModelSelection(m)).toBe(false);
    expect(isPlanningReadyForApproval(m)).toBe(false);
  });

  it("advances intake → rounds → rounds_complete and unlocks model selection", async () => {
    expect((await recordIntake(s)).ok).toBe(true);
    expect(manifestOf(s).leadState.planning?.stage).toBe("round_functional");
    // out-of-order round is rejected
    const wrongOrder = await recordRound(s, "ui");
    expect(wrongOrder.ok).toBe(false);

    expect((await recordRound(s, "functional")).ok).toBe(true);
    expect((await recordRound(s, "ui")).ok).toBe(true);
    expect(isPlanningReadyForModelSelection(manifestOf(s))).toBe(false);
    expect((await recordRound(s, "extras")).ok).toBe(true);
    expect(manifestOf(s).leadState.planning?.stage).toBe("rounds_complete");
    expect(isPlanningReadyForModelSelection(manifestOf(s))).toBe(true);
  });

  it("rejects a round with no real user answer", async () => {
    await recordIntake(s);
    const res = await s.svc.recordPlanningRound(s.runId, s.bundlePath, {
      id: "",
      kind: "functional",
      askedAt: new Date().toISOString(),
      question: "Q?",
      lockedSummary: "locked",
      // no answeredAt + no selection/freeText
    });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error).toBe("round_unanswered");
  });

  it("markPlanningReady requires intake + 3 rounds + validation steps + model routing", async () => {
    const tooEarly = await s.svc.markPlanningReady(s.runId, s.bundlePath);
    expect(tooEarly.ok).toBe(false);
    await recordIntake(s);
    await recordRound(s, "functional");
    await recordRound(s, "ui");
    await recordRound(s, "extras");
    const noValidation = await s.svc.markPlanningReady(s.runId, s.bundlePath);
    expect(noValidation.ok).toBe(false); // no validation steps yet
    await addValidationStep(s);
    const noModelRouting = await s.svc.markPlanningReady(s.runId, s.bundlePath);
    expect(noModelRouting.ok).toBe(false);
    expect(noModelRouting.ok ? [] : noModelRouting.missing).toContain(
      "model routing (pick a model for at least one role/tag before approval)",
    );
    await addModelRouting(s);
    const ready = await s.svc.markPlanningReady(s.runId, s.bundlePath);
    expect(ready.ok).toBe(true);
    const m = manifestOf(s);
    expect(m.leadState.planning?.stage).toBe("ready");
    expect(m.planSpec?.approval.state).toBe("ready");
    expect(isPlanningReadyForApproval(m)).toBe(true);
  });

  it("markPlanningReady accepts by-role model routing", async () => {
    await recordIntake(s);
    await recordRound(s, "functional");
    await recordRound(s, "ui");
    await recordRound(s, "extras");
    await addValidationStep(s);
    await patchManifest(s, [
      {
        op: "add",
        path: "/modelRouting/byRole",
        value: { worker: { provider: "codex", modelId: "gpt-5.4" } },
      },
    ]);
    const ready = await s.svc.markPlanningReady(s.runId, s.bundlePath);
    expect(ready.ok).toBe(true);
  });

  it("skipped rounds (user override) satisfy the readiness gate", async () => {
    await recordIntake(s);
    await recordRound(s, "functional");
    // user waives UI + extras
    const ov = await s.svc.recordPlanningOverride(s.runId, s.bundlePath, {
      skippedRounds: ["ui", "extras"],
      skipReason: "no UI and no extras",
    });
    expect(ov.ok).toBe(true);
    const manifest = manifestOf(s);
    expect(manifest.leadState.planning?.stage).toBe("rounds_complete");
    expect(manifest.userOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ affectedDefault: "planning.round.ui", instruction: "no UI and no extras" }),
        expect.objectContaining({ affectedDefault: "planning.round.extras", instruction: "no UI and no extras" }),
      ]),
    );
    await addValidationStepAndRouting(s);
    expect((await s.svc.markPlanningReady(s.runId, s.bundlePath)).ok).toBe(true);
  });

  it("advances past already-skipped rounds after recording the current round", async () => {
    await recordIntake(s);
    const ov = await s.svc.recordPlanningOverride(s.runId, s.bundlePath, {
      skippedRounds: ["ui", "extras"],
      skipReason: "skip UI and extras",
    });
    expect(ov.ok).toBe(true);
    expect(manifestOf(s).leadState.planning?.stage).toBe("round_functional");
    await recordRound(s, "functional");
    expect(manifestOf(s).leadState.planning?.stage).toBe("rounds_complete");
    await addValidationStepAndRouting(s);
    expect((await s.svc.markPlanningReady(s.runId, s.bundlePath)).ok).toBe(true);
  });

  it("does not count skipped rounds when the matching user override entry is missing", async () => {
    await recordIntake(s);
    await recordRound(s, "functional");
    const ov = await s.svc.recordPlanningOverride(s.runId, s.bundlePath, {
      skippedRounds: ["ui", "extras"],
      skipReason: "no UI and no extras",
    });
    expect(ov.ok).toBe(true);
    const overrideIds = manifestOf(s).userOverrides.map((entry) => entry.id);
    expect(overrideIds.length).toBeGreaterThan(0);
    await patchManifest(
      s,
      overrideIds.map((id) => ({ op: "remove", path: `/userOverrides/{id:${id}}` })),
    );
    await addValidationStepAndRouting(s);
    const ready = await s.svc.markPlanningReady(s.runId, s.bundlePath);
    expect(ready.ok).toBe(false);
    expect(ready.ok ? [] : ready.missing).toEqual(
      expect.arrayContaining(["ui deliberation round", "extras deliberation round"]),
    );
  });

  it("requires a positive validation waiver before skipping validation steps", async () => {
    await recordIntake(s);
    await recordRound(s, "functional");
    await recordRound(s, "ui");
    await recordRound(s, "extras");
    await patchManifest(s, [{
      op: "add",
      path: "/userOverrides/-",
      value: {
        id: "O-negated-validation",
        at: new Date().toISOString(),
        scope: "phase",
        appliedToId: "planning",
        instruction: "do not skip validation; no validation shortcuts",
        affectedDefault: "validation",
      },
    }]);
    const negated = await s.svc.markPlanningReady(s.runId, s.bundlePath);
    expect(negated.ok).toBe(false);
    expect(negated.ok ? [] : negated.missing).toContain("validation steps (derive at least one, or log a skip-validation user override)");

    const waiver = await s.svc.recordPlanningOverride(s.runId, s.bundlePath, {
      skipReason: "no validation for this run",
    });
    expect(waiver.ok).toBe(true);
    await addModelRouting(s);
    expect((await s.svc.markPlanningReady(s.runId, s.bundlePath)).ok).toBe(true);
  });

  it("does not treat incidental no-validation text as a validation waiver", async () => {
    await recordIntake(s);
    const ov = await s.svc.recordPlanningOverride(s.runId, s.bundlePath, {
      skippedRounds: ["ui"],
      skipReason: "skip the UI round; no validation changes",
    });
    expect(ov.ok).toBe(true);
    await recordRound(s, "functional");
    await recordRound(s, "extras");
    await addModelRouting(s);
    const ready = await s.svc.markPlanningReady(s.runId, s.bundlePath);
    expect(ready.ok).toBe(false);
    expect(ready.ok ? [] : ready.missing).toContain(
      "validation steps (derive at least one, or log a skip-validation user override)",
    );
    expect(manifestOf(s).userOverrides).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ affectedDefault: "validation" })]),
    );
  });

  it("setPlanApprovalState approved advances the run to developing + stamps the hash", async () => {
    await recordIntake(s);
    await recordRound(s, "functional");
    await recordRound(s, "ui");
    await recordRound(s, "extras");
    await addValidationStepAndRouting(s);
    await s.svc.markPlanningReady(s.runId, s.bundlePath);
    const res = await s.svc.setPlanApprovalState(s.runId, s.bundlePath, {
      state: "approved",
      sessionId: "S-lead",
      planContentHash: "deadbeef",
    });
    expect(res.ok).toBe(true);
    const m = manifestOf(s);
    expect(m.currentPhase).toBe("developing");
    expect(m.leadState.planApprovedAt).toBeTruthy();
    expect(m.planSpec?.approval.state).toBe("approved");
    expect(m.planSpec?.approval.approvedPlanContentHash).toBe("deadbeef");
  });

  it("setPlanApprovalState approved rechecks manifest readiness atomically", async () => {
    await recordIntake(s);
    await recordRound(s, "functional");
    await recordRound(s, "ui");
    await recordRound(s, "extras");
    await addValidationStepAndRouting(s);
    await s.svc.markPlanningReady(s.runId, s.bundlePath);
    await patchManifest(s, [{ op: "remove", path: "/modelRouting/byRoleTag" }]);

    const res = await s.svc.setPlanApprovalState(s.runId, s.bundlePath, {
      state: "approved",
      sessionId: "S-lead",
      planContentHash: "deadbeef",
    });

    expect(res.ok).toBe(false);
    expect(res.ok ? [] : res.missing).toContain(
      "model routing (pick a model for at least one role/tag before approval)",
    );
    const m = manifestOf(s);
    expect(m.currentPhase).toBe("planning");
    expect(m.leadState.planApprovedAt).toBeUndefined();
    expect(m.planSpec?.approval.state).toBe("ready");
  });
});

describe("assessPlanReadiness (structural, un-gameable)", () => {
  let s: Setup;
  beforeEach(async () => {
    s = await makeSetup();
  });
  afterEach(async () => {
    await s.svc.dispose();
    await fsp.rm(s.laneRoot, { recursive: true, force: true });
  });

  it("fails when validation steps / model routing are absent even with full prose", () => {
    // Full plan prose but no validationStrategy.steps and no modelRouting.
    const res = assessPlanReadiness(manifestOf(s), FULL_PLAN_MD);
    expect(res.ok).toBe(false);
    const ids = res.missing.map((m) => m.id);
    expect(ids).toContain("validation_plan");
    expect(ids).toContain("agent_plan");
  });

  it("passes when prose covers the sections AND state backs the claims", async () => {
    await addValidationStepAndRouting(s);
    const res = assessPlanReadiness(manifestOf(s), FULL_PLAN_MD);
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
  });

  it("does not treat negated validation text as a plan-quality waiver", async () => {
    await addModelRouting(s);
    await patchManifest(s, [{
      op: "add",
      path: "/userOverrides/-",
      value: {
        id: "O-negated-validation",
        at: new Date().toISOString(),
        scope: "phase",
        appliedToId: "planning",
        instruction: "do not skip validation; no validation shortcuts",
        affectedDefault: "validation",
      },
    }]);
    const negated = assessPlanReadiness(manifestOf(s), FULL_PLAN_MD);
    expect(negated.ok).toBe(false);
    expect(negated.missing.map((m) => m.id)).toContain("validation_plan");

    const waiver = await s.svc.recordPlanningOverride(s.runId, s.bundlePath, {
      skipReason: "no validation for this run",
    });
    expect(waiver.ok).toBe(true);
    const waived = assessPlanReadiness(manifestOf(s), FULL_PLAN_MD);
    expect(waived.missing.map((m) => m.id)).not.toContain("validation_plan");
  });

  it("does not count non-goals headings as the required goal section", async () => {
    await addValidationStepAndRouting(s);
    const noGoalPlan = FULL_PLAN_MD
      .replace("## Goal\nMake remote CLI image paste work end to end.\n\n", "")
      .replace("## Out of scope", "## Out of scope / non-goals");
    const res = assessPlanReadiness(manifestOf(s), noGoalPlan);
    expect(res.ok).toBe(false);
    expect(res.missing.map((m) => m.id)).toContain("goal");
  });

  it("ignores headings inside fenced code blocks", async () => {
    await addValidationStepAndRouting(s);
    const fencedGoalOnly = FULL_PLAN_MD.replace(
      "## Goal\nMake remote CLI image paste work end to end.",
      "```markdown\n## Goal\nMake remote CLI image paste work end to end.\n```",
    );
    const res = assessPlanReadiness(manifestOf(s), fencedGoalOnly);
    expect(res.ok).toBe(false);
    expect(res.missing.map((m) => m.id)).toContain("goal");
  });

  it("keeps heading parsing disabled inside mixed fence markers", async () => {
    await addValidationStepAndRouting(s);
    const mixedFenceGoalOnly = FULL_PLAN_MD.replace(
      "## Goal\nMake remote CLI image paste work end to end.",
      "```markdown\n~~~\n## Goal\nMake remote CLI image paste work end to end.\n~~~\n```",
    );
    const res = assessPlanReadiness(manifestOf(s), mixedFenceGoalOnly);
    expect(res.ok).toBe(false);
    expect(res.missing.map((m) => m.id)).toContain("goal");
  });

  it("does not let N/A satisfy core required sections", async () => {
    await addValidationStepAndRouting(s);
    const naGoalPlan = FULL_PLAN_MD.replace(
      "## Goal\nMake remote CLI image paste work end to end.",
      "## Goal\nN/A",
    );
    const res = assessPlanReadiness(manifestOf(s), naGoalPlan);
    expect(res.ok).toBe(false);
    expect(res.missing.map((m) => m.id)).toContain("goal");
  });

  it("does not let the initial pending goal placeholder satisfy Goal", async () => {
    await addValidationStepAndRouting(s);
    const pendingGoalPlan = FULL_PLAN_MD.replace(
      "## Goal\nMake remote CLI image paste work end to end.",
      "## Goal\n_pending — the lead will fill this in_",
    );
    const res = assessPlanReadiness(manifestOf(s), pendingGoalPlan);
    expect(res.ok).toBe(false);
    expect(res.missing.map((m) => m.id)).toContain("goal");
  });

  it("allows N/A only for UI decisions by default", async () => {
    await addValidationStepAndRouting(s);
    const noUiPlan = FULL_PLAN_MD.replace(
      "## UI decisions\nInline thumbnail in the composer; no other UI.",
      "## UI decisions\nN/A — no UI changes.",
    );
    const res = assessPlanReadiness(manifestOf(s), noUiPlan);
    expect(res.ok).toBe(true);
  });

  it("accepts a later substantive heading when an earlier broad match is thin", async () => {
    await addValidationStepAndRouting(s);
    const duplicateValidationPlan = FULL_PLAN_MD.replace(
      "## Validation plan\nRe-verify changes, run vitest, and confirm remote path semantics.",
      "## Validation findings\nN/A\n\n## Validation plan\nRe-verify changes, run vitest, and confirm remote path semantics.",
    );
    const res = assessPlanReadiness(manifestOf(s), duplicateValidationPlan);
    expect(res.ok).toBe(true);
  });

  it("counts child subsection content toward required section bodies", async () => {
    await addValidationStepAndRouting(s);
    const nestedAgentPlan = FULL_PLAN_MD.replace(
      "## Agent plan\nOne worker (tag prompt-tools) and one validator. Models picked during planning.",
      "## Agent plan\n### Worker\nOne worker owns prompt-tools implementation.\n\n### Validator\nOne validator owns focused proof.",
    );
    const res = assessPlanReadiness(manifestOf(s), nestedAgentPlan);
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
  });

  it("is not satisfiable by keyword-stuffing a single blob", async () => {
    await addValidationStepAndRouting(s);
    const stuffed =
      "out of scope, implementation order, agent plan, validation, ui, coordination, alternatives";
    const res = assessPlanReadiness(manifestOf(s), stuffed);
    expect(res.ok).toBe(false); // no headings → no section coverage
  });
});

describe("patch policy denies forging planning state", () => {
  it("blocks the lead from patching /leadState/planning and /planSpec directly", async () => {
    const s = await makeSetup();
    const manifest = manifestOf(s);
    const denyPlanning = checkPatchOp(
      { op: "replace", path: "/leadState/planning/stage", value: "ready" },
      { actorRole: "lead", manifest },
    );
    expect(denyPlanning.allowed).toBe(false);
    const denySpec = checkPatchOp(
      { op: "replace", path: "/planSpec/approval/state", value: "approved" },
      { actorRole: "lead", manifest },
    );
    expect(denySpec.allowed).toBe(false);
    await s.svc.dispose();
    await fsp.rm(s.laneRoot, { recursive: true, force: true });
  });
});

describe("crash-resume: releaseStaleClaims", () => {
  it("resets expired-lease claimed tasks back to pending and clears the assignee", async () => {
    const s = await makeSetup();
    // Seed a developing task that is claimed with an already-expired lease.
    const m0 = manifestOf(s);
    const expired = new Date(Date.now() - 60_000).toISOString();
    const res = await s.svc.manifestPatch(
      {
        runId: s.runId,
        ifMatchEtag: m0.etag,
        actorRole: "lead",
        actorSessionId: "S-lead",
        patches: [
          {
            op: "add",
            path: "/tasks/-",
            value: {
              id: "T-1",
              phaseId: "developing",
              title: "Build it",
              description: "do the work",
              status: "in_progress",
              assigneeSessionId: "S-worker-dead",
              claimedAt: expired,
              claimLeaseUntil: expired,
              validationGate: { required: false, stepIds: [] },
            },
          },
        ],
      },
      s.bundlePath,
    );
    expect(res.ok).toBe(true);

    const recovered = await s.svc.releaseStaleClaims(s.runId, s.bundlePath);
    expect(recovered.ok).toBe(true);
    expect(recovered.ok && recovered.recovered).toEqual(["T-1"]);
    const task = manifestOf(s).tasks.find((t) => t.id === "T-1")!;
    expect(task.status).toBe("pending");
    expect(task.assigneeSessionId).toBeUndefined();
    expect(task.claimLeaseUntil).toBeUndefined();

    await s.svc.dispose();
    await fsp.rm(s.laneRoot, { recursive: true, force: true });
  });
});
