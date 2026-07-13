import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLastFailure, recordLastFailure } from "./lastFailureStore";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("lastFailureStore", () => {
  it("keeps the current report readable when a rotated replacement fails", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-last-failure-"));
    roots.push(projectRoot);
    const target = { kind: "project" as const, projectRoot };
    const first = recordLastFailure(target, {
      code: "disk_full",
      message: "Project data could not be saved.",
      component: "project_db_open",
      at: "2026-07-12T12:00:00.000Z",
    });
    expect(first).not.toBeNull();
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("replacement failed");
    });

    const replacement = recordLastFailure(target, {
      code: "db_integrity",
      message: "Project data needs attention.",
      component: "project_db_open",
      at: "2026-07-12T12:01:00.000Z",
    });

    expect(replacement).toBeNull();
    expect(readLastFailure(target)).toEqual(first);
  });
});
