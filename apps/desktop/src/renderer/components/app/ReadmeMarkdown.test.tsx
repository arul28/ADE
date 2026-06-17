/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ReadmeMarkdown } from "./ReadmeMarkdown";

afterEach(cleanup);

describe("ReadmeMarkdown", () => {
  it("renders raw README HTML instead of showing literal tags", () => {
    const { container } = render(
      <ReadmeMarkdown content={'<p align="center">Centered intro</p>'} />,
    );
    // The text is rendered…
    expect(screen.getByText("Centered intro")).toBeTruthy();
    // …and the literal markup is NOT shown as text.
    expect(container.textContent).not.toContain("<p align");
  });

  it("honors align=center on a paragraph (centered logos/badges)", () => {
    const { container } = render(
      <ReadmeMarkdown
        content={
          '<p align="center"><img src="https://img.shields.io/badge/test.svg" alt="Test Badge" /></p>'
        }
      />,
    );
    expect(screen.queryByAltText("Test Badge")).toBeNull();
    expect(screen.getByText("Test Badge")).toBeTruthy();
    const paragraph = container.querySelector("p");
    expect(paragraph?.style.textAlign).toBe("center");
  });

  it("keeps align on non-overridden elements like <div> after sanitize", () => {
    const { container } = render(
      <ReadmeMarkdown content={'<div align="center">Hello</div>'} />,
    );
    expect(container.querySelector('div[align="center"]')).not.toBeNull();
  });

  it("falls back to alt text for image sources instead of loading them", () => {
    const inlinePng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l5v4ygAAAABJRU5ErkJggg==";
    render(
      <ReadmeMarkdown
        content={`![Local Logo](assets/logo.png)\n\n![Remote](https://example.com/x.png)\n\n![Inline](${inlinePng})`}
      />,
    );
    expect(screen.queryByAltText("Inline")).toBeNull();
    expect(screen.getByText("Inline")).toBeTruthy();
    expect(screen.queryByAltText("Remote")).toBeNull();
    expect(screen.getByText("Remote")).toBeTruthy();
    expect(screen.queryByAltText("Local Logo")).toBeNull();
    expect(screen.getByText("Local Logo")).toBeTruthy();
  });
});
