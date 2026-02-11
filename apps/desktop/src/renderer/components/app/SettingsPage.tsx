import React, { useEffect, useState } from "react";
import { EmptyState } from "../ui/EmptyState";
import type { AppInfo, ProviderMode } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";

export function SettingsPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [providerModeDraft, setProviderModeDraft] = useState<ProviderMode>("guest");
  const providerMode = useAppStore((s) => s.providerMode);
  const refreshProviderMode = useAppStore((s) => s.refreshProviderMode);

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
    window.ade.projectConfig.get().then((snapshot) => {
      if (!cancelled) {
        setProviderModeDraft(snapshot.effective.providerMode ?? "guest");
      }
    }).catch(() => {});
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
      {saveNotice ? <div className="mt-2 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{saveNotice}</div> : null}
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
          <div className="text-xs text-muted-fg">Provider Mode</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={providerModeDraft}
              onChange={(e) => setProviderModeDraft(e.target.value as ProviderMode)}
              className="h-9 rounded-md border border-border bg-card/80 px-3 text-sm"
            >
              <option value="guest">Guest (local templates)</option>
              <option value="hosted">Hosted</option>
              <option value="byok">BYOK</option>
              <option value="cli">CLI</option>
            </select>
            <Button
              size="sm"
              onClick={() => {
                setError(null);
                setSaveNotice(null);
                window.ade.projectConfig.get()
                  .then((snapshot) => {
                    const nextLocal = {
                      ...snapshot.local,
                      providers: {
                        ...(snapshot.local.providers ?? {}),
                        mode: providerModeDraft
                      }
                    };
                    return window.ade.projectConfig.save({
                      shared: snapshot.shared,
                      local: nextLocal
                    });
                  })
                  .then(async () => {
                    await refreshProviderMode();
                    setSaveNotice("Provider mode updated.");
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)));
              }}
            >
              Save Provider
            </Button>
            <div className="text-xs text-muted-fg">Current: {providerMode}</div>
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
