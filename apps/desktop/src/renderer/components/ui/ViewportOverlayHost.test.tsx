// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewportOverlayHost, createViewportOverlayHost } from "./ViewportOverlayHost";

describe("ViewportOverlayHost", () => {
  it("owns fixed viewport placement and uses the named stacking layer", () => {
    render(
      <ViewportOverlayHost layer="hud" testId="viewport-overlay">
        <button type="button">End call</button>
      </ViewportOverlayHost>,
    );

    const host = screen.getByTestId("viewport-overlay");
    expect(host.style.position).toBe("fixed");
    expect(host.style.inset).toBe("0");
    expect(host.style.zIndex).toBe("130");
    expect(host.style.pointerEvents).toBe("none");
    expect(screen.getByRole("button", { name: "End call" })).toBeTruthy();
  });

  it("marks DOM-only animation layers as inert and reuses the named layer", () => {
    const host = createViewportOverlayHost("chatFirstMessageHandoff", {
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px",
    });

    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.inert).toBe(true);
    expect(host.style.position).toBe("fixed");
    expect(host.style.zIndex).toBe("80");
    expect(host.style.pointerEvents).toBe("none");
  });
});
