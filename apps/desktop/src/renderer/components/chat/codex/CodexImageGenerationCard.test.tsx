/* @vitest-environment jsdom */

import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodexImageGenerationCard } from "./CodexImageGenerationCard";

type ImageGenEvent = ComponentProps<typeof CodexImageGenerationCard>["event"];

const baseEvent: ImageGenEvent = {
  type: "codex_image_generation",
  itemId: "item-1",
  status: "completed",
  prompt: "A small bird in flight",
  revisedPrompt: "A small bird soaring across an indigo sunset sky",
  result: null,
  savedPath: null,
};

describe("CodexImageGenerationCard", () => {
  let originalAde: typeof window.ade;
  let openPath: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openPath = vi.fn(async () => undefined);
    originalAde = (window as { ade?: unknown }).ade as typeof window.ade;
    (window as unknown as { ade: { app: { openPath: typeof openPath } } }).ade = {
      ...(originalAde ?? {}),
      app: {
        ...(originalAde?.app ?? {}),
        openPath,
      },
    } as never;
  });

  afterEach(() => {
    cleanup();
    (window as unknown as { ade: typeof originalAde }).ade = originalAde;
  });

  it("renders the Open button only when savedPath is set, and triggers window.ade.app.openPath on click", () => {
    const { rerender } = render(
      <CodexImageGenerationCard event={{ ...baseEvent, savedPath: null }} />,
    );
    expect(screen.queryByRole("button", { name: /open/i })).toBeNull();

    rerender(
      <CodexImageGenerationCard event={{ ...baseEvent, savedPath: "/tmp/out/bird.png" }} />,
    );
    const openBtn = screen.getByRole("button", { name: /open/i });
    fireEvent.click(openBtn);
    expect(openPath).toHaveBeenCalledWith("/tmp/out/bird.png");
  });

  it("renders an <img> thumbnail when result is an https URL", () => {
    const { container } = render(
      <CodexImageGenerationCard
        event={{ ...baseEvent, result: "https://cdn.example.com/bird.png" }}
      />,
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.getAttribute("src")).toBe("https://cdn.example.com/bird.png");
    expect(imgs[0]!.getAttribute("loading")).toBe("lazy");
  });

  it("renders the file-path-with-icon branch (no <img>) when only savedPath is set", () => {
    const { container } = render(
      <CodexImageGenerationCard
        event={{ ...baseEvent, result: null, savedPath: "/var/folders/abc/bird.png" }}
      />,
    );
    expect(container.querySelectorAll("img").length).toBe(0);
    expect(screen.getByText("bird.png")).toBeTruthy();
  });

  it("normalizes Windows file URLs before opening saved images", () => {
    render(
      <CodexImageGenerationCard
        event={{ ...baseEvent, savedPath: "file:///C:/Users/ADE/image%20one.png" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    expect(openPath).toHaveBeenCalledWith("C:/Users/ADE/image one.png");
  });

  it("keeps the revised prompt hidden by default and reveals it when clicked", () => {
    render(<CodexImageGenerationCard event={baseEvent} />);
    expect(screen.queryByText(/soaring across an indigo sunset/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /revised prompt/i }));
    expect(screen.getByText(/soaring across an indigo sunset/)).toBeTruthy();
  });
});
