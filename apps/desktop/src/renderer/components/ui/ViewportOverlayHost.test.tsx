// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewportOverlayHost, createViewportOverlayHost } from "./ViewportOverlayHost";

describe("ViewportOverlayHost", () => {
  it("renders its child in the overlay host", () => {
    render(
      <ViewportOverlayHost layer="hud" testId="viewport-overlay">
        <button type="button">End call</button>
      </ViewportOverlayHost>,
    );

    expect(screen.getByRole("button", { name: "End call" })).toBeTruthy();
  });

  it("marks DOM-only animation layers as hidden and inert", () => {
    const host = createViewportOverlayHost("chatFirstMessageHandoff");

    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.inert).toBe(true);
  });
});
