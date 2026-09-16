/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { settingsScopeForAnchor } from "../settingsManifest";
import {
  SettingsManagerPage,
  SettingsManagerTable,
  SettingsManagerRow,
  SettingsManagerEmpty,
} from "./SettingsManagerPage";
import { SettingsDashboardPage, SettingsDashboardStat } from "./SettingsDashboardPage";

/**
 * The seam these templates sit on is navigation, not looks: `?tab=x#anchor`
 * and ⌘K both land by scrolling to `id={anchor}`, and the scope chip is only
 * trustworthy while it is read from the manifest rather than hand-passed.
 * Those two properties, plus the slots adopters actually fill, are what this
 * file pins; the pixels are deliberately not asserted.
 */

const UNREGISTERED_ANCHOR = "not-a-real-settings-anchor";

afterEach(cleanup);

describe("settings page templates", () => {
  it("has a registered and an unregistered anchor to test with", () => {
    expect(settingsScopeForAnchor("secrets")).toBe("account-repo");
    expect(settingsScopeForAnchor(UNREGISTERED_ANCHOR)).toBeNull();
  });

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

    it("reads the scope chip from the manifest", () => {
      const { container } = render(
        <SettingsManagerPage anchor="secrets" title="Secrets" description="Keys and tokens.">
          <div>body</div>
        </SettingsManagerPage>,
      );

      expect(container.querySelector('[data-scope="account-repo"]')).toBeTruthy();
    });

    it("shows no chip for an anchor the manifest does not know", () => {
      const { container } = render(
        <SettingsManagerPage anchor={UNREGISTERED_ANCHOR} title="Unregistered">
          <div>body</div>
        </SettingsManagerPage>,
      );

      expect(container.querySelector("[data-scope]")).toBeNull();
    });

    it("renders the toolbar slot", () => {
      render(
        <SettingsManagerPage
          anchor="secrets"
          title="Secrets"
          toolbar={<button type="button">Import .env</button>}
        >
          <div>body</div>
        </SettingsManagerPage>,
      );

      expect(screen.getByRole("button", { name: "Import .env" })).toBeTruthy();
    });

    it("renders table headers, row cells and row actions", () => {
      render(
        <SettingsManagerPage anchor="secrets" title="Secrets">
          <SettingsManagerTable
            columns={[{ label: "Name" }, { label: "Updated" }, { label: "Actions", align: "right" }]}
          >
            <SettingsManagerRow actions={<button type="button">Delete</button>}>
              <span>STRIPE_API_KEY</span>
              <span>2 days ago</span>
            </SettingsManagerRow>
          </SettingsManagerTable>
        </SettingsManagerPage>,
      );

      expect(screen.getByText("Name")).toBeTruthy();
      expect(screen.getByText("STRIPE_API_KEY")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    });

    it("renders the empty state's action", () => {
      render(
        <SettingsManagerEmpty
          title="No templates yet"
          description="A template says what happens when a lane is created."
          action={<button type="button">Create your first template</button>}
        />,
      );

      expect(screen.getByText("No templates yet")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Create your first template" })).toBeTruthy();
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

    it("reads the scope chip from the manifest, and omits it otherwise", () => {
      const { container: registered } = render(
        <SettingsDashboardPage anchor="secrets" title="Usage">
          <div>body</div>
        </SettingsDashboardPage>,
      );
      expect(registered.querySelector('[data-scope="account-repo"]')).toBeTruthy();

      cleanup();

      const { container: unregistered } = render(
        <SettingsDashboardPage anchor={UNREGISTERED_ANCHOR} title="Usage">
          <div>body</div>
        </SettingsDashboardPage>,
      );
      expect(unregistered.querySelector("[data-scope]")).toBeNull();
    });

    it("renders a stat's label, value and hint", () => {
      render(<SettingsDashboardStat label="Processed tokens" value="1.2M" hint="Last 7 days" />);

      expect(screen.getByText("Processed tokens")).toBeTruthy();
      expect(screen.getByText("1.2M")).toBeTruthy();
      expect(screen.getByText("Last 7 days")).toBeTruthy();
    });
  });
});
