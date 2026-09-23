/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ProductAnalyticsStatus } from "../../../shared/types/productAnalytics";
import { ProductAnalyticsSection } from "./ProductAnalyticsSection";

const STATUS: ProductAnalyticsStatus = {
  configured: true,
  enabled: true,
  effective: true,
  host: "https://analytics.test",
  dailyBudget: 500,
  acceptedToday: 0,
  droppedToday: 0,
  day: "2026-09-23",
};

beforeEach(() => {
  (window as unknown as { ade?: unknown }).ade = {
    analytics: {
      getStatus: async () => STATUS,
      setEnabled: async () => STATUS,
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ProductAnalyticsSection", () => {
  it("says the same switch sends a daily usage summary, and what it holds", async () => {
    render(<ProductAnalyticsSection />);
    expect(await screen.findByText(/Daily safety limit: 500 events/)).toBeTruthy();
    expect(screen.getByText(/anonymous usage events and a daily usage summary/)).toBeTruthy();
    const summary = screen.getByText(/one usage summary a day to ADE's own servers/);
    expect(summary.textContent).toContain("providers and models");
    expect(summary.textContent).toContain("token counts, costs, your plan tier, and the local hour");
    expect(summary.textContent).toContain("never includes prompts, file paths, or account emails");
  });
});
