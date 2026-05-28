import { useCallback, useEffect, useState } from "react";
import { ArrowCircleUp, ArrowsClockwise, CheckCircle } from "@phosphor-icons/react";
import type { AppInfo, AutoUpdateSnapshot, LatestReleaseInfo } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  width: 84,
  flexShrink: 0,
};

const valueStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
};

function formatReleasedAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const diffMs = Date.now() - ts;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const days = Math.floor(diffMs / dayMs);
  if (days <= 0) {
    const hours = Math.floor(diffMs / hourMs);
    if (hours <= 0) return "released just now";
    return `released ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (days < 30) return `released ${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `released ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `released ${years} year${years === 1 ? "" : "s"} ago`;
}

export function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [latest, setLatest] = useState<LatestReleaseInfo | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.ade.app
      .getInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch(() => {});
    void window.ade.app
      .getLatestRelease()
      .then((value) => {
        if (!cancelled) setLatest(value);
      })
      .catch(() => {
        if (!cancelled) setLatest(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.ade.onUpdateEvent((snapshot: AutoUpdateSnapshot) => {
      setChecking(snapshot.status === "checking");
    });
    return unsubscribe;
  }, []);

  const checkForUpdates = useCallback(() => {
    setChecking(true);
    void window.ade.updateCheckForUpdates().catch(() => setChecking(false));
  }, []);

  const openReleaseNotes = useCallback(() => {
    if (latest?.htmlUrl) void window.ade.app.openExternal(latest.htmlUrl);
  }, [latest]);

  if (!info) return null;

  const isDev = !info.isPackaged;
  const updateAvailable = Boolean(latest?.updateAvailable) && !isDev;
  const releasedAgo = formatReleasedAgo(latest?.publishedAt ?? null);

  let pill: React.ReactNode = null;
  if (isDev) {
    pill = <span style={inlineBadge(COLORS.textMuted)}>DEV BUILD</span>;
  } else if (latest && updateAvailable) {
    pill = (
      <span style={{ ...inlineBadge(COLORS.warning), gap: 5 }}>
        <ArrowCircleUp size={13} weight="fill" />
        Update available
      </span>
    );
  } else if (latest) {
    pill = (
      <span style={{ ...inlineBadge(COLORS.success), gap: 5 }}>
        <CheckCircle size={13} weight="fill" />
        Up to date
      </span>
    );
  }

  return (
    <div
      style={cardStyle(
        updateAvailable
          ? { borderColor: "color-mix(in srgb, var(--color-warning) 40%, transparent)" }
          : undefined,
      )}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>ADE</div>
        {pill}
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={labelStyle}>Installed</span>
          <span style={valueStyle}>{info.appVersion}</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={labelStyle}>Latest</span>
          {latest ? (
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={valueStyle}>{latest.version}</span>
              {releasedAgo ? (
                <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>· {releasedAgo}</span>
              ) : null}
            </span>
          ) : (
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Unavailable</span>
          )}
        </div>
      </div>

      {(updateAvailable || !isDev) ? (
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18, flexWrap: "wrap" }}>
          {updateAvailable && latest?.htmlUrl ? (
            <button type="button" style={outlineButton()} onClick={openReleaseNotes}>
              View release notes
            </button>
          ) : null}
          {!isDev ? (
            <button type="button" style={primaryButton()} disabled={checking} onClick={checkForUpdates}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <ArrowsClockwise size={13} weight="bold" />
                {checking ? "Checking..." : "Check for updates"}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
