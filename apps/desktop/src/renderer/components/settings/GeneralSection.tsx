import React, { useEffect, useState } from "react";
import type { AppInfo } from "../../../shared/types";
import { useAppStore, ThemeId, THEME_IDS } from "../../state/appStore";
import { cn } from "../ui/cn";
import { EmptyState } from "../ui/EmptyState";

const THEME_META: Record<
  ThemeId,
  { label: string; colors: { bg: string; fg: string; card: string; muted: string; border: string; accent: string; accentSecondary: string } }
> = {
  "e-paper": {
    label: "E-Paper",
    colors: {
      bg: "#fdfbf7",
      fg: "#201a14",
      card: "#fdfbf7",
      muted: "#efe8dd",
      border: "#d3cfc6",
      accent: "#c22323",
      accentSecondary: "#ddd1be"
    }
  },
  bloomberg: {
    label: "Bloomberg",
    colors: {
      bg: "#0a0a0a",
      fg: "#ffc87a",
      card: "#16110a",
      muted: "#1f180f",
      border: "#403121",
      accent: "#ff7a00",
      accentSecondary: "#4f3c1f"
    }
  },
  github: {
    label: "GitHub",
    colors: {
      bg: "#0d1117",
      fg: "#c9d1d9",
      card: "#111b2c",
      muted: "#1d2a3a",
      border: "#2f3b49",
      accent: "#58a6ff",
      accentSecondary: "#1f6feb"
    }
  },
  rainbow: {
    label: "Rainbow",
    colors: {
      bg: "#1b1f23",
      fg: "#e6edf3",
      card: "#222737",
      muted: "#2a3342",
      border: "#525e72",
      accent: "#fb7185",
      accentSecondary: "#c084fc"
    }
  },
  sky: {
    label: "Sky",
    colors: {
      bg: "#f0f6ff",
      fg: "#1e3a8a",
      card: "#f7faff",
      muted: "#dbeafe",
      border: "#b7d5ff",
      accent: "#2563eb",
      accentSecondary: "#14b8a6"
    }
  },
  pats: {
    label: "Pats",
    colors: {
      bg: "#001a36",
      fg: "#edf4ff",
      card: "#001a34",
      muted: "#163f66",
      border: "#c60c30",
      accent: "#c60c30",
      accentSecondary: "#0d426b"
    }
  }
};

function ThemeSwatch({ themeId, selected, onClick }: { themeId: ThemeId; selected: boolean; onClick: () => void }) {
  const { label, colors } = THEME_META[themeId];
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-center gap-1.5 rounded-lg p-2 transition-all",
        "hover:bg-muted/40",
        selected && "ring-2 ring-accent ring-offset-1"
      )}
      style={{ "--tw-ring-offset-color": "var(--color-bg)" } as React.CSSProperties}
      title={label}
    >
      <div
        className="h-12 w-12 rounded-md border overflow-hidden"
        style={{ backgroundColor: colors.bg, borderColor: colors.border }}
      >
        <div className="h-2 w-full" style={{ backgroundColor: colors.card }} />
        <div className="mx-auto mt-1 h-1.5 w-8 rounded-full" style={{ backgroundColor: colors.accent }} />
        <div className="mx-auto mt-1 h-1.5 w-8 rounded-full" style={{ backgroundColor: colors.accentSecondary }} />
        <div className="mx-1 mt-1 space-y-0.5">
          <div className="h-0.5 w-6 rounded-full" style={{ backgroundColor: colors.fg, opacity: 0.6 }} />
          <div className="h-0.5 w-4 rounded-full" style={{ backgroundColor: colors.muted, opacity: 0.75 }} />
          <div className="h-0.5 w-5 rounded-full" style={{ backgroundColor: colors.muted, opacity: 0.55 }} />
        </div>
      </div>
      <span className="text-[10px] font-medium leading-none">{label}</span>
      {selected && (
        <div className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-fg text-[8px] font-bold">
          ✓
        </div>
      )}
    </button>
  );
}

export function GeneralSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providerMode = useAppStore((s) => s.providerMode);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getInfo()
      .then((v) => {
        if (!cancelled) setInfo(v);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return <EmptyState title="General" description={`Failed to load: ${loadError}`} />;
  }

  if (!info) {
    return <EmptyState title="General" description="Loading..." />;
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-semibold">Theme</div>
        <div className="mt-2 flex flex-wrap gap-1">
          {THEME_IDS.map((id) => (
            <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
          <div className="text-xs text-muted-fg">Provider Mode</div>
          <div className="mt-2 text-sm">{providerMode}</div>
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
