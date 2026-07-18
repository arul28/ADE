/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthConnectModal } from "./OAuthConnectModal";

describe("OAuthConnectModal", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    globalThis.window.ade = {
      ai: {
        opencodeOAuthStart: vi.fn().mockResolvedValue({
          url: "http://example.com/oauth",
          method: "auto",
          instructions: "Sign in to continue.",
        }),
        opencodeOAuthCancel: vi.fn().mockResolvedValue(undefined),
        onOpencodeOAuthStatus: vi.fn(() => () => undefined),
      },
      builtInBrowser: {
        navigate: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("rejects an unsafe OAuth URL before opening it in the ADE browser", async () => {
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
    expect(window.ade.ai.opencodeOAuthCancel).toHaveBeenCalledWith({ providerId: "openai" });
  });
});
