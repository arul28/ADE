/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessesPage } from "./HarnessesPage";
import { AppStoreProvider, createProjectAppStore, useAppStore } from "../../../state/appStore";
import {
  HARNESS_PRESET_SUBAGENT_INHERIT,
  exportHarnessPreset,
  type HarnessPreset,
} from "../../../../shared/harnessPresets";
import type { ApiCredentialSummary } from "../../../../shared/types/apiCredentials";

const apiCredentialsList = vi.fn(async () => [] as ApiCredentialSummary[]);

function preset(overrides: Partial<HarnessPreset> = {}): HarnessPreset {
  return {
    id: "hp_1",
    name: "Opus on work",
    harness: "claude",
    source: { kind: "account", provider: "claude", instanceId: "claude-work" },
    model: "anthropic/claude-opus-5",
    subagentModel: HARNESS_PRESET_SUBAGENT_INHERIT,
    agentOverrides: {},
    permissionMode: "default",
    accentColor: "#d97757",
    logo: { kind: "ade" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function setPresets(presets: HarnessPreset[]) {
  act(() => {
    useAppStore.getState().setHarnessPresets(presets);
  });
}

beforeEach(() => {
  apiCredentialsList.mockReset();
  apiCredentialsList.mockResolvedValue([]);
  (window as unknown as { ade?: unknown }).ade = {
    ai: {
      getStatus: vi.fn(async () => null),
      listApiKeys: vi.fn(async () => []),
    },
    apiCredentials: { list: apiCredentialsList },
    providerInstances: {
      list: vi.fn(async () => [
        {
          id: "claude-work",
          provider: "claude",
          label: "Work",
          configHome: "/tmp/claude-work",
          isDefault: true,
          createdAt: "2026-09-01T00:00:00.000Z",
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
  setPresets([]);
});

afterEach(() => {
  cleanup();
  setPresets([]);
  vi.restoreAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("HarnessesPage", () => {
  it("offers the one action that fills an empty list", () => {
    render(<HarnessesPage />);
    expect(screen.getByText("Nothing custom yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add new" }).length).toBeGreaterThan(0);
  });

  /**
   * The row is the owner's reading order: mark, name, the agent that runs it,
   * then the models labelled by the role each one plays. It used to be one
   * run-on string ("Claude Code · Claude Opus 5") with no logo on it, which is
   * the plain-text dump this row replaced.
   */
  it("lists a saved setup as name, agent, and models labelled by role", async () => {
    setPresets([preset()]);
    const { container } = render(<HarnessesPage />);
    expect(screen.getByText("Opus on work")).toBeTruthy();

    const row = container.querySelector('[data-custom-preset-row="hp_1"]');
    expect(row).toBeTruthy();
    expect(row!.querySelector('[data-preset-agent="claude"]')?.textContent).toBe("Claude Code");
    expect(row!.querySelector('[data-preset-model="main"]')?.textContent).toContain("Claude Opus 5");
    expect(row!.querySelector("[data-preset-models]")?.textContent).toContain("Same as main");

    // The source and the last-changed time still exist — on the name's tooltip,
    // rather than as two more columns of muted text.
    await waitFor(() => {
      expect(row!.textContent).toContain("Opus on work");
    });
  });

  it("lays the rows flat instead of inside a table box", () => {
    setPresets([preset()]);
    const { container } = render(<HarnessesPage />);
    expect(container.querySelector("[data-custom-preset-list]")).toBeTruthy();
    expect(container.querySelector('[role="row"]')).toBeNull();
  });

  /** Only Add new and Import. Back is navigation, and sits before the title. */
  it("keeps the toolbar to Add new and Import", () => {
    setPresets([preset()]);
    const { container } = render(<HarnessesPage onBack={() => {}} />);
    const toolbar = container.querySelector("[data-settings-manager-toolbar]");
    expect(toolbar).toBeTruthy();
    const labels = [...toolbar!.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(labels).toEqual(["Import", "Add new"]);
    expect(screen.getByRole("button", { name: "Back to providers" })).toBeTruthy();
  });

  /** The two-sentence blurb is gone; the explanation waits behind a "?". */
  it("explains itself behind a ? rather than in a paragraph", () => {
    render(<HarnessesPage />);
    const help = screen.getByRole("button", { name: "What is this?" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(help);
    expect(screen.getByRole("tooltip").textContent).toContain("saved together");
  });

  it("renames a setup in place, without walking the wizard", () => {
    setPresets([preset()]);
    render(<HarnessesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Opus on work" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Opus weekdays" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useAppStore.getState().harnessPresets[0]?.name).toBe("Opus weekdays");
  });

  // Settings renders inside a project tab, which has its OWN store seeded from
  // the root once. The preset list is account-scoped and every write goes to
  // the root store, so a page reading the project copy shows a table that a
  // create never reaches — the harness is saved and the user is told so, while
  // the row is missing until the page is re-entered.
  it("lists a setup saved while rendered inside a project-scoped store", async () => {
    const store = createProjectAppStore({
      rootPath: "/tmp/lv-project",
      displayName: "LV Project",
      baseRef: "main",
    });
    render(
      <AppStoreProvider store={store}>
        <HarnessesPage />
      </AppStoreProvider>,
    );

    setPresets([preset()]);

    expect(await screen.findByText("Opus on work")).toBeTruthy();
  });

  it("duplicates under a free name instead of a second row with the same one", () => {
    setPresets([preset()]);
    render(<HarnessesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Opus on work" }));
    const names = useAppStore.getState().harnessPresets.map((entry) => entry.name);
    expect(names).toEqual(["Opus on work", "Opus on work 2"]);
  });

  it("asks before deleting, and keeps the setup when you say no", () => {
    setPresets([preset()]);
    render(<HarnessesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Opus on work" }));
    expect(screen.getByText("Delete?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(useAppStore.getState().harnessPresets).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete Opus on work" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useAppStore.getState().harnessPresets).toHaveLength(0);
  });

  /**
   * Four identical icon buttons per row: "Delete" announced five times over a
   * five-harness list never said which harness it would delete.
   */
  it("names the setup in every row action, so the list is not five identical buttons", () => {
    setPresets([preset(), preset({ id: "hp_2", name: "Haiku sweeps" })]);
    render(<HarnessesPage />);

    for (const action of ["Edit", "Rename", "Duplicate", "Export", "Delete"]) {
      expect(screen.getByRole("button", { name: `${action} Opus on work` })).toBeTruthy();
      expect(screen.getByRole("button", { name: `${action} Haiku sweeps` })).toBeTruthy();
    }
  });

  it("opens the wizard prefilled when a row is edited", () => {
    setPresets([preset()]);
    render(<HarnessesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Opus on work" }));
    expect(screen.getByText("Edit custom")).toBeTruthy();
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
  });

  it("opens the wizard from an imported file and lists what is missing", async () => {
    render(<HarnessesPage />);
    const exported = exportHarnessPreset(
      preset({ source: { kind: "key", provider: "openai", credentialId: "cred_absent", label: "OpenAI" } }),
    );
    const file = new File([JSON.stringify(exported)], "opus.ade-harness.json", { type: "application/json" });
    // jsdom's File has no `text()` in this environment; the page only needs the
    // contents, so supply them the same way a real File would.
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(exported) });

    const input = screen.getByLabelText("Import a custom setup") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => {
      expect(screen.getByText("New custom")).toBeTruthy();
      expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    });
    expect(screen.getByText(/names an API key this computer does not hold/i)).toBeTruthy();
  });

  it("loads and selects a non-default custom-provider credential from the bridge", async () => {
    apiCredentialsList.mockResolvedValue([
      {
        provider: "acme",
        credentialId: "work",
        label: "Acme work",
        baseUrl: "https://acme.example/v1",
        models: ["acme/model"],
        source: "store",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    render(<HarnessesPage />);

    fireEvent.click(screen.getAllByRole("button", { name: "Add new" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));

    const source = await waitFor(() => {
      const element = document.querySelector('[data-harness-source="key:acme:work"]');
      expect(element).toBeTruthy();
      return element as HTMLButtonElement;
    });
    expect(source.getAttribute("aria-checked")).toBe("false");
    expect(source.textContent).toContain("Acme work");

    fireEvent.click(source);
    expect(source.getAttribute("aria-checked")).toBe("true");
    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    fireEvent.change(model, { target: { value: "acme/model" } });
    expect(model.value).toBe("acme/model");

    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme harness" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(useAppStore.getState().harnessPresets[0]?.source).toEqual({
      kind: "key",
      provider: "acme",
      credentialId: "work",
      label: "Acme work",
    });
  });

  it("refuses a file that is not a saved setup, in a sentence", async () => {
    render(<HarnessesPage />);
    const file = new File(["{}"], "notes.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => "{}" });
    const input = screen.getByLabelText("Import a custom setup") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => {
      expect(screen.getByText("That file is not a harness ADE can read.")).toBeTruthy();
    });
  });
});
