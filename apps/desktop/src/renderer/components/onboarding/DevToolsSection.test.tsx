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
      ],
    });

    globalThis.window.ade = {
      ...originalAde,
      adeCli: {
        getStatus: vi.fn().mockResolvedValue({
          command: "ade",
          platform: "darwin",
          isPackaged: true,
          bundledAvailable: true,
          bundledBinDir: "/Applications/ADE.app/Contents/Resources/ade-cli/bin",
          bundledCommandPath: "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade",
          installerPath: "/Applications/ADE.app/Contents/Resources/ade-cli/install-path.sh",
          agentPathReady: true,
          terminalInstalled: false,
          terminalCommandPath: null,
          installAvailable: true,
          installTargetPath: "/Users/admin/.local/bin/ade",
          installTargetDirOnPath: true,
          message: "ADE-launched agents can use ade. Terminal access is not installed yet.",
          nextAction: "Install the ade command for Terminal access.",
        }),
        installForUser: vi.fn(),
      },
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
    expect(onStatusChange).toHaveBeenCalledWith(true);
  });

  it("forces a fresh scan when scan again is clicked", async () => {
    render(<DevToolsSection onStatusChange={vi.fn()} />);

    await waitFor(() => expect(detect).toHaveBeenCalledWith(undefined));

    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));

    await waitFor(() => expect(detect).toHaveBeenCalledWith(true));
  });
});
