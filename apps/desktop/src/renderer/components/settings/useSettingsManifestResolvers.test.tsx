/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";
import { useAppStore } from "../../state/appStore";
import type { OpenProjectBinding } from "../../../shared/types";
import { hasWebMachineBinding, isBuiltinSurfaceShown } from "./settingsAvailability";
import { useSettingsManifestResolvers } from "./useSettingsManifestResolvers";

/**
 * The one lifecycle both settings surfaces share.
 *
 * `SettingsPage` and `CommandPalette` each used to carry their own character-
 * for-character copy of this install/uninstall pair against two module globals,
 * which is exactly the shape where one surface silently stops matching the
 * other. Now there is one hook, so this is where the contract is pinned:
 * installed DURING render (an effect would be a render too late, and the first
 * paint is the one that would show a card for a surface a plugin has taken
 * over), and cleared on unmount only if it is still ours.
 */

const LOCAL_BINDING: OpenProjectBinding = {
  kind: "local",
  key: "local:/repo",
  rootPath: "/repo",
  displayName: "repo",
};

/** Reads both resolvers back mid-render, right after installing them. */
function Probe({ seen }: { seen: { linearShown: boolean[]; machineBound: boolean[] } }) {
  useSettingsManifestResolvers();
  seen.linearShown.push(isBuiltinSurfaceShown("linear"));
  seen.machineBound.push(hasWebMachineBinding());
  return null;
}

function record() {
  return { linearShown: [] as boolean[], machineBound: [] as boolean[] };
}

afterEach(() => {
  cleanup();
  resetBuiltinSurfacePlugins();
  useAppStore.setState({ projectBinding: null });
});

describe("useSettingsManifestResolvers", () => {
  it("answers for the plugin registry during the very render that installs it", () => {
    seedBuiltinSurfacePlugins(["linear"]);
    const seen = record();
    render(<Probe seen={seen} />);
    // Not `toBe(false)` on the last value only: every render must have seen the
    // gated answer, because the first one is the paint.
    expect(seen.linearShown).toEqual([false]);
  });

  it("leaves a superseded surface alone on a machine without the plugin", () => {
    seedBuiltinSurfacePlugins([]);
    const seen = record();
    render(<Probe seen={seen} />);
    expect(seen.linearShown).toEqual([true]);
  });

  it("reports the machine binding mid-render too", () => {
    useAppStore.setState({ projectBinding: LOCAL_BINDING });
    const seen = record();
    render(<Probe seen={seen} />);
    expect(seen.machineBound).toEqual([true]);
  });

  it("takes down only its own resolvers, because both surfaces install both", () => {
    // The settings page and the palette unmount in no fixed order. An
    // unconditional clear would leave the manifest answering for a registry the
    // other surface is still watching.
    seedBuiltinSurfacePlugins(["linear"]);
    useAppStore.setState({ projectBinding: LOCAL_BINDING });
    const page = render(<Probe seen={record()} />);
    const palette = render(<Probe seen={record()} />);

    page.unmount();
    expect(isBuiltinSurfaceShown("linear")).toBe(false);
    expect(hasWebMachineBinding()).toBe(true);

    palette.unmount();
    // Nothing installed: the manifest falls back to the shipped default, which
    // for a superseded surface is "ADE still draws it".
    expect(isBuiltinSurfaceShown("linear")).toBe(true);
    expect(hasWebMachineBinding()).toBe(false);
  });
});
