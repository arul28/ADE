import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AppInfo } from "../../../shared/types";
import { EmptyState } from "../ui/EmptyState";
import {
  COLORS,
  MONO_FONT,
  cardStyle,
  LABEL_STYLE,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { AdeCliSection } from "./AdeCliSection";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

type RuntimeServiceInstallState = NonNullable<AppInfo["localRuntime"]>["serviceInstall"]["state"];
type RuntimeServiceHealthState = NonNullable<AppInfo["localRuntime"]>["serviceHealth"]["state"];

function runtimeServiceLabel(state: RuntimeServiceInstallState): string {
  switch (state) {
    case "installed": return "Installed";
    case "installing": return "Installing";
    case "failed": return "Needs attention";
    case "skipped": return "Skipped";
    default: return "Not checked";
  }
}

function runtimeServiceColor(state: RuntimeServiceInstallState): string {
  switch (state) {
    case "installed": return COLORS.success;
    case "installing": return COLORS.accent;
    case "failed": return COLORS.danger;
    case "skipped": return COLORS.warning;
    default: return COLORS.textMuted;
  }
}

function runtimeServiceHealthLabel(state: RuntimeServiceHealthState): string {
  switch (state) {
    case "running": return "Running";
    case "installed": return "Installed";
    case "not_installed": return "Not installed";
    case "error": return "Status error";
    case "unsupported": return "Unsupported";
    default: return "Unknown";
  }
}

function runtimeServiceHealthColor(state: RuntimeServiceHealthState): string {
  switch (state) {
    case "running": return COLORS.success;
    case "installed": return COLORS.warning;
    case "not_installed": return COLORS.textMuted;
    case "error": return COLORS.danger;
    case "unsupported": return COLORS.warning;
    default: return COLORS.textMuted;
  }
}

function formatRuntimeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export function GeneralSection() {
  const navigate = useNavigate();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<{ completedAt: string | null; dismissedAt: string | null; freshProject?: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      });
    window.ade.onboarding
      .getStatus()
      .then((value) => {
        if (!cancelled) setOnboardingStatus(value);
      })
      .catch(() => {
        if (!cancelled) setOnboardingStatus({ completedAt: null, dismissedAt: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (info?.localRuntime?.serviceInstall.state !== "installing") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      window.ade.app
        .getInfo()
        .then((value) => {
          if (!cancelled) setInfo(value);
        })
        .catch(() => {});
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [info?.localRuntime?.serviceInstall.state]);

  if (loadError) {
    return <EmptyState title="General" description={`Failed to load: ${loadError}`} />;
  }

  if (!info) {
    return <EmptyState title="General" description="Loading..." />;
  }

  const setupComplete = Boolean(onboardingStatus?.completedAt);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section>
        <div style={sectionLabelStyle}>PROJECT SETUP</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>
                {setupComplete ? "Project setup completed" : onboardingStatus?.freshProject ? "Fresh project setup available" : "Project setup can be reopened"}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                The guided setup flow covers AI, GitHub, Linear, and local helpers for fresh projects. You can reopen it any time if you want to walk through those steps again.
              </div>
            </div>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "4px 8px",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: setupComplete ? COLORS.success : onboardingStatus?.freshProject ? COLORS.warning : COLORS.textMuted,
                background: setupComplete ? "color-mix(in srgb, var(--color-success) 18%, transparent)" : onboardingStatus?.freshProject ? "color-mix(in srgb, var(--color-warning) 18%, transparent)" : "color-mix(in srgb, var(--color-muted-fg) 18%, transparent)",
                border: setupComplete
                  ? "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)"
                  : onboardingStatus?.freshProject
                    ? "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)"
                    : "1px solid color-mix(in srgb, var(--color-muted-fg) 30%, transparent)",
              }}
            >
              {setupComplete ? "Ready" : onboardingStatus?.freshProject ? "Fresh project" : "Available"}
            </span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" style={primaryButton()} onClick={() => navigate("/onboarding")}>
              {setupComplete ? "RUN SETUP AGAIN" : "OPEN PROJECT SETUP"}
            </button>
          </div>
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>ADE CLI</div>
        <AdeCliSection compact />
      </section>

      {info.localRuntime ? (
        <section>
          <div style={sectionLabelStyle}>BACKGROUND RUNTIME</div>
          <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>
                  Runtime daemon service
                </div>
                <div style={{ marginTop: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                  Connection: {info.localRuntime.connectionState}. Install: {info.localRuntime.serviceInstall.message ?? "No install status."}
                </div>
                <div style={{ marginTop: 4, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                  Login service: {info.localRuntime.serviceHealth.message ?? "No service health status."}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "4px 8px",
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: MONO_FONT,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    color: runtimeServiceColor(info.localRuntime.serviceInstall.state),
                    background: `color-mix(in srgb, ${runtimeServiceColor(info.localRuntime.serviceInstall.state)} 18%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${runtimeServiceColor(info.localRuntime.serviceInstall.state)} 30%, transparent)`,
                  }}
                >
                  {runtimeServiceLabel(info.localRuntime.serviceInstall.state)}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "4px 8px",
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: MONO_FONT,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    color: runtimeServiceHealthColor(info.localRuntime.serviceHealth.state),
                    background: `color-mix(in srgb, ${runtimeServiceHealthColor(info.localRuntime.serviceHealth.state)} 18%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${runtimeServiceHealthColor(info.localRuntime.serviceHealth.state)} 30%, transparent)`,
                  }}
                >
                  {runtimeServiceHealthLabel(info.localRuntime.serviceHealth.state)}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
              {info.localRuntime.serviceHealth.path ?? info.localRuntime.serviceInstall.path ? (
                <span>Path: {info.localRuntime.serviceHealth.path ?? info.localRuntime.serviceInstall.path}</span>
              ) : null}
              {info.localRuntime.serviceInstall.exitCode != null ? (
                <span>Exit code: {info.localRuntime.serviceInstall.exitCode}</span>
              ) : null}
              {info.localRuntime.serviceHealth.checkedAt ? (
                <span>Service checked: {formatRuntimeTimestamp(info.localRuntime.serviceHealth.checkedAt)}</span>
              ) : null}
              {formatRuntimeTimestamp(info.localRuntime.serviceInstall.updatedAt) ? (
                <span>Updated: {formatRuntimeTimestamp(info.localRuntime.serviceInstall.updatedAt)}</span>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <section
        style={{
          paddingTop: 20,
          borderTop: `1px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: COLORS.textDim,
          }}
        >
          APP VERSION
        </span>
        <span
          style={{
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
          }}
        >
          v{info.appVersion}
        </span>
        <span
          style={{
            fontSize: 9,
            fontFamily: MONO_FONT,
            color: COLORS.textDim,
            padding: "1px 6px",
            background: "color-mix(in srgb, var(--color-muted-fg) 18%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-muted-fg) 30%, transparent)",
            borderRadius: 0,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          {info.isPackaged ? "PACKAGED" : "DEV"}
        </span>
      </section>
    </div>
  );
}
