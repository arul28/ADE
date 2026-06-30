import { describe, expect, it } from "vitest";
import { editorTabId } from "./editorGroupsStore";
import { filterTabsForScope, orderTabsByLane } from "./tabDisplayOrder";

const WS = "ws-1";

function tab(path: string, laneId: string | null) {
  return {
    id: editorTabId(WS, path),
    workspaceId: WS,
    laneId,
    path,
    title: path,
    viewerKind: "code" as const,
    languageId: "typescript",
    preview: false,
    pinned: false,
  };
}

describe("tabDisplayOrder", () => {
  it("orders tabs by lane order", () => {
    const lanes = [
      { id: "lane-a", color: "#f00" } as const,
      { id: "lane-b", color: "#0f0" } as const,
    ];
    const ordered = orderTabsByLane(
      [tab("b.ts", "lane-b"), tab("a.ts", "lane-a"), tab("primary.ts", null)],
      lanes as never,
    );
    expect(ordered.map((entry) => entry.path)).toEqual(["primary.ts", "a.ts", "b.ts"]);
  });

  it("filters tabs to the current lane in lane-only scope", () => {
    const tabs = [tab("a.ts", "lane-a"), tab("b.ts", "lane-b")];
    expect(filterTabsForScope(tabs, "lane", "lane-a").map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(filterTabsForScope(tabs, "all", "lane-a").map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);
  });
});
