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

vi.mock("./AdeCliSection", () => ({
  AdeCliSection: () => <div>ADE CLI section</div>,
}));

afterEach(cleanup);

describe("IntegrationsSettingsSection", () => {
  it("opens the Linear tab from the integration search param", () => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=integrations&integration=linear"]}>
        <IntegrationsSettingsSection />
      </MemoryRouter>,
    );

    expect(screen.getByText("Linear section")).toBeTruthy();
    expect(screen.queryByText("GitHub section")).toBeNull();
  });

  it("switches between integrations sub-tabs", () => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=integrations"]}>
        <IntegrationsSettingsSection />
      </MemoryRouter>,
    );

    expect(screen.getByText("GitHub section")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Linear" }));
    expect(screen.getByText("Linear section")).toBeTruthy();
  });

  it("opens the ADE CLI sub-tab", () => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=integrations&integration=cli"]}>
        <IntegrationsSettingsSection />
      </MemoryRouter>,
    );

    expect(screen.getByText("ADE CLI section")).toBeTruthy();
    expect(screen.queryByText("GitHub section")).toBeNull();
  });
});
