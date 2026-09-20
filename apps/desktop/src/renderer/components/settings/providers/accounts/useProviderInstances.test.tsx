/* @vitest-environment jsdom */

/**
 * The two registry reads that feed surfaces outside this folder.
 *
 * The provider list's "N accounts" detail and the model picker's smart-balance
 * note are each one line of JSX over one of these hooks, so the hook is where
 * the behaviour worth pinning lives — including the part that matters most:
 * both must stay silent on a host that has no provider account registry at all,
 * rather than throwing inside an unrelated page.
 */
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviderAccountCounts, useSmartBalanceProviders } from "./useProviderInstances";

function Counts() {
  const counts = useProviderAccountCounts();
  return <div data-testid="counts">{JSON.stringify(counts)}</div>;
}

function SmartBalance() {
  const enabled = useSmartBalanceProviders();
  return <div data-testid="smart">{[...enabled].sort().join(",")}</div>;
}

describe("useProviderAccountCounts", () => {
  const originalAde = (globalThis.window as unknown as { ade: unknown }).ade;

  afterEach(() => {
    cleanup();
    (globalThis.window as unknown as { ade: unknown }).ade = originalAde;
  });

  it("counts every instance by provider in one read", async () => {
    (globalThis.window as unknown as { ade: unknown }).ade = {
      providerInstances: {
        list: vi.fn().mockResolvedValue([
          { id: "claude", provider: "claude" },
          { id: "claude-work", provider: "claude" },
          { id: "codex", provider: "codex" },
        ]),
      },
    };
    render(<Counts />);
    await waitFor(() => {
      expect(screen.getByTestId("counts").textContent).toBe('{"claude":2,"codex":1}');
    });
  });

  it("stays empty when the host has no registry", async () => {
    (globalThis.window as unknown as { ade: unknown }).ade = {};
    render(<Counts />);
    await waitFor(() => {
      expect(screen.getByTestId("counts").textContent).toBe("{}");
    });
  });
});

describe("useSmartBalanceProviders", () => {
  const originalAde = (globalThis.window as unknown as { ade: unknown }).ade;

  afterEach(() => {
    cleanup();
    (globalThis.window as unknown as { ade: unknown }).ade = originalAde;
  });

  it("reports only the providers whose smart balance is on", async () => {
    (globalThis.window as unknown as { ade: unknown }).ade = {
      providerInstances: {
        getSettings: vi.fn(async ({ provider }: { provider: string }) => ({
          smartBalance: provider === "codex",
          autoStartWindows: false,
        })),
      },
    };
    render(<SmartBalance />);
    await waitFor(() => {
      expect(screen.getByTestId("smart").textContent).toBe("codex");
    });
  });

  it("reports nothing when the registry read fails", async () => {
    (globalThis.window as unknown as { ade: unknown }).ade = {
      providerInstances: {
        getSettings: vi.fn().mockRejectedValue(new Error("no registry")),
      },
    };
    render(<SmartBalance />);
    await waitFor(() => {
      expect(screen.getByTestId("smart").textContent).toBe("");
    });
  });
});
