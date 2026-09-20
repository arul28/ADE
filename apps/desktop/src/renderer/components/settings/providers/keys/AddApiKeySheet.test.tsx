/* @vitest-environment jsdom */

/**
 * The sheet shows only the fields the provider's harness reads.
 *
 * This is the contract the old form broke: it asked every provider for an
 * endpoint, an npm package and a model list, so three of its six fields were
 * inert for whichever provider you were configuring. A field that does nothing
 * reads as a promise, so each provider's presence/absence set is asserted here
 * rather than left to the spec table being read correctly.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsProviderId } from "../types";
import { AddApiKeySheet } from "./AddApiKeySheet";
import { providerKeySpec } from "./providerKeySpecs";

function open(provider: SettingsProviderId, onSave = vi.fn(async () => undefined)) {
  render(
    <AddApiKeySheet
      spec={providerKeySpec(provider)}
      providerLabel={provider}
      onSave={onSave}
      onClose={() => undefined}
    />,
  );
  return onSave;
}

const EXPECTED: Record<SettingsProviderId, { endpoint: boolean; protocol: boolean; models: boolean; providerId: boolean }> = {
  claude: { endpoint: true, protocol: false, models: true, providerId: false },
  codex: { endpoint: true, protocol: false, models: true, providerId: false },
  cursor: { endpoint: false, protocol: false, models: false, providerId: false },
  droid: { endpoint: true, protocol: true, models: true, providerId: false },
  pi: { endpoint: false, protocol: false, models: false, providerId: false },
  opencode: { endpoint: true, protocol: true, models: true, providerId: true },
  qwen: { endpoint: true, protocol: false, models: false, providerId: false },
  kimi: { endpoint: false, protocol: false, models: false, providerId: false },
  grok: { endpoint: false, protocol: false, models: false, providerId: false },
  copilot: { endpoint: false, protocol: false, models: false, providerId: false },
};

describe("AddApiKeySheet", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("picks the article that fits the provider's own name", () => {
    render(
      <AddApiKeySheet
        spec={providerKeySpec("opencode")}
        providerLabel="OpenCode"
        onSave={vi.fn(async () => undefined)}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Add an OpenCode key" })).toBeTruthy();
    cleanup();

    render(
      <AddApiKeySheet
        spec={providerKeySpec("claude")}
        providerLabel="Claude Code"
        onSave={vi.fn(async () => undefined)}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Add a Claude Code key" })).toBeTruthy();
  });

  for (const [provider, expected] of Object.entries(EXPECTED) as Array<[SettingsProviderId, typeof EXPECTED["claude"]]>) {
    it(`asks ${provider} for exactly the fields its harness reads`, () => {
      open(provider);
      // Label and key are the two every provider needs.
      expect(screen.getByLabelText("Key label")).toBeTruthy();
      expect(screen.getByLabelText("API key")).toBeTruthy();
      expect(Boolean(screen.queryByLabelText("Endpoint"))).toBe(expected.endpoint);
      expect(Boolean(screen.queryByLabelText("Protocol"))).toBe(expected.protocol);
      expect(Boolean(screen.queryByLabelText("Models"))).toBe(expected.models);
      expect(Boolean(screen.queryByLabelText("Provider id"))).toBe(expected.providerId);
    });
  }

  it("tells Pi users where Pi actually reads its endpoints from", () => {
    open("pi");
    expect(screen.getByText(/models\.json/)).toBeTruthy();
  });

  it("names the gateway variable once Claude's key points somewhere other than Anthropic", () => {
    open("claude");
    expect(screen.getByText(/Exported as ANTHROPIC_API_KEY\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://openrouter.ai/api" } });
    expect(screen.getByText(/Exported as ANTHROPIC_AUTH_TOKEN\./)).toBeTruthy();
  });

  it("will not save without a label and a key", () => {
    const onSave = open("grok");
    const save = screen.getByText("Save key") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "xAI" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "xai-1" } });
    expect(save.disabled).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("refuses an endpoint that is not an absolute http(s) URL", async () => {
    const onSave = open("claude");
    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "Gateway" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-1" } });
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByText("Save key"));

    expect(
      await screen.findByText("The endpoint needs to be a full URL, like https://api.example.com/v1."),
    ).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "ftp://files.example.com" } });
    fireEvent.click(screen.getByText("Save key"));
    expect(
      await screen.findByText("The endpoint needs to start with https:// (or http:// on your own machine)."),
    ).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    // An empty endpoint still means "use the vendor directly", not an error.
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "  " } });
    fireEvent.click(screen.getByText("Save key"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "" })));
  });

  it("trims the whitespace a pasted key arrives with", async () => {
    const onSave = open("grok");
    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "xAI" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "  xai-secret-1\n" } });
    fireEvent.click(screen.getByText("Save key"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ key: "xai-secret-1" })));
  });

  it("hands the caller a parsed model list rather than the raw text", async () => {
    const onSave = open("claude");
    fireEvent.change(screen.getByLabelText("Key label"), { target: { value: "Gateway" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-1" } });
    fireEvent.change(screen.getByLabelText("Models"), { target: { value: " a , b ,, c " } });
    fireEvent.click(screen.getByText("Save key"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ models: ["a", "b", "c"] })));
  });

  it("locks the provider id when an OpenCode custom provider is edited", () => {
    render(
      <AddApiKeySheet
        spec={providerKeySpec("opencode")}
        providerLabel="OpenCode"
        existing={{
          provider: "my-gateway",
          credentialId: "default",
          label: "My gateway",
          baseUrl: "https://api.example.com/v1",
          protocol: "anthropic",
          models: ["big", "small"],
          source: "store",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        }}
        keyOptionalOnReplace
        onSave={vi.fn(async () => undefined)}
        onClose={() => undefined}
      />,
    );
    const id = screen.getByLabelText("Provider id") as HTMLInputElement;
    expect(id.value).toBe("my-gateway");
    expect(id.readOnly).toBe(true);
    expect((screen.getByLabelText("Models") as HTMLInputElement).value).toBe("big, small");
    // Editing an endpoint must not force the saved key to be re-typed.
    expect(screen.getByText("Leave empty to keep the saved key.")).toBeTruthy();
    expect((screen.getByText("Replace key") as HTMLButtonElement).disabled).toBe(false);
  });
});
