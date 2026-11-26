import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROOF_LISTING_ARTIFACT_FILTER, type ComputerUseArtifactView } from "../../../shared/types";
import { openFreshKvDb } from "../../../test/freshKvDb";
import type { CtoMachineTarget, CtoRemoteActionCall } from "../ai/tools/ctoCrossMachine";
import { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import type { AdeDb } from "../state/kvDb";
import { importRemoteChatProof } from "./ctoProofShare";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
const studio: CtoMachineTarget = { machineId: "machine-studio", name: "Studio", isThisMachine: false };

/**
 * Another machine holding one child chat's screenshot: it lists the record and
 * serves `readArtifactRange` slices, the bridge calls `ctoProofShare` makes.
 */
function otherMachine(bytes: Buffer) {
  const remote: ComputerUseArtifactView = {
    id: "remote-shot",
    kind: "screenshot",
    title: "Settings saved",
    uri: ".ade/artifacts/computer-use/shot.png",
    storageKind: "file",
    mimeType: "image/png",
    availability: "available",
    metadata: { turnId: "turn-1" },
    createdAt: "2026-11-25T10:00:00.000Z",
  } as unknown as ComputerUseArtifactView;
  // An earlier turn's screenshot, filed before the one above.
  const older = {
    ...remote,
    id: "remote-older",
    title: "Before the change",
    uri: ".ade/artifacts/computer-use/older.png",
    metadata: { turnId: "turn-0" },
    createdAt: "2026-11-25T09:00:00.000Z",
  } as unknown as ComputerUseArtifactView;
  const calls: CtoRemoteActionCall[] = [];
  const runAction = async (_machine: CtoMachineTarget, call: CtoRemoteActionCall): Promise<unknown> => {
    calls.push(call);
    if (call.action === "listArtifacts") return [remote, older];
    const offset = Number(call.args?.offset ?? 0);
    const end = Math.min(bytes.length, offset + 4);
    // Let the other caller run between slices, as a real network round trip does.
    await new Promise((resolve) => setImmediate(resolve));
    return { data: bytes.subarray(offset, end).toString("base64"), totalSize: bytes.length };
  };
  return { remote, older, calls, runAction };
}

describe("importRemoteChatProof", () => {
  let projectRoot: string;
  let db: AdeDb;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-proof-share-"));
    db = await openFreshKvDb(path.join(projectRoot, ".ade.db"), logger);
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["project-1", projectRoot, "ADE", "main", "2026-11-25T00:00:00.000Z", "2026-11-25T00:00:00.000Z"],
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("copies a remote proof home once, even for two callers at once, and keeps showing it after the original is gone or its machine sleeps", async () => {
    const broker = createComputerUseArtifactBrokerService({ db, projectId: "project-1", projectRoot, logger });
    const png = Buffer.from("\x89PNG proof bytes that span several slices");
    const machine = otherMachine(png);
    const pull = () => importRemoteChatProof({
      broker,
      runAction: machine.runAction,
      machine: studio,
      chatSessionId: "child-chat",
      ctoSessionId: "cto-chat",
      selection: "latest",
      scratchDir: path.join(projectRoot, ".ade", "tmp", "cto-proof"),
      logger,
    });
    const ctoOwned = () => broker.listArtifacts({
      ownerKind: "chat_session",
      ownerId: "cto-chat",
      limit: 50,
      ...PROOF_LISTING_ARTIFACT_FILTER,
    });

    // A child's report wake and the CTO's own getChatProof can ask together.
    const [first, second] = await Promise.all([pull(), pull()]);

    expect(ctoOwned()).toHaveLength(1);
    const copy = ctoOwned()[0]!;
    expect(first.shown.map((item) => item.artifactId)).toEqual([copy.id]);
    expect(second.shown.map((item) => item.artifactId)).toEqual([copy.id]);
    expect(first.shown[0]!.cite).toContain(`ade-proof://${copy.id}`);
    expect(fs.readFileSync(broker.resolveArtifactFilePath(copy)!)).toEqual(png);
    const slicesRead = machine.calls.filter((call) => call.action === "readArtifactRange").length;
    expect(slicesRead).toBe(Math.ceil(png.length / 4));

    // The file there is deleted (or that machine sleeps): the copy still shows.
    machine.remote.availability = "missing_file";
    const later = await pull();
    expect(later.skipped).toEqual([]);
    expect(later.shown.map((item) => item.artifactId)).toEqual([copy.id]);
    expect(machine.calls.filter((call) => call.action === "readArtifactRange")).toHaveLength(slicesRead);

    // The CTO also pulls the earlier turn, so its copy is filed here last.
    const earlier = await importRemoteChatProof({
      broker,
      runAction: machine.runAction,
      machine: studio,
      chatSessionId: "child-chat",
      ctoSessionId: "cto-chat",
      selection: { turnId: "turn-0" },
      scratchDir: path.join(projectRoot, ".ade", "tmp", "cto-proof"),
      logger,
    });
    expect(earlier.shown).toHaveLength(1);

    // That machine goes to sleep: the listing fails, and the copies still come
    // back, said to be copies, the newest by when that machine filed them.
    const asleepLatest = await importRemoteChatProof({
      broker,
      runAction: async () => { throw new Error("Studio is offline."); },
      machine: studio,
      chatSessionId: "child-chat",
      ctoSessionId: "cto-chat",
      selection: "latest",
      scratchDir: path.join(projectRoot, ".ade", "tmp", "cto-proof"),
      logger,
    });
    expect(asleepLatest.shown.map((item) => item.artifactId)).toEqual([copy.id]);
    const asleep = await importRemoteChatProof({
      broker,
      runAction: async () => { throw new Error("Studio is offline."); },
      machine: studio,
      chatSessionId: "child-chat",
      ctoSessionId: "cto-chat",
      selection: { turnId: "turn-1" },
      scratchDir: path.join(projectRoot, ".ade", "tmp", "cto-proof"),
      logger,
    });
    expect(asleep.shown.map((item) => item.artifactId)).toEqual([copy.id]);
    expect(asleep.shown[0]!.sourceArtifactId).toBe("remote-shot");
    expect(asleep.note).toMatch(/Studio is unreachable/);
  });
});
