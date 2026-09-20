/* @vitest-environment jsdom */

/**
 * Custom providers are readable, editable and deletable.
 *
 * The one that matters most is the write shape: `ai.updateConfig` merges arrays
 * with replace semantics, so an edit or a delete that sends anything less than
 * the whole list silently drops every other custom provider. Both directions
 * are asserted here because both were reachable from a UI that had neither.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCustomProviderConfig } from "../../../../../shared/types/config";
import type { ProvidersViewContext } from "../types";
import { OpenCodeCustomProvidersPanel } from "./OpenCodeCustomProvidersPanel";

vi.mock("../../../../lib/aiDiscoveryCache", () => ({ invalidateAiDiscoveryCache: vi.fn() }));

const ENTRIES: AiCustomProviderConfig[] = [
  { id: "my-gateway", name: "My gateway", baseURL: "https://api.example.com/v1", npm: "@ai-sdk/anthropic", models: ["big", "small"] },
  { id: "other", name: "Other", baseURL: "https://other.example.com/v1", npm: "@ai-sdk/openai-compatible", models: ["one"] },
];

function ctxWith(entries: AiCustomProviderConfig[], refreshStatus = vi.fn(async () => null)) {
  return {
    status: { customProviders: entries },
    actions: { refreshStatus },
  } as unknown as ProvidersViewContext;
}

function mockBridge() {
  const updateConfig = vi.fn(async () => undefined);
  const store = vi.fn(async () => null);
  const remove = vi.fn(async () => undefined);
  (window as unknown as { ade: unknown }).ade = {
    ai: { updateConfig },
    apiCredentials: { store, remove, list: vi.fn(async () => []), get: vi.fn(async () => null) },
  };
  return { updateConfig, store, remove };
}

function rowFor(id: string): HTMLElement {
  const node = screen.getByText(id);
  return node.parentElement as HTMLElement;
}

describe("OpenCodeCustomProvidersPanel", () => {
  beforeEach(() => {
    delete (window as unknown as { ade?: unknown }).ade;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("lists what is configured instead of leaving it write-only", () => {
    mockBridge();
    render(<OpenCodeCustomProvidersPanel ctx={ctxWith(ENTRIES)} />);

    expect(screen.getByText("My gateway")).toBeTruthy();
    expect(screen.getByText("https://api.example.com/v1")).toBeTruthy();
    expect(screen.getByText("2 models")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
  });

  it("edits one entry and sends the whole list back, so the others survive", async () => {
    const { updateConfig, store } = mockBridge();
    render(<OpenCodeCustomProvidersPanel ctx={ctxWith(ENTRIES)} />);

    fireEvent.click(within(rowFor("my-gateway")).getByLabelText("Edit my-gateway"));
    fireEvent.change(screen.getByLabelText("Models"), { target: { value: "big, small, huge" } });
    fireEvent.click(screen.getByText("Replace key"));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    expect(updateConfig).toHaveBeenCalledWith({
      customProviders: [
        ENTRIES[1],
        { id: "my-gateway", name: "My gateway", baseURL: "https://api.example.com/v1", npm: "@ai-sdk/anthropic", models: ["big", "small", "huge"] },
      ],
    });
    // The key was not re-typed, so it must not be overwritten with an empty one.
    expect(store).not.toHaveBeenCalled();
  });

  it("deletes an entry and its key, keeping every other entry", async () => {
    const { updateConfig, remove } = mockBridge();
    render(<OpenCodeCustomProvidersPanel ctx={ctxWith(ENTRIES)} />);

    fireEvent.click(within(rowFor("my-gateway")).getByLabelText("Delete my-gateway"));
    await screen.findByText("Delete My gateway?");
    expect(updateConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Delete provider"));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ customProviders: [ENTRIES[1]] }));
    expect(remove).toHaveBeenCalledWith({ provider: "my-gateway", credentialId: "default" });
  });

  it("writes the key into the slot the generated OpenCode config reads", async () => {
    const { store, updateConfig } = mockBridge();
    render(<OpenCodeCustomProvidersPanel ctx={ctxWith([])} />);

    fireEvent.click(screen.getByLabelText("Add a custom provider"));
    fireEvent.change(screen.getByLabelText("Provider id"), { target: { value: "fresh" } });
    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "Fresh" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-fresh" } });
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://fresh.example.com/v1" } });
    fireEvent.change(screen.getByLabelText("Models"), { target: { value: "m1" } });
    fireEvent.click(screen.getByText("Save key"));

    await waitFor(() => expect(store).toHaveBeenCalledWith(expect.objectContaining({
      provider: "fresh",
      credentialId: "default",
      key: "sk-fresh",
      models: ["m1"],
    })));
    expect(updateConfig).toHaveBeenCalledWith({
      customProviders: [
        { id: "fresh", name: "Fresh", baseURL: "https://fresh.example.com/v1", npm: "@ai-sdk/openai-compatible", models: ["m1"] },
      ],
    });
  });

  it("refuses a provider with no endpoint or no models rather than writing a dead block", async () => {
    const { updateConfig } = mockBridge();
    render(<OpenCodeCustomProvidersPanel ctx={ctxWith([])} />);

    fireEvent.click(screen.getByLabelText("Add a custom provider"));
    fireEvent.change(screen.getByLabelText("Provider id"), { target: { value: "fresh" } });
    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "Fresh" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-fresh" } });
    fireEvent.click(screen.getByText("Save key"));

    await screen.findByText("A custom provider needs at least one model id.");
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
