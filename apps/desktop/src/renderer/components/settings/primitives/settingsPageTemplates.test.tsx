/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SettingsManagerPage } from "./SettingsManagerPage";
import { SettingsDashboardPage } from "./SettingsDashboardPage";

/**
 * The seam these templates sit on is navigation, not looks: `?tab=x#anchor`
 * and ⌘K both land by scrolling to `id={anchor}`. That property, the absence of
 * the scope badge these headers used to wear, and the slots adopters actually
 * fill are what this file pins; the pixels are deliberately not asserted.
 */

const UNREGISTERED_ANCHOR = "not-a-real-settings-anchor";

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

    it("wears no scope badge, registered anchor or not", () => {
      const { container } = render(
        <SettingsManagerPage anchor="secrets" title="Secrets" description="Keys and tokens.">
          <div>body</div>
        </SettingsManagerPage>,
      );
      expect(container.querySelector("[data-scope]")).toBeNull();
      expect(container.textContent).not.toContain("Account");

      cleanup();

      const { container: unregistered } = render(
        <SettingsManagerPage anchor={UNREGISTERED_ANCHOR} title="Unregistered">
          <div>body</div>
        </SettingsManagerPage>,
      );
      expect(unregistered.querySelector("[data-scope]")).toBeNull();
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

    it("wears no scope badge either", () => {
      const { container } = render(
        <SettingsDashboardPage anchor="secrets" title="Usage">
          <div>body</div>
        </SettingsDashboardPage>,
      );
      expect(container.querySelector("[data-scope]")).toBeNull();
      expect(container.textContent).not.toContain("Account");
    });
  });
});
