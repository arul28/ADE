// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createViewportOverlayHost } from "./ViewportOverlayHost";

describe("ViewportOverlayHost", () => {
  it("marks DOM-only animation layers as hidden and inert", () => {
    const host = createViewportOverlayHost("chatFirstMessageHandoff");

    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.inert).toBe(true);
  });
});
