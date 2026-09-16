import { describe, expect, it } from "vitest";
import { EMPTY_PR_DETAIL_BUNDLE, settlePrDetailBundle } from "./prDetailBundle";

describe("settlePrDetailBundle", () => {
  it("fills sidecars that reject with the empty bundle values", async () => {
    await expect(settlePrDetailBundle({
      status: async () => {
        throw new Error("missing");
      },
      checks: async () => [],
      reviews: async () => {
        throw new Error("missing");
      },
      comments: async () => [],
    })).resolves.toEqual({
      status: EMPTY_PR_DETAIL_BUNDLE.status,
      checks: [],
      reviews: EMPTY_PR_DETAIL_BUNDLE.reviews,
      comments: [],
    });
  });
});
