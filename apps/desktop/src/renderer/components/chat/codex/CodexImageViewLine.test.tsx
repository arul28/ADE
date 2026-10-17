/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodexImageViewLine } from "./CodexImageViewLine";

afterEach(cleanup);

describe("CodexImageViewLine", () => {
  it("names a data-URI image instead of printing its base64, and shows it only once opened", () => {
    const dataUri = "data:image/png;base64,AAAA";
    const { container } = render(
      <CodexImageViewLine
        event={{ type: "codex_image_view", itemId: "view-1", url: dataUri, status: "completed" }}
      />,
    );

    // One line, named by the file (a data URI has no name), never by its bytes.
    expect(screen.getByRole("button", { name: "Viewed image" })).toBeTruthy();
    expect(container.textContent).not.toContain("data:image/png");
    // The picture is behind a click, not painted up front.
    expect(container.querySelector("img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Viewed image" }));

    expect(screen.getByTestId("viewed-image-strip")).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(dataUri);
  });

  it("names a titled remote attachment and offers no picture this window cannot paint", () => {
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

    // The row keeps the file name (not the URL) as its words.
    expect(screen.getByText("Viewed Screenshot 2026-09-18.png")).toBeTruthy();
    // The renderer CSP would block the remote image, so there is no picture to
    // open: no <img>, and the line is plain text, not a button.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([
    ["path", { path: "/Users/me/proj/.ade/cache/scene-previews/scene-2026-10-16T03-38-49-499Z-b1f21aa3.png" }],
    // OpenCode names the file in the title and omits the inlined image.
    ["title", { title: "C:\\Users\\Jane Doe\\proj\\.ade\\cache\\scene-previews\\scene-1.png", url: null }],
    ["file:// url", { url: "file:///Users/me/proj/.ade/cache/scene-previews/scene-2.png" }],
  ])("collapses an agent viewing its own scene preview (%s) to one line with no picture", (_field, fields) => {
    const { container } = render(
      <CodexImageViewLine
        event={{ type: "codex_image_view", itemId: "view-preview", status: "completed", ...fields }}
        siblings={[{ type: "codex_image_view", itemId: "view-preview-2", status: "completed", ...fields }]}
      />,
    );

    expect(container.textContent).toContain("Checked the scene preview 2 times");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open image" })).toBeNull();
  });

  it("keeps a mixed run as one quiet line: one scene preview does not collapse the whole run", () => {
    const dataUri = "data:image/png;base64,AAAA";
    const { container } = render(
      <CodexImageViewLine
        event={{ type: "codex_image_view", itemId: "mixed-1", path: "/p/.ade/cache/scene-previews/scene-1.png", status: "completed" }}
        siblings={[{ type: "codex_image_view", itemId: "mixed-2", url: dataUri, status: "completed" }]}
      />,
    );

    // The run is not all scene previews, so it stays a quiet line of its own.
    expect(container.textContent).toContain("Viewed 2 images");
    expect(container.textContent).not.toContain("Checked the scene preview");
    // The picture is behind the click, the way every image view is now.
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Viewed 2 images" }));
    expect(container.querySelector(`img[src="${dataUri}"]`)).toBeTruthy();
  });

  it("names a local path by its file and opens a tile for it on a click", () => {
    const { container } = render(
      <CodexImageViewLine
        event={{ type: "codex_image_view", itemId: "view-3", path: "/tmp/pasted photo.jpg", status: "completed" }}
      />,
    );

    const line = screen.getByRole("button", { name: "Viewed pasted photo.jpg" });
    // Only the file name shows: never the whole path.
    expect(container.textContent).not.toContain("/tmp/");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByTestId("viewed-image-strip")).toBeNull();

    fireEvent.click(line);

    expect(screen.getByTestId("viewed-image-strip")).toBeTruthy();
  });
});
