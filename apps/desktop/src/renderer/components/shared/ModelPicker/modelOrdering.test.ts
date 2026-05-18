import { describe, expect, it } from "vitest";

import { sortModelItems } from "./modelOrdering";

describe("sortModelItems", () => {
  it("preserves the original order when no options are provided", () => {
    const items = [
      { modelId: "anthropic/claude-opus-4-7", label: "opus" },
      { modelId: "openai/gpt-5", label: "gpt" },
      { modelId: "anthropic/claude-sonnet-4-6", label: "sonnet" },
    ];
    expect(sortModelItems(items).map((i) => i.modelId)).toEqual([
      "anthropic/claude-opus-4-7",
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("groups favorites first when groupFavorites is enabled", () => {
    const items = [
      { modelId: "openai/gpt-5" },
      { modelId: "anthropic/claude-opus-4-7" },
      { modelId: "anthropic/claude-sonnet-4-6" },
    ];
    const sorted = sortModelItems(items, {
      favoriteModelIds: ["anthropic/claude-opus-4-7"],
      groupFavorites: true,
    });
    expect(sorted.map((i) => i.modelId)).toEqual([
      "anthropic/claude-opus-4-7",
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("does not move favorites when groupFavorites is false", () => {
    const items = [
      { modelId: "openai/gpt-5" },
      { modelId: "anthropic/claude-opus-4-7" },
    ];
    const sorted = sortModelItems(items, {
      favoriteModelIds: ["anthropic/claude-opus-4-7"],
      groupFavorites: false,
    });
    expect(sorted.map((i) => i.modelId)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-opus-4-7",
    ]);
  });

  it("honors an explicit modelIdOrder ahead of original order", () => {
    const items = [
      { modelId: "a" },
      { modelId: "b" },
      { modelId: "c" },
      { modelId: "d" },
    ];
    const sorted = sortModelItems(items, { modelIdOrder: ["c", "a"] });
    expect(sorted.map((i) => i.modelId)).toEqual(["c", "a", "b", "d"]);
  });

  it("combines favorites grouping with id ordering", () => {
    const items = [
      { modelId: "a" },
      { modelId: "b" },
      { modelId: "c" },
      { modelId: "d" },
    ];
    const sorted = sortModelItems(items, {
      favoriteModelIds: new Set(["c"]),
      groupFavorites: true,
      modelIdOrder: ["b", "d"],
    });
    expect(sorted.map((i) => i.modelId)).toEqual(["c", "b", "d", "a"]);
  });

  it("accepts a Set for favoriteModelIds", () => {
    const items = [{ modelId: "x" }, { modelId: "y" }];
    const sorted = sortModelItems(items, {
      favoriteModelIds: new Set(["y"]),
      groupFavorites: true,
    });
    expect(sorted.map((i) => i.modelId)).toEqual(["y", "x"]);
  });
});
