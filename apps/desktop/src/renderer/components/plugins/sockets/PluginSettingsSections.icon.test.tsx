/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { PluginSettingsSections } from "./PluginSettingsSections";
import { rootAppStoreApi } from "../../../state/appStore";

/**
 * The glyph on a contributed settings section's header.
 *
 * Its own file because the registry fixture is loaded once per surface, so a
 * plugin whose manifest names a `brand:*` icon cannot share one with the file
 * that proves page resolution.
 *
 * The bug: the header resolved the icon NAME without the plugin's shipped
 * artwork, so `brand:linear` — a token that arrives with the package and can
 * never be in a compiled list — drew the puzzle piece here while the tab rail
 * two inches away drew Linear's mark, off the same manifest field.
 */

/** A one-path mono SVG, the shape the host sanitizes a shipped brand icon to. */
const LINEAR_PATH = "M2 2 L38 2 L38 38 L2 38 Z";
const LINEAR_GLYPH = { viewBox: "0 0 40 40", paths: [{ d: LINEAR_PATH }] };

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "linear",
          displayName: "Linear",
          enabled: true,
          accent: null,
          // A token no compiled catalogue can hold: the artwork ships with the
          // plugin, so only the plugin's own rows can resolve it.
          icon: "brand:linear",
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "linear",
        version: "1.0.0",
        sockets: [
          {
            socket: "settings-section",
            surface: "settings",
            id: "conn",
            label: "Linear connection",
            panelId: "connection",
            section: "integrations",
          },
        ],
      }),
      listContributions: async () => [],
      invoke: async () => ({}),
      getPanel: async () => null,
      readPanel: async () => null,
      getCollection: async () => [],
      onChanged: () => () => {},
    },
  };
});

afterEach(() => cleanup());

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

/**
 * The header's own glyph — the first SVG inside the section's header row.
 *
 * The plugin record is seeded HERE rather than in a `beforeEach`, because the
 * artwork is what each test varies and a hook cannot read a value the test body
 * has not assigned yet.
 */
async function headerGlyph(brandIcons?: Record<string, unknown>): Promise<SVGSVGElement> {
  rootAppStoreApi.setState({
    pluginsLoaded: true,
    installedPlugins: [{
      pluginId: "linear",
      displayName: "Linear",
      enabled: true,
      accent: null,
      icon: "brand:linear",
      tabs: [],
      disabledContributions: [],
      ...(brandIcons ? { brandIcons } : {}),
    }] as never,
  });
  render(<PluginSettingsSections tab="integrations" />);
  const title = await screen.findByText("Linear connection");
  const header = title.closest("header") as HTMLElement;
  await waitFor(() => expect(header.querySelector("svg")).toBeTruthy());
  return header.querySelector("svg") as SVGSVGElement;
}

describe("the section header's glyph", () => {
  it("draws the plugin's own shipped mark for a brand token", async () => {
    const svg = await headerGlyph({ linear: LINEAR_GLYPH });

    expect(svg.getAttribute("viewBox")).toBe("0 0 40 40");
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(LINEAR_PATH);
  });

  it("still degrades to the puzzle piece when the plugin shipped no artwork", async () => {
    // The honest fallback, and the one case that must NOT be papered over: a
    // well-formed token with no artwork on either side is an unfinished plugin,
    // and drawing something else would hide it.
    const svg = await headerGlyph();

    expect(svg.getAttribute("viewBox")).toBe("0 0 256 256");
    expect(svg.querySelector("path")?.getAttribute("d")).not.toBe(LINEAR_PATH);
  });

  it("refuses a malformed row rather than throwing inside the header", async () => {
    // The rows reach the renderer through the CRR table another machine filled,
    // so the glyph is re-validated here the way iOS re-runs the ceilings.
    const svg = await headerGlyph({
      linear: { viewBox: "not a viewBox", paths: [{ d: LINEAR_PATH }] },
    });

    expect(svg.getAttribute("viewBox")).toBe("0 0 256 256");
  });
});
