import { describe, expect, it } from "vitest";
import { parseCodexPluginList } from "./codexPluginList";

describe("parseCodexPluginList", () => {
  it("reads PluginListResponse marketplaces and hides uninstalled remotes", () => {
    expect(parseCodexPluginList({
      marketplaces: [
        {
          name: "openai-bundled",
          plugins: [
            {
              id: "bundled.docs",
              name: "docs",
              enabled: true,
              installed: true,
              source: { type: "local", path: "/bundled/docs" },
              installPolicy: "INSTALLED_BY_DEFAULT",
            },
          ],
        },
        {
          name: "local-market",
          plugins: [
            {
              id: "local.lint",
              name: "lint",
              enabled: false,
              installed: true,
              source: { type: "local", path: "/home/.codex/plugins/lint" },
              installPolicy: "AVAILABLE",
            },
          ],
        },
        {
          name: "remote-catalog",
          plugins: [
            {
              id: "remote.shown",
              name: "shown",
              enabled: true,
              installed: true,
              source: { type: "remote" },
              installPolicy: "AVAILABLE",
            },
            {
              id: "remote.hidden",
              name: "hidden",
              enabled: false,
              installed: false,
              source: { type: "remote" },
              installPolicy: "AVAILABLE",
            },
          ],
        },
      ],
    })).toEqual([
      {
        id: "bundled.docs",
        name: "docs",
        enabled: true,
        installed: true,
        origin: "bundled",
        marketplaceName: "openai-bundled",
      },
      {
        id: "local.lint",
        name: "lint",
        enabled: false,
        installed: true,
        origin: "local",
        marketplaceName: "local-market",
      },
      {
        id: "remote.shown",
        name: "shown",
        enabled: true,
        installed: true,
        origin: "remote",
        marketplaceName: "remote-catalog",
      },
    ]);
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseCodexPluginList(null)).toEqual([]);
    expect(parseCodexPluginList({})).toEqual([]);
    expect(parseCodexPluginList({ marketplaces: "nope" })).toEqual([]);
  });
});
