/**
 * A route whose page belongs to a plugin.
 *
 * Hiding the rail item is not enough. Graph, Review and History SUPERSEDE: ADE
 * ships the compiled page, and installing the owner sends that URL to the
 * plugin tab. Enabling surfaces still refuse the route when their owner is
 * gone. A hidden rail item is not access control.
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
import { Navigate } from "react-router-dom";

import { builtinGateForRoute, isBuiltinTabVisible, supersededCompiledRouteReplacement } from "./builtinTabs";
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
  const replacement = supersededCompiledRouteReplacement(route, gateInput);
  if (replacement) return <Navigate to={replacement} replace />;
  return <BuiltinSurfaceUnavailable title={builtinGateForRoute(route)?.title ?? "This tab"} />;
}
