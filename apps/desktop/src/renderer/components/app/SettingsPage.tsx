import React, { useEffect, useState } from "react";
import { EmptyState } from "../ui/EmptyState";
import type { AppInfo } from "../../../shared/types";

export function SettingsPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getInfo()
      .then((v) => {
        if (!cancelled) setInfo(v);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <EmptyState title="Settings" description={`Failed to load app info: ${error}`} />;
  }

  if (!info) {
    return <EmptyState title="Settings" description="Loading…" />;
  }

  return (
    <div className="h-full overflow-auto rounded-lg border border-border bg-card/60 p-4 backdrop-blur">
      <div className="text-sm font-semibold">Environment</div>
      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card/70 p-3">
          <div className="text-xs text-muted-fg">App</div>
          <div className="mt-1 text-sm font-medium">v{info.appVersion}</div>
          <div className="mt-1 text-xs text-muted-fg">{info.isPackaged ? "packaged" : "dev"}</div>
        </div>
        <div className="rounded-lg border border-border bg-card/70 p-3">
          <div className="text-xs text-muted-fg">Runtime</div>
          <div className="mt-1 text-sm">
            {info.platform} / {info.arch}
          </div>
          <div className="mt-1 text-xs text-muted-fg">
            node {info.versions.node} · electron {info.versions.electron}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
          <div className="text-xs text-muted-fg">Versions</div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div>
              <div className="text-xs text-muted-fg">Electron</div>
              <div>{info.versions.electron}</div>
            </div>
            <div>
              <div className="text-xs text-muted-fg">Chrome</div>
              <div>{info.versions.chrome}</div>
            </div>
            <div>
              <div className="text-xs text-muted-fg">Node</div>
              <div>{info.versions.node}</div>
            </div>
            <div>
              <div className="text-xs text-muted-fg">V8</div>
              <div>{info.versions.v8}</div>
            </div>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
          <div className="text-xs text-muted-fg">Env</div>
          <div className="mt-2 grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
            <div>
              <div className="text-xs text-muted-fg">NODE_ENV</div>
              <div>{info.env.nodeEnv ?? "(unset)"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-fg">VITE_DEV_SERVER_URL</div>
              <div className="truncate">{info.env.viteDevServerUrl ?? "(unset)"}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

