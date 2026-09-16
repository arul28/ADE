import { describe, expect, it } from "vitest";
import type { PrCheck } from "./types";
import { EMPTY_PR_DETAIL_BUNDLE, settlePrDetailBundle } from "./prDetailBundle";

describe("settlePrDetailBundle", () => {
  it("fills sidecars that reject with the empty bundle values", async () => {
    await expect(settlePrDetailBundle({
      status: async () => {
        throw new Error("missing");
      },
      checks: async () => [{ id: "check-1" }] as PrCheck[],
      reviews: async () => {
        throw new Error("missing");
      },
      comments: async () => [],
    })).resolves.toEqual({
      status: EMPTY_PR_DETAIL_BUNDLE.status,
      checks: [{ id: "check-1" }],
      reviews: EMPTY_PR_DETAIL_BUNDLE.reviews,
      comments: [],
    });
  });
});
