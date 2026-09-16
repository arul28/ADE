import { describe, expect, it } from "vitest";
import { mergeGeneratedPrDraft } from "./graphPrDraft";

describe("mergeGeneratedPrDraft", () => {
  const baseline = { title: "lane name", body: "" };

  it("applies generated copy when the fields are still the open-dialog baseline", () => {
    expect(mergeGeneratedPrDraft(
      { laneId: "lane-1", title: "lane name", body: "" },
      "lane-1",
      { title: "Generated title", body: "Generated body" },
      baseline,
    )).toEqual({
      laneId: "lane-1",
      title: "Generated title",
      body: "Generated body",
    });
  });

  it("does not replace a title or body the user already edited", () => {
    expect(mergeGeneratedPrDraft(
      { laneId: "lane-1", title: "typed title", body: "typed body" },
      "lane-1",
      { title: "Generated title", body: "Generated body" },
      baseline,
    )).toEqual({
      laneId: "lane-1",
      title: "typed title",
      body: "typed body",
    });
  });

  it("ignores a late draft for a different lane", () => {
    const prev = { laneId: "lane-2", title: "lane name", body: "" };
    expect(mergeGeneratedPrDraft(
      prev,
      "lane-1",
      { title: "Generated title", body: "Generated body" },
      baseline,
    )).toBe(prev);
  });
});
