import React, { useEffect, useState } from "react";
import { EmptyState } from "../ui/EmptyState";
import type {
  AppInfo,
  GitHubStatus,
  HostedGitHubAppStatus,
  HostedGitHubEvent,
  HostedBootstrapConfig,
  HostedStatus,
  ProviderMode,
  ProjectConfigSnapshot
} from "../../../shared/types";
import { useAppStore, ThemeId, THEME_IDS } from "../../state/appStore";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

type ProviderDraft = {
  mode: ProviderMode;
  hosted: {
    consentGiven: boolean;
    githubRepoConsent: boolean;
    apiBaseUrl: string;
    region: string;
    clerkPublishableKey: string;
    clerkOauthClientId: string;
    clerkIssuer: string;
    clerkFrontendApiUrl: string;
    clerkOauthMetadataUrl: string;
    clerkOauthAuthorizeUrl: string;
    clerkOauthTokenUrl: string;
    clerkOauthRevocationUrl: string;
    clerkOauthUserInfoUrl: string;
    clerkOauthScopes: string;
    uploadTranscripts: boolean;
    mirrorExcludePatternsText: string;
  };
  byok: {
    provider: "openai" | "anthropic" | "gemini";
    model: string;
    apiKey: string;
  };
  cli: {
    command: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toPatternsFromTextarea(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readProviderDraft(snapshot: ProjectConfigSnapshot): ProviderDraft {
  const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};
  const effectiveProviders = isRecord(snapshot.effective.providers) ? snapshot.effective.providers : {};
  const providers = { ...effectiveProviders, ...localProviders };

  const hosted = isRecord(providers.hosted) ? providers.hosted : {};
  const byok = isRecord(providers.byok) ? providers.byok : {};
  const cli = isRecord(providers.cli) ? providers.cli : {};

  const modeRaw = asString(providers.mode);
  const mode: ProviderMode =
    modeRaw === "hosted" || modeRaw === "byok" || modeRaw === "cli" || modeRaw === "guest"
      ? modeRaw
      : snapshot.effective.providerMode ?? "guest";

  return {
    mode,
    hosted: {
      consentGiven: asBoolean(hosted.consentGiven),
      githubRepoConsent: asBoolean(hosted.githubRepoConsent),
      apiBaseUrl: asString(hosted.apiBaseUrl),
      region: asString(hosted.region),
      clerkPublishableKey: asString(hosted.clerkPublishableKey),
      clerkOauthClientId: asString(hosted.clerkOauthClientId),
      clerkIssuer: asString(hosted.clerkIssuer),
      clerkFrontendApiUrl: asString(hosted.clerkFrontendApiUrl),
      clerkOauthMetadataUrl: asString(hosted.clerkOauthMetadataUrl),
      clerkOauthAuthorizeUrl: asString(hosted.clerkOauthAuthorizeUrl),
      clerkOauthTokenUrl: asString(hosted.clerkOauthTokenUrl),
      clerkOauthRevocationUrl: asString(hosted.clerkOauthRevocationUrl),
      clerkOauthUserInfoUrl: asString(hosted.clerkOauthUserInfoUrl),
      clerkOauthScopes: asString(hosted.clerkOauthScopes) || "openid profile email offline_access",
      uploadTranscripts: asBoolean(hosted.uploadTranscripts),
      mirrorExcludePatternsText: asStringArray(hosted.mirrorExcludePatterns).join("\n")
    },
    byok: {
      provider:
        asString(byok.provider) === "openai"
          ? "openai"
          : asString(byok.provider) === "gemini"
            ? "gemini"
            : "anthropic",
      model: asString(byok.model),
      apiKey: asString(byok.apiKey)
    },
    cli: {
      command: asString(cli.command)
    }
  };
}

function validateProviderDraft(draft: ProviderDraft, hasBootstrapConfig: boolean): string | null {
  if (draft.mode === "hosted" && !draft.hosted.consentGiven) {
    return "Hosted mode requires consent before saving.";
  }

  if (draft.mode === "hosted" && !draft.hosted.githubRepoConsent) {
    return "Enable repository connection consent before signing in.";
  }

  if (draft.mode === "hosted" && !draft.hosted.apiBaseUrl.trim() && !hasBootstrapConfig) {
    return "Hosted mode requires an API base URL (or an applied bootstrap file).";
  }

  if (draft.mode === "hosted" && !draft.hosted.clerkOauthClientId.trim() && !hasBootstrapConfig) {
    return "Hosted mode requires a Clerk OAuth client ID (or an applied bootstrap file).";
  }

  if (draft.mode === "byok" && !draft.byok.apiKey.trim()) {
    return "BYOK mode requires an API key.";
  }

  if (draft.mode === "byok" && !draft.byok.model.trim()) {
    return "BYOK mode requires a model name.";
  }

  return null;
}

const THEME_META: Record<ThemeId, { label: string; colors: { bg: string; fg: string; card: string; border: string; accent: string } }> = {
  "e-paper": {
    label: "E-Paper",
    colors: { bg: "#fdfbf7", fg: "#1c1917", card: "#fdfbf7", border: "#dbd8d3", accent: "#c22323" }
  },
  bloomberg: {
    label: "Bloomberg",
    colors: { bg: "#0a0a0a", fg: "#ff9900", card: "#111111", border: "#333333", accent: "#ff6600" }
  },
  github: {
    label: "GitHub",
    colors: { bg: "#0d1117", fg: "#c9d1d9", card: "#161b22", border: "#30363d", accent: "#58a6ff" }
  },
  rainbow: {
    label: "Rainbow",
    colors: { bg: "#1b1f23", fg: "#e6edf3", card: "#24292e", border: "#444c56", accent: "#c084fc" }
  },
  sky: {
    label: "Sky",
    colors: { bg: "#f0f6ff", fg: "#1e3a8a", card: "#ffffff", border: "#bfdbfe", accent: "#3b82f6" }
  },
  pats: {
    label: "Pats",
    colors: { bg: "#002244", fg: "#ffffff", card: "#001122", border: "#c60c30", accent: "#c60c30" }
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
      {/* Preview square */}
      <div
        className="h-12 w-12 rounded-md border overflow-hidden"
        style={{ backgroundColor: colors.bg, borderColor: colors.border }}
      >
        {/* Mini layout: top bar */}
        <div className="h-2 w-full" style={{ backgroundColor: colors.card }} />
        {/* Accent stripe */}
        <div className="mx-auto mt-1 h-1.5 w-8 rounded-full" style={{ backgroundColor: colors.accent }} />
        {/* Text lines */}
        <div className="mx-1 mt-1 space-y-0.5">
          <div className="h-0.5 w-6 rounded-full" style={{ backgroundColor: colors.fg, opacity: 0.6 }} />
          <div className="h-0.5 w-4 rounded-full" style={{ backgroundColor: colors.fg, opacity: 0.35 }} />
          <div className="h-0.5 w-5 rounded-full" style={{ backgroundColor: colors.fg, opacity: 0.35 }} />
        </div>
      </div>
      {/* Label */}
      <span className="text-[10px] font-medium leading-none">{label}</span>
      {/* Selected indicator */}
      {selected && (
        <div className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-fg text-[8px] font-bold">
          ✓
        </div>
      )}
    </button>
  );
}

export function SettingsPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [hostedStatus, setHostedStatus] = useState<HostedStatus | null>(null);
  const [hostedBootstrapConfig, setHostedBootstrapConfig] = useState<HostedBootstrapConfig | null>(null);
  const [hostedBusy, setHostedBusy] = useState(false);
  const [showAdvancedHostedFields, setShowAdvancedHostedFields] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [githubBusy, setGithubBusy] = useState(false);
  const [prPollingIntervalDraft, setPrPollingIntervalDraft] = useState("25");
  const [prPollingBusy, setPrPollingBusy] = useState(false);
  const [hostedGithubStatus, setHostedGithubStatus] = useState<HostedGitHubAppStatus | null>(null);
  const [hostedGithubEvents, setHostedGithubEvents] = useState<HostedGitHubEvent[]>([]);
  const [hostedGithubBusy, setHostedGithubBusy] = useState(false);
  const [hostedGithubPollingUntil, setHostedGithubPollingUntil] = useState<number | null>(null);
  const providerMode = useAppStore((s) => s.providerMode);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const refreshProviderMode = useAppStore((s) => s.refreshProviderMode);

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

    window.ade.projectConfig
      .get()
      .then((snapshot) => {
        if (!cancelled) {
          setProviderDraft(readProviderDraft(snapshot));
          const localSeconds = typeof snapshot.local.github?.prPollingIntervalSeconds === "number" ? snapshot.local.github.prPollingIntervalSeconds : null;
          const effectiveSeconds =
            typeof snapshot.effective.github?.prPollingIntervalSeconds === "number" ? snapshot.effective.github.prPollingIntervalSeconds : null;
          const seconds = localSeconds ?? effectiveSeconds ?? 25;
          setPrPollingIntervalDraft(String(seconds));
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });

    window.ade.hosted
      .getStatus()
      .then((status) => {
        if (!cancelled) setHostedStatus(status);
      })
      .catch(() => { });

    window.ade.hosted
      .getBootstrapConfig()
      .then((config) => {
        if (!cancelled) setHostedBootstrapConfig(config);
      })
      .catch(() => { });

    window.ade.github
      .getStatus()
      .then((status) => {
        if (!cancelled) setGithubStatus(status);
      })
      .catch(() => { });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!providerDraft || providerDraft.mode !== "hosted") {
      setHostedGithubStatus(null);
      setHostedGithubEvents([]);
      setHostedGithubPollingUntil(null);
      return () => {
        cancelled = true;
      };
    }

    window.ade.hosted.github
      .getStatus()
      .then((status) => {
        if (!cancelled) setHostedGithubStatus(status);
      })
      .catch(() => { });

    window.ade.hosted.github
      .listEvents()
      .then((res) => {
        if (!cancelled) setHostedGithubEvents(res.events ?? []);
      })
      .catch(() => { });

    return () => {
      cancelled = true;
    };
  }, [providerDraft?.mode]);

  useEffect(() => {
    if (hostedGithubPollingUntil == null) return;
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (cancelled || inFlight) return;
      if (Date.now() >= hostedGithubPollingUntil) {
        setHostedGithubPollingUntil(null);
        return;
      }

      inFlight = true;
      try {
        const status = await window.ade.hosted.github.getStatus();
        if (!cancelled) setHostedGithubStatus(status);
        if (status.connected) {
          setHostedGithubPollingUntil(null);
          setSaveNotice("GitHub App connected.");
        }
      } catch {
        // Ignore polling errors; user can manually refresh.
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => void tick(), 2000);
    void tick();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hostedGithubPollingUntil]);

  useEffect(() => {
    if (!providerDraft || providerDraft.mode !== "hosted") return;
    if (!hostedGithubStatus?.connected) return;

    let cancelled = false;
    let inFlight = false;

    const refreshEvents = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const res = await window.ade.hosted.github.listEvents();
        if (!cancelled) setHostedGithubEvents(res.events ?? []);
      } catch {
        // ignore
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => void refreshEvents(), 10_000);
    void refreshEvents();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [providerDraft?.mode, hostedGithubStatus?.connected]);

  if (loadError) {
    return <EmptyState title="Settings" description={`Failed to load settings: ${loadError}`} />;
  }

  if (!info || !providerDraft) {
    return <EmptyState title="Settings" description="Loading..." />;
  }

  const refreshProviderDraftAndHostedState = async () => {
    const snapshot = await window.ade.projectConfig.get();
    setProviderDraft(readProviderDraft(snapshot));
    const localSeconds = typeof snapshot.local.github?.prPollingIntervalSeconds === "number" ? snapshot.local.github.prPollingIntervalSeconds : null;
    const effectiveSeconds =
      typeof snapshot.effective.github?.prPollingIntervalSeconds === "number" ? snapshot.effective.github.prPollingIntervalSeconds : null;
    setPrPollingIntervalDraft(String(localSeconds ?? effectiveSeconds ?? 25));
    const [status, bootstrap] = await Promise.all([
      window.ade.hosted.getStatus().catch(() => null),
      window.ade.hosted.getBootstrapConfig().catch(() => null)
    ]);
    if (status) setHostedStatus(status);
    setHostedBootstrapConfig(bootstrap ?? null);
  };

  const saveProvider = async () => {
    setActionError(null);
    setSaveNotice(null);

    const validationError = validateProviderDraft(providerDraft, Boolean(hostedBootstrapConfig));
    if (validationError) {
      setActionError(validationError);
      return;
    }

    try {
      const snapshot = await window.ade.projectConfig.get();
      const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};

      const nextProviders: Record<string, unknown> = {
        ...localProviders,
        mode: providerDraft.mode,
        hosted: {
          consentGiven: providerDraft.hosted.consentGiven,
          githubRepoConsent: providerDraft.hosted.githubRepoConsent,
          apiBaseUrl: providerDraft.hosted.apiBaseUrl.trim(),
          region: providerDraft.hosted.region.trim(),
          clerkPublishableKey: providerDraft.hosted.clerkPublishableKey.trim(),
          clerkOauthClientId: providerDraft.hosted.clerkOauthClientId.trim(),
          clerkIssuer: providerDraft.hosted.clerkIssuer.trim(),
          clerkFrontendApiUrl: providerDraft.hosted.clerkFrontendApiUrl.trim(),
          clerkOauthMetadataUrl: providerDraft.hosted.clerkOauthMetadataUrl.trim(),
          clerkOauthAuthorizeUrl: providerDraft.hosted.clerkOauthAuthorizeUrl.trim(),
          clerkOauthTokenUrl: providerDraft.hosted.clerkOauthTokenUrl.trim(),
          clerkOauthRevocationUrl: providerDraft.hosted.clerkOauthRevocationUrl.trim(),
          clerkOauthUserInfoUrl: providerDraft.hosted.clerkOauthUserInfoUrl.trim(),
          clerkOauthScopes: providerDraft.hosted.clerkOauthScopes.trim() || "openid profile email offline_access",
          uploadTranscripts: providerDraft.hosted.uploadTranscripts,
          mirrorExcludePatterns: toPatternsFromTextarea(providerDraft.hosted.mirrorExcludePatternsText)
        },
        byok: {
          provider: providerDraft.byok.provider,
          model: providerDraft.byok.model.trim(),
          apiKey: providerDraft.byok.apiKey.trim()
        },
        cli: {
          command: providerDraft.cli.command.trim()
        },
        updatedAt: new Date().toISOString()
      };

      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          providers: nextProviders
        }
      });

      await refreshProviderMode();
      await refreshProviderDraftAndHostedState();
      setSaveNotice("Provider configuration saved to .ade/local.yaml.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const savePrPollingSettings = async () => {
    setActionError(null);
    setSaveNotice(null);

    const raw = prPollingIntervalDraft.trim();
    const snapshot = await window.ade.projectConfig.get();
    const currentGithub = isRecord(snapshot.local.github) ? snapshot.local.github : {};
    const nextGithub: Record<string, unknown> = { ...currentGithub };

    if (!raw.length) {
      delete nextGithub.prPollingIntervalSeconds;
    } else {
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        setActionError("PR polling interval must be a positive number of seconds.");
        return;
      }
      if (seconds < 5 || seconds > 300) {
        setActionError("PR polling interval must be between 5 and 300 seconds.");
        return;
      }
      nextGithub.prPollingIntervalSeconds = seconds;
    }

    setPrPollingBusy(true);
    try {
      const nextLocal = {
        ...snapshot.local,
        ...(Object.keys(nextGithub).length ? { github: nextGithub } : {})
      };
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: nextLocal
      });

      await refreshProviderDraftAndHostedState();
      setSaveNotice("PR polling settings saved to .ade/local.yaml.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPrPollingBusy(false);
    }
  };

  const applyHostedBootstrap = async () => {
    setActionError(null);
    setSaveNotice(null);
    setHostedBusy(true);
    try {
      const bootstrap = await window.ade.hosted.applyBootstrapConfig();
      setHostedBootstrapConfig(bootstrap);
      await refreshProviderDraftAndHostedState();
      setSaveNotice(`Applied hosted bootstrap for stage '${bootstrap.stage}'.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setHostedBusy(false);
    }
  };

  const authSummary = hostedStatus?.auth.signedIn
    ? hostedStatus.auth.email || hostedStatus.auth.displayName || hostedStatus.auth.userId || "Signed in"
    : "signed out";

  return (
    <div className="h-full overflow-auto rounded-lg border border-border bg-card/60 p-4 backdrop-blur">
      <div className="text-sm font-semibold">Theme</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {THEME_IDS.map((id) => (
          <ThemeSwatch key={id} themeId={id} selected={theme === id} onClick={() => setTheme(id)} />
        ))}
      </div>

      <div className="my-6 h-px w-full bg-border" />

      <div className="text-sm font-semibold">Environment</div>
      {saveNotice ? (
        <div className="mt-2 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {saveNotice}
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{actionError}</div>
      ) : null}

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
          <div className="text-xs text-muted-fg">Provider Mode</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={providerDraft.mode}
              onChange={(e) => {
                const nextMode = e.target.value as ProviderMode;
                setProviderDraft((prev) =>
                  prev
                    ? {
                      ...prev,
                      mode: nextMode
                    }
                    : prev
                );
              }}
              className="h-9 rounded-md border border-border bg-card/80 px-3 text-sm"
            >
              <option value="guest">Guest (local templates)</option>
              <option value="hosted">Hosted</option>
              <option value="byok">BYOK</option>
              <option value="cli">CLI</option>
            </select>
            <Button size="sm" onClick={() => void saveProvider()}>
              Save Provider
            </Button>
            <div className="text-xs text-muted-fg">Current: {providerMode}</div>
          </div>
        </div>

        {providerDraft.mode === "hosted" ? (
          <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
            <div className="text-xs text-muted-fg">Hosted Agent (Clerk + GitHub/Google)</div>
            <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Hosted mode uploads redacted mirror data and job payloads to ADE cloud. You can authenticate through Clerk with
              GitHub or Google. Repo linking is consent-only in Phase 6; full GitHub repo connection lands in Phase 7.
            </div>

            <label className="mt-3 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={providerDraft.hosted.consentGiven}
                onChange={(e) =>
                  setProviderDraft((prev) =>
                    prev
                      ? {
                        ...prev,
                        hosted: {
                          ...prev.hosted,
                          consentGiven: e.target.checked
                        }
                      }
                      : prev
                  )
                }
              />
              <span>I accept hosted processing and cloud mirror sync for this project.</span>
            </label>

            <label className="mt-2 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={providerDraft.hosted.githubRepoConsent}
                onChange={(e) =>
                  setProviderDraft((prev) =>
                    prev
                      ? {
                        ...prev,
                        hosted: {
                          ...prev.hosted,
                          githubRepoConsent: e.target.checked
                        }
                      }
                      : prev
                  )
                }
              />
              <span>I allow ADE to connect to my repositories for hosted features (connection flow is stubbed in Phase 6).</span>
            </label>

            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={providerDraft.hosted.uploadTranscripts}
                onChange={(e) =>
                  setProviderDraft((prev) =>
                    prev
                      ? {
                        ...prev,
                        hosted: {
                          ...prev.hosted,
                          uploadTranscripts: e.target.checked
                        }
                      }
                      : prev
                  )
                }
              />
              Upload transcript logs during hosted mirror sync.
            </label>

            <div className="mt-3 rounded border border-border bg-card/30 p-2 text-xs">
              <div className="font-medium text-fg">Bootstrap Config</div>
              {hostedBootstrapConfig ? (
                <div className="mt-1 text-muted-fg">
                  stage: {hostedBootstrapConfig.stage} · api: {hostedBootstrapConfig.apiBaseUrl}
                  {hostedBootstrapConfig.generatedAt ? ` · generated ${hostedBootstrapConfig.generatedAt}` : ""}
                </div>
              ) : (
                <div className="mt-1 text-muted-fg">
                  No bootstrap file detected at `.ade/hosted/bootstrap.json`.
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={hostedBusy} onClick={() => void applyHostedBootstrap()}>
                  Apply Bootstrap
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={hostedBusy}
                  onClick={() => {
                    setHostedBusy(true);
                    setActionError(null);
                    window.ade.hosted
                      .getBootstrapConfig()
                      .then((config) => setHostedBootstrapConfig(config))
                      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                      .finally(() => setHostedBusy(false));
                  }}
                >
                  Refresh Bootstrap
                </Button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={hostedBusy}
                onClick={() => {
                  setHostedBusy(true);
                  setActionError(null);
                  window.ade.hosted
                    .signIn()
                    .then(() => window.ade.hosted.getStatus())
                    .then((status) => {
                      setHostedStatus(status);
                      setSaveNotice("Hosted sign-in completed.");
                    })
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setHostedBusy(false));
                }}
              >
                {hostedBusy ? "Working..." : "Sign in / Sign up (GitHub or Google)"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={hostedBusy}
                onClick={() => {
                  setHostedBusy(true);
                  setActionError(null);
                  window.ade.hosted
                    .signOut()
                    .then(() => window.ade.hosted.getStatus())
                    .then((status) => {
                      setHostedStatus(status);
                      setSaveNotice("Hosted auth session cleared.");
                    })
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setHostedBusy(false));
                }}
              >
                Sign Out
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={hostedBusy}
                onClick={() => {
                  setHostedBusy(true);
                  setActionError(null);
                  window.ade.hosted
                    .syncMirror({ includeTranscripts: providerDraft.hosted.uploadTranscripts })
                    .then((result) => {
                      setSaveNotice(
                        `Mirror sync complete. Uploaded ${result.uploaded} blobs (${result.deduplicated} deduplicated, ${result.excluded} excluded).`
                      );
                    })
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setHostedBusy(false));
                }}
              >
                Sync Mirror
              </Button>
              <div className="text-xs text-muted-fg">
                Auth: {authSummary}
                {hostedStatus?.auth.expiresAt ? ` · access token exp ${hostedStatus.auth.expiresAt}` : ""}
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-xs text-muted-fg">Mirror exclude patterns (one per line)</div>
              <textarea
                className="min-h-[90px] w-full rounded border border-border bg-bg px-3 py-2 text-xs"
                value={providerDraft.hosted.mirrorExcludePatternsText}
                onChange={(e) =>
                  setProviderDraft((prev) =>
                    prev
                      ? {
                        ...prev,
                        hosted: {
                          ...prev.hosted,
                          mirrorExcludePatternsText: e.target.value
                        }
                      }
                      : prev
                  )
                }
                placeholder=".env\nsecrets/\n*.pem"
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowAdvancedHostedFields((prev) => !prev)}>
                {showAdvancedHostedFields ? "Hide Advanced Fields" : "Show Advanced Fields"}
              </Button>
            </div>

            {showAdvancedHostedFields ? (
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="API Base URL"
                  value={providerDraft.hosted.apiBaseUrl}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            apiBaseUrl: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="AWS Region"
                  value={providerDraft.hosted.region}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            region: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk Publishable Key"
                  value={providerDraft.hosted.clerkPublishableKey}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkPublishableKey: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk OAuth Client ID"
                  value={providerDraft.hosted.clerkOauthClientId}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkOauthClientId: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk JWT Issuer"
                  value={providerDraft.hosted.clerkIssuer}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkIssuer: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk Frontend API URL"
                  value={providerDraft.hosted.clerkFrontendApiUrl}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkFrontendApiUrl: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk OAuth Metadata URL"
                  value={providerDraft.hosted.clerkOauthMetadataUrl}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkOauthMetadataUrl: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk OAuth Authorize URL"
                  value={providerDraft.hosted.clerkOauthAuthorizeUrl}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkOauthAuthorizeUrl: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk OAuth Token URL"
                  value={providerDraft.hosted.clerkOauthTokenUrl}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkOauthTokenUrl: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk OAuth Revocation URL"
                  value={providerDraft.hosted.clerkOauthRevocationUrl}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkOauthRevocationUrl: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm"
                  placeholder="Clerk OAuth UserInfo URL"
                  value={providerDraft.hosted.clerkOauthUserInfoUrl}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkOauthUserInfoUrl: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
                <input
                  className="h-9 rounded border border-border bg-bg px-3 text-sm md:col-span-2"
                  placeholder="Clerk OAuth scopes"
                  value={providerDraft.hosted.clerkOauthScopes}
                  onChange={(e) =>
                    setProviderDraft((prev) =>
                      prev
                        ? {
                          ...prev,
                          hosted: {
                            ...prev.hosted,
                            clerkOauthScopes: e.target.value
                          }
                        }
                        : prev
                    )
                  }
                />
              </div>
            ) : null}

            <div className="mt-2 text-xs text-muted-fg">
              Hosted tokens are stored in OS secure storage. Existing sessions are restored across app restarts.
            </div>
          </div>
        ) : null}

        {providerDraft.mode === "hosted" ? (
          <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
            <div className="text-xs text-muted-fg">GitHub App (Hosted, Phase 7A)</div>
            <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Hosted GitHub uses a GitHub App installation per project (no PATs). Click Connect, complete the installation in the browser, then return to ADE.
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={
                  hostedGithubBusy ||
                  providerMode !== "hosted" ||
                  !hostedStatus?.auth.signedIn ||
                  !providerDraft.hosted.consentGiven ||
                  !providerDraft.hosted.githubRepoConsent ||
                  hostedGithubStatus?.configured === false
                }
                onClick={() => {
                  setHostedGithubBusy(true);
                  setActionError(null);
                  setSaveNotice(null);
                  window.ade.hosted.github
                    .connectStart()
                    .then(() => {
                      setSaveNotice("Opened GitHub App installation page. Finish install and return to ADE.");
                      setHostedGithubPollingUntil(Date.now() + 2 * 60_000);
                    })
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setHostedGithubBusy(false));
                }}
              >
                {hostedGithubBusy ? "Working..." : "Connect GitHub App"}
              </Button>

              <Button
                size="sm"
                variant="outline"
                disabled={hostedGithubBusy || providerMode !== "hosted" || !hostedGithubStatus?.connected}
                onClick={() => {
                  setHostedGithubBusy(true);
                  setActionError(null);
                  setSaveNotice(null);
                  window.ade.hosted.github
                    .disconnect()
                    .then(() => window.ade.hosted.github.getStatus())
                    .then((status) => {
                      setHostedGithubStatus(status);
                      setSaveNotice("GitHub App disconnected.");
                    })
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setHostedGithubBusy(false));
                }}
              >
                Disconnect
              </Button>

              <Button
                size="sm"
                variant="outline"
                disabled={hostedGithubBusy || providerMode !== "hosted"}
                onClick={() => {
                  setHostedGithubBusy(true);
                  setActionError(null);
                  window.ade.hosted.github
                    .getStatus()
                    .then((status) => setHostedGithubStatus(status))
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setHostedGithubBusy(false));
                }}
              >
                Refresh Status
              </Button>

              {!hostedStatus?.auth.signedIn ? (
                <div className="text-xs text-muted-fg">Sign in first.</div>
              ) : providerMode !== "hosted" ? (
                <div className="text-xs text-muted-fg">Save provider mode as Hosted first.</div>
              ) : hostedGithubStatus?.configured === false ? (
                <div className="text-xs text-muted-fg">Server GitHub App not configured.</div>
              ) : null}
            </div>

            <div className="mt-2 rounded border border-border bg-bg/40 px-3 py-2 text-xs text-muted-fg">
              <div>configured: {hostedGithubStatus ? (hostedGithubStatus.configured ? "yes" : "no") : "unknown"}</div>
              <div>connected: {hostedGithubStatus ? (hostedGithubStatus.connected ? "yes" : "no") : "unknown"}</div>
              <div>app slug: {hostedGithubStatus?.appSlug ?? "unknown"}</div>
              <div>installation: {hostedGithubStatus?.installationId ?? "none"}</div>
              <div>connected at: {hostedGithubStatus?.connectedAt ?? "never"}</div>
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-fg">Recent GitHub webhook events (debug)</div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={hostedGithubBusy || providerMode !== "hosted"}
                  onClick={() => {
                    setHostedGithubBusy(true);
                    setActionError(null);
                    window.ade.hosted.github
                      .listEvents()
                      .then((res) => setHostedGithubEvents(res.events ?? []))
                      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                      .finally(() => setHostedGithubBusy(false));
                  }}
                >
                  Refresh Events
                </Button>
              </div>

              <div className="mt-2 max-h-[220px] overflow-auto rounded border border-border bg-card/30">
                <div className="divide-y divide-border">
                  {hostedGithubEvents.map((ev) => (
                    <div key={ev.eventId} className="px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-fg">{ev.summary}</div>
                        <div className="shrink-0 text-[11px] text-muted-fg">{ev.createdAt}</div>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-fg">
                        {ev.repoFullName ? ev.repoFullName : "unknown repo"}
                        {ev.prNumber != null ? ` · #${ev.prNumber}` : ""}
                        {ev.action ? ` · ${ev.action}` : ""}
                      </div>
                    </div>
                  ))}
                  {!hostedGithubEvents.length ? (
                    <div className="px-3 py-3 text-xs text-muted-fg">No events stored yet.</div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {providerDraft.mode === "byok" ? (
          <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
            <div className="text-xs text-muted-fg">BYOK (ONBOARD-015)</div>
            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
              <select
                className="h-9 rounded border border-border bg-bg px-3 text-sm"
                value={providerDraft.byok.provider}
                onChange={(e) =>
                  setProviderDraft((prev) =>
                    prev
                      ? {
                        ...prev,
                        byok: {
                          ...prev.byok,
                          provider:
                            e.target.value === "openai" ? "openai" : e.target.value === "gemini" ? "gemini" : "anthropic"
                        }
                      }
                      : prev
                  )
                }
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>
              <input
                className="h-9 rounded border border-border bg-bg px-3 text-sm"
                placeholder="Model"
                value={providerDraft.byok.model}
                onChange={(e) =>
                  setProviderDraft((prev) =>
                    prev
                      ? {
                        ...prev,
                        byok: {
                          ...prev.byok,
                          model: e.target.value
                        }
                      }
                      : prev
                  )
                }
              />
              <input
                type="password"
                className="h-9 rounded border border-border bg-bg px-3 text-sm"
                placeholder="API Key"
                value={providerDraft.byok.apiKey}
                onChange={(e) =>
                  setProviderDraft((prev) =>
                    prev
                      ? {
                        ...prev,
                        byok: {
                          ...prev.byok,
                          apiKey: e.target.value
                        }
                      }
                      : prev
                  )
                }
              />
            </div>
            <div className="mt-2 text-xs text-muted-fg">API key is stored in `.ade/local.yaml` and excluded from git.</div>
          </div>
        ) : null}

        <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
          <div className="text-xs text-muted-fg">GitHub (Local Token)</div>
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
            <input
              type="password"
              className="h-9 rounded border border-border bg-bg px-3 text-sm md:col-span-2"
              placeholder="GitHub token (PAT; non-hosted mode only)"
              value={githubTokenDraft}
              onChange={(e) => setGithubTokenDraft(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={githubBusy}
                onClick={() => {
                  const token = githubTokenDraft.trim();
                  if (!token) {
                    setActionError("GitHub token is empty.");
                    return;
                  }
                  setGithubBusy(true);
                  setActionError(null);
                  window.ade.github
                    .setToken(token)
                    .then((status) => {
                      setGithubStatus(status);
                      setGithubTokenDraft("");
                      setSaveNotice("GitHub token saved.");
                    })
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setGithubBusy(false));
                }}
              >
                Save Token
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={githubBusy}
                onClick={() => {
                  setGithubBusy(true);
                  setActionError(null);
                  window.ade.github
                    .clearToken()
                    .then((status) => {
                      setGithubStatus(status);
                      setSaveNotice("GitHub token cleared.");
                    })
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setGithubBusy(false));
                }}
              >
                Clear
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={githubBusy}
                onClick={() => {
                  setGithubBusy(true);
                  setActionError(null);
                  window.ade.github
                    .getStatus()
                    .then((status) => setGithubStatus(status))
                    .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setGithubBusy(false));
                }}
              >
                Refresh
              </Button>
            </div>
          </div>
          <div className="mt-2 rounded border border-border bg-bg/40 px-3 py-2 text-xs text-muted-fg">
            <div>token stored: {githubStatus?.tokenStored ? "yes" : "no"}</div>
            <div>repo: {githubStatus?.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : "unknown"}</div>
            <div>user: {githubStatus?.userLogin ?? "unknown"}</div>
            <div>scopes: {(githubStatus?.scopes ?? []).join(", ") || "unknown"}</div>
            <div>checked: {githubStatus?.checkedAt ?? "never"}</div>
          </div>
          <div className="mt-2 text-xs text-muted-fg">
            Token is encrypted using OS secure storage and stored locally under `.ade/`. In Hosted mode, GitHub uses the GitHub App connection instead of this token.
          </div>
          <div className="mt-3 rounded border border-border bg-bg/40 px-3 py-2 text-xs text-muted-fg">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">PR Polling</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={5}
                max={300}
                className="h-8 w-[120px] rounded border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
                value={prPollingIntervalDraft}
                onChange={(e) => setPrPollingIntervalDraft(e.target.value)}
              />
              <span className="text-[11px] text-muted-fg">seconds</span>
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" disabled={prPollingBusy} onClick={() => void savePrPollingSettings()}>
                  {prPollingBusy ? "Saving..." : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={prPollingBusy}
                  onClick={() => {
                    window.ade.projectConfig
                      .get()
                      .then((snapshot) => {
                        const localSeconds =
                          typeof snapshot.local.github?.prPollingIntervalSeconds === "number" ? snapshot.local.github.prPollingIntervalSeconds : null;
                        const effectiveSeconds =
                          typeof snapshot.effective.github?.prPollingIntervalSeconds === "number"
                            ? snapshot.effective.github.prPollingIntervalSeconds
                            : null;
                        setPrPollingIntervalDraft(String(localSeconds ?? effectiveSeconds ?? 25));
                      })
                      .catch(() => {});
                  }}
                >
                  Reset
                </Button>
              </div>
            </div>
            <div className="mt-1 text-[11px] text-muted-fg">
              Controls background PR refresh and notifications. Default is 25s; higher values reduce GitHub API usage.
            </div>
          </div>
        </div>

        {providerDraft.mode === "cli" ? (
          <div className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
            <div className="text-xs text-muted-fg">CLI Provider</div>
            <input
              className="mt-2 h-9 w-full rounded border border-border bg-bg px-3 text-sm"
              placeholder="CLI command (for example: claude, codex, aider)"
              value={providerDraft.cli.command}
              onChange={(e) =>
                setProviderDraft((prev) =>
                  prev
                    ? {
                      ...prev,
                      cli: {
                        command: e.target.value
                      }
                    }
                    : prev
                )
              }
            />
          </div>
        ) : null}

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
