/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

/**
 * The install decision, and the one part of it that is not immediate.
 *
 * A plugin's skill takes effect at the start of the NEXT agent turn, and the
 * turn the reader is most likely to test it on is the one already running. The
 * approval card an agent shows says so; this dialog is the other way in, and it
 * said nothing — the same decision reaching two surfaces with one of them
 * silent, which is the shape of confusion the alpha retrospective is about.
 *
 * The second half is the folder route. A local directory has always installed —
 * the host resolves a path before it tries git — but nothing on this screen
 * offered one, and a user holding a plugin they had just written reported the
 * Marketplace as having no way to take it. What is pinned below is not the
 * button's markup: it is that the pick reaches the field, that ADE then reads
 * the folder it was actually handed rather than whatever the field held before,
 * and that the picker is not offered where there is nothing behind it.
 */

vi.mock("../../state/appStore", () => ({
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({ refreshInstalledPlugins: async () => {} }),
}));

/** What the host answered, and what it was asked about. */
const bridge = {
  inspected: [] as string[],
  inspection: null as { manifest: unknown } | null,
};

vi.mock("../../lib/pluginRuntimeBridge", () => ({
  inspectPluginSource: async (source: string) => {
    bridge.inspected.push(source);
    return bridge.inspection;
  },
  installPlugin: async () => ({ pluginId: "ade-tipsy" }),
  pluginMarketplaceCapabilities: () => ({ install: true, inspect: true }),
}));

vi.mock("../../lib/openExternal", () => ({ openExternalUrl: () => {} }));

const { PluginInstallDialog } = await import("./PluginInstallDialog");
const { listingFromManifest } = await import("./marketplaceModel");
const { parsePluginManifest } = await import("../../../shared/plugins/manifest");

function listing(overrides: Record<string, unknown> = {}) {
  const parsed = parsePluginManifest({
    name: "ade-tipsy",
    version: "0.3.0",
    displayName: "Tipsy",
    description: "A drink counter.",
    vocabVersion: 1,
    entry: "index.js",
    panels: [{ id: "main", schemaFile: "panels/main.json" }],
    ...overrides,
  });
  if (!parsed.manifest) throw new Error(parsed.errors.join(", "));
  return listingFromManifest(parsed.manifest, "https://github.com/arul/ade-tipsy");
}

/** The folder someone picked, and the plugin ADE finds sitting in it. */
const HN_FOLDER = "/Users/arul/repos/ade/plugins/hn";
const HN_MANIFEST = {
  name: "hn",
  version: "0.1.0",
  displayName: "Hacker News",
  description: "The front page, in a tab.",
  vocabVersion: 1,
  entry: "index.js",
  panels: [{ id: "main", schemaFile: "panels/main.json" }],
};

type Picker = (args?: { title?: string; defaultPath?: string }) => Promise<string | null>;

/** Stand the desktop preload's folder picker up for one test. */
function withFolderPicker(picker: Picker) {
  (window as unknown as { ade?: unknown }).ade = { project: { chooseDirectory: picker } };
}

beforeEach(() => {
  bridge.inspected.length = 0;
  bridge.inspection = null;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
  delete (window as unknown as { __adeWebClient?: boolean }).__adeWebClient;
});

const TIMING = /Affects agents from their next turn/;
const CHOOSE_FOLDER = "Choose folder…";

/* Queried off the document, not the render container: the dialog shell portals. */
const sourceValue = () =>
  document.querySelector<HTMLInputElement>("#plugin-install-source")?.value ?? null;

describe("PluginInstallDialog", () => {
  it("says when the plugin will change how agents behave, and from when", () => {
    render(
      <PluginInstallDialog
        target={{ kind: "listing", listing: listing({ skills: ["skills/tipsy"] }) }}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText("Adds")).toBeTruthy();
    expect(screen.getByText(TIMING)).toBeTruthy();
  });

  it("stays silent for a plugin that ships no skill", () => {
    render(
      <PluginInstallDialog
        target={{ kind: "listing", listing: listing() }}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText("Adds")).toBeTruthy();
    expect(screen.queryByText(TIMING)).toBeNull();
  });

  it("promises nothing about a source whose manifest nobody has read yet", () => {
    // Install-from-URL before Check: there is no manifest, so any claim about
    // skills would be a guess. The detail page says it once the install has
    // actually read one.
    render(<PluginInstallDialog target={{ kind: "url" }} onOpenChange={() => {}} />);
    expect(screen.queryByText(TIMING)).toBeNull();
  });
});

