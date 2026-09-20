/* @vitest-environment jsdom */

/**
 * The keys panel's contracts, not its pixels.
 *
 * Four things can break here silently: a key ADE did not write offering a
 * Delete it cannot perform, a Verify button on a provider with no probe behind
 * it, a delete that fires without a confirm, and Cursor's key being written
 * somewhere its SDK does not read.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCredentialSummary } from "../../../../../shared/types/apiCredentials";
import { ProviderApiKeysPanel } from "./ProviderApiKeysPanel";

function credential(overrides: Partial<ApiCredentialSummary> & { provider: string; credentialId: string }): ApiCredentialSummary {
  return {
    label: overrides.credentialId,
    source: "store",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const STORE_ROW = credential({
  provider: "anthropic",
  credentialId: "default",
  label: "Anthropic",
  envVar: "ANTHROPIC_API_KEY",
  maskedTail: "••••3c1x",
});

const GATEWAY_ROW = credential({
  provider: "anthropic",
  credentialId: "openrouter-1",
  label: "OpenRouter",
  envVar: "ANTHROPIC_AUTH_TOKEN",
  baseUrl: "https://openrouter.ai/api",
  maskedTail: "••••7f2a",
});

const ENV_ROW = credential({
  provider: "anthropic",
  credentialId: "env-anthropic",
  label: "Anthropic",
  envVar: "ANTHROPIC_API_KEY",
  source: "env",
  maskedTail: "••••9d4b",
});

function mockBridge(rows: ApiCredentialSummary[]) {
  const list = vi.fn(async () => rows);
  const store = vi.fn(async () => rows[0] ?? null);
  const remove = vi.fn(async () => undefined);
  const storeApiKey = vi.fn(async () => undefined);
  const deleteApiKey = vi.fn(async () => undefined);
  const verifyApiKey = vi.fn(async () => ({
    provider: "anthropic",
    ok: true,
    message: "Key works.",
    verifiedAt: "2026-09-18T00:00:00.000Z",
  }));
  (window as unknown as { ade: unknown }).ade = {
    apiCredentials: { list, store, remove, get: vi.fn(async () => null) },
    ai: { storeApiKey, deleteApiKey, verifyApiKey, updateConfig: vi.fn(async () => undefined) },
  };
  return { list, store, remove, storeApiKey, deleteApiKey, verifyApiKey };
}

function rowFor(label: string, tail: string): HTMLElement {
  const nodes = screen.getAllByText(label);
  for (const node of nodes) {
    const row = node.parentElement?.parentElement;
    if (row && within(row).queryByText(tail)) return row as HTMLElement;
  }
  throw new Error(`No key row for ${label} / ${tail}`);
}

describe("ProviderApiKeysPanel", () => {
  beforeEach(() => {
    delete (window as unknown as { ade?: unknown }).ade;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("renders a row per key with its env var, masked tail, source and endpoint host", async () => {
    mockBridge([STORE_ROW, GATEWAY_ROW]);
    render(<ProviderApiKeysPanel provider="claude" providerLabel="Claude Code" />);

    await screen.findByText("OpenRouter");
    expect(screen.getByText("ANTHROPIC_API_KEY")).toBeTruthy();
    expect(screen.getByText("ANTHROPIC_AUTH_TOKEN")).toBeTruthy();
    expect(screen.getByText("••••7f2a")).toBeTruthy();
    // The host only — the whole base URL is noise on a one-line row.
    expect(screen.getByText("openrouter.ai")).toBeTruthy();
    expect(screen.getAllByText("Local store").length).toBe(2);
  });

  it("shows an environment key as read-only, with no Replace or Delete", async () => {
    mockBridge([ENV_ROW]);
    render(<ProviderApiKeysPanel provider="claude" providerLabel="Claude Code" />);

    await screen.findByText("Environment");
    expect(screen.getByText("Managed outside ADE — clear the env/config value to remove.")).toBeTruthy();
    expect(screen.queryByText("Replace")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("offers Verify only for the default key of a provider that has a probe", async () => {
    mockBridge([STORE_ROW, GATEWAY_ROW, ENV_ROW]);
    render(<ProviderApiKeysPanel provider="claude" providerLabel="Claude Code" />);

    await screen.findByText("OpenRouter");
    // Default store row only: the verification path reads one key per provider,
    // so a second key would verify a key other than the row it sits on.
    expect(screen.getAllByText("Verify").length).toBe(1);
    expect(within(rowFor("OpenRouter", "••••7f2a")).queryByText("Verify")).toBeNull();
  });

  it("offers no Verify at all for a provider with no probe", async () => {
    mockBridge([credential({ provider: "copilot", credentialId: "default", label: "Copilot", envVar: "GITHUB_TOKEN" })]);
    render(<ProviderApiKeysPanel provider="copilot" providerLabel="GitHub Copilot" />);

    await screen.findByText("Copilot");
    expect(screen.queryByText("Verify")).toBeNull();
  });

  it("confirms before deleting, then removes that exact credential", async () => {
    const { remove } = mockBridge([STORE_ROW, GATEWAY_ROW]);
    render(<ProviderApiKeysPanel provider="claude" providerLabel="Claude Code" />);

    await screen.findByText("OpenRouter");
    fireEvent.click(within(rowFor("OpenRouter", "••••7f2a")).getByText("Delete"));

    await screen.findByText("Delete this key?");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Delete key"));

    await waitFor(() => expect(remove).toHaveBeenCalledWith({ provider: "anthropic", credentialId: "openrouter-1" }));
  });

  it("writes Cursor's key through the legacy slot its SDK signs in from", async () => {
    const { store, storeApiKey } = mockBridge([]);
    render(<ProviderApiKeysPanel provider="cursor" providerLabel="Cursor" />);

    fireEvent.click(await screen.findByLabelText("Add a Cursor API key"));
    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "Dashboard key" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "key_live_123" } });
    fireEvent.click(screen.getByText("Save key"));

    await waitFor(() => expect(storeApiKey).toHaveBeenCalledWith("cursor", "key_live_123"));
    expect(store).not.toHaveBeenCalled();
  });

  it("gives the first key of a provider the default slot every single-key reader uses", async () => {
    const { store } = mockBridge([]);
    render(<ProviderApiKeysPanel provider="grok" providerLabel="Grok" />);

    fireEvent.click(await screen.findByLabelText("Add a Grok API key"));
    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "xAI console" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "xai-abc" } });
    fireEvent.click(screen.getByText("Save key"));

    await waitFor(() => expect(store).toHaveBeenCalledWith(expect.objectContaining({
      provider: "xai",
      credentialId: "default",
      label: "xAI console",
      key: "xai-abc",
      envVar: "XAI_API_KEY",
    })));
  });

  it("shows a refused delete in the store's own words, not the IPC wrapper", async () => {
    const { remove } = mockBridge([STORE_ROW, GATEWAY_ROW]);
    remove.mockRejectedValue(
      new Error(
        "Error invoking remote method 'ade.localRuntime.callAction': Error: This key is still in use by a harness preset.",
      ),
    );
    render(<ProviderApiKeysPanel provider="claude" providerLabel="Claude Code" />);

    await screen.findByText("OpenRouter");
    fireEvent.click(within(rowFor("OpenRouter", "••••7f2a")).getByText("Delete"));
    await screen.findByText("Delete this key?");
    fireEvent.click(screen.getByText("Delete key"));

    expect(await screen.findByText("This key is still in use by a harness preset.")).toBeTruthy();
    expect(screen.queryByText(/invoking remote method/)).toBeNull();
  });

  it("lists every key a page holds when a provider has several", async () => {
    mockBridge([
      STORE_ROW,
      GATEWAY_ROW,
      credential({ provider: "anthropic", credentialId: "third-1", label: "Third", maskedTail: "••••1111" }),
      credential({ provider: "anthropic", credentialId: "fourth-1", label: "Third", maskedTail: "••••2222" }),
    ]);
    render(<ProviderApiKeysPanel provider="claude" providerLabel="Claude Code" />);

    await screen.findByText("OpenRouter");
    // Two keys share a label on purpose: the masked tail is what tells them
    // apart, so both rows must still be reachable.
    expect(screen.getAllByText("Third").length).toBe(2);
    expect(screen.getByText("••••1111")).toBeTruthy();
    expect(screen.getByText("••••2222")).toBeTruthy();
    expect(screen.getAllByText("Delete").length).toBe(4);
  });

  it("stays out of the way when the host has no key bridge", async () => {
    (window as unknown as { ade: unknown }).ade = { ai: {} };
    const { container } = render(<ProviderApiKeysPanel provider="claude" providerLabel="Claude Code" />);
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });
});
