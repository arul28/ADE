/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessWizard, emptyHarnessDraft } from "./HarnessWizard";
import type { HarnessPresetDraft } from "../../../../shared/harnessPresets";
import type { AiSettingsStatus } from "../../../../shared/types";
import { cursorCatalog } from "./harnessTestCatalog";
import { resetModelPickerRuntimeCatalogForTests } from "../../shared/ModelPicker/runtimeCatalogCache";

function status(overrides: Partial<AiSettingsStatus> = {}): AiSettingsStatus {
  return {
    mode: "subscription",
    availableProviders: {
      claude: { binary: { present: true, source: "path" }, auth: { ready: true, mode: "oauth" } },
      codex: true,
      cursor: false,
      droid: false,
    },
    models: { claude: [], codex: [], cursor: [], droid: [] },
    features: [],
    ...overrides,
  } as AiSettingsStatus;
}

function claudeDraft(overrides: Partial<HarnessPresetDraft> = {}): HarnessPresetDraft {
  return {
    ...emptyHarnessDraft("claude"),
    name: "Opus on work",
    model: "anthropic/claude-opus-5",
    ...overrides,
  };
}

beforeEach(() => {
  (window as unknown as { ade?: unknown }).ade = {
    providerInstances: {
      list: vi.fn(async () => [
        {
          id: "claude-work",
          provider: "claude",
          label: "Work",
          configHome: "/tmp/claude-work",
          isDefault: true,
          createdAt: "2026-09-01T00:00:00.000Z",
          account: { email: "arul@example.com", plan: "Max" },
          signedIn: true,
        },
      ]),
    },
  };
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetModelPickerRuntimeCatalogForTests();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("HarnessWizard", () => {
  it("walks body → brain → name and saves the assembled draft", async () => {
    const onSave = vi.fn();
    render(
      <HarnessWizard
        initialDraft={claudeDraft()}
        status={status()}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );

    expect(screen.getByText("Pick a harness")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
    expect(screen.getByText("Pick a model provider")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
    expect(screen.getByText("Name it")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ harness: "claude", model: "anthropic/claude-opus-5" });
  });

  it("blocks the step that has not been answered, and unblocks it when it is", () => {
    render(
      <HarnessWizard
        initialDraft={claudeDraft({ model: "" })}
        status={status()}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
    // Step 2 with no model: Next is refused rather than landing on a step that
    // cannot be completed.
    const next = screen.getByRole("button", { name: /^Next/ }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "anthropic/claude-opus-5" } });
    expect((screen.getByRole("button", { name: /^Next/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a harness that is not set up, with its reason, and still lets you pick it", () => {
    render(
      <HarnessWizard
        initialDraft={claudeDraft()}
        status={status({
          availableProviders: {
            claude: { binary: { present: false, source: "missing" }, auth: { ready: false, mode: "none" } },
            codex: true,
            cursor: false,
            droid: false,
          },
        } as Partial<AiSettingsStatus>)}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    const claudeCard = document.querySelector('[data-harness-card="claude"]') as HTMLButtonElement;
    expect(claudeCard).toBeTruthy();
    expect(claudeCard.textContent).toContain("Claude Code is not installed on this computer.");
    expect(claudeCard.disabled).toBe(false);
  });

  it("keeps Advanced folded, and notes the cost of pinning a built-in", () => {
    render(
      <HarnessWizard
        initialDraft={claudeDraft()}
        status={status()}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));

    const disclosure = document.querySelector("details") as HTMLDetailsElement;
    expect(disclosure).toBeTruthy();
    expect(disclosure.open).toBe(false);
    expect(document.querySelector("[data-harness-agent-note]")).toBeNull();

    disclosure.open = true;
    fireEvent.change(screen.getByLabelText("Explore model"), { target: { value: "anthropic/claude-haiku-4-5" } });
    const note = document.querySelector('[data-harness-agent-note="explore"]');
    expect(note?.textContent).toBe(
      "Explore now runs on ADE's copy of Anthropic's Explore prompt. Updates to Claude Code do not change it.",
    );
  });

  it("hides Advanced for a harness that is not Claude", () => {
    render(
      <HarnessWizard
        initialDraft={{ ...claudeDraft(), harness: "droid" }}
        status={status()}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
    expect(document.querySelector("details")).toBeNull();
  });

  it("disables the proxy sign-in and says why when the host has no proxy", async () => {
    render(
      <HarnessWizard
        initialDraft={claudeDraft()}
        status={status()}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));

    await waitFor(() => {
      expect(document.querySelector('[data-harness-proxy-sign-in="claude"]')).toBeTruthy();
    });
    const button = document.querySelector('[data-harness-proxy-sign-in="claude"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Sign-in through ADE's proxy is not available yet on this host.");
  });

  it("lists what an imported harness is missing on this computer", () => {
    render(
      <HarnessWizard
        initialDraft={claudeDraft()}
        missing={["account", "subscription-signin"]}
        status={status()}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    const banner = document.querySelector("[data-harness-wizard-missing]") as HTMLElement;
    expect(banner).toBeTruthy();
    expect(within(banner).getByText(/provider account this computer does not have/i)).toBeTruthy();
    expect(within(banner).getByText(/ADE's proxy, which is not signed in/i)).toBeTruthy();
  });

  it("lists a Cursor model from the live catalog instead of a free-text box", async () => {
    const modelCatalog = vi.fn(async () => cursorCatalog());
    const ade = (window as unknown as { ade: Record<string, unknown> }).ade;
    ade.agentChat = { modelCatalog };

    render(
      <HarnessWizard
        initialDraft={claudeDraft({
          model: "",
          source: { kind: "key", provider: "cursor", credentialId: "default", label: "Cursor" },
        })}
        status={status()}
        credentialSummaries={[
          {
            provider: "cursor",
            credentialId: "default",
            label: "Cursor",
            source: "store",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ]}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));

    const model = await waitFor(() => {
      const control = screen.getByLabelText("Model") as HTMLElement;
      expect(control.tagName).toBe("SELECT");
      expect(within(control).getByText("Composer 9")).toBeTruthy();
      return control as HTMLSelectElement;
    });
    expect(modelCatalog).toHaveBeenCalled();
    fireEvent.change(model, { target: { value: "cursor/composer-9" } });
    expect(model.value).toBe("cursor/composer-9");
  });

  it("groups the sources into what this computer holds and what the proxy holds", async () => {
    render(
      <HarnessWizard
        initialDraft={claudeDraft()}
        status={status()}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));

    await waitFor(() => {
      expect(screen.getByRole("radiogroup", { name: "Your accounts and keys" })).toBeTruthy();
    });
    const proxy = screen.getByRole("radiogroup", { name: "Through ADE's proxy" });
    expect(within(proxy).getAllByRole("radio").length).toBe(2);
    expect(document.querySelector('[data-harness-proxy-sign-in="claude"]')?.closest("[role=radiogroup]"))
      .toBe(proxy);
  });

  it("has no permission mode control: the tier is chosen at launch", () => {
    render(
      <HarnessWizard
        initialDraft={claudeDraft()}
        status={status()}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
    expect(screen.queryByText("Permission mode")).toBeNull();
  });

  it("shows the account's email and plan on its source row", async () => {
    render(
      <HarnessWizard
        initialDraft={claudeDraft()}
        status={status()}
        onCancel={() => undefined}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
    await waitFor(() => {
      expect(screen.getByText("arul@example.com · Max")).toBeTruthy();
    });
  });
});
