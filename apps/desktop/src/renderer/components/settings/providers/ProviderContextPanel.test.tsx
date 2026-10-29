/* @vitest-environment jsdom */

/**
 * The Initial context window card stays mounted when the user picks another
 * provider, so two reads can be in flight at once. The one contract that can
 * break silently: the card shows the provider the page is on, whichever read
 * answers last.
 */
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderContextInventory } from "../../../../shared/types/providerContext";
import { ProviderContextPanel } from "./ProviderContextPanel";

function inventory(provider: string, label: string): ProviderContextInventory {
  return {
    provider,
    generatedAt: "2026-10-28T00:00:00.000Z",
    cwd: "/repo",
    laneId: null,
    coverage: "good",
    coverageNote: "note",
    items: [{ id: `${provider}-1`, owner: "user", kind: "instructions", label, tokens: 100, sizeKind: "estimated", timing: "every-request" }],
    measured: null,
    listedTokens: 100,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function panel(providerId: string) {
  return (
    <MemoryRouter>
      <ProviderContextPanel providerId={providerId} providerLabel={providerId} providerLogo={null} pin={null} canReveal={false} />
    </MemoryRouter>
  );
}

const originalAde = (globalThis.window as unknown as { ade: unknown }).ade;

afterEach(() => {
  cleanup();
  (globalThis.window as unknown as { ade: unknown }).ade = originalAde;
});

describe("ProviderContextPanel", () => {
  it("keeps the current provider's list when the previous provider's read answers last", async () => {
    const claude = deferred<ProviderContextInventory>();
    const read = vi.fn((args: { provider: string }) => (
      args.provider === "claude" ? claude.promise : Promise.resolve(inventory("codex", "Codex AGENTS.md"))
    ));
    (globalThis.window as unknown as { ade: unknown }).ade = { ai: { getProviderContextInventory: read } };

    const view = render(panel("claude"));
    view.rerender(panel("codex"));
    expect(await screen.findByText("Codex AGENTS.md")).toBeTruthy();

    claude.resolve(inventory("claude", "Claude CLAUDE.md"));
    await claude.promise;
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Claude CLAUDE.md")).toBeNull();
    expect(screen.getByText("Codex AGENTS.md")).toBeTruthy();
  });
});
