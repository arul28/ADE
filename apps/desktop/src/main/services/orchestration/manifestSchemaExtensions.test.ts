/* @vitest-environment node */
import { describe, expect, it } from "vitest";

import {
  normalizeManifestShape,
  validateManifestShape,
} from "./manifestNormalization";
import type {
  OrchestrationAsset,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";

/**
 * Round-trip a manifest the way the service does on load: serialize to JSON,
 * JSON.parse it back (as the runtime does from disk), normalize its shape, then
 * validate. Returns the normalized manifest so callers can assert field
 * survival, plus the validation error string (null == valid).
 */
function roundTrip(manifest: OrchestrationManifest): {
  next: OrchestrationManifest;
  error: string | null;
} {
  const parsed = JSON.parse(JSON.stringify(manifest)) as OrchestrationManifest;
  const next = normalizeManifestShape(parsed);
  return { next, error: validateManifestShape(next) };
}

/** A minimal manifest that satisfies validateManifestShape (>=1 agent, valid phase). */
function baseManifest(
  overrides: Partial<OrchestrationManifest> = {},
): OrchestrationManifest {
  return {
    version: 1,
    schemaCompatibility: { minReader: 1, maxKnown: 1 },
    runId: "R-1",
    laneId: "L-1",
    bundlePath: "/tmp/ade-lane/.ade/orchestration/R-1",
    etag: "etag-0",
    serverGeneration: 0,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    title: "Run",
    goalSummary: "do the thing",
    currentPhase: "developing",
    phases: [],
    agents: [
      {
        sessionId: "S-lead",
        role: "lead",
        goalSummary: "lead",
        status: "running",
        spawnedAt: "2026-07-22T00:00:00.000Z",
      },
    ],
    tasks: [],
    validationStrategy: { steps: [], checklist: [] },
    modelRouting: {},
    assets: [],
    decisions: [],
    userOverrides: [],
    leadState: {},
    history: [],
    ...overrides,
  };
}

describe("orchestration manifest schema extensions", () => {
  it("round-trips new-kind assets with externalRef intact", () => {
    const assets: OrchestrationAsset[] = [
      {
        id: "A-1",
        path: "artifacts/proof/login.png",
        kind: "proof_artifact",
        version: 1,
        approval: "approved",
        externalRef: { artifactId: "proof-abc123", url: "ade://proof/abc123" },
      },
      {
        id: "A-2",
        path: "artifacts/pr/link.json",
        kind: "pr_link",
        version: 1,
        externalRef: { prNumber: 868, url: "https://github.com/org/repo/pull/868" },
      },
      {
        id: "A-3",
        path: "artifacts/linear/issue.json",
        kind: "linear_issue",
        version: 1,
        externalRef: { linearId: "ADE-122", url: "https://linear.app/x/issue/ADE-122" },
      },
      {
        id: "A-4",
        path: "artifacts/deeplink.txt",
        kind: "deeplink",
        version: 1,
        externalRef: { url: "ade://run/R-1" },
      },
    ];

    const { next, error } = roundTrip(
      baseManifest({
        assets,
        goalSource: { kind: "linear", ref: "ADE-122" },
        capabilities: {
          allowed: ["proof_capture", "linear", "pr"],
          required: ["proof_capture"],
          notes: "capture before/after screenshots of the login screen",
        },
        scheduledFollowups: [
          {
            id: "F-1",
            summary: "re-check CI in 30 minutes",
            scheduledFor: "2026-07-22T00:30:00.000Z",
            status: "pending",
          },
        ],
      }),
    );

    expect(error).toBeNull();
    // New asset kinds + externalRef survive the serialize→parse→normalize trip.
    expect(next.assets).toHaveLength(4);
    expect(next.assets[0]).toMatchObject({
      kind: "proof_artifact",
      externalRef: { artifactId: "proof-abc123", url: "ade://proof/abc123" },
    });
    expect(next.assets[1].externalRef).toEqual({
      prNumber: 868,
      url: "https://github.com/org/repo/pull/868",
    });
    expect(next.assets[2].externalRef).toEqual({
      linearId: "ADE-122",
      url: "https://linear.app/x/issue/ADE-122",
    });
    // New top-level manifest fields survive.
    expect(next.goalSource).toEqual({ kind: "linear", ref: "ADE-122" });
    expect(next.capabilities?.required).toEqual(["proof_capture"]);
    expect(next.scheduledFollowups?.[0]).toMatchObject({
      id: "F-1",
      summary: "re-check CI in 30 minutes",
      status: "pending",
    });
  });

  it("still parses an OLD manifest with no new fields", () => {
    // A pre-extension manifest: only the original four asset kinds, no
    // externalRef, no goalSource / capabilities / scheduledFollowups.
    const legacy = baseManifest({
      assets: [
        { id: "A-1", path: "artifacts/ui/spec.html", kind: "html_spec", version: 1 },
        { id: "A-2", path: "artifacts/screens/home.png", kind: "screenshot", version: 2 },
        { id: "A-3", path: "artifacts/test.log", kind: "test_log", version: 1 },
        { id: "A-4", path: "artifacts/readme.md", kind: "doc", version: 1 },
      ],
    });

    const { next, error } = roundTrip(legacy);

    expect(error).toBeNull();
    // Normalization must not inject the new optional fields.
    expect(next.goalSource).toBeUndefined();
    expect(next.capabilities).toBeUndefined();
    expect(next.scheduledFollowups).toBeUndefined();
    // Legacy assets pass through untouched (no externalRef synthesized).
    expect(next.assets).toHaveLength(4);
    expect(next.assets.every((a) => a.externalRef === undefined)).toBe(true);
    expect(next.assets.map((a) => a.kind)).toEqual([
      "html_spec",
      "screenshot",
      "test_log",
      "doc",
    ]);
  });
});
