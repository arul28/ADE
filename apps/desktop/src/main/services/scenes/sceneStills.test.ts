import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComputerUseArtifactView } from "../../../shared/types/computerUseArtifacts";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import { buildComputerUseOwnerSnapshot } from "../computerUse/controlPlane";
import { createComputerUseArtifactPath } from "../computerUse/localComputerUse";
import {
  fileSceneStill,
  requireSceneStillScopeKey,
  SceneStillScopeKeyError,
  findVoiceCallStills,
  sceneStillFileLabel,
  SCENE_STILL_MAX_PER_SESSION,
  type SceneStillArtifactSource,
} from "./sceneStills";

/**
 * A scene's still is a PICTURE, not proof.
 *
 * It goes through the broker because the broker owns the bytes and the index
 * that resolves them, and everything here is about the consequences of that: it
 * must not appear in the proof drawer, and — unlike proof, which a person chose
 * to keep — it must be bounded, because every settled scene writes one. Reading
 * them back is the same rules run the other way, so it is the same suite.
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
      metadataKind: "scene_still",
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
      proofSource: "ade-capture",
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

  /**
   * A call's stills are the case the owner was silently missing on.
   *
   * The voice HUD is mounted at the shell, outside every chat scope, so it
   * filed every call still with no owner at all — and BOTH bounds are scoped
   * to the owner, so nothing was ever pruned, while the finished call's card
   * asked an owner query and got nothing back. Everything here is downstream
   * of one fact: a call still has a `chat_session` owner like any other.
   */
  it("owns a call's stills by chat and finds them by call", () => {
    const first = fileStill({ title: "Lanes", scopeKey: "call-9:aa", callId: "call-9" });

    const [artifact] = broker.listArtifacts({ artifactId: first.artifactId! });
    expect(artifact?.links).toContainEqual(
      expect.objectContaining({ ownerKind: "chat_session", ownerId: "chat-1" }),
    );

    expect(findVoiceCallStills(broker, { sessionId: "chat-1", callId: "call-9" })).toEqual([
      expect.objectContaining({ artifactId: first.artifactId, title: "Lanes" }),
    ]);
  });

  /**
   * A call is not a scene. It draws several views over its length and the card
   * shows all of them, so the per-scope bound has to be scoped to the VIEW —
   * keyed by the call id alone, filing the second view deleted the first, and
   * the record named one view while the live card drew broken tiles. The HUD
   * derives that key with `sceneScopeKeyFor(callId, source)`; here the two
   * shapes are spelled out directly.
   */
  it("keeps a picture of every view one call draws, and one per redraw", () => {
    const lanes = fileStill({ title: "Lanes", scopeKey: "call-9:aa", callId: "call-9" });
    const prs = fileStill({ title: "PRs", scopeKey: "call-9:bb", callId: "call-9" });

    expect(prs.removedArtifactIds).toEqual([]);
    expect(fs.existsSync(lanes.path)).toBe(true);
    expect(findVoiceCallStills(broker, { sessionId: "chat-1", callId: "call-9" })).toEqual([
      expect.objectContaining({ artifactId: lanes.artifactId, title: "Lanes" }),
      expect.objectContaining({ artifactId: prs.artifactId, title: "PRs" }),
    ]);

    // The SAME view drawn again is the same key, and supersedes itself rather
    // than leaving a trail of pictures on disk.
    const redrawn = fileStill({ title: "Lanes again", scopeKey: "call-9:aa", callId: "call-9" });
    expect(redrawn.removedArtifactIds).toEqual([lanes.artifactId]);
    expect(fs.existsSync(lanes.path)).toBe(false);
    expect(findVoiceCallStills(broker, { sessionId: "chat-1", callId: "call-9" })).toEqual([
      expect.objectContaining({ artifactId: prs.artifactId, title: "PRs" }),
      expect.objectContaining({ artifactId: redrawn.artifactId, title: "Lanes again" }),
    ]);
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

function artifact(over: Partial<ComputerUseArtifactView>): ComputerUseArtifactView {
  return {
    id: "a1",
    kind: "screenshot",
    backendStyle: "manual",
    backendName: "scene",
    sourceToolName: "scene_snapshot",
    originalType: null,
    title: "Generated view",
    description: null,
    uri: ".ade/artifacts/computer-use/a.png",
    storageKind: "file",
    mimeType: "image/png",
    metadata: {},
    createdAt: "2026-09-17T10:00:00.000Z",
    links: [],
    reviewState: "pending",
    workflowState: "evidence_only",
    reviewNote: null,
    ...over,
  };
}

/**
 * The broker answers newest first, which is the order a transcript reverses.
 *
 * It honours `metadataKind` the way the real one does, because that filter is
 * now the ONLY thing separating a still from ordinary proof: a fake that
 * ignored it would pass a reader that had stopped filtering at all.
 */
function brokerOf(rows: ComputerUseArtifactView[]): SceneStillArtifactSource {
  return {
    listArtifacts: vi.fn((args: { metadataKind?: string | null }) => (
      args.metadataKind
        ? rows.filter((row) => row.metadata?.kind === args.metadataKind)
        : rows
    )),
  };
}

const still = (
  id: string,
  voiceCallId: string | null,
  sceneTitle?: string,
): ComputerUseArtifactView =>
  artifact({
    id,
    uri: `.ade/artifacts/computer-use/${id}.png`,
    metadata: {
      kind: "scene_still",
      sceneScopeKey: voiceCallId ?? "chat",
      ...(voiceCallId ? { voiceCallId } : {}),
      ...(sceneTitle ? { sceneTitle } : {}),
    },
  });

/**
 * The one contract the desktop handler and the runtime action share about a
 * missing key, which is what decides whether a picture is an INDEX or EVIDENCE.
 * Two sides disagreed about it before: in process a blank key filed an index
 * row nothing could look up, and over the runtime action a missing key is
 * exactly what marks a call as the Proof button — so the same still landed in
 * the drawer. Typed, because the desktop handler catches this one and answers
 * null instead of logging a failure.
 */
describe("requireSceneStillScopeKey", () => {
  it("trims a real key and refuses every spelling of none", () => {
    expect(requireSceneStillScopeKey("  row-1:aa  ")).toBe("row-1:aa");
    for (const blank of ["", "   ", null, undefined, 7, {}]) {
      expect(() => requireSceneStillScopeKey(blank)).toThrow(SceneStillScopeKeyError);
    }
  });
});

describe("findVoiceCallStills", () => {
  it("keeps this call's stills, in the order they were drawn", () => {
    const broker = brokerOf([
      still("c", "call-1", "PRs"),
      still("b", "call-1", "Lanes"),
      still("a", "call-1", "Today"),
    ]);

    const found = findVoiceCallStills(broker, { sessionId: "session-1", callId: "call-1" });

    expect(found).toEqual([
      { artifactId: "a", uri: ".ade/artifacts/computer-use/a.png", title: "Today" },
      { artifactId: "b", uri: ".ade/artifacts/computer-use/b.png", title: "Lanes" },
      { artifactId: "c", uri: ".ade/artifacts/computer-use/c.png", title: "PRs" },
    ]);
    // Asked of the QUERY, not filtered afterwards: a session with a page of
    // ordinary proof would otherwise fill the scan window with it and push the
    // call's own pictures off the end.
    expect(broker.listArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKind: "chat_session",
        ownerId: "session-1",
        metadataKind: "scene_still",
      }),
    );
  });

  /**
   * One CTO session holds every call the project ever had, and every ordinary
   * capture besides. The call id is the filter that makes the read this call's.
   */
  it("leaves another call's stills, and every artifact that is not one", () => {
    const found = findVoiceCallStills(
      brokerOf([
        still("mine", "call-1"),
        still("theirs", "call-2"),
        // A scene still from a chat, not a call: no call id on it at all.
        still("chat", null),
        // An ordinary capture that happens to be on the same session.
        artifact({ id: "shot", metadata: { kind: "screenshot" } }),
      ]),
      { sessionId: "session-1", callId: "call-1" },
    );

    expect(found.map((row) => row.artifactId)).toEqual(["mine"]);
  });

  it("falls back to the artifact's own title when the still carried none", () => {
    const found = findVoiceCallStills(
      brokerOf([artifact({
        id: "a",
        title: "Snapshot",
        metadata: { kind: "scene_still", sceneScopeKey: "call-1", voiceCallId: "call-1" },
      })]),
      { sessionId: "session-1", callId: "call-1" },
    );

    expect(found[0]?.title).toBe("Snapshot");
  });

  /**
   * A record without its pictures is a smaller loss than a hang-up that throws,
   * and the broker is optional on the runtime in the first place.
   */
  it("answers nothing rather than failing when there is nobody to ask", () => {
    expect(findVoiceCallStills(null, { sessionId: "session-1", callId: "call-1" })).toEqual([]);
    expect(findVoiceCallStills(brokerOf([still("a", "call-1")]), {
      sessionId: null,
      callId: "call-1",
    })).toEqual([]);
    expect(findVoiceCallStills(brokerOf([still("a", "call-1")]), {
      sessionId: "session-1",
      callId: null,
    })).toEqual([]);
    expect(findVoiceCallStills(
      { listArtifacts: () => { throw new Error("database is locked"); } },
      { sessionId: "session-1", callId: "call-1" },
    )).toEqual([]);
  });
});
