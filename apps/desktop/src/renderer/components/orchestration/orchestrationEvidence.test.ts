/* @vitest-environment node */
import { describe, expect, it } from "vitest";

import type {
  OrchestrationAgent,
  OrchestrationAsset,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";
import {
  deriveAgentEvidence,
  deriveRunEvidence,
  evidenceChipLabel,
  evidenceExternalUrl,
  isEvidenceAsset,
} from "./orchestrationEvidence";

function asset(partial: Partial<OrchestrationAsset> & { id: string; kind: OrchestrationAsset["kind"] }): OrchestrationAsset {
  return {
    path: `artifacts/${partial.id}`,
    version: 1,
    approval: "pending",
    ...partial,
  } as OrchestrationAsset;
}

function agent(sessionId: string, tag?: string): OrchestrationAgent {
  return {
    sessionId,
    role: "worker",
    ...(tag ? { tag } : {}),
    goalSummary: "work",
    status: "running",
    spawnedAt: new Date().toISOString(),
  };
}

function manifestWith(
  assets: OrchestrationAsset[],
  agents: OrchestrationAgent[] = [],
): Pick<OrchestrationManifest, "assets" | "agents"> {
  return { assets, agents };
}

describe("orchestrationEvidence", () => {
  it("classifies only externally-visible kinds as evidence", () => {
    expect(isEvidenceAsset(asset({ id: "A1", kind: "pr_link" }))).toBe(true);
    expect(isEvidenceAsset(asset({ id: "A2", kind: "proof_artifact" }))).toBe(true);
    expect(isEvidenceAsset(asset({ id: "A3", kind: "screenshot" }))).toBe(true);
    // Plan-authoring assets are NOT evidence.
    expect(isEvidenceAsset(asset({ id: "A4", kind: "html_spec" }))).toBe(false);
    expect(isEvidenceAsset(asset({ id: "A5", kind: "doc" }))).toBe(false);
  });

  it("groups evidence by producing agent and ignores un-attributed / plan assets", () => {
    const assets = [
      asset({ id: "A1", kind: "pr_link", registeredBySessionId: "S-w1", externalRef: { prNumber: 7 } }),
      asset({ id: "A2", kind: "screenshot", registeredBySessionId: "S-w1" }),
      asset({ id: "A3", kind: "proof_artifact", registeredBySessionId: "S-w2" }),
      asset({ id: "A4", kind: "html_spec", registeredBySessionId: "S-w1" }), // not evidence
      asset({ id: "A5", kind: "deeplink", externalRef: { url: "ade://x" } }), // no producer
    ];
    const byAgent = deriveAgentEvidence(manifestWith(assets));
    expect(byAgent.get("S-w1")?.map((a) => a.id)).toEqual(["A1", "A2"]);
    expect(byAgent.get("S-w2")?.map((a) => a.id)).toEqual(["A3"]);
    // html_spec excluded; deeplink with no producer not grouped under any agent.
    expect([...byAgent.keys()].sort()).toEqual(["S-w1", "S-w2"]);
  });

  it("aggregates run evidence with producing agent, ordered by kind", () => {
    const assets = [
      asset({ id: "A1", kind: "screenshot", registeredBySessionId: "S-w1" }),
      asset({ id: "A2", kind: "pr_link", registeredBySessionId: "S-w1", externalRef: { prNumber: 9 } }),
      asset({ id: "A3", kind: "html_spec", registeredBySessionId: "S-w1" }),
      asset({ id: "A4", kind: "linear_issue", registeredBySessionId: "S-w2", externalRef: { linearId: "ENG-1" } }),
    ];
    const items = deriveRunEvidence(
      manifestWith(assets, [agent("S-w1", "impl"), agent("S-w2", "docs")]),
    );
    // html_spec excluded; pr_link + linear_issue ranked before screenshot.
    expect(items.map((i) => i.asset.id)).toEqual(["A2", "A4", "A1"]);
    expect(items[0].agent?.sessionId).toBe("S-w1");
    expect(items[1].agent?.tag).toBe("docs");
  });

  it("produces compact chip labels per kind", () => {
    expect(evidenceChipLabel(asset({ id: "A1", kind: "pr_link", externalRef: { prNumber: 42 } }))).toBe("PR #42");
    expect(evidenceChipLabel(asset({ id: "A2", kind: "linear_issue", externalRef: { linearId: "ENG-9" } }))).toBe("ENG-9");
    expect(evidenceChipLabel(asset({ id: "A3", kind: "deeplink", externalRef: { url: "ade://x" } }))).toBe("link");
    expect(
      evidenceChipLabel(asset({ id: "A4", kind: "proof_artifact", path: "artifacts/proof/login.png" })),
    ).toBe("login.png");
  });

  it("exposes an external URL, or an artifact deeplink for artifactId-backed evidence", () => {
    // Explicit URL (PR / Linear / deeplink) is used verbatim.
    expect(evidenceExternalUrl(asset({ id: "A1", kind: "pr_link", externalRef: { url: "https://gh/pr/1" } }))).toBe("https://gh/pr/1");
    // Proof / computer-use / video assets carry only an artifactId → derive the
    // canonical ade://artifact/<id> deeplink so the row/chip is openable.
    expect(evidenceExternalUrl(asset({ id: "A2", kind: "proof_artifact", externalRef: { artifactId: "art-1" } }))).toBe("ade://artifact/art-1");
    expect(evidenceExternalUrl(asset({ id: "A3", kind: "computer_use", externalRef: { artifactId: "art 2/x" } }))).toBe("ade://artifact/art%202%2Fx");
    expect(evidenceExternalUrl(asset({ id: "A4", kind: "video", externalRef: { artifactId: "vid-9" } }))).toBe("ade://artifact/vid-9");
    // An explicit URL still wins over an artifactId when both are present.
    expect(evidenceExternalUrl(asset({ id: "A5", kind: "proof_artifact", externalRef: { url: "https://host/a", artifactId: "art-1" } }))).toBe("https://host/a");
    // No externalRef target → non-interactive.
    expect(evidenceExternalUrl(asset({ id: "A6", kind: "screenshot" }))).toBeNull();
  });
});