describe("installing from a folder on this machine", () => {
  it("puts the picked folder in the field and reads that folder, not the old one", async () => {
    withFolderPicker(async () => HN_FOLDER);
    bridge.inspection = { manifest: HN_MANIFEST };
    render(<PluginInstallDialog target={{ kind: "url" }} onOpenChange={() => {}} />);

    // Something typed first, so a stale read would be visible: inspecting the
    // half-typed URL instead of the folder is exactly the bug worth pinning.
    const field = document.querySelector<HTMLInputElement>("#plugin-install-source");
    if (!field) throw new Error("no source field");
    fireEvent.change(field, { target: { value: "https://github.com/arul/half-typed" } });

    await act(async () => {
      fireEvent.click(screen.getByText(CHOOSE_FOLDER));
    });

    expect(sourceValue()).toBe(HN_FOLDER);
    expect(bridge.inspected).toEqual([HN_FOLDER]);
    // The disclosure filled in, so the person decides against a real manifest.
    expect(screen.getByText("Hacker News")).toBeTruthy();
  });

  it("leaves everything alone when the picker is cancelled", async () => {
    withFolderPicker(async () => null);
    render(<PluginInstallDialog target={{ kind: "url" }} onOpenChange={() => {}} />);

    const field = document.querySelector<HTMLInputElement>("#plugin-install-source");
    if (!field) throw new Error("no source field");
    fireEvent.change(field, { target: { value: "https://github.com/arul/ade-tipsy" } });

    await act(async () => {
      fireEvent.click(screen.getByText(CHOOSE_FOLDER));
    });

    // A cancel that wiped the typed URL would be worse than doing nothing.
    expect(sourceValue()).toBe("https://github.com/arul/ade-tipsy");
    expect(bridge.inspected).toEqual([]);
  });

  it("is not offered in the web client, whose picker always answers nothing", async () => {
    // The hosted adapter stubs `chooseDirectory` and resolves null every time,
    // so a button gated on the member merely existing would open nothing.
    (window as unknown as { __adeWebClient?: boolean }).__adeWebClient = true;
    withFolderPicker(async () => HN_FOLDER);
    render(<PluginInstallDialog target={{ kind: "url" }} onOpenChange={() => {}} />);

    expect(screen.queryByText(CHOOSE_FOLDER)).toBeNull();
    expect(screen.getByText("Check")).toBeTruthy();
  });
});

/**
 * The handoff from the in-chat approval card.
 *
 * A plugin an agent just wrote lives in a folder, so it is in neither the
 * bundled index nor the registry and has no detail page to link to. "View in
 * Marketplace" therefore hands this dialog the source, and the reader gets the
 * full disclosure for the exact thing they were asked to approve.
 */
describe("a source handed in from elsewhere", () => {
  it("fills the field and reads the manifest without a second press", async () => {
    bridge.inspection = { manifest: HN_MANIFEST };
    await act(async () => {
      render(
        <PluginInstallDialog
          target={{ kind: "url", source: HN_FOLDER }}
          onOpenChange={() => {}}
        />,
      );
    });
    expect(sourceValue()).toBe(HN_FOLDER);
    expect(bridge.inspected).toEqual([HN_FOLDER]);
    expect(screen.getByText("Hacker News")).toBeTruthy();
  });

  it("reads it once, not on every render", async () => {
    bridge.inspection = { manifest: HN_MANIFEST };
    const view = await act(async () => render(
      <PluginInstallDialog target={{ kind: "url", source: HN_FOLDER }} onOpenChange={() => {}} />,
    ));
    await act(async () => {
      view.rerender(
        <PluginInstallDialog target={{ kind: "url", source: HN_FOLDER }} onOpenChange={() => {}} />,
      );
    });
    expect(bridge.inspected).toEqual([HN_FOLDER]);
  });

  it("leaves the plain install-a-plugin dialog empty", async () => {
    await act(async () => {
      render(<PluginInstallDialog target={{ kind: "url" }} onOpenChange={() => {}} />);
    });
    expect(sourceValue()).toBe("");
    expect(bridge.inspected).toEqual([]);
  });
});
