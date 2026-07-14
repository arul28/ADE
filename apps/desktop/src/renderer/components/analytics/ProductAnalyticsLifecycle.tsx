import React, { useCallback, useEffect, useState } from "react";
import { isWebClientMode } from "../../lib/webClientMode";
import { Button } from "../ui/Button";

type ProductAnalyticsLifecycleArgs = {
  projectRoot: string | null;
  screen: string;
};

function captureHostedWebStartup(screen: string, includeScreen: boolean): void {
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
  if (includeScreen) {
    void analytics.capture({
      event: "ade_screen_viewed",
      properties: {
        screen,
        route_kind: "web",
        source: "renderer_route",
      },
      dedupeKey: `web_screen:${screen}`,
      minimumIntervalMs: 2_000,
    }).catch(() => undefined);
  }
}

export function useProductAnalyticsLifecycle({
  projectRoot,
  screen,
}: ProductAnalyticsLifecycleArgs): {
  consentRequired: boolean;
  allow: () => void;
  decline: () => void;
} {
  const [consentRequired, setConsentRequired] = useState(false);

  useEffect(() => {
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
    captureHostedWebStartup(screen, false);
  }, []);

  useEffect(() => {
    if (!isWebClientMode()) return;
    const analytics = window.ade.analytics;
    if (!analytics) return;
    void Promise.resolve(analytics.getStatus())
      .then((status) => setConsentRequired(status?.consentRequired === true))
      .catch(() => setConsentRequired(false));
  }, []);

  const decline = useCallback(() => {
    void window.ade.analytics?.setEnabled(false).finally(() => {
      setConsentRequired(false);
    });
  }, []);

  const allow = useCallback(() => {
    const analytics = window.ade.analytics;
    if (!analytics) return;
    void analytics.setEnabled(true).then(() => {
      setConsentRequired(false);
      captureHostedWebStartup(screen, true);
    });
  }, [screen]);

  return { consentRequired, allow, decline };
}

export function WebAnalyticsConsentBanner(props: {
  onAllow: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  return (
    <div className="shrink-0 mx-2 mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-fg">
      <span className="min-w-64 flex-1">
        Allow anonymous, daily-capped screen and feature analytics? ADE never sends prompts, code, project or file names, terminal content, raw errors, or recordings.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={props.onDecline}
      >
        Not now
      </Button>
      <Button size="sm" className="h-7 px-2 text-xs" onClick={props.onAllow}>
        Allow analytics
      </Button>
    </div>
  );
}
