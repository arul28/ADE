import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openKvDb, type AdeDb } from "../state/kvDb";
import { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import { buildComputerUseOwnerSnapshot } from "../computerUse/controlPlane";
import { createComputerUseArtifactPath } from "../computerUse/localComputerUse";
import {
  fileSceneStill,
  sceneStillFileLabel,
  SCENE_STILL_MAX_PER_SESSION,
} from "./sceneStillFiling";

/**
 * A scene's still is a PICTURE, not proof.
 *
 * It goes through the broker because the broker owns the bytes and the index
 * that resolves them, and everything here is about the consequences of that: it
 * must not appear in the proof drawer, and — unlike proof, which a person chose
 * to keep — it must be bounded, because every settled scene writes one.
 */

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

describe("scene still filing", () => {
  let projectRoot: string;
  let db: AdeDb;
  let broker: ReturnType<typeof createComputerUseArtifactBrokerService>;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-scene-still-"));
    db = await openKvDb(path.join(projectRoot, ".ade.db"), logger);
    db.run(
      `
        insert into projects(
          id, root_path, display_name, default_base_ref, created_at, last_opened_at
        ) values (?, ?, ?, ?, ?, ?)
      `,
      ["project-1", projectRoot, "ADE", "main", "2026-03-12T14:00:00.000Z", "2026-03-12T14:00:00.000Z"],
    );
    broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeStillBytes(title: string): string {
    const artifactPath = createComputerUseArtifactPath(projectRoot, sceneStillFileLabel(title), "png");
    fs.writeFileSync(artifactPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return artifactPath;
  }

  function fileStill(args: { title: string; scopeKey: string; callId?: string }) {
    const artifactPath = writeStillBytes(args.title);
    return {
      ...fileSceneStill({
        broker,
        path: artifactPath,
        title: args.title,
        ownerSessionId: "chat-1",
        sceneScopeKey: args.scopeKey,
        ...(args.callId ? { voiceCallId: args.callId } : {}),
      }),
      path: artifactPath,
    };
  }

  function stills() {
    return broker.listArtifacts({
      ownerKind: "chat_session",
      ownerId: "chat-1",
      metadataKinds: ["scene_still"],
      limit: 2000,
    });
  }

  it("tags the record as a still, with the scene's key and call", () => {
    const filed = fileStill({ title: "Merged pull requests", scopeKey: "row-1:aa", callId: "call-7" });
    const [artifact] = broker.listArtifacts({ artifactId: filed.artifactId! });
    expect(artifact?.metadata).toMatchObject({
      kind: "scene_still",
      sceneScopeKey: "row-1:aa",
      sceneTitle: "Merged pull requests",
      voiceCallId: "call-7",
    });
  });

  /**
   * The drawer's rows, its counts and its activity feed all come from this one
   * snapshot. Before the tag, every settled scene buried real proof under
   * pictures nobody asked to keep.
   */
  it("keeps stills out of the proof drawer while proof stays visible", () => {
    fileStill({ title: "Generated view", scopeKey: "row-1:aa" });
    broker.ingest({
      backend: { name: "cto", style: "manual" },
      owners: [{ kind: "chat_session", id: "chat-1" }],
      inputs: [{ kind: "browser_verification", title: "Checkout", text: "{}" }],
    });

    const snapshot = buildComputerUseOwnerSnapshot({
      broker,
      owner: { kind: "chat_session", id: "chat-1" },
    });
    expect(snapshot.artifacts.map((artifact) => artifact.title)).toEqual(["Checkout"]);
    expect(snapshot.recentArtifacts).toHaveLength(1);
    expect(snapshot.activity).toHaveLength(1);
    expect(snapshot.summary).toContain("1 computer-use artifact");
    // The record itself is still there — it is the index the picture is found
    // through, and only the proof surfaces exclude it.
    expect(stills()).toHaveLength(1);
  });

  it("keeps one still per scene, and deletes the bytes of the one it replaces", () => {
    const first = fileStill({ title: "First draw", scopeKey: "row-1:aa" });
    expect(fs.existsSync(first.path)).toBe(true);

    const second = fileStill({ title: "Second draw", scopeKey: "row-1:aa" });
    expect(second.removedArtifactIds).toEqual([first.artifactId]);
    expect(stills().map((artifact) => artifact.id)).toEqual([second.artifactId]);
    // Bounded on DISK, not just in the index.
    expect(fs.existsSync(first.path)).toBe(false);
  });

  it("leaves a different scene's still alone", () => {
    const other = fileStill({ title: "Other scene", scopeKey: "row-2:bb" });
    fileStill({ title: "First draw", scopeKey: "row-1:aa" });
    fileStill({ title: "Second draw", scopeKey: "row-1:aa" });
    expect(stills().map((artifact) => artifact.id)).toContain(other.artifactId);
    expect(stills()).toHaveLength(2);
  });

  it("keeps only the newest stills once a chat has drawn too many", () => {
    const filed: Array<ReturnType<typeof fileStill>> = [];
    for (let index = 0; index <= SCENE_STILL_MAX_PER_SESSION; index += 1) {
      filed.push(fileStill({ title: `View ${index}`, scopeKey: `row-${index}` }));
    }
    const kept = stills();
    expect(kept).toHaveLength(SCENE_STILL_MAX_PER_SESSION);
    // The oldest is the one that went, and its bytes went with it.
    const oldest = filed[0]!;
    expect(kept.some((artifact) => artifact.id === oldest.artifactId)).toBe(false);
    expect(kept.some((artifact) => artifact.id === filed.at(-1)!.artifactId)).toBe(true);
  });

  /** A title is agent-authored and reaches a file name on every filesystem. */
  it("clamps the name on disk without touching the recorded title", () => {
    const title = "A".repeat(200);
    const filed = fileSceneStill({
      broker,
      path: writeStillBytes(title),
      title,
      ownerSessionId: "chat-1",
      sceneScopeKey: "row-long",
    });
    const [artifact] = broker.listArtifacts({ artifactId: filed.artifactId! });
    expect(path.basename(artifact!.uri).length).toBeLessThan(120);
    expect(artifact?.title.length).toBe(200);
  });
});
