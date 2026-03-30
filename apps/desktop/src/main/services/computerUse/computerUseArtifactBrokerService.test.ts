import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createComputerUseArtifactBrokerService } from "./computerUseArtifactBrokerService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

describe("computerUseArtifactBrokerService", () => {
  let projectRoot: string;
  let db: AdeDb;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-computer-use-broker-"));
    db = await openKvDb(path.join(projectRoot, ".ade.db"), createLogger());
    db.run(
      `
        insert into projects(
          id, root_path, display_name, default_base_ref, created_at, last_opened_at
        ) values (?, ?, ?, ?, ?, ?)
      `,
      [
        "project-1",
        projectRoot,
        "ADE",
        "main",
        "2026-03-12T14:00:00.000Z",
        "2026-03-12T14:00:00.000Z",
      ],
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("routes ingested artifacts to additional owners and persists review metadata", () => {
    const missionService = { addArtifact: vi.fn() } as any;
    const orchestratorService = { registerArtifact: vi.fn() } as any;
    const events: Array<{ type: string; artifactId: string }> = [];

    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      missionService,
      orchestratorService,
      logger: createLogger(),
      onEvent: (payload) => events.push({ type: payload.type, artifactId: payload.artifactId }),
    });

    const ingested = broker.ingest({
      backend: {
        style: "external_cli",
        name: "agent-browser",
      },
      owners: [{ kind: "lane", id: "lane-1" }],
      inputs: [
        {
          kind: "browser_verification",
          title: "Checkout verification",
          text: "{\"result\":\"ok\"}",
          mimeType: "application/json",
        },
      ],
    });

    const artifactId = ingested.artifacts[0]!.id;

    const routed = broker.routeArtifact({
      artifactId,
      owner: { kind: "mission", id: "mission-1" },
    });
    expect(routed.links.map((link) => `${link.ownerKind}:${link.ownerId}`)).toEqual([
      "lane:lane-1",
      "mission:mission-1",
    ]);
    expect(missionService.addArtifact).toHaveBeenCalledWith(expect.objectContaining({
      missionId: "mission-1",
      metadata: expect.objectContaining({
        brokerArtifactId: artifactId,
        backendName: "agent-browser",
      }),
    }));

    const reviewed = broker.updateArtifactReview({
      artifactId,
      reviewState: "accepted",
      workflowState: "published",
      reviewNote: "Looks good.",
    });

    expect(reviewed.reviewState).toBe("accepted");
    expect(reviewed.workflowState).toBe("published");
    expect(reviewed.reviewNote).toBe("Looks good.");

    const listed = broker.listArtifacts({ artifactId });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.reviewState).toBe("accepted");
    expect(listed[0]?.workflowState).toBe("published");
    expect(events.map((event) => event.type)).toEqual([
      "artifact-linked",
      "artifact-ingested",
      "artifact-linked",
      "artifact-reviewed",
    ]);
  });

  it("rejects local file imports outside allowed artifact roots", () => {
    const missionService = { addArtifact: vi.fn() } as any;
    const orchestratorService = { registerArtifact: vi.fn() } as any;
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      missionService,
      orchestratorService,
      logger: createLogger(),
    });

    const blockedPath = path.join(process.cwd(), `.ade-broker-blocked-${Date.now()}.txt`);
    fs.writeFileSync(blockedPath, "secret", "utf8");
    try {
      expect(() =>
        broker.ingest({
          backend: {
            style: "external_cli",
            name: "agent-browser",
          },
          inputs: [
            {
              kind: "console_logs",
              title: "Blocked import",
              path: blockedPath,
            },
          ],
        }),
      ).toThrow(/outside allowed import roots/);
    } finally {
      fs.rmSync(blockedPath, { force: true });
    }
  });

  it("rejects symlinked artifact paths that escape the project artifact directory", () => {
    const missionService = { addArtifact: vi.fn() } as any;
    const orchestratorService = { registerArtifact: vi.fn() } as any;
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      missionService,
      orchestratorService,
      logger: createLogger(),
    });

    const outsideDir = fs.mkdtempSync(path.join(process.cwd(), ".ade-computer-use-broker-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    const artifactDir = path.join(projectRoot, ".ade", "artifacts");
    const symlinkPath = path.join(artifactDir, "linked-secret.txt");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(outsideFile, "secret", "utf8");
    fs.symlinkSync(outsideFile, symlinkPath);

    try {
      expect(() =>
        broker.ingest({
          backend: {
            style: "external_cli",
            name: "agent-browser",
          },
          inputs: [
            {
              kind: "console_logs",
              title: "Linked artifact",
              path: symlinkPath,
            },
          ],
        }),
      ).toThrow(/outside allowed import roots/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
