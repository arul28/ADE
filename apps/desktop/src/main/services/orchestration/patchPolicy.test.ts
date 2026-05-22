/* @vitest-environment node */
import { describe, expect, it } from "vitest";

import {
  checkPatchOp,
  isTaskHumanOverridePatch,
  isTaskStatusDonePatch,
  isUserOverrideEntryAppend,
  isValidationGateRequiredOff,
  parsePatchPath,
  pathMatchesPattern,
} from "./patchPolicy";
import type {
  ManifestPatchOp,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";

function makeManifest(): OrchestrationManifest {
  return {
    version: 1,
    runId: "R-1",
    laneId: "L-1",
    bundlePath: "/tmp/bundle",
    etag: "e0",
    serverGeneration: 0,
    createdAt: "now",
    updatedAt: "now",
    title: "x",
    goalSummary: "",
    currentPhase: "planning",
    phases: [],
    agents: [
      {
        sessionId: "S-lead",
        role: "lead",
        goalSummary: "lead",
        status: "running",
        spawnedAt: "now",
      },
      {
        sessionId: "S-worker",
        role: "worker",
        tag: "web-ui",
        goalSummary: "worker",
        status: "pending",
        spawnedAt: "now",
      },
    ],
    tasks: [
      {
        id: "T-1",
        phaseId: "developing",
        title: "x",
        description: "",
        status: "pending",
        validationGate: { required: true, stepIds: [] },
        assigneeSessionId: "S-worker",
      },
    ],
    validationStrategy: { steps: [], checklist: [] },
    modelRouting: {},
    assets: [],
    decisions: [],
    userOverrides: [],
    leadState: {},
    history: [],
  };
}

describe("patchPolicy", () => {
  it("parses id-predicate paths", () => {
    const parsed = parsePatchPath("/tasks/{id:T-3}/status");
    expect(parsed.segments).toEqual([
      { kind: "literal", key: "tasks" },
      { kind: "predicate", field: "id", value: "T-3" },
      { kind: "literal", key: "status" },
    ]);
  });

  it("rejects numeric segments", () => {
    expect(() => parsePatchPath("/tasks/0/status")).toThrow(/numeric/i);
  });

  it("pattern matches wildcards", () => {
    const parsed = parsePatchPath("/tasks/{id:T-3}/status");
    expect(pathMatchesPattern(parsed, "/tasks/{id:*}/status")).toBe(true);
    expect(pathMatchesPattern(parsed, "/tasks/{id:*}/title")).toBe(false);
  });

  it("lead can patch tasks but not system fields", () => {
    const manifest = makeManifest();
    const allowed = checkPatchOp(
      { op: "replace", path: "/tasks/{id:T-1}/status", value: "in_progress" },
      { actorRole: "lead", manifest },
    );
    expect(allowed.allowed).toBe(true);

    const denied = checkPatchOp(
      { op: "replace", path: "/runId", value: "R-2" },
      { actorRole: "lead", manifest },
    );
    expect(denied.allowed).toBe(false);
  });

  it("worker may patch its own status; not validationGate", () => {
    const manifest = makeManifest();
    const ok = checkPatchOp(
      { op: "replace", path: "/tasks/{id:T-1}/status", value: "claimed" },
      { actorRole: "worker", actorSessionId: "S-worker", manifest },
    );
    expect(ok.allowed).toBe(true);

    const gate = checkPatchOp(
      {
        op: "replace",
        path: "/tasks/{id:T-1}/validationGate",
        value: { required: false, stepIds: [] },
      },
      { actorRole: "worker", actorSessionId: "S-worker", manifest },
    );
    expect(gate.allowed).toBe(false);
  });

  it("worker cannot patch another worker's task", () => {
    const manifest = makeManifest();
    const denied = checkPatchOp(
      { op: "replace", path: "/tasks/{id:T-1}/status", value: "done" },
      { actorRole: "worker", actorSessionId: "S-other-worker", manifest },
    );
    expect(denied.allowed).toBe(false);
  });

  it("validator may patch its own row + checklist runs", () => {
    const manifest = makeManifest();
    const ok = checkPatchOp(
      {
        op: "add",
        path: "/validationStrategy/checklist/{id:C-1}/runs/-",
        value: { id: "R-1", runBySessionId: "S-v", status: "running", startedAt: "now" },
      },
      { actorRole: "validator", actorSessionId: "S-v", manifest },
    );
    expect(ok.allowed).toBe(true);

    const denied = checkPatchOp(
      { op: "replace", path: "/tasks/{id:T-1}/status", value: "done" },
      { actorRole: "validator", actorSessionId: "S-v", manifest },
    );
    expect(denied.allowed).toBe(false);
  });

  it("identifies coordinated transaction predicates", () => {
    const statusOp: ManifestPatchOp = {
      op: "replace",
      path: "/tasks/{id:T-1}/status",
      value: "done",
    };
    const overrideOp: ManifestPatchOp = {
      op: "add",
      path: "/tasks/{id:T-1}/humanOverride",
      value: {},
    };
    const userOverrideOp: ManifestPatchOp = {
      op: "add",
      path: "/userOverrides/-",
      value: {},
    };
    const lowerOp: ManifestPatchOp = {
      op: "replace",
      path: "/tasks/{id:T-1}/validationGate/required",
      value: false,
    };
    expect(isTaskStatusDonePatch(statusOp)).toBe(true);
    expect(isTaskHumanOverridePatch(overrideOp)).toBe(true);
    expect(isUserOverrideEntryAppend(userOverrideOp)).toBe(true);
    expect(isValidationGateRequiredOff(lowerOp)).toBe(true);
  });
});
