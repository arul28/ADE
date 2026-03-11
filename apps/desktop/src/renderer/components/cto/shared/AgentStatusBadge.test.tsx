// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentStatusBadge } from "./AgentStatusBadge";

describe("AgentStatusBadge", () => {
  it("renders the mapped label for a worker status", () => {
    render(<AgentStatusBadge status="paused" />);
    expect(screen.getByText("Paused")).toBeTruthy();
  });
});
