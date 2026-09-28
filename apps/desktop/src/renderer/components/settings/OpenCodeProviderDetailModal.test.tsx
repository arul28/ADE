/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenCodeProviderDetailModal,
  useOpenCodeProviderDetail,
  type OpenCodeProviderDetail,
  type OpenCodeSignInVia,
} from "./OpenCodeProviderDetailModal";

/**
 * OpenCode Go has no sign-in of its own: it borrows the `opencode` provider's
 * OAuth flow. The provider catalog is rebuilt from a status refresh, so the
 * detail view must survive a refresh that briefly drops the open row or the
 * borrowed methods — otherwise the dialog unmounts and cancels a sign-in that
 * was about to succeed.
 */

function detail(id: string, name: string, methods: OpenCodeProviderDetail["methods"] = []): OpenCodeProviderDetail {
  return { id, name, methods, connected: false, hasKey: false };
}

const BORROWED_METHODS: OpenCodeProviderDetail["methods"] = [
  { type: "oauth", label: "Sign in with OpenCode" },
];

const SIGN_IN_VIA: OpenCodeSignInVia = {
  providerId: "opencode",
  providerName: "OpenCode Zen",
  methods: BORROWED_METHODS,
};

describe("useOpenCodeProviderDetail", () => {
  it("keeps the open provider when a refresh drops its row", () => {
    const go = detail("opencode-go", "OpenCode Go");
    const policy = detail("openai", "OpenAI");
    const { result, rerender } = renderHook(
      ({ catalog }: { catalog: OpenCodeProviderDetail[] }) => useOpenCodeProviderDetail("opencode-go", catalog),
      { initialProps: { catalog: [policy, go] } },
    );
    expect(result.current.provider?.id).toBe("opencode-go");

    rerender({ catalog: [policy] });

    expect(result.current.provider?.id).toBe("opencode-go");
  });

  it("follows the selection to another provider", () => {
    const go = detail("opencode-go", "OpenCode Go");
    const policy = detail("openai", "OpenAI");
    const { result, rerender } = renderHook(
      ({ id, catalog }: { id: string; catalog: OpenCodeProviderDetail[] }) =>
        useOpenCodeProviderDetail(id, catalog),
      { initialProps: { id: "opencode-go", catalog: [policy, go] } },
    );
    rerender({ id: "openai", catalog: [policy, go] });

    expect(result.current.provider?.id).toBe("openai");
    expect(result.current.signInVia).toBeUndefined();
  });

  it("borrows the opencode OAuth methods for OpenCode Go", () => {
    const go = detail("opencode-go", "OpenCode Go");
    const zen = detail("opencode", "OpenCode Zen", BORROWED_METHODS);
    const { result } = renderHook(
      ({ catalog }: { catalog: OpenCodeProviderDetail[] }) => useOpenCodeProviderDetail("opencode-go", catalog),
      { initialProps: { catalog: [go, zen] } },
    );

    expect(result.current.signInVia).toEqual(SIGN_IN_VIA);
  });

  it("drops the borrowed sign-in when the opencode row has no OAuth methods", () => {
    const go = detail("opencode-go", "OpenCode Go");
    const zenWithoutOauth = detail("opencode", "OpenCode Zen", [{ type: "api", label: "API key" }]);
    const { result } = renderHook(
      ({ catalog }: { catalog: OpenCodeProviderDetail[] }) => useOpenCodeProviderDetail("opencode-go", catalog),
      { initialProps: { catalog: [go, zenWithoutOauth] } },
    );

    expect(result.current.provider?.id).toBe("opencode-go");
    expect(result.current.signInVia).toBeUndefined();
  });
});

describe("OpenCodeProviderDetailModal", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    globalThis.window.ade = {
      ai: {
        opencodeOAuthStart: vi.fn().mockResolvedValue({
          url: "https://opencode.ai/auth",
          method: "auto",
          instructions: "Open the page and approve.",
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
    globalThis.window.ade = originalAde;
  });

  function renderModal(signInVia: OpenCodeSignInVia | undefined) {
    const go = detail("opencode-go", "OpenCode Go");
    const props = {
      provider: go,
      onClose: vi.fn(),
      onConnected: vi.fn(),
      onSaveKey: vi.fn().mockResolvedValue(undefined),
      onDeleteKey: vi.fn().mockResolvedValue(undefined),
      onVerifyKey: vi.fn().mockResolvedValue(undefined),
    };
    return render(<OpenCodeProviderDetailModal {...props} signInVia={signInVia} />);
  }

  it("does not retarget or cancel a running sign-in when a refresh drops the borrowed methods", async () => {
    const { rerender } = renderModal(SIGN_IN_VIA);

    await act(async () => {
      screen.getByLabelText("Sign in to OpenCode Go").click();
    });
    expect(screen.getByRole("dialog", { name: "Connect OpenCode Zen" })).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Connect" }).click();
    });
    await waitFor(() => {
      expect(window.ade.ai.opencodeOAuthStart).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "opencode" }),
        null,
      );
    });

    // A catalog refresh that loses the `opencode` row (and so `signInVia`).
    const go = detail("opencode-go", "OpenCode Go");
    rerender(
      <OpenCodeProviderDetailModal
        provider={go}
        onClose={vi.fn()}
        onConnected={vi.fn()}
        onSaveKey={vi.fn().mockResolvedValue(undefined)}
        onDeleteKey={vi.fn().mockResolvedValue(undefined)}
        onVerifyKey={vi.fn().mockResolvedValue(undefined)}
        signInVia={undefined}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Connect OpenCode Zen" })).toBeTruthy();
    expect(window.ade.ai.opencodeOAuthCancel).not.toHaveBeenCalled();
  });
});
