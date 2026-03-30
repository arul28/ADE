/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevToolsSection } from "./DevToolsSection";

const originalAde = globalThis.window.ade;

describe("DevToolsSection", () => {
  const detect = vi.fn();

  beforeEach(() => {
    detect.mockReset();
    detect.mockResolvedValue({
      platform: "darwin",
      tools: [
        {
          id: "git",
          label: "Git",
          command: "git",
          installed: true,
          detectedPath: "/usr/bin/git",
          detectedVersion: "git version 2.50.1",
          required: true,
        },
        {
          id: "gh",
          label: "GitHub CLI",
          command: "gh",
          installed: false,
          detectedPath: null,
          detectedVersion: null,
          required: false,
        },
      ],
    });

    globalThis.window.ade = {
      ...originalAde,
      devTools: {
        detect,
      },
    } as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("renders requirement copy without conflicting requirement badges", async () => {
    const onStatusChange = vi.fn();
    render(<DevToolsSection onStatusChange={onStatusChange} />);

    await waitFor(() => expect(screen.getByText("Installed")).toBeTruthy());

    expect(screen.queryByText("REQUIRED")).toBeNull();
    expect(screen.queryByText("RECOMMENDED")).toBeNull();
    expect(screen.getByText("Required to continue setup.")).toBeTruthy();
    expect(screen.getByText("Optional, but recommended for PR workflows.")).toBeTruthy();
    expect(onStatusChange).toHaveBeenCalledWith(true);
  });

  it("forces a fresh scan when scan again is clicked", async () => {
    render(<DevToolsSection onStatusChange={vi.fn()} />);

    await waitFor(() => expect(detect).toHaveBeenCalledWith(undefined));

    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));

    await waitFor(() => expect(detect).toHaveBeenCalledWith(true));
  });
});
