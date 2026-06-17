import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getProjectDetail, parseDirtyStatus } from "./projectDetailService";
import { writeGlobalState } from "../state/globalState";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseDirtyStatus", () => {
  it("returns zeros for a clean tree", () => {
    expect(parseDirtyStatus("")).toEqual({
      count: 0,
      breakdown: { staged: 0, unstaged: 0, untracked: 0 },
    });
  });

  it("counts untracked files via the '??' code", () => {
    const raw = ["?? new-file.ts", "?? docs/another.md"].join("\n");
    expect(parseDirtyStatus(raw)).toEqual({
      count: 2,
      breakdown: { staged: 0, unstaged: 0, untracked: 2 },
    });
  });

  it("splits staged (X) vs unstaged (Y) porcelain columns", () => {
    // "M " = staged modification; " M" = unstaged modification; "MM" = both.
    const raw = ["M  staged.ts", " M unstaged.ts", "MM both.ts"].join("\n");
    const { count, breakdown } = parseDirtyStatus(raw);
    expect(count).toBe(3);
    expect(breakdown.staged).toBe(2); // staged.ts + both.ts
    expect(breakdown.unstaged).toBe(2); // unstaged.ts + both.ts
    expect(breakdown.untracked).toBe(0);
  });

  it("matches the total dirty count to the number of porcelain lines", () => {
    const raw = ["A  added.ts", " D deleted.ts", "?? untracked.ts", "R  old -> new.ts"].join("\n");
    const { count, breakdown } = parseDirtyStatus(raw);
    expect(count).toBe(4);
    expect(breakdown).toEqual({ staged: 2, unstaged: 1, untracked: 1 });
  });

  it("ignores blank trailing lines", () => {
    const raw = "?? a.ts\n\n";
    expect(parseDirtyStatus(raw).count).toBe(1);
  });
});

describe("getProjectDetail recent metadata", () => {
  it("ignores remote recents when matching a local project root", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-detail-local-recent-"));
    tempDirs.push(rootPath);
    const globalStatePath = path.join(rootPath, "state.json");
    writeGlobalState(globalStatePath, {
      recentProjects: [
        {
          rootPath,
          displayName: "Remote twin",
          lastOpenedAt: "2026-05-10T00:00:00.000Z",
          remote: {
            targetId: "target-1",
            projectId: "project-1",
            runtimeName: "Studio",
            hostname: "studio.local",
          },
        },
        {
          rootPath,
          displayName: "Local",
          lastOpenedAt: "2026-05-09T00:00:00.000Z",
        },
      ],
    });

    const detail = await getProjectDetail(rootPath, { globalStatePath });

    expect(detail.lastOpenedAt).toBe("2026-05-09T00:00:00.000Z");
  });
});
