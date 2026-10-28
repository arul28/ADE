import { describe, expect, it } from "vitest";
import { buildHistoryExport } from "./historyExport";

describe("buildHistoryExport", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1:A2)", "\t=1+1", "\n=1+1"])(
    "keeps formula-like lane names literal in CSV exports (%j)",
    (laneName) => {
      const { content } = buildHistoryExport({
        format: "csv",
        rows: [{
          id: "operation-1",
          laneId: "lane-1",
          laneName,
          kind: "commit",
          startedAt: "2026-10-28T12:00:00.000Z",
          endedAt: null,
          status: "succeeded",
          preHeadSha: null,
          postHeadSha: null,
          metadataJson: null,
        }],
        exportedAt: "2026-10-28T12:00:00.000Z",
        project: { rootPath: "/project", displayName: "Project" },
        filters: {},
      });

      expect(content).toContain(`'${laneName}`);
    },
  );
});
