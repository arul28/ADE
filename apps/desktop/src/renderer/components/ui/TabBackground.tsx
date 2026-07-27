import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "./cn";

function primaryTabPath(pathname: string): string {
  const roots = ["/lanes", "/files", "/work", "/graph", "/prs", "/review", "/history", "/automations", "/cto", "/settings"];
  return roots.find((root) => pathname === root || pathname.startsWith(`${root}/`)) ?? pathname;
}

const routeToTabBg: Record<string, string> = {
  "/lanes": "ade-tab-bg-lanes",
  "/files": "ade-tab-bg-files",
  "/work": "ade-tab-bg-terminals",
  "/graph": "ade-tab-bg-graph",
  "/prs": "ade-tab-bg-prs",
  "/review": "ade-tab-bg-review",
  "/history": "ade-tab-bg-history",
  "/automations": "ade-tab-bg-automations",
  "/cto": "ade-tab-bg-cto",
  "/settings": "ade-tab-bg-settings",
};

const routeToTint: Record<string, string> = {
  "/lanes": "tab-tint-lanes",
  "/files": "tab-tint-files",
  "/work": "tab-tint-work",
  "/graph": "tab-tint-graph",
  "/prs": "tab-tint-prs",
  "/review": "tab-tint-review",
  "/history": "tab-tint-history",
  "/automations": "tab-tint-automations",
  "/cto": "tab-tint-cto",
  "/settings": "tab-tint-settings",
};

export function TabBackground() {
  const location = useLocation();
  const path = primaryTabPath(location.pathname);
  const bgClass = routeToTabBg[path] ?? null;
  const tintClass = routeToTint[path] ?? null;
  const [prev, setPrev] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const timerRef = useRef<number>(0);

  useEffect(() => {
    if (prev !== bgClass) {
      setTransitioning(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setPrev(bgClass);
        setTransitioning(false);
      }, 350);
    }
    return () => window.clearTimeout(timerRef.current);
  }, [bgClass, prev]);

  return (
    <>
      {/* Previous background fading out */}
      {transitioning && prev && (
        <div
          className={cn(
            "ade-tab-bg pointer-events-none absolute inset-0 z-0 overflow-hidden",
            prev
          )}
          style={{ opacity: 0, transition: "opacity 200ms ease-out" }}
          aria-hidden="true"
        />
      )}
      {/* Current background */}
      {bgClass && (
        <div
          className={cn(
            "ade-tab-bg pointer-events-none absolute inset-0 z-0 overflow-hidden",
            bgClass,
            tintClass,
            transitioning && "animate-in fade-in duration-300"
          )}
          style={transitioning ? { animation: "ade-bg-fade-in 300ms ease-in forwards" } : undefined}
          aria-hidden="true"
        />
      )}
    </>
  );
}
