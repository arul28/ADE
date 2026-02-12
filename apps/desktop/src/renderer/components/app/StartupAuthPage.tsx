import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { HostedBootstrapConfig, HostedStatus, ProjectConfigSnapshot } from "../../../shared/types";
import { Button } from "../ui/Button";
import { useAppStore } from "../../state/appStore";

const STARTUP_CHOICE_KEY = "ade.startup.choice";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function getHostedConfig(snapshot: ProjectConfigSnapshot): Record<string, unknown> {
  const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};
  const effectiveProviders = isRecord(snapshot.effective.providers) ? snapshot.effective.providers : {};
  const localHosted = isRecord(localProviders.hosted) ? localProviders.hosted : {};
  const effectiveHosted = isRecord(effectiveProviders.hosted) ? effectiveProviders.hosted : {};
  return { ...effectiveHosted, ...localHosted };
}

export function StartupAuthPage() {
  const navigate = useNavigate();
  const refreshProviderMode = useAppStore((s) => s.refreshProviderMode);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostedStatus, setHostedStatus] = useState<HostedStatus | null>(null);
  const [bootstrapConfig, setBootstrapConfig] = useState<HostedBootstrapConfig | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [githubConsentAccepted, setGithubConsentAccepted] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [status, bootstrap, snapshot] = await Promise.all([
          window.ade.hosted.getStatus().catch(() => null),
          window.ade.hosted.getBootstrapConfig().catch(() => null),
          window.ade.projectConfig.get()
        ]);

        if (cancelled) return;

        if (status) setHostedStatus(status);
        if (bootstrap) setBootstrapConfig(bootstrap);

        const hosted = getHostedConfig(snapshot);
        setTermsAccepted(asBoolean(hosted.consentGiven));
        setGithubConsentAccepted(asBoolean(hosted.githubRepoConsent));

        const startupChoice = window.localStorage.getItem(STARTUP_CHOICE_KEY);
        if (status?.auth.signedIn || startupChoice === "guest") {
          navigate("/project", { replace: true });
          return;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const persistProviderConfig = async (args: {
    mode: "guest" | "hosted";
    consentGiven: boolean;
    githubRepoConsent: boolean;
  }) => {
    const snapshot = await window.ade.projectConfig.get();
    const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};
    const localHosted = isRecord(localProviders.hosted) ? localProviders.hosted : {};

    const nextProviders: Record<string, unknown> = {
      ...localProviders,
      mode: args.mode,
      hosted: {
        ...localHosted,
        consentGiven: args.consentGiven,
        githubRepoConsent: args.githubRepoConsent
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
  };

  const continueAsGuest = async () => {
    setError(null);
    setBusy(true);
    try {
      await persistProviderConfig({
        mode: "guest",
        consentGiven: termsAccepted,
        githubRepoConsent: githubConsentAccepted
      });
      window.localStorage.setItem(STARTUP_CHOICE_KEY, "guest");
      navigate("/project", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signInWithClerk = async () => {
    if (!termsAccepted || !githubConsentAccepted) {
      setError("Please accept both consent checkboxes before signing in.");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      if (bootstrapConfig) {
        await window.ade.hosted.applyBootstrapConfig();
      }

      await persistProviderConfig({
        mode: "hosted",
        consentGiven: true,
        githubRepoConsent: true
      });

      await window.ade.hosted.signIn();
      const status = await window.ade.hosted.getStatus();
      setHostedStatus(status);

      window.localStorage.removeItem(STARTUP_CHOICE_KEY);
      navigate("/project", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const bootstrapStatus = useMemo(() => {
    if (!bootstrapConfig) {
      return "No hosted bootstrap config detected. Run infra deploy + bootstrap script first.";
    }
    return `Bootstrap ready (${bootstrapConfig.stage})`;
  }, [bootstrapConfig]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-fg">
        <div className="rounded-lg border border-border bg-card/70 px-4 py-3 text-sm">Loading startup setup...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg p-4 text-fg">
      <div className="w-full max-w-xl rounded-xl border border-border bg-card/70 p-5 shadow-lg backdrop-blur">
        <div className="text-lg font-semibold">Welcome to ADE</div>
        <div className="mt-1 text-sm text-muted-fg">
          Sign in or sign up to enable hosted mirror sync, narratives, and conflict proposals. ADE uses Clerk here, where you can
          continue with GitHub or Google. You can also continue in Guest Mode and sign in later from Settings.
        </div>

        <div className="mt-4 rounded border border-border bg-card/40 p-3 text-xs text-muted-fg">{bootstrapStatus}</div>

        <div className="mt-4 space-y-2 rounded border border-border bg-card/40 p-3">
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(event) => setTermsAccepted(event.target.checked)}
            />
            <span>I accept ADE hosted processing and cloud mirror sync terms for this project.</span>
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={githubConsentAccepted}
              onChange={(event) => setGithubConsentAccepted(event.target.checked)}
            />
            <span>
              I allow ADE to connect to my repositories for hosted features (actual repo connection is stubbed in Phase 6; GitHub
              connection flow lands in Phase 7).
            </span>
          </label>
        </div>

        {hostedStatus?.auth.signedIn ? (
          <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            Already signed in as {hostedStatus.auth.email || hostedStatus.auth.displayName || hostedStatus.auth.userId || "user"}.
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void signInWithClerk()}>
            {busy ? "Working..." : "Sign in / Sign up (GitHub or Google)"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void continueAsGuest()}>
            Continue as Guest
          </Button>
        </div>

        <div className="mt-3 text-xs text-muted-fg">
          You can always change auth mode later in Settings.
        </div>
      </div>
    </div>
  );
}
