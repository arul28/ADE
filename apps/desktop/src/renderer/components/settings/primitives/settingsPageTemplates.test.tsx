/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SettingsManagerPage } from "./SettingsManagerPage";
import { SettingsDashboardPage } from "./SettingsDashboardPage";

/**
 * The seam these templates sit on is navigation, not looks: `?tab=x#anchor`
 * and ⌘K both land by scrolling to `id={anchor}`. That property is what this
 * file pins; the pixels are deliberately not asserted.
 */

afterEach(cleanup);

describe("settings page templates", () => {

  describe("SettingsManagerPage", () => {
    it("owns its anchor so deeplinks and search land on it", () => {
      const { container } = render(
        <SettingsManagerPage anchor="secrets" title="Secrets">
          <div>body</div>
        </SettingsManagerPage>,
      );

      const root = container.querySelector("#secrets");
      expect(root).toBeTruthy();
      expect(root!.getAttribute("data-settings-anchor")).toBe("secrets");
    });
  });

  describe("SettingsDashboardPage", () => {
    it("owns its anchor so deeplinks and search land on it", () => {
      const { container } = render(
        <SettingsDashboardPage anchor="secrets" title="Usage">
          <div>body</div>
        </SettingsDashboardPage>,
      );

      const root = container.querySelector("#secrets");
      expect(root).toBeTruthy();
      expect(root!.getAttribute("data-settings-anchor")).toBe("secrets");
    });
  });
});
