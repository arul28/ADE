/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { LaneChip } from "./LaneChip";
import { openLaneInLanesTabPath } from "../../lib/laneNavigation";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <LaneChip
        laneName="UI audit lane"
        laneColor="#22c55e"
        onClick={() => navigate(openLaneInLanesTabPath("lane-1"))}
        aria-label="Open UI audit lane in Lanes tab"
      />
      <LocationProbe />
    </>
  );
}

describe("LaneChip", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens the lane in the Lanes tab when clicked", () => {
    render(
      <MemoryRouter initialEntries={["/work"]}>
        <Routes>
          <Route path="*" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open UI audit lane in Lanes tab/i }));
    expect(screen.getByTestId("location").textContent).toBe("/lanes?laneId=lane-1&focus=single");
  });
});
