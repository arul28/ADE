import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileService } from "./fileService";

describe("fileService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves non-escape filesystem errors while resolving workspace paths", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-"));
    const rootReal = fs.realpathSync(rootPath);
    const blockedPath = path.join(rootReal, "blocked");
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" as const });
    const originalLstatSync = fs.lstatSync.bind(fs);

    const laneService = {
      resolveWorkspaceById: vi.fn(() => ({
        id: "workspace-1",
        laneId: "lane-1",
        rootPath,
      })),
      getFilesWorkspaces: vi.fn(() => []),
    } as any;

    const service = createFileService({ laneService });
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((filePath: fs.PathLike) => {
      if (String(filePath) === blockedPath) {
        throw permissionError;
      }
      return originalLstatSync(filePath);
    }) as typeof fs.lstatSync);

    try {
      expect(() =>
        service.readFile({
          workspaceId: "workspace-1",
          path: "blocked/child.txt",
        })
      ).toThrow(permissionError);
    } finally {
      spy.mockRestore();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
