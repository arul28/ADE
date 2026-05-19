/* @vitest-environment jsdom */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionTabNavigation } from "./MissionTabContainer";
import { initialMissionsState, useMissionsStore } from "./useMissionsStore";

vi.mock("./MissionChatV2", () => ({
  MissionChatV2: () => null,
}));

describe("MissionTabNavigation", () => {
  beforeEach(() => {
    useMissionsStore.setState({ ...initialMissionsState, activeTab: "chat" });
  });

  it("exposes selected mission view state with tab semantics", () => {
    render(<MissionTabNavigation />);

    expect(screen.getByRole("tablist", { name: "Mission views" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Conversations" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("false");

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));

    expect(useMissionsStore.getState().activeTab).toBe("plan");
    expect(screen.getByRole("tab", { name: "Plan" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Conversations" }).getAttribute("aria-selected")).toBe("false");
  });
});
