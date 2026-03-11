// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TimelineEntry } from "./TimelineEntry";

describe("TimelineEntry", () => {
  it("expands child content when toggled", () => {
    render(
      <TimelineEntry
        timestamp="2026-03-05T10:00:00.000Z"
        title="Worker event"
        subtitle="details"
      >
        <div>Expanded body</div>
      </TimelineEntry>,
    );

    expect(screen.queryByText("Expanded body")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Expanded body")).toBeTruthy();
  });
});
