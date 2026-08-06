/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthConnectModal } from "./OAuthConnectModal";

describe("OAuthConnectModal", () => {
  const originalAde = globalThis.window.ade;
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    localStorage.clear();
    globalThis.window.ade = {
      ai: {
        opencodeOAuthStart: vi.fn().mockResolvedValue({
          url: "https://example.com/oauth",
          method: "auto",
          instructions: "Sign in to continue.",
        }),
        opencodeOAuthCancel: vi.fn().mockResolvedValue(undefined),
        onOpencodeOAuthStatus: vi.fn(() => () => undefined),
      },
      builtInBrowser: {
        navigate: vi.fn().mockResolvedValue(undefined),
      },
      app: {
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    globalThis.window.ade = originalAde;
  });

  it("opens a safe OAuth URL in the system browser by default", async () => {
    render(
      <OAuthConnectModal
        providerId="openai"
        providerName="OpenAI"
        methods={[{ type: "oauth", label: "Sign in with ChatGPT" }]}
        onClose={vi.fn()}
        onConnected={vi.fn()}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: "Connect" }).click();
    });

    expect(window.ade.app.openExternal).toHaveBeenCalledWith("https://example.com/oauth");
    expect(window.ade.builtInBrowser.navigate).not.toHaveBeenCalled();
  });

  it("opens the ADE browser when that open target is selected", async () => {
    render(
      <OAuthConnectModal
        providerId="openai"
        providerName="OpenAI"
        methods={[{ type: "oauth", label: "Sign in with ChatGPT" }]}
        onClose={vi.fn()}
        onConnected={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Open sign-in link in"), {
      target: { value: "ade-browser" },
    });

    await act(async () => {
      screen.getByRole("button", { name: "Connect" }).click();
    });

    expect(window.ade.builtInBrowser.navigate).toHaveBeenCalledWith({
      url: "https://example.com/oauth",
      newTab: true,
    });
  });

  it("persists the selected open target for the next sign-in", async () => {
    const props = {
      providerId: "openai",
      providerName: "OpenAI",
      methods: [{ type: "oauth" as const, label: "Sign in with ChatGPT" }],
      onClose: vi.fn(),
      onConnected: vi.fn(),
    };
    const { unmount } = render(<OAuthConnectModal {...props} />);

    fireEvent.change(screen.getByLabelText("Open sign-in link in"), {
      target: { value: "ade-browser" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Connect" }).click();
    });
    expect(localStorage.getItem("ade.opencode.oauthOpenTarget")).toBe("ade-browser");

    unmount();
    render(<OAuthConnectModal {...props} />);
    expect((screen.getByLabelText("Open sign-in link in") as HTMLSelectElement).value).toBe("ade-browser");
  });

  it("copies the OAuth URL when copy is selected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <OAuthConnectModal
        providerId="openai"
        providerName="OpenAI"
        methods={[{ type: "oauth", label: "Sign in with ChatGPT" }]}
        onClose={vi.fn()}
        onConnected={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Open sign-in link in"), {
      target: { value: "copy" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Connect" }).click();
    });

    expect(writeText).toHaveBeenCalledWith("https://example.com/oauth");
    expect(window.ade.app.openExternal).not.toHaveBeenCalled();
  });

  it("lets a full OAuth link be hidden after starting in view mode", async () => {
    render(
      <OAuthConnectModal
        providerId="openai"
        providerName="OpenAI"
        methods={[{ type: "oauth", label: "Sign in with ChatGPT" }]}
        onClose={vi.fn()}
        onConnected={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Open sign-in link in"), {
      target: { value: "view" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Connect" }).click();
    });

    expect(screen.getByText("https://example.com/oauth")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("https://example.com/oauth")).toBeNull();
  });

  it("rejects an unsafe OAuth URL before opening it", async () => {
    window.ade.ai.opencodeOAuthStart = vi.fn().mockResolvedValue({
      url: "http://example.com/oauth",
      method: "auto",
      instructions: "Sign in to continue.",
    });

    render(
      <OAuthConnectModal
        providerId="openai"
        providerName="OpenAI"
        methods={[{ type: "oauth", label: "Sign in with ChatGPT" }]}
        onClose={vi.fn()}
        onConnected={vi.fn()}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: "Connect" }).click();
    });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "OpenCode returned an unsafe OAuth URL.",
    );
    expect(window.ade.builtInBrowser.navigate).not.toHaveBeenCalled();
    expect(window.ade.app.openExternal).not.toHaveBeenCalled();
    expect(window.ade.ai.opencodeOAuthCancel).toHaveBeenCalledWith({ providerId: "openai" });
  });
});
