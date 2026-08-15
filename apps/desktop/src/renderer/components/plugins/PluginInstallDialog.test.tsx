/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

/**
 * The install decision, and the one part of it that is not immediate.
 *
 * A plugin's skill takes effect at the start of the NEXT agent turn, and the
 * turn the reader is most likely to test it on is the one already running. The
 * approval card an agent shows says so; this dialog is the other way in, and it
 * said nothing — the same decision reaching two surfaces with one of them
 * silent, which is the shape of confusion the alpha retrospective is about.
 */

vi.mock("../../state/appStore", () => ({
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({ refreshInstalledPlugins: async () => {} }),
}));

vi.mock("../../lib/pluginRuntimeBridge", () => ({
  inspectPluginSource: async () => null,
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

afterEach(cleanup);

const TIMING = /Affects agents from their next turn/;

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
