import { useEffect } from "react";
import { isWebClientMode } from "../../lib/webClientMode";

type ProductAnalyticsLifecycleArgs = {
  projectRoot: string | null;
  screen: string;
};

const KEY_ANALYTICS_SCREENS = new Set([
  "project",
  "hub",
  "lanes",
  "work",
  "prs",
  "settings",
  "onboarding",
]);

function captureHostedWebStartup(): void {
  const analytics = window.ade.analytics;
  if (!analytics) return;
  void analytics.capture({
    event: "ade_app_opened",
    properties: {
      entry_point: "hosted_web_client",
      source: "renderer_startup",
    },
    dedupeKey: "web_app_opened",
    minimumIntervalMs: 5 * 60_000,
  }).catch(() => undefined);
}

export function useProductAnalyticsLifecycle({
  projectRoot,
  screen,
}: ProductAnalyticsLifecycleArgs): void {
  useEffect(() => {
    if (!KEY_ANALYTICS_SCREENS.has(screen)) return;
    const analytics = window.ade.analytics;
    if (!analytics) return;
    const routeKind = isWebClientMode() ? "web" : "desktop";
    void analytics.capture({
      event: "ade_screen_viewed",
      properties: {
        screen,
        route_kind: routeKind,
        source: "renderer_route",
      },
      dedupeKey: `${routeKind}_screen:${screen}`,
      minimumIntervalMs: 2_000,
    }).catch(() => undefined);
  }, [screen]);

  useEffect(() => {
    if (!projectRoot) return;
    const analytics = window.ade.analytics;
    if (!analytics) return;
    const routeKind = isWebClientMode() ? "web" : "desktop";
    void analytics.capture({
      event: "ade_project_opened",
      properties: {
        route_kind: routeKind,
        source: "renderer_project",
      },
      minimumIntervalMs: 60 * 60_000,
    }).catch(() => undefined);
  }, [projectRoot]);

  useEffect(() => {
    if (!isWebClientMode()) return;
    captureHostedWebStartup();
  }, []);
}
