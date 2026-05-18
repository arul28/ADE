/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// openExternalUrl uses window.ade.app.openExternal; stub it before importing.
const openExternalCalls: string[] = [];

beforeEach(() => {
  openExternalCalls.length = 0;
  (window as unknown as {
    ade?: { app?: { openExternal?: (url: string) => Promise<void> } };
  }).ade = {
    app: {
      openExternal: (url: string) => {
        openExternalCalls.push(url);
        return Promise.resolve();
      },
    },
  };
});

afterEach(() => {
  cleanup();
});

// Import after we wire the global so the module-eval-time bindings see it.
// (openExternalUrl reads window.ade at call time, so order doesn't strictly
// matter — but this keeps test setup consistent.)
import { ProviderEmptyState, ProviderSetupBanner } from "./providerEmptyState";

describe("ProviderEmptyState", () => {
  it("renders cursor-specific copy and signin/external CTAs", async () => {
    const onOpenSignIn = vi.fn();
    render(<ProviderEmptyState family="cursor" onOpenSignIn={onOpenSignIn} />);
    expect(screen.getByText("Connect Cursor")).toBeTruthy();
    expect(screen.getByText(/Add a Cursor API key/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Open Settings/i }));
    expect(onOpenSignIn).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: /Get Cursor API key/i }));
    expect(openExternalCalls).toContain("https://cursor.com/dashboard/integrations");
  });

  it("renders Droid (factory) copy", () => {
    render(<ProviderEmptyState family="factory" />);
    expect(screen.getByText(/Install Droid CLI/i)).toBeTruthy();
  });

  it("renders OpenCode copy", () => {
    render(<ProviderEmptyState family="opencode" />);
    expect(screen.getByText(/Install OpenCode/i)).toBeTruthy();
  });

  it("renders LM Studio copy", () => {
    render(<ProviderEmptyState family="lmstudio" />);
    expect(screen.getByText(/Start LM Studio/i)).toBeTruthy();
  });

  it("falls back to generic copy for unknown family", () => {
    render(<ProviderEmptyState family={"groq" as never} />);
    expect(screen.getByText(/No models discovered/i)).toBeTruthy();
  });

  it("does not show 'no models match this view' wording (regression)", () => {
    render(<ProviderEmptyState family="cursor" />);
    expect(screen.queryByText(/No models match this view/i)).toBeNull();
  });
});

describe("ProviderSetupBanner", () => {
  it("renders provider-specific label and invokes onOpenSignIn on click", async () => {
    const onOpenSignIn = vi.fn();
    render(<ProviderSetupBanner family="cursor" onOpenSignIn={onOpenSignIn} />);
    const banner = screen.getByRole("button", { name: /Set up Cursor/i });
    expect(banner).toBeTruthy();
    await userEvent.click(banner);
    expect(onOpenSignIn).toHaveBeenCalledOnce();
  });

  it("uses Droid label for the 'factory' family", () => {
    render(<ProviderSetupBanner family="factory" onOpenSignIn={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Set up Droid/i })).toBeTruthy();
  });

  it("uses Claude label for the 'anthropic' family", () => {
    render(<ProviderSetupBanner family="anthropic" onOpenSignIn={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Set up Claude/i })).toBeTruthy();
  });

  it("uses OpenAI Codex label for the 'openai' family", () => {
    render(<ProviderSetupBanner family="openai" onOpenSignIn={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Set up OpenAI Codex/i })).toBeTruthy();
  });

  it("renders nothing when onOpenSignIn is not provided", () => {
    const { container } = render(<ProviderSetupBanner family="cursor" />);
    expect(container.firstChild).toBeNull();
  });

  it("falls back to the family slug for unmapped families", () => {
    render(<ProviderSetupBanner family={"groq" as never} onOpenSignIn={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Set up groq/i })).toBeTruthy();
  });
});
