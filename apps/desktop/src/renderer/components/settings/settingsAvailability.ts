/**
 * The renderer-state bridge the settings manifest reads its availability from.
 *
 * `settingsManifest.ts` is a plain data module: no React, no store, and it is
 * consulted mid-render by three different surfaces (the settings nav, the
 * settings page's own search, and the Cmd-K palette). Two of its availability
 * questions have answers that only live app state can give — is a machine
 * bound, and does ADE still draw a given compiled surface — so each is a
 * resolver installed from the React side rather than a flag pushed here on a
 * lifecycle event that may not have run yet.
 *
 * It lives beside the manifest instead of inside it because these two mutable
 * module globals are the only stateful thing in an otherwise pure registry, and
 * a registry that is 1,000 lines of data reads better without them. The
 * manifest re-exports every symbol here, so the seam callers and tests drive is
 * unchanged.
 */

import { builtinSurfaceDrawn } from "../../../shared/plugins/builtinSurfaces";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";

/**
 * "Does ADE still draw this compiled surface?", as a value.
 *
 * Named because it is passed as well as installed: `availableSettingsTabs`
 * takes one so a React memo can name the dependency it would otherwise read
 * invisibly through the module global below.
 */
export type BuiltinSurfaceGate = (builtinId: PluginBuiltinSurfaceId) => boolean;

/**
 * Whether the hosted client currently has a machine to write machine-scoped
 * settings to — i.e. whether a project tab is bound.
 *
 * A resolver rather than a flag: nav, search and the palette all ask
 * `isSettingAvailable` mid-render, so the answer has to be read at call time
 * from live app state instead of pushed here on a lifecycle event that may not
 * have run yet. The desktop never installs one, and never asks.
 */
let webMachineBindingResolver: (() => boolean) | null = null;

export function setWebMachineBindingResolver(resolve: (() => boolean) | null): void {
  webMachineBindingResolver = resolve;
}

/**
 * Uninstall a resolver, but only if it is still the installed one.
 *
 * Two surfaces install a resolver (the settings page and the palette) and they
 * unmount in no fixed order, so an unconditional clear on unmount would tear
 * down a resolver the OTHER surface had since installed, leaving the manifest
 * answering `false` for a machine that is in fact bound.
 */
export function clearWebMachineBindingResolver(resolve: () => boolean): void {
  if (webMachineBindingResolver === resolve) webMachineBindingResolver = null;
}

export function hasWebMachineBinding(): boolean {
  return webMachineBindingResolver?.() ?? false;
}

/**
 * Whether ADE still draws a compiled surface, for the settings that live on one.
 *
 * A resolver for the same reason the machine binding is one: the answer comes
 * from the plugin registry in the root store, this module has no React, and
 * nav, search and the palette all ask mid-render. The React surfaces install it
 * with `isBuiltinSurfaceVisible` behind it, so the polarity rules live in one
 * place rather than being restated here.
 */
let builtinSurfaceResolver: BuiltinSurfaceGate | null = null;

export function setBuiltinSurfaceResolver(resolve: BuiltinSurfaceGate | null): void {
  builtinSurfaceResolver = resolve;
}

/** Uninstall a resolver, but only if it is still the installed one. */
export function clearBuiltinSurfaceResolver(resolve: BuiltinSurfaceGate): void {
  if (builtinSurfaceResolver === resolve) builtinSurfaceResolver = null;
}

export function isBuiltinSurfaceShown(builtinId: PluginBuiltinSurfaceId): boolean {
  // With no resolver installed, the empty registry is the honest input and the
  // shared rule answers from it — see the polarity contract in `builtinTabs.ts`.
  return builtinSurfaceResolver?.(builtinId) ?? builtinSurfaceDrawn(builtinId, []);
}
