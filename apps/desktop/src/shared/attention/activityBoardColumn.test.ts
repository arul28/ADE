import { describe, expect, it } from "vitest";

import type { AttentionItem } from "../types/attention";
import { activityBoardColumn } from "./activityBoardColumn";
import fixture from "./activityBoardColumn.cases.json";

type BoardColumnCase = {
  name: string;
  kind: AttentionItem["kind"];
  phase: AttentionItem["phase"];
  tier: AttentionItem["activityTier"] | null;
  boardColumn: string | null;
  expected: string | null;
};

describe("activityBoardColumn", () => {
  it.each((fixture as { cases: BoardColumnCase[] }).cases)("$name", (testCase) => {
    expect(activityBoardColumn({
      kind: testCase.kind,
      phase: testCase.phase,
      activityTier: testCase.tier ?? undefined,
      boardColumn: testCase.boardColumn as AttentionItem["boardColumn"],
    })).toBe(testCase.expected);
  });
});
