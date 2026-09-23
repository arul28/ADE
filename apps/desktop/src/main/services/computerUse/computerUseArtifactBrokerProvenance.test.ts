import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createComputerUseArtifactBrokerService } from "./computerUseArtifactBrokerService";

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
}

const MAC_EPOCH_OFFSET = 2_082_844_800;

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/** A tiny MP4 whose mvhd says it was made at `createdAt` (null writes 0). */
function mp4Bytes(createdAt: Date | null, filler = 0): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(createdAt ? createdAt.getTime() / 1000 + MAC_EPOCH_OFFSET : 0, 4);
  return Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\0\0", "latin1")),
    box("mdat", Buffer.alloc(256, filler)),
    box("moov", box("mvhd", mvhd)),
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("computerUseArtifactBroker proof provenance", () => {
  let projectRoot: string;
  let db: AdeDb;
  let turnStartedAt: string | null;

  beforeEach(async () => {
    projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-proof-provenance-")));
    db = await openKvDb(path.join(projectRoot, ".ade.db"), createLogger());
    db.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-1", projectRoot, "ADE", "main", "2026-09-23T00:00:00.000Z", "2026-09-23T00:00:00.000Z"],
    );
    turnStartedAt = null;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const makeBroker = () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: createLogger(),
    });
    broker.setChatTurnStartResolver(() => turnStartedAt);
    return broker;
  };

  const writeCacheFile = (name: string, bytes: Buffer): string => {
    const dir = path.join(projectRoot, ".ade", "cache");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };

  const attach = (broker: ReturnType<typeof makeBroker>, file: string, title: string) => broker.ingestAsync({
    backend: { name: "ade-cli", style: "manual", toolName: "proof attach" },
    owners: [{ kind: "chat_session", id: "chat-1" }],
    inputs: [{ kind: "video_recording", title, path: file }],
  });

  const storedFiles = (): string[] => {
    const dir = path.join(projectRoot, ".ade", "artifacts", "computer-use");
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };

  it("stamps an attach with its source, hash, and size", async () => {
    const bytes = mp4Bytes(null, 1);
    const result = await attach(makeBroker(), writeCacheFile("a.mp4", bytes), "First");
    expect(result.artifacts[0]!.metadata).toMatchObject({
      proofSource: "attached",
      contentSha256: sha256(bytes),
      contentBytes: bytes.length,
    });
    expect(result.warnings).toBeUndefined();
  });

  it("refuses a renamed copy of existing proof and names the earlier one", async () => {
    const broker = makeBroker();
    const bytes = mp4Bytes(null, 2);
    await attach(broker, writeCacheFile("google-search.mp4", bytes), "Google search");
    const before = storedFiles().length;

    await expect(attach(broker, writeCacheFile("safari-reddit-search.mp4", bytes), "Safari Reddit search"))
      .rejects.toThrow(/^PROOF_DUPLICATE: Same bytes as "Google search" \(filed .+\)\. This file is already proof\. Record a new one, or report that recording failed\.$/);
    // The staged copy of the refused file is removed, and no row is written.
    expect(storedFiles()).toHaveLength(before);
    expect(broker.listArtifacts({})).toHaveLength(1);
  });

  it("accepts different bytes", async () => {
    const broker = makeBroker();
    await attach(broker, writeCacheFile("one.mp4", mp4Bytes(null, 3)), "One");
    await attach(broker, writeCacheFile("two.mp4", mp4Bytes(null, 4)), "Two");
    expect(broker.listArtifacts({})).toHaveLength(2);
  });

  it("refuses the same bytes twice in one call", async () => {
    const bytes = mp4Bytes(null, 5);
    const broker = makeBroker();
    await expect(broker.ingestAsync({
      backend: { name: "ade-cli", style: "manual" },
      inputs: [
        { kind: "video_recording", title: "A", path: writeCacheFile("x.mp4", bytes) },
        { kind: "video_recording", title: "B", path: writeCacheFile("y.mp4", bytes) },
      ],
    })).rejects.toThrow(/PROOF_DUPLICATE: Same bytes as "A"/);
    expect(broker.listArtifacts({})).toHaveLength(0);
  });

  it("does not block ADE's own recorder, and records its start and stop", async () => {
    const broker = makeBroker();
    const bytes = mp4Bytes(null, 6);
    await attach(broker, writeCacheFile("first.mp4", bytes), "First");
    const recorded = await broker.ingestAsync({
      backend: { name: "apple-device", style: "local_fallback", toolName: "apple_record" },
      provenance: {
        source: "ade-recorder",
        recordedFrom: "2026-09-23T10:24:00.000Z",
        recordedTo: "2026-09-23T10:25:10.000Z",
      },
      inputs: [{ kind: "video_recording", title: "Recorder", path: writeCacheFile("rec.mp4", bytes) }],
    });
    expect(recorded.artifacts[0]!.metadata).toMatchObject({
      proofSource: "ade-recorder",
      recordedFrom: "2026-09-23T10:24:00.000Z",
      recordedTo: "2026-09-23T10:25:10.000Z",
      contentSha256: sha256(bytes),
    });
  });

  it("stamps ade-capture and ignores a caller's own provenance claims", async () => {
    const broker = makeBroker();
    const capture = await broker.ingestAsync({
      backend: { name: "apple-device", toolName: "apple_screenshot" },
      provenance: { source: "ade-capture" },
      inputs: [{ kind: "screenshot", title: "Shot", path: writeCacheFile("shot.png", Buffer.from("png-1")) }],
    });
    expect(capture.artifacts[0]!.metadata.proofSource).toBe("ade-capture");
    expect(capture.artifacts[0]!.metadata.recordedFrom).toBeUndefined();

    const spoofed = await broker.ingestAsync({
      backend: { name: "ade-cli" },
      inputs: [{
        kind: "screenshot",
        title: "Spoof",
        path: writeCacheFile("spoof.png", Buffer.from("png-2")),
        metadata: { proofSource: "ade-recorder", recordedBeforeRequest: false, contentSha256: "abc", note: "kept" },
      }],
    });
    expect(spoofed.artifacts[0]!.metadata).toMatchObject({ proofSource: "attached", note: "kept" });
    expect(spoofed.artifacts[0]!.metadata.contentSha256).toBe(sha256(Buffer.from("png-2")));
  });

  it("hashes an older row with no stored hash only when its size matches", async () => {
    const broker = makeBroker();
    const legacyDir = path.join(projectRoot, ".ade", "artifacts", "computer-use");
    fs.mkdirSync(legacyDir, { recursive: true });
    const bytes = mp4Bytes(null, 7);
    fs.writeFileSync(path.join(legacyDir, "legacy-same.mp4"), bytes);
    fs.writeFileSync(path.join(legacyDir, "legacy-other.mp4"), Buffer.concat([bytes, Buffer.from("x")]));
    const insertLegacy = (id: string, file: string, title: string) => db.run(
      `insert into computer_use_artifacts(
         id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
         original_type, title, description, uri, storage_kind, mime_type, metadata_json, lane_id, created_at
       ) values (?, 'project-1', 'video_recording', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', 'video/mp4', '{}', null, ?)`,
      [id, title, `.ade/artifacts/computer-use/${file}`, "2026-09-23T05:19:00.000Z"],
    );
    insertLegacy("legacy-other", "legacy-other.mp4", "Other size");
    insertLegacy("legacy-same", "legacy-same.mp4", "Old recording");

    await expect(attach(broker, writeCacheFile("copy.mp4", bytes), "Copy"))
      .rejects.toThrow(/PROOF_DUPLICATE: Same bytes as "Old recording"/);
    const readMeta = (id: string) => JSON.parse(db.get<{ metadata_json: string }>(
      "select metadata_json from computer_use_artifacts where id = ?",
      [id],
    )!.metadata_json);
    // The matching row was hashed and the hash kept; the other size never was.
    expect(readMeta("legacy-same")).toMatchObject({ contentSha256: sha256(bytes), contentBytes: bytes.length });
    expect(readMeta("legacy-other").contentSha256).toBeUndefined();
  });

  it("refuses a copy of an Apple recording that never reached the drawer", async () => {
    const broker = makeBroker();
    const laneDir = path.join(projectRoot, ".ade", "artifacts", "apple-recordings", "lane-1");
    fs.mkdirSync(laneDir, { recursive: true });
    const bytes = mp4Bytes(null, 8);
    fs.writeFileSync(path.join(laneDir, "rec-1.mp4"), bytes);
    fs.writeFileSync(path.join(laneDir, "rec-1.json"), JSON.stringify({
      id: "rec-1",
      label: "Simulator recording · iPhone · 0:12",
      startedAt: "2026-09-23T05:19:00.000Z",
      proofArtifactId: null,
    }));
    await expect(attach(broker, writeCacheFile("safari.mp4", bytes), "Safari"))
      .rejects.toThrow(/PROOF_DUPLICATE: Same bytes as "Simulator recording · iPhone · 0:12"/);
  });

  it("attaches an Apple recording whose filing failed, in place, without calling it a copy of itself", async () => {
    const broker = makeBroker();
    const laneDir = path.join(projectRoot, ".ade", "artifacts", "apple-recordings", "lane-1");
    fs.mkdirSync(laneDir, { recursive: true });
    const bytes = mp4Bytes(null, 15);
    const recording = path.join(laneDir, "rec-2.mp4");
    fs.writeFileSync(recording, bytes);
    fs.writeFileSync(path.join(laneDir, "rec-2.json"), JSON.stringify({
      id: "rec-2",
      label: "Simulator recording · iPhone · 0:09",
      startedAt: "2026-09-23T05:19:00.000Z",
      proofArtifactId: null,
    }));
    const result = await attach(broker, recording, "Checkout flow");
    expect(result.artifacts[0]!.uri).toBe(".ade/artifacts/apple-recordings/lane-1/rec-2.mp4");
    expect(result.artifacts[0]!.metadata).toMatchObject({ contentSha256: sha256(bytes), contentBytes: bytes.length });
    // A copy of it is still refused.
    await expect(attach(broker, writeCacheFile("copy-of-rec.mp4", bytes), "Copy"))
      .rejects.toThrow(/PROOF_DUPLICATE: Same bytes as "Checkout flow"/);
  });

  it("does not hash ADE's own recording at filing time, but still catches a later copy of it", async () => {
    const broker = makeBroker();
    const laneDir = path.join(projectRoot, ".ade", "artifacts", "apple-recordings", "lane-1");
    fs.mkdirSync(laneDir, { recursive: true });
    const bytes = mp4Bytes(null, 16);
    const recording = path.join(laneDir, "rec-3.mp4");
    fs.writeFileSync(recording, bytes);
    const filed = await broker.ingestAsync({
      backend: { name: "apple-device", style: "local_fallback", toolName: "apple_record" },
      owners: [{ kind: "lane", id: "lane-1" }],
      provenance: { source: "ade-recorder" },
      inputs: [{ kind: "video_recording", title: "Recorder", path: recording }],
    });
    expect(filed.artifacts[0]!.metadata.contentSha256).toBeUndefined();
    expect(filed.artifacts[0]!.metadata.contentBytes).toBe(bytes.length);
    // The streamed attach finds it by size, hashes it once, and refuses the copy.
    await expect(broker.ingestAsync({
      backend: { name: "ade-cli", style: "manual", toolName: "proof attach" },
      owners: [{ kind: "chat_session", id: "chat-1" }],
      inputs: [{ kind: "video_recording", title: "Copy", path: writeCacheFile("rec-copy.mp4", bytes) }],
    })).rejects.toThrow(/PROOF_DUPLICATE: Same bytes as "Recorder"/);
    expect(storedFiles()).toHaveLength(0);
  });

  it("streams the hash of an attached file already in the store", async () => {
    const broker = makeBroker();
    const dir = path.join(projectRoot, ".ade", "artifacts", "manual");
    fs.mkdirSync(dir, { recursive: true });
    const bytes = mp4Bytes(null, 17);
    fs.writeFileSync(path.join(dir, "clip.mp4"), bytes);
    const result = await broker.ingestAsync({
      backend: { name: "ade-cli", style: "manual", toolName: "proof attach" },
      owners: [{ kind: "chat_session", id: "chat-1" }],
      inputs: [{ kind: "video_recording", title: "Clip", path: path.join(dir, "clip.mp4") }],
    });
    expect(result.artifacts[0]!.metadata).toMatchObject({ contentSha256: sha256(bytes), contentBytes: bytes.length });
  });

  it("regression: files a capture whose bytes changed after ADE hashed them as an attach", async () => {
    const broker = makeBroker();
    const bytes = mp4Bytes(null, 18);
    await attach(broker, writeCacheFile("earlier.mp4", bytes), "Earlier");
    const capture = (file: string, capturedSha256: string[]) => broker.ingestAsync({
      backend: { name: "ade-cli", style: "manual", toolName: "proof attach" },
      owners: [{ kind: "chat_session", id: "chat-1" }],
      provenance: { source: "ade-recorder", refuseDuplicates: false, flagOlderMedia: true, capturedSha256 },
      inputs: [{ kind: "video_recording", title: "Capture", path: file }],
    });

    const fresh = mp4Bytes(null, 19);
    const kept = await capture(writeCacheFile("fresh.mp4", fresh), [sha256(fresh)]);
    expect(kept.artifacts[0]!.metadata).toMatchObject({ proofSource: "ade-recorder", contentSha256: sha256(fresh) });
    // Old proof swapped in after the registry hashed the capture: an attach, so the duplicate check runs.
    await expect(capture(writeCacheFile("swapped.mp4", bytes), [sha256(mp4Bytes(null, 20))]))
      .rejects.toThrow(/PROOF_DUPLICATE: Same bytes as "Earlier"/);
    const other = mp4Bytes(null, 21);
    const downgraded = await capture(writeCacheFile("other.mp4", other), [sha256(mp4Bytes(null, 22))]);
    expect(downgraded.artifacts[0]!.metadata.proofSource).toBe("attached");
  });

  it("never hashes a stored file on the calling thread: the sync door sends that attach to ingestAsync", () => {
    const broker = makeBroker();
    const dir = path.join(projectRoot, ".ade", "artifacts", "manual");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "in-place.mp4"), mp4Bytes(null, 23));
    expect(() => broker.ingest({
      backend: { name: "ade-cli", style: "manual", toolName: "proof attach" },
      owners: [{ kind: "chat_session", id: "chat-1" }],
      inputs: [{ kind: "video_recording", title: "Clip", path: path.join(dir, "in-place.mp4") }],
    })).toThrow(/ingestAsync/);
    expect(broker.listArtifacts({})).toHaveLength(0);
  });

  describe("age of an attached video", () => {
    const turn = new Date("2026-09-23T10:00:00.000Z");

    it("flags a video made before the chat's turn started, and warns", async () => {
      turnStartedAt = turn.toISOString();
      const made = new Date(turn.getTime() - 5 * 60 * 60 * 1000);
      const result = await attach(makeBroker(), writeCacheFile("old.mp4", mp4Bytes(made, 9)), "Old");
      expect(result.artifacts[0]!.metadata).toMatchObject({
        mediaCreatedAt: made.toISOString(),
        recordedBeforeRequest: true,
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toMatch(
        /^This video was recorded at .+, before this request\. It will be marked as older in the proof drawer\.$/,
      );
    });

    it("does not flag a video made after the turn started, or within the slack", async () => {
      turnStartedAt = turn.toISOString();
      const broker = makeBroker();
      const after = await attach(broker, writeCacheFile("new.mp4", mp4Bytes(new Date(turn.getTime() + 30_000), 10)), "New");
      expect(after.artifacts[0]!.metadata.recordedBeforeRequest).toBeUndefined();
      expect(after.artifacts[0]!.metadata.mediaCreatedAt).toBe(new Date(turn.getTime() + 30_000).toISOString());
      const slack = await attach(broker, writeCacheFile("slack.mp4", mp4Bytes(new Date(turn.getTime() - 30_000), 11)), "Slack");
      expect(slack.artifacts[0]!.metadata.recordedBeforeRequest).toBeUndefined();
      expect(after.warnings).toBeUndefined();
    });

    it("does not flag an unknown creation time or a chat with no turn", async () => {
      turnStartedAt = turn.toISOString();
      const unknown = await attach(makeBroker(), writeCacheFile("zero.mp4", mp4Bytes(null, 12)), "Zero");
      expect(unknown.artifacts[0]!.metadata.mediaCreatedAt).toBeUndefined();
      expect(unknown.artifacts[0]!.metadata.recordedBeforeRequest).toBeUndefined();

      turnStartedAt = null;
      const noTurn = await attach(makeBroker(), writeCacheFile("noturn.mp4", mp4Bytes(new Date("2020-01-01T00:00:00Z"), 13)), "No turn");
      expect(noTurn.artifacts[0]!.metadata.recordedBeforeRequest).toBeUndefined();
    });

    it("never flags ADE's own recorder", async () => {
      turnStartedAt = turn.toISOString();
      const result = await makeBroker().ingestAsync({
        backend: { name: "apple-device", toolName: "apple_record" },
        owners: [{ kind: "chat_session", id: "chat-1" }],
        provenance: { source: "ade-recorder" },
        inputs: [{
          kind: "video_recording",
          title: "Recorder",
          path: writeCacheFile("rec-old.mp4", mp4Bytes(new Date(turn.getTime() - 3_600_000), 14)),
        }],
      });
      expect(result.artifacts[0]!.metadata.recordedBeforeRequest).toBeUndefined();
      expect(result.warnings).toBeUndefined();
    });
  });
});
