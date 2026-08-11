/**
 * A route whose page belongs to a plugin.
 *
 * Hiding the rail item is not enough, and this is where round 1 stopped: the
 * `/graph` route stayed live so old links kept working, which meant a removed
 * tab was still one URL away and the persisted last-route could put you back on
 * it with no click. The product decision is that a surface you do not have is
 * simply not part of your ADE, so the route answers plainly instead.
 *
 * "Not loaded yet" is the one case a route must NOT treat as hidden, and it is
 * the only place that differs from the rail. The rail is right to stay empty
 * until it knows, because a tab that appears and vanishes reads as a glitch. A
 * route has already been asked for: answering "you do not have this" during the
 * moment before the registry resolves would tell every installed user their tab
 * is gone, on every cold start. So it waits, wearing whatever the caller uses
 * while a lazy chunk loads.
 *
 * Callers should keep this OUTSIDE their Suspense boundary — a page nobody may
 * open should not pull its chunk down to find that out.
 */

import React from "react";

import { builtinGateForRoute, isBuiltinTabVisible } from "./builtinTabs";
import { BuiltinSurfaceUnavailable } from "./BuiltinSurfaceUnavailable";
import { useBuiltinGateInput } from "./useBuiltinTabs";

export function BuiltinRouteGuard({
  route,
  pending,
  children,
}: {
  route: string;
  /** Shown while the registry is still resolving. */
  pending: React.ReactNode;
  children: React.ReactNode;
}) {
  const gateInput = useBuiltinGateInput();
  if (isBuiltinTabVisible(route, gateInput)) return <>{children}</>;
  if (gateInput.pluginSupport && !gateInput.pluginsLoaded) return <>{pending}</>;
  return <BuiltinSurfaceUnavailable title={builtinGateForRoute(route)?.title ?? "This tab"} />;
}
