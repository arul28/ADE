/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useAppStore } from "../../../state/appStore";
import { ProjectSidebar } from "./ProjectSidebar";
import { setProjectSidebarHidden } from "./projectSidebarPrefs";
import { resetSettingsReturnRoutesForTest } from "./settingsReturnRoute";

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

  it("keeps CTO and History, and puts a settings cog at the end", () => {
    renderSidebar("/work");
    const footerButtons = [...document.querySelectorAll(".ade-project-sidebar-footer button")];
    expect(footerButtons.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "CTO",
      "History",
      "Settings",
    ]);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBeNull();
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
    window.localStorage.setItem(`ade:project-route:local:${ROOT}`, "/settings?tab=appearance#theme");
    renderSidebar("/work");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("location").textContent).toBe("/settings?tab=appearance#theme");
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
    window.localStorage.setItem(`ade:project-route:local:${ROOT}`, "/settings?tab=appearance#theme");
    renderSidebar("/settings?tab=providers");
    cleanup();
    renderSidebar("/lanes");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("location").textContent).toBe("/settings?tab=providers");
  });

  it("keeps the page under CTO selected and turns the footer into one Back button", () => {
    renderSidebar("/cto", "/prs?pr=1292");
    expect(screen.getByRole("button", { name: "PRs" }).getAttribute("aria-current")).toBe("page");
    // The whole footer row is the way back; CTO and History leave it meanwhile.
    expect(screen.queryByRole("button", { name: "CTO" })).toBeNull();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("location").textContent).toBe("/prs?pr=1292");
  });

  it("shows no Back chip when nothing is held", () => {
    renderSidebar("/cto");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
