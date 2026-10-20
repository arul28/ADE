import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMoveRecord } from "../../../shared/types/projectMove";
import { nonAsarFs } from "../shared/nonAsarFs";
import { currentBootMinute, readMoveRecord, writeMoveRecord, writeMovedMarker } from "../../../../../ade-cli/src/services/projects/projectMove/moveJournal";
import { createProjectMoveController } from "./projectMoveController";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-move-controller-")));
  vi.stubEnv("ADE_HOME", path.join(tmp, "ade-home"));
  vi.stubEnv("HOME", path.join(tmp, "home"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ProjectMoveController.cleanup", () => {
  it("joins concurrent deletes and treats a repeated delete as complete", async () => {
    const moveId = "move_cleanup_race";
    const parked = path.join(tmp, "drive", "old-project");
    const destination = path.join(tmp, "drive", "new-project");
    fs.mkdirSync(path.join(parked, ".ade"), { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    writeMovedMarker(parked, { movedTo: destination, moveId });
    const source = path.join(tmp, "old-project");
    const record: ProjectMoveRecord = {
      moveId,
      projectName: "old-project",
      sourceRoot: source,
      destinationRoot: destination,
      originalParkedAt: parked,
      originalBytes: 0,
      destinationVolumeUuid: null,
      destinationVolumeName: null,
      destinationInternal: false,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      state: "done",
      cleanup: { choice: "pending" },
      followUps: [],
      problems: [],
      pid: 0,
      bootMinute: currentBootMinute(),
      resume: { sourceSpellings: [source], knownPaths: [source], moveAgentHistory: false, outsideLanes: [] },
    };
    writeMoveRecord(record);

    const controller = createProjectMoveController({
      logger,
      getActivity: async () => ({ runningChats: [], openTerminals: [] }),
      releaseProject: async () => {},
      afterMove: async () => {},
      afterFailedMove: async () => {},
      emitProgress: () => {},
    });
    const remove = nonAsarFs.promises.rm.bind(nonAsarFs.promises);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let reportDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { reportDeleteStarted = resolve; });
    let blocked = false;
    const rmSpy = vi.spyOn(nonAsarFs.promises, "rm").mockImplementation(async (target, options) => {
      if (!blocked && path.resolve(String(target)) === parked) {
        blocked = true;
        reportDeleteStarted();
        await deleteGate;
      }
      return remove(target, options);
    });
    try {
      const first = controller.cleanup({ moveId, choice: "delete" });
      await deleteStarted;
      const second = controller.cleanup({ moveId, choice: "delete" });
      releaseDelete();
      const [firstRecord, secondRecord] = await Promise.all([first, second]);

      expect(firstRecord.cleanup.choice).toBe("deleted");
      expect(secondRecord.cleanup).toEqual(firstRecord.cleanup);
      expect(firstRecord.originalParkedAt).toBeNull();
      expect(fs.existsSync(parked)).toBe(false);
      expect(readMoveRecord(moveId)).toMatchObject({ state: "done", originalParkedAt: null, cleanup: { choice: "deleted" } });
      expect(rmSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === parked)).toHaveLength(1);

      const repeated = await controller.cleanup({ moveId, choice: "delete" });
      expect(repeated.cleanup.choice).toBe("deleted");
      expect(repeated.originalParkedAt).toBeNull();
      expect(rmSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === parked)).toHaveLength(1);
    } finally {
      rmSpy.mockRestore();
    }
  });
});
