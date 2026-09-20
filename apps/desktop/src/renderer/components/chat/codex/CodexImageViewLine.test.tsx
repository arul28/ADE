/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CodexImageViewLine } from "./CodexImageViewLine";

afterEach(cleanup);

describe("CodexImageViewLine", () => {
  it("names a data-URI image instead of printing its base64 and previews it", () => {
    const dataUri = "data:image/png;base64,AAAA";
    const { container } = render(
      <CodexImageViewLine
        event={{ type: "codex_image_view", itemId: "view-1", url: dataUri, status: "completed" }}
      />,
    );

    expect(screen.getByText("image")).toBeTruthy();
    expect(container.textContent).not.toContain("data:image/png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(dataUri);
    // Data URIs are not browser-openable, so no dead "open" button renders.
    expect(screen.queryByRole("button", { name: "Open image" })).toBeNull();
  });

  it("keeps a titled attachment's name and offers open for a remote URL without previewing it", () => {
    const { container } = render(
      <CodexImageViewLine
        event={{
          type: "codex_image_view",
          itemId: "view-2",
          title: "Screenshot 2026-09-18.png",
          url: "https://cdn.example.com/shot.png",
          status: "completed",
        }}
      />,
    );

    expect(screen.getByText("Screenshot 2026-09-18.png")).toBeTruthy();
    // The renderer CSP would block the remote image; no broken preview box.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Open image" })).toBeTruthy();
  });

  it("renders a local path with no inline preview and an open affordance", () => {
    const { container } = render(
      <CodexImageViewLine
        event={{ type: "codex_image_view", itemId: "view-3", path: "/tmp/pasted photo.jpg", status: "completed" }}
      />,
    );

    expect(screen.getByText("pasted photo.jpg")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Open image" })).toBeTruthy();
  });
});
