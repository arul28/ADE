/* @vitest-environment jsdom */

import React, { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useAppStore } from "../../../state/appStore";
import { ProjectSidebar } from "./ProjectSidebar";
import {
  ProjectSidebarHold,
  ProjectSidebarSlot,
  ProjectSidebarSlotProvider,
  useProjectSidebarSlotTarget,
} from "./ProjectSidebarSlot";
import { setProjectSidebarHidden } from "./projectSidebarPrefs";
import {
  lastSettingsRoute,
  rememberProjectRoute,
  resetSettingsReturnRoutesForTest,
  settingsReturnRoute,
} from "./settingsReturnRoute";

const ROOT = "/Users/arul/ADE";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function renderSidebar(route: string, heldRoute: string | null = null) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <LocationProbe />
      <Routes>
        <Route path="*" element={<ProjectSidebar route={route} heldRoute={heldRoute} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectSidebar footer", () => {
  beforeEach(() => {
    useAppStore.setState({ project: { rootPath: ROOT, name: "ADE" }, projectBinding: null } as any);
  });

  afterEach(() => {
    cleanup();
    setProjectSidebarHidden(false);
    resetSettingsReturnRoutesForTest();
    window.localStorage.clear();
    delete (window as { __adeWebClient?: boolean }).__adeWebClient;
  });

  it("opens Help and toggles the detailed-tooltip preference", () => {
    const initialPreference = useAppStore.getState().smartTooltipsEnabled;
    renderSidebar("/work");
    const helpButton = screen.getByRole("button", { name: "Help menu" });

    fireEvent.click(helpButton);

    expect(screen.getByRole("menu", { name: "Help" })).toBeTruthy();
    expect(helpButton.getAttribute("aria-expanded")).toBe("true");
    const preference = screen.getByRole("menuitemcheckbox");
    expect(preference.getAttribute("aria-checked")).toBe(String(initialPreference));

    fireEvent.click(preference);
    expect(useAppStore.getState().smartTooltipsEnabled).toBe(!initialPreference);
    fireEvent.click(preference);
    expect(useAppStore.getState().smartTooltipsEnabled).toBe(initialPreference);
  });

  it("opens Settings from the cog, and marks it active on the settings route", () => {
    renderSidebar("/work");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("location").textContent).toBe("/settings");

    cleanup();
    renderSidebar("/settings?tab=account");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
  });

  it("reopens the project's stored settings page", () => {
    window.localStorage.setItem(`ade:project-route:local:${ROOT}`, "/settings?tab=chat");
    renderSidebar("/work");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("location").textContent).toBe("/settings?tab=chat");
  });

  it("returns to where you were when the cog is clicked again", () => {
    renderSidebar("/prs?pr=1292");
    cleanup();
    renderSidebar("/settings?tab=account");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("title")).toBe("Back");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("location").textContent).toBe("/prs?pr=1292");
  });

  it("reopens the last settings section used in this session before the stored one", () => {
    window.localStorage.setItem(`ade:project-route:local:${ROOT}`, "/settings?tab=secrets");
    renderSidebar("/settings?tab=chat");
    cleanup();
    renderSidebar("/lanes");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("location").textContent).toBe("/settings?tab=chat");
  });

  it("keeps the held page's tab selected while the footer stays reachable", async () => {
    renderSidebar("/cto", "/prs?pr=1292");
    expect(screen.getByRole("button", { name: "PRs" }).getAttribute("aria-current")).toBe("page");
    // The footer no longer collapses to one Back row: both footer tabs stay
    // usable, so the page you are on is never the only way out.
    expect(screen.getByRole("button", { name: "CTO" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    // Pressing the open item keeps it open; CTO stays on its thread.
    fireEvent.click(screen.getByRole("button", { name: "CTO" }));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/cto");
    });
  });

  it("shows no Back chip when nothing is held", () => {
    renderSidebar("/cto");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});

function SlotHost({ children }: { children: React.ReactNode }) {
  const setTarget = useProjectSidebarSlotTarget();
  return <div ref={setTarget}>{children}</div>;
}

function FocusQueueReportProbe({
  queue,
  onChange,
}: {
  queue: readonly string[];
  onChange: (queue: readonly string[]) => void;
}) {
  useEffect(() => {
    onChange(queue);
  }, [onChange, queue]);
  return null;
}

describe("settings return routes", () => {
  afterEach(() => {
    resetSettingsReturnRoutesForTest();
  });

  it("remembers the page you left and the settings section you opened", () => {
    rememberProjectRoute("local:/repo", "/prs?pr=12");
    rememberProjectRoute("local:/repo", "/settings?tab=account");
    rememberProjectRoute("local:/other", "/files");

    expect(settingsReturnRoute("local:/repo")).toBe("/prs?pr=12");
    expect(lastSettingsRoute("local:/repo")).toBe("/settings?tab=account");
    expect(settingsReturnRoute("local:/other")).toBe("/files");
    expect(settingsReturnRoute(null)).toBe("/work");
    expect(lastSettingsRoute("local:/missing")).toBeNull();
  });

  it("keeps the page under Settings when CTO or History opens on top", () => {
    rememberProjectRoute("local:/repo", "/prs?pr=12");
    rememberProjectRoute("local:/repo", "/settings?tab=account");
    rememberProjectRoute("local:/repo", "/cto");
    rememberProjectRoute("local:/repo", "/history");

    expect(settingsReturnRoute("local:/repo")).toBe("/prs?pr=12");
    expect(lastSettingsRoute("local:/repo")).toBe("/settings?tab=account");
  });
});

describe("ProjectSidebarSlot hold", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides the held list while another slot is active", () => {
    render(
      <ProjectSidebarSlotProvider>
        <SlotHost>
          <ProjectSidebarHold held>
            <ProjectSidebarSlot active={false}>
              <div>Held list</div>
            </ProjectSidebarSlot>
          </ProjectSidebarHold>
          <ProjectSidebarSlot active>
            <div>Settings sections</div>
          </ProjectSidebarSlot>
        </SlotHost>
      </ProjectSidebarSlotProvider>,
    );

    const held = screen.getByText("Held list").parentElement;
    const settings = screen.getByText("Settings sections").parentElement;
    expect(held?.hidden).toBe(true);
    expect(settings?.hidden).toBe(false);
  });
});

describe("ProjectSidebar Focus queue", () => {
  beforeEach(() => {
    useAppStore.setState({ project: { rootPath: ROOT, name: "ADE" }, projectBinding: null } as any);
  });

  afterEach(() => {
    cleanup();
    setProjectSidebarHidden(false);
    window.localStorage.clear();
  });

  it("keeps queue reports current while the sidebar is collapsed", () => {
    const reportedQueues: string[][] = [];
    const reportQueue = (queue: readonly string[]) => reportedQueues.push([...queue]);
    const tree = (queue: readonly string[]) => (
      <MemoryRouter initialEntries={["/work"]}>
        <ProjectSidebarSlotProvider>
          <ProjectSidebar route="/work" />
          <ProjectSidebarSlot active>
            <FocusQueueReportProbe queue={queue} onChange={reportQueue} />
          </ProjectSidebarSlot>
        </ProjectSidebarSlotProvider>
      </MemoryRouter>
    );

    const view = render(tree(["first-chat"]));
    expect(reportedQueues).toEqual([["first-chat"]]);

    act(() => setProjectSidebarHidden(true));
    view.rerender(tree(["second-chat"]));

    expect(reportedQueues).toEqual([["first-chat"], ["second-chat"]]);
  });
});
