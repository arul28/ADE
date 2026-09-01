import React from "react";

import { useAppStore } from "../../state/appStore";
import { useBuiltinSurfaceGate } from "../plugins/useBuiltinTabs";
import {
  clearBuiltinSurfaceResolver,
  clearWebMachineBindingResolver,
  setBuiltinSurfaceResolver,
  setWebMachineBindingResolver,
  type BuiltinSurfaceGate,
} from "./settingsAvailability";

/**
 * Install the two resolvers the settings manifest reads its availability from,
 * and hand back the surface gate the caller still needs itself.
 *
 * `settingsManifest` has no React and no store, but `isSettingAvailable` is
 * consulted mid-render by the settings nav, the settings page's own search and
 * the Cmd-K palette. So the answers arrive as resolvers, installed *during
 * render* — an effect would install them a render too late, and the first paint
 * would be the one that showed a machine-scoped setting on an unbound web tab
 * or a settings card for a surface a plugin has taken over.
 *
 * Both settings surfaces install BOTH resolvers rather than one each: either
 * can be the only one mounted, and a settings row must not appear on one and be
 * missing from the other. That is also why the effects clear conditionally —
 * the two unmount in no fixed order, so each takes down only its own function
 * identity, which is what the lazily-initialised refs below preserve for the
 * whole life of the component.
 *
 * This lived twice, character for character, in `SettingsPage` and
 * `CommandPalette`. Two copies of an install/uninstall pair against a shared
 * module global is the shape where one surface quietly stops matching the
 * other, so it is one hook.
 */
export function useSettingsManifestResolvers(): BuiltinSurfaceGate {
  // Machine-scoped settings write to the machine the active project tab is
  // bound to, so on web they exist only while one is open. Read through a ref
  // so the installed resolver keeps one identity while its answer moves.
  const machineBound = useAppStore((state) => state.projectBinding) != null;
  const machineBoundRef = React.useRef(machineBound);
  machineBoundRef.current = machineBound;
  const bindingResolverRef = React.useRef<() => boolean>(() => machineBoundRef.current);
  setWebMachineBindingResolver(bindingResolverRef.current);
  React.useEffect(() => {
    const installed = bindingResolverRef.current;
    return () => clearWebMachineBindingResolver(installed);
  }, []);

  // A setting whose card belongs to a plugin-owned compiled surface exists only
  // while ADE still draws that surface. `useBuiltinSurfaceGate` owns the
  // polarity rule; this only keeps a stable wrapper around whichever gate is
  // current, for the same install/uninstall-identity reason as above.
  const gate = useBuiltinSurfaceGate();
  const gateRef = React.useRef(gate);
  gateRef.current = gate;
  const surfaceResolverRef = React.useRef<BuiltinSurfaceGate>(
    (builtinId) => gateRef.current(builtinId),
  );
  setBuiltinSurfaceResolver(surfaceResolverRef.current);
  React.useEffect(() => {
    const installed = surfaceResolverRef.current;
    return () => clearBuiltinSurfaceResolver(installed);
  }, []);

  // Returned, not just installed: the caller passes it to `availableSettingsTabs`
  // and names it as a memo dependency, which is how the registry edge stops
  // being invisible to React. Its identity changes exactly when the gate input
  // does, so it is a correct dependency as well as a correct argument.
  return gate;
}
