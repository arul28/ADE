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

  it("persists review metadata for ingested artifacts", () => {
    const events: Array<{ type: string; artifactId: string }> = [];

    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
      onEvent: (payload) => events.push({ type: payload.type, artifactId: payload.artifactId }),
    });

    const ingested = broker.ingest({
      backend: {
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
    const initial = broker.listArtifacts({ artifactId });
    expect(initial[0]?.reviewState).toBe("accepted");
    expect(initial[0]?.workflowState).toBe("evidence_only");

    expect(initial[0]?.links.map((link) => `${link.ownerKind}:${link.ownerId}`)).toEqual([
      "lane:lane-1",
    ]);

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
      "artifact-reviewed",
    ]);
  });

  it("lists legacy lane-owned artifacts that have lane_id but no owner link", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       ) values ('lane-only', 'project-1', 'screenshot', 'manual', 'ade-cli', null, null,
         'Lane only', null, '.ade/artifacts/computer-use/lane-only.png', 'file', 'image/png',
         '{}', 'lane-1', '2026-03-12T14:00:00.000Z')`,
    );

    expect(broker.listArtifacts({ ownerKind: "lane", ownerId: "lane-1" }))
      .toEqual([expect.objectContaining({ id: "lane-only", laneId: "lane-1" })]);
    expect(broker.listArtifacts({ ownerKind: "lane", ownerId: "lane-2" })).toEqual([]);
  });

  it("reads image previews only from the project artifact directory", async () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const artifactDir = path.join(projectRoot, ".ade", "artifacts", "computer-use");
    fs.mkdirSync(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, "preview.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(artifactPath, bytes);

    await expect(broker.readArtifactPreview({
      uri: "ade-artifact://project/.ade/artifacts/computer-use/preview.png",
    })).resolves.toBe(`data:image/png;base64,${bytes.toString("base64")}`);

    const videoPath = path.join(artifactDir, "preview.mp4");
    const videoBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    fs.writeFileSync(videoPath, videoBytes);
    await expect(broker.readArtifactPreview({
      uri: "ade-artifact://project/.ade/artifacts/computer-use/preview.mp4",
    })).resolves.toBe(`data:video/mp4;base64,${videoBytes.toString("base64")}`);

    const outsidePath = path.join(projectRoot, "outside.png");
    fs.writeFileSync(outsidePath, bytes);
    await expect(broker.readArtifactPreview({ uri: outsidePath })).resolves.toBeNull();
  });

  it("rejects local file imports outside allowed artifact roots", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });

    const blockedPath = path.join(process.cwd(), `.ade-broker-blocked-${Date.now()}.txt`);
    fs.writeFileSync(blockedPath, "secret", "utf8");
    try {
      expect(() =>
        broker.ingest({
          backend: {
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

  it("allows ADE cache browser observations to be promoted into proof", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const observationDir = path.join(projectRoot, ".ade", "cache", "browser-observations", "profile", "tab-1");
    fs.mkdirSync(observationDir, { recursive: true });
    const observationPath = path.join(observationDir, "obs.png");
    fs.writeFileSync(observationPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const ingested = broker.ingest({
      backend: {
        name: "ade-browser",
        style: "manual",
      },
      inputs: [
        {
          kind: "screenshot",
          title: "Browser proof",
          path: observationPath,
        },
      ],
    });

    expect(ingested.artifacts[0]).toMatchObject({
      backendName: "ade-browser",
      kind: "screenshot",
      title: "Browser proof",
    });
  });

  it("allows only the configured machine-local personal browser scratch root to be promoted", () => {
    const personalObservationRoot = fs.mkdtempSync(path.join(process.cwd(), ".browser-personal-proof-"));
    try {
      const broker = createComputerUseArtifactBrokerService({
        db,
        projectId: "project-1",
        projectRoot,
        additionalAllowedImportRoots: [personalObservationRoot],
        logger: createLogger(),
      });
      const observationPath = path.join(personalObservationRoot, "personal", "tab-1", "obs.png");
      fs.mkdirSync(path.dirname(observationPath), { recursive: true });
      fs.writeFileSync(observationPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const ingested = broker.ingest({
        backend: { name: "ade-browser", style: "manual" },
        inputs: [{ kind: "screenshot", title: "Personal browser proof", path: observationPath }],
      });

      expect(ingested.artifacts[0]).toMatchObject({
        backendName: "ade-browser",
        kind: "screenshot",
        title: "Personal browser proof",
      });
    } finally {
      fs.rmSync(personalObservationRoot, { recursive: true, force: true });
    }
  });

  it("persists the declared backend style for ingested artifacts", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });

    const ingested = broker.ingest({
      backend: {
        name: "ade-cli",
        style: "manual",
      },
      inputs: [
        {
          kind: "console_logs",
          title: "Manual note",
          text: "Looks good.",
        },
      ],
    });

    expect(ingested.artifacts[0]?.backendStyle).toBe("manual");
    const row = db.get<{ backend_style: string }>(
      `select backend_style from computer_use_artifacts where id = ?`,
      [ingested.artifacts[0]!.id],
    );
    expect(row?.backend_style).toBe("manual");
  });

  it("resolves a relative capture path against the caller's lane worktree", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });

    // Agents run inside the lane worktree, so this is where their relative
    // paths point — resolving against projectRoot silently lost every capture.
    const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-a");
    fs.mkdirSync(path.join(laneRoot, "shots"), { recursive: true });
    fs.writeFileSync(path.join(laneRoot, "shots", "proof.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const ingested = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      callerRoot: laneRoot,
      inputs: [{ kind: "screenshot", title: "Lane proof", path: "shots/proof.png" }],
    });

    const stored = ingested.artifacts[0]!;
    // The bytes were copied into the artifact store, not merely referenced.
    expect(stored.uri).toMatch(/^\.ade\/artifacts\/computer-use\//);
    expect(fs.existsSync(path.join(projectRoot, stored.uri))).toBe(true);
    expect(broker.listArtifacts({ artifactId: stored.id })[0]?.availability).toBe("available");
  });

  it("throws instead of persisting a record when the capture file is not found", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });

    expect(() =>
      broker.ingest({
        backend: { name: "ade-cli", style: "manual" },
        callerRoot: path.join(projectRoot, ".ade", "worktrees", "lane-a"),
        inputs: [{ kind: "screenshot", title: "Missing proof", path: "shots/gone.png" }],
      }),
    ).toThrow(/Artifact file not found: shots\/gone\.png/);

    // The whole point: no dead row survives a failed capture.
    expect(broker.listArtifacts({ limit: 50 })).toHaveLength(0);
  });

  it("removes every staged file when a later batch input fails validation", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const firstCapture = path.join(projectRoot, "first.png");
    const secondCapture = path.join(projectRoot, "second.png");
    const rejectedCapture = path.join(projectRoot, "rejected.bin");
    fs.writeFileSync(firstCapture, "first", "utf8");
    fs.writeFileSync(secondCapture, "second", "utf8");
    fs.writeFileSync(rejectedCapture, "rejected", "utf8");

    expect(() =>
      broker.ingest({
        backend: { name: "ade-cli", style: "manual" },
        inputs: [
          { kind: "screenshot", title: "First proof", path: firstCapture },
          { kind: "screenshot", title: "Second proof", path: secondCapture },
          { kind: "screenshot", title: "Rejected proof", path: rejectedCapture },
        ],
      }),
    ).toThrow(/not importable as proof/);

    const stagedDir = path.join(projectRoot, ".ade", "artifacts", "computer-use");
    expect(fs.existsSync(stagedDir) ? fs.readdirSync(stagedDir) : []).toEqual([]);
    expect(broker.listArtifacts({ limit: 50 })).toHaveLength(0);
  });

  it("deletes an artifact's rows and its stored file, and stays idempotent", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });

    const ingested = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      owners: [{ kind: "chat_session", id: "chat-1" }],
      inputs: [{ kind: "console_logs", title: "Notes", text: "hello" }],
    });
    const artifactId = ingested.artifacts[0]!.id;
    const filePath = path.join(projectRoot, ingested.artifacts[0]!.uri);
    expect(fs.existsSync(filePath)).toBe(true);

    const result = broker.deleteArtifacts({ artifactId });
    expect(result.deleted[0]).toMatchObject({ artifactId, fileRemoved: true });
    expect(fs.existsSync(filePath)).toBe(false);
    expect(broker.listArtifacts({ artifactId })).toHaveLength(0);
    expect(
      db.all(`select id from computer_use_artifact_links where artifact_id = ?`, [artifactId]),
    ).toHaveLength(0);

    // Deleting again is not an error — the file may already be gone.
    const repeat = broker.deleteArtifacts({ artifactId });
    expect(repeat.missing).toEqual([artifactId]);
    expect(repeat.failed).toEqual([]);
  });

  it("keeps shared stored bytes until the final artifact record is deleted", () => {
    const canonicalProjectRoot = fs.realpathSync(projectRoot);
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot: canonicalProjectRoot,
      logger: createLogger(),
    });
    const first = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      inputs: [{ kind: "console_logs", title: "Shared notes", text: "hello" }],
    }).artifacts[0]!;
    const filePath = path.join(canonicalProjectRoot, first.uri);
    const second = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      inputs: [{ kind: "console_logs", title: "Shared notes again", path: filePath }],
    }).artifacts[0]!;

    expect(second.uri).toBe(first.uri);
    expect(broker.deleteArtifacts({ artifactId: first.id }).deleted[0]).toMatchObject({
      artifactId: first.id,
      fileRemoved: false,
      freedBytes: 0,
    });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(broker.listArtifacts({ artifactId: second.id })[0]?.availability).toBe("available");

    expect(broker.deleteArtifacts({ artifactId: second.id }).deleted[0]).toMatchObject({
      artifactId: second.id,
      fileRemoved: true,
    });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("keeps shared stored bytes when surviving records use an equivalent URI spelling", () => {
    const canonicalProjectRoot = fs.realpathSync(projectRoot);
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot: canonicalProjectRoot,
      logger: createLogger(),
    });
    const first = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      inputs: [{ kind: "console_logs", title: "Shared aliases", text: "hello" }],
    }).artifacts[0]!;
    const filePath = path.join(canonicalProjectRoot, first.uri);
    const second = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      inputs: [{ kind: "console_logs", title: "Shared aliases again", path: filePath }],
    }).artifacts[0]!;
    db.run(
      "update computer_use_artifacts set uri = ? where id = ?",
      [`ade-artifact://project/${first.uri}`, second.id],
    );

    expect(broker.deleteArtifacts({ artifactId: first.id }).deleted[0]).toMatchObject({
      artifactId: first.id,
      fileRemoved: false,
    });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(broker.listArtifacts({ artifactId: second.id })[0]?.availability).toBe("available");
  });

  it("removes rows for records whose file was already deleted", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const ingested = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      inputs: [{ kind: "console_logs", title: "Notes", text: "hello" }],
    });
    const artifactId = ingested.artifacts[0]!.id;
    fs.rmSync(path.join(projectRoot, ingested.artifacts[0]!.uri), { force: true });

    expect(broker.listArtifacts({ artifactId })[0]?.availability).toBe("missing_file");
    const result = broker.deleteArtifacts({ artifactId });
    expect(result.deleted[0]?.fileRemoved).toBe(false);
    expect(broker.listArtifacts({ artifactId })).toHaveLength(0);
  });

  it("retains the file and database rows when stored-byte deletion fails", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const ingested = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      owners: [{ kind: "chat_session", id: "chat-1" }],
      inputs: [{ kind: "console_logs", title: "Retryable notes", text: "hello" }],
    });
    const artifactId = ingested.artifacts[0]!.id;
    const filePath = path.join(projectRoot, ingested.artifacts[0]!.uri);
    const canonicalFilePath = fs.realpathSync(filePath);
    const originalRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(((candidate, options) => {
      if (fs.realpathSync(String(candidate)) === canonicalFilePath) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return originalRmSync(candidate, options);
    }) as typeof fs.rmSync);

    try {
      const result = broker.deleteArtifacts({ artifactId });
      expect(result.deleted).toEqual([]);
      expect(result.failed).toEqual([
        { artifactId, reason: "permission denied" },
      ]);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(broker.listArtifacts({ artifactId })).toHaveLength(1);
      expect(
        db.all(`select id from computer_use_artifact_links where artifact_id = ?`, [artifactId]),
      ).toHaveLength(1);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("prunes broken records and reports where a recoverable one still lives", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    // A record shaped like the ones the old silent fallback wrote: a raw
    // relative path that never made it into `.ade/artifacts`.
    const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-a");
    fs.mkdirSync(laneRoot, { recursive: true });
    fs.writeFileSync(path.join(laneRoot, "survivor.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       ) values (?, ?, 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, ?, null, ?)`,
      [
        "dead-1",
        "project-1",
        "Orphan",
        "survivor.png",
        JSON.stringify({ sourcePath: "survivor.png" }),
        "2026-03-12T14:00:00.000Z",
      ],
    );

    const broken = broker.listBrokenArtifacts();
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ artifactId: "dead-1", reason: "outside_artifact_store" });
    // Compared by suffix: the resolver realpaths, and on macOS the temp dir
    // resolves through the /private symlink.
    expect(broken[0]?.recoverablePath?.endsWith("/.ade/worktrees/lane-a/survivor.png")).toBe(true);

    // Recovery re-imports the surviving bytes rather than dropping the record.
    const recovered = broker.recoverArtifact({ artifactId: "dead-1" });
    expect(recovered.availability).toBe("available");
    expect(broker.listBrokenArtifacts()).toHaveLength(0);
  });

  it("rejects ambiguous legacy recovery when multiple lanes contain the same relative path", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const firstLaneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-a");
    const secondLaneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-b");
    for (const [root, contents] of [[firstLaneRoot, "first"], [secondLaneRoot, "second"]] as const) {
      fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
      fs.writeFileSync(path.join(root, "screenshots", "result.png"), contents, "utf8");
    }
    db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       ) values (?, ?, 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, ?, null, ?)`,
      [
        "ambiguous-legacy",
        "project-1",
        "Ambiguous legacy proof",
        "screenshots/result.png",
        JSON.stringify({ sourcePath: "screenshots/result.png" }),
        "2026-03-12T14:00:00.000Z",
      ],
    );

    expect(broker.listBrokenArtifacts()[0]).toMatchObject({
      artifactId: "ambiguous-legacy",
      recoverablePath: null,
    });
    expect(() => broker.recoverArtifact({ artifactId: "ambiguous-legacy" }))
      .toThrow(/matches multiple surviving roots and cannot be recovered safely/);
    expect(broker.listArtifacts({ artifactId: "ambiguous-legacy" })[0]?.uri)
      .toBe("screenshots/result.png");
  });

  it("uses an artifact's lane owner to disambiguate legacy recovery", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const firstLaneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-a");
    const secondLaneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-b");
    for (const [root, contents] of [[firstLaneRoot, "lane-a"], [secondLaneRoot, "lane-b"]] as const) {
      fs.mkdirSync(path.join(root, "screenshots"), { recursive: true });
      fs.writeFileSync(path.join(root, "screenshots", "result.png"), contents, "utf8");
    }
    db.run(
      `
        insert into lanes(
          id, project_id, name, base_ref, branch_ref, worktree_path, status, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "lane-a",
        "project-1",
        "Lane A",
        "main",
        "feature/lane-a",
        firstLaneRoot,
        "active",
        "2026-03-12T14:00:00.000Z",
      ],
    );
    db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       ) values (?, ?, 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, ?, null, ?)`,
      [
        "owned-legacy",
        "project-1",
        "Owned legacy proof",
        "screenshots/result.png",
        JSON.stringify({ sourcePath: "screenshots/result.png" }),
        "2026-03-12T14:00:00.000Z",
      ],
    );
    db.run(
      `insert into computer_use_artifact_links(
         id, artifact_id, project_id, owner_kind, owner_id, relation, metadata_json, created_at
       ) values (?, ?, ?, 'lane', ?, 'attached_to', null, ?)`,
      [
        "owned-legacy-link",
        "owned-legacy",
        "project-1",
        "lane-a",
        "2026-03-12T14:00:00.000Z",
      ],
    );

    const recovered = broker.recoverArtifact({ artifactId: "owned-legacy" });
    expect(recovered.availability).toBe("available");
    expect(fs.readFileSync(path.join(projectRoot, recovered.uri), "utf8")).toBe("lane-a");
  });

  it("prunes broken records that cannot be recovered", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       ) values (?, ?, 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, '{}', null, ?)`,
      ["dead-2", "project-1", "Gone", "nowhere/missing.png", "2026-03-12T14:00:00.000Z"],
    );

    const pruned = broker.pruneBrokenArtifacts();
    expect(pruned.deleted.map((entry) => entry.artifactId)).toEqual(["dead-2"]);
    expect(broker.listArtifacts({ limit: 50 })).toHaveLength(0);
  });

  it("filters for broken artifacts before applying the result limit", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const artifactDir = path.join(projectRoot, ".ade", "artifacts", "computer-use");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "healthy.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       ) values (?, ?, 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, '{}', null, ?)`,
      [
        "new-healthy",
        "project-1",
        "New healthy proof",
        ".ade/artifacts/computer-use/healthy.png",
        "2026-03-13T14:00:00.000Z",
      ],
    );
    db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       ) values (?, ?, 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, '{}', null, ?)`,
      ["old-broken", "project-1", "Old broken proof", "nowhere/old-broken.png", "2026-03-12T14:00:00.000Z"],
    );

    expect(broker.listBrokenArtifacts({ limit: 1 }).map((entry) => entry.artifactId)).toEqual(["old-broken"]);
  });

  it("prunes broken artifacts beyond the old 2,000-record scan cap", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const artifactDir = path.join(projectRoot, ".ade", "artifacts", "computer-use");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "healthy.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const healthyUri = ".ade/artifacts/computer-use/healthy.png";
    db.run(
      `with recursive healthy(index_value) as (
         select 0
         union all
         select index_value + 1 from healthy where index_value < 1999
       )
       insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       )
       select
         'healthy-' || index_value, ?, 'screenshot', 'manual', 'ade-cli', null, null,
         'Healthy ' || index_value, null, ?, 'file', null, '{}', null, ?
       from healthy`,
      ["project-1", healthyUri, "2026-03-13T14:00:00.000Z"],
    );
    db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json,
         lane_id, created_at
       ) values (?, ?, 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, '{}', null, ?)`,
      ["old-broken", "project-1", "Old broken proof", "nowhere/old-broken.png", "2026-03-12T14:00:00.000Z"],
    );

    expect(broker.pruneBrokenArtifacts().deleted.map((entry) => entry.artifactId)).toEqual(["old-broken"]);
    expect(broker.listArtifacts({ artifactId: "healthy-0" })[0]?.availability).toBe("available");
  });

  it("refuses to promote files from the project secrets directory", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const secretPath = path.join(secretsDir, "api-keys.v1.bin");
    fs.writeFileSync(secretPath, "token", "utf8");

    expect(() =>
      broker.ingest({
        backend: { name: "ade-cli", style: "manual" },
        inputs: [{ kind: "console_logs", title: "Keys", path: secretPath }],
      }),
    ).toThrow(/not allowed as a proof source/);
  });

  // The import roots include the project root and every lane worktree, because
  // agents capture next to the code they are changing. That puts credential
  // files in the same directories as legitimate screenshots, and the artifact
  // store syncs to paired phones — so the file-type gate, not the root list, is
  // what keeps them out.
  it.each([
    [".env.local", "GEMINI_API_KEY=live-key"],
    ["ade.db", "sqlite"],
    ["ade.db-wal", "wal"],
    ["id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["server.pem", "-----BEGIN CERTIFICATE-----"],
  ])("refuses to import %s from an allowed root", (name, contents) => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const sensitivePath = path.join(projectRoot, name);
    fs.writeFileSync(sensitivePath, contents, "utf8");

    expect(() =>
      broker.ingest({
        backend: { name: "ade-cli", style: "manual" },
        inputs: [{ kind: "screenshot", title: "Proof", path: sensitivePath }],
      }),
    ).toThrow(/not importable as proof/);
    expect(broker.listArtifacts({ limit: 50 })).toHaveLength(0);
  });

  it("still imports real proof from the project root", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    const shotPath = path.join(projectRoot, "capture.png");
    fs.writeFileSync(shotPath, "png-bytes", "utf8");

    const result = broker.ingest({
      backend: { name: "ade-cli", style: "manual" },
      inputs: [{ kind: "screenshot", title: "Proof", path: shotPath }],
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].uri).toMatch(/^\.ade\/artifacts\/computer-use\//);
  });

  it("rejects symlinked artifact paths that escape the project artifact directory", () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
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
