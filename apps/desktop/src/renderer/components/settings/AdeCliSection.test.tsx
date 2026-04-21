/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdeCliSection } from "./AdeCliSection";

const originalAde = globalThis.window.ade;

describe("AdeCliSection", () => {
  const getStatus = vi.fn();
  const installForUser = vi.fn();

  beforeEach(() => {
    getStatus.mockReset();
    installForUser.mockReset();
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("explains that Terminal install is separate from ADE-launched agents", async () => {
    getStatus.mockResolvedValue({
      bundledAvailable: true,
      bundledCommandPath: "/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade",
      installTargetPath: "/Users/arul/.local/bin/ade",
      installAvailable: true,
    });
    globalThis.window.ade = {
      adeCli: {
        getStatus,
        installForUser,
      },
    } as any;

    render(<AdeCliSection />);

    expect(await screen.findByText("Bundled")).toBeTruthy();
    expect(screen.getByText(/Agents launched by ADE get the bundled CLI automatically/i)).toBeTruthy();
    expect(screen.getByText(/Installing it here makes/i)).toBeTruthy();
    expect(screen.getByText("/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install for Terminal" })).toBeTruthy();
  });

  it("installs the command and refreshes to the returned on-PATH status", async () => {
    getStatus.mockResolvedValue({
      bundledAvailable: true,
      installTargetPath: "/Users/arul/.local/bin/ade",
      installAvailable: true,
    });
    installForUser.mockResolvedValue({
      ok: true,
      message: "Installed.",
      status: {
        terminalInstalled: true,
        terminalCommandPath: "/Users/arul/.local/bin/ade",
        version: "1.2.3",
      },
    });
    globalThis.window.ade = {
      adeCli: {
        getStatus,
        installForUser,
      },
    } as any;

    render(<AdeCliSection />);

    await screen.findByText("Bundled");
    fireEvent.click(screen.getByRole("button", { name: "Install for Terminal" }));

    await waitFor(() => expect(installForUser).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("On PATH")).toBeTruthy();
    expect(screen.getByText("/Users/arul/.local/bin/ade")).toBeTruthy();
  });

  it("shows a manual state when the renderer bridge is not present yet", async () => {
    globalThis.window.ade = {} as any;

    render(<AdeCliSection />);

    expect(await screen.findByText("Manual action")).toBeTruthy();
    expect(screen.getByText(/CLI install status is not available in this build/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Install for Terminal" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
