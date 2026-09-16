import { describe, expect, it } from "vitest";
import type { PrCheck } from "./types";
import { EMPTY_PR_DETAIL_BUNDLE, settlePrDetailBundle } from "./prDetailBundle";

const passingCheck: PrCheck = {
  name: "ci",
  status: "completed",
  conclusion: "success",
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
};

describe("settlePrDetailBundle", () => {
  it("fills sidecars that reject with the empty bundle values", async () => {
    await expect(settlePrDetailBundle({
      status: async () => {
        throw new Error("missing");
      },
      checks: async () => [passingCheck],
      reviews: async () => {
        throw new Error("missing");
      },
      comments: async () => [],
    })).resolves.toEqual({
      status: EMPTY_PR_DETAIL_BUNDLE.status,
      checks: [passingCheck],
      reviews: EMPTY_PR_DETAIL_BUNDLE.reviews,
      comments: [],
    });
  });
});
