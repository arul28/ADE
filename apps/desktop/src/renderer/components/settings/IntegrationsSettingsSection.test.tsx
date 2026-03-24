/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IntegrationsSettingsSection } from "./IntegrationsSettingsSection";

vi.mock("./GitHubSection", () => ({
  GitHubSection: () => <div>GitHub section</div>,
}));

vi.mock("./LinearSection", () => ({
  LinearSection: () => <div>Linear section</div>,
}));

vi.mock("./ExternalMcpSection", () => ({
  ExternalMcpSection: () => <div>Managed MCP section</div>,
}));

vi.mock("./ComputerUseSection", () => ({
  ComputerUseSection: () => <div>Computer Use section</div>,
}));

afterEach(cleanup);

describe("IntegrationsSettingsSection", () => {
  it("opens the managed MCP tab from the integration search param", () => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=integrations&integration=managed-mcp"]}>
        <IntegrationsSettingsSection />
      </MemoryRouter>,
    );

    expect(screen.getByText("Managed MCP section")).toBeTruthy();
    expect(screen.queryByText("GitHub section")).toBeNull();
  });

  it("switches between integrations sub-tabs", () => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=integrations"]}>
        <IntegrationsSettingsSection />
      </MemoryRouter>,
    );

    expect(screen.getByText("GitHub section")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Managed MCP" }));
    expect(screen.getByText("Managed MCP section")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Computer Use" }));
    expect(screen.getByText("Computer Use section")).toBeTruthy();
  });
});
