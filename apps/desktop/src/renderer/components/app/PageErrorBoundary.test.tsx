/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageErrorBoundary } from "./PageErrorBoundary";

vi.mock("../../lib/debugLog", () => ({ logRendererDebugEvent: vi.fn() }));
vi.mock("./ReportIssueButton", () => ({ ReportIssueButton: () => <button type="button">Report issue</button> }));

function Boom(): JSX.Element {
  throw new Error("the route blew up");
}

function CurrentRoute(): JSX.Element {
  const location = useLocation();
  return <div data-testid="route">{location.pathname}</div>;
}

function renderAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <CurrentRoute />
      <Routes>
        <Route path="/work/*" element={<PageErrorBoundary><Boom /></PageErrorBoundary>} />
        <Route path="/prs" element={<PageErrorBoundary><Boom /></PageErrorBoundary>} />
        <Route path="/lanes" element={<div>Lanes</div>} />
        <Route path="/work" element={<div>Work</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // React logs the caught render error; the boundary is what is under test.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PageErrorBoundary", () => {
  it("leaves a crashed Work route instead of remounting it", () => {
    renderAt("/work/chat-1");

    fireEvent.click(screen.getByRole("button", { name: "Go to Lanes" }));

    expect(screen.getByTestId("route").textContent).toBe("/lanes");
  });

  it("sends every other crashed route home to Work", () => {
    renderAt("/prs");

    fireEvent.click(screen.getByRole("button", { name: "Go to Work" }));

    expect(screen.getByTestId("route").textContent).toBe("/work");
  });
});
