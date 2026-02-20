import React, { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "./cn";

const routeToTabBg: Record<string, string> = {
  "/project": "ade-tab-bg-project",
  "/lanes": "ade-tab-bg-lanes",
  "/files": "ade-tab-bg-files",
  "/terminals": "ade-tab-bg-terminals",
  "/conflicts": "ade-tab-bg-conflicts",
  "/graph": "ade-tab-bg-graph",
  "/prs": "ade-tab-bg-prs",
  "/history": "ade-tab-bg-history",
  "/automations": "ade-tab-bg-automations",
  "/missions": "ade-tab-bg-missions",
  "/settings": "ade-tab-bg-settings",
};

export function TabBackground() {
  const location = useLocation();

  const bgClass = useMemo(() => {
    const path = location.pathname;
    return routeToTabBg[path] ?? null;
  }, [location.pathname]);

  if (!bgClass) return null;

  return (
    <div
      className={cn(
        "ade-tab-bg pointer-events-none absolute inset-0 z-0 overflow-hidden transition-opacity duration-300",
        bgClass
      )}
      aria-hidden="true"
    />
  );
}
