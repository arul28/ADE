import {
  useState,
  useEffect,
  useCallback,
  useId,
  useRef,
  type CSSProperties,
} from "react";
import type {
  OAuthRedirectStatus,
  OAuthRedirectEvent,
  OAuthSession,
  OAuthSessionStatus,
  RedirectUriInfo,
  ProxyStatus,
  LaneProxyEvent,
  OAuthRoutingMode,
} from "../../../shared/types";
import {
  Shield,
  Copy,
  CaretDown,
  CaretRight,
  Check,
  Globe,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  outlineButton,
  primaryButton,
  cardStyle,
  inlineBadge,
} from "../lanes/laneDesignTokens";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDERS = ["Generic", "Google", "GitHub", "Auth0"] as const;
type ProviderName = (typeof PROVIDERS)[number];

function statusColor(status: OAuthSessionStatus): string {
  switch (status) {
    case "active":
    case "completed":
      return COLORS.success;
    case "pending":
      return COLORS.warning;
    case "failed":
      return COLORS.danger;
    default:
      return COLORS.textMuted;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Shared inline styles
// ---------------------------------------------------------------------------

const sectionLabelStyle: CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

const descriptionStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textSecondary,
  lineHeight: "20px",
};

const errorBoxStyle: CSSProperties = {
  background: `${COLORS.danger}12`,
  border: `1px solid ${COLORS.danger}30`,
  padding: "8px 12px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.danger,
  borderRadius: 0,
};

const selectStyle: CSSProperties = {
  height: 32,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 0,
  padding: "0 10px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  outline: "none",
  cursor: "pointer",
  appearance: "none",
  WebkitAppearance: "none",
};

const inputStyle: CSSProperties = {
  height: 32,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 0,
  padding: "0 12px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  outline: "none",
  width: "100%",
};

// ---------------------------------------------------------------------------
// Small sub-components
// ---------------------------------------------------------------------------

function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      style={{
        position: "relative",
        width: 44,
        height: 24,
        background: checked ? COLORS.accent : COLORS.border,
        border: "none",
        borderRadius: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s ease",
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          background: checked ? COLORS.pageBg : COLORS.textMuted,
          borderRadius: 0,
          transition: "left 0.15s ease",
        }}
      />
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      if (window.ade?.app?.writeClipboardText) {
        await window.ade.app.writeClipboardText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopyError(null);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : "Failed to copy");
      setCopied(false);
    }
  }, [text]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        type="button"
        onClick={handleCopy}
        style={outlineButton({
          height: 28,
          padding: "0 8px",
          fontSize: 10,
          color: copyError
            ? COLORS.danger
            : copied
              ? COLORS.success
              : COLORS.textSecondary,
          borderColor: copyError
            ? `${COLORS.danger}40`
            : copied
              ? `${COLORS.success}40`
              : COLORS.outlineBorder,
        })}
        title={`Copy: ${text}`}
        aria-label={`Copy redirect URI ${text}`}
      >
        {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
        {copied ? "COPIED" : copyError ? "RETRY" : "COPY"}
      </button>
      {copyError && (
        <span
          aria-live="polite"
          style={{
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.danger,
          }}
        >
          {copyError}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProxyAndPreviewSection() {
  // --- Proxy state ---
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);

  // --- OAuth state ---
  const [oauthStatus, setOAuthStatus] = useState<OAuthRedirectStatus | null>(null);
  const [oauthBusy, setOAuthBusy] = useState(false);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<OAuthSession[]>([]);

  // --- Redirect URI helper ---
  const [selectedProvider, setSelectedProvider] = useState<ProviderName>("Generic");
  const [uriInfo, setUriInfo] = useState<RedirectUriInfo | null>(null);
  const [uriLoading, setUriLoading] = useState(false);
  const [uriError, setUriError] = useState<string | null>(null);

  // --- Advanced settings ---
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const [routingMode, setRoutingMode] = useState<OAuthRoutingMode>("state-parameter");
  const [callbackPathsDraft, setCallbackPathsDraft] = useState("");
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const providerSelectId = useId();
  const advancedPanelId = useId();
  const callbackPathsId = useId();
  const latestUriRequestRef = useRef(0);
  const advancedOpenRef = useRef(advancedOpen);
  advancedOpenRef.current = advancedOpen;
  const advancedDirtyRef = useRef(advancedDirty);
  advancedDirtyRef.current = advancedDirty;

  const syncAdvancedDrafts = useCallback((status: OAuthRedirectStatus) => {
    setRoutingMode(status.routingMode);
    setCallbackPathsDraft(status.callbackPaths.join(", "));
    setAdvancedDirty(false);
  }, []);

  // -----------------------------------------------------------------------
  // Initial data fetch
  // -----------------------------------------------------------------------

  const fetchProxyStatus = useCallback(async () => {
    try {
      const status = await window.ade.lanes.proxyGetStatus();
      setProxyStatus(status);
      setProxyError(status.error ?? null);
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const fetchOAuthStatus = useCallback(async () => {
    try {
      const status = await window.ade.lanes.oauthGetStatus();
      setOAuthStatus(status);
      syncAdvancedDrafts(status);
      setOAuthError(null);
    } catch (err) {
      setOAuthError(err instanceof Error ? err.message : String(err));
    }
  }, [syncAdvancedDrafts]);

  const fetchOAuthSessions = useCallback(async () => {
    try {
      const nextSessions = await window.ade.lanes.oauthListSessions();
      setSessions(
        [...nextSessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    } catch (err) {
      setOAuthError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Fetch initial data with cancellation awareness.
    // We inline the fetch logic here rather than calling fetchProxyStatus() etc.
    // because those functions always call setState and don't check cancellation.
    void Promise.all([
      window.ade.lanes.proxyGetStatus().then((status) => {
        if (cancelled) return;
        setProxyStatus(status);
        setProxyError(status.error ?? null);
      }).catch((err) => {
        if (cancelled) return;
        setProxyError(err instanceof Error ? err.message : String(err));
      }),
      window.ade.lanes.oauthGetStatus().then((status) => {
        if (cancelled) return;
        setOAuthStatus(status);
        syncAdvancedDrafts(status);
        setOAuthError(null);
      }).catch((err) => {
        if (cancelled) return;
        setOAuthError(err instanceof Error ? err.message : String(err));
      }),
      window.ade.lanes.oauthListSessions().then((nextSessions) => {
        if (cancelled) return;
        setSessions(
          [...nextSessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        );
      }).catch((err) => {
        if (cancelled) return;
        setOAuthError(err instanceof Error ? err.message : String(err));
      }),
    ]);

    // Subscribe to live events
    const unsubProxy = window.ade.lanes.onProxyEvent((ev: LaneProxyEvent) => {
      if (cancelled) return;
      if (ev.status) setProxyStatus(ev.status);
      if (ev.error) setProxyError(ev.error);
    });

    const unsubOAuth = window.ade.lanes.onOAuthEvent((ev: OAuthRedirectEvent) => {
      if (cancelled) return;
      if (ev.status) {
        setOAuthStatus(ev.status);
        if (ev.type === "oauth-config-changed" || !advancedOpenRef.current || !advancedDirtyRef.current) {
          syncAdvancedDrafts(ev.status);
        }
      }
      if (ev.session) {
        setSessions((current) => {
          const next = [ev.session!, ...current.filter((session) => session.id !== ev.session!.id)];
          return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        });
      }
      if (ev.error) setOAuthError(ev.error);
    });

    return () => {
      cancelled = true;
      unsubProxy();
      unsubOAuth();
    };
  }, [syncAdvancedDrafts]);

  // -----------------------------------------------------------------------
  // Proxy actions
  // -----------------------------------------------------------------------

  const handleProxyToggle = useCallback(async () => {
    setProxyBusy(true);
    setProxyError(null);
    try {
      if (proxyStatus?.running) {
        await window.ade.lanes.proxyStop();
        const status = await window.ade.lanes.proxyGetStatus();
        setProxyStatus(status);
      } else {
        const status = await window.ade.lanes.proxyStart();
        setProxyStatus(status);
      }
    } catch (err) {
      setProxyError(err instanceof Error ? err.message : String(err));
    } finally {
      setProxyBusy(false);
    }
  }, [proxyStatus?.running]);

  // -----------------------------------------------------------------------
  // OAuth actions
  // -----------------------------------------------------------------------

  const handleOAuthToggle = useCallback(
    async (enabled: boolean) => {
      setOAuthBusy(true);
      setOAuthError(null);
      try {
        await window.ade.lanes.oauthUpdateConfig({ enabled });
        await fetchOAuthStatus();
      } catch (err) {
        setOAuthError(err instanceof Error ? err.message : String(err));
      } finally {
        setOAuthBusy(false);
      }
    },
    [fetchOAuthStatus],
  );

  // -----------------------------------------------------------------------
  // Redirect URI generation
  // -----------------------------------------------------------------------

  const fetchUris = useCallback(async (provider: ProviderName) => {
    const requestId = latestUriRequestRef.current + 1;
    latestUriRequestRef.current = requestId;
    setUriLoading(true);
    setUriError(null);
    try {
      const results = await window.ade.lanes.oauthGenerateRedirectUris({
        provider: provider.toLowerCase(),
      });
      if (latestUriRequestRef.current !== requestId) return;
      // API returns array; pick the first matching entry or first overall
      const match = results.find(
        (r) => r.provider.toLowerCase() === provider.toLowerCase(),
      ) ?? results[0] ?? null;
      setUriInfo(match);
    } catch (err) {
      if (latestUriRequestRef.current !== requestId) return;
      setUriInfo(null);
      setUriError(err instanceof Error ? err.message : "Unable to load redirect URIs.");
    } finally {
      if (latestUriRequestRef.current === requestId) {
        setUriLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchUris(selectedProvider);
  }, [selectedProvider, fetchUris]);

  // -----------------------------------------------------------------------
  // Advanced settings save
  // -----------------------------------------------------------------------

  const handleSaveAdvanced = useCallback(async () => {
    setAdvancedSaving(true);
    setOAuthError(null);
    try {
      const paths = callbackPathsDraft
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      await window.ade.lanes.oauthUpdateConfig({
        routingMode,
        callbackPaths: paths,
      });
      await fetchOAuthStatus();
    } catch (err) {
      setOAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdvancedSaving(false);
    }
  }, [routingMode, callbackPathsDraft, fetchOAuthStatus]);

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  const proxyRunning = proxyStatus?.running ?? false;
  const oauthEnabled = oauthStatus?.enabled ?? false;
  const routeCount = proxyStatus?.routes?.length ?? 0;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {/* ============ SECTION HEADER ============ */}
      <div style={sectionLabelStyle}>PROXY &amp; PREVIEW</div>

      {/* ============ PROXY STATUS CARD ============ */}
      <div style={cardStyle()}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Globe size={20} weight="bold" style={{ color: COLORS.textPrimary }} />
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                color: COLORS.textPrimary,
              }}
            >
              Reverse Proxy
            </span>
          </div>

          <span
            style={inlineBadge(proxyRunning ? COLORS.success : COLORS.textMuted)}
          >
            <StatusDot color={proxyRunning ? COLORS.success : COLORS.textMuted} />
            <span style={{ marginLeft: 6 }}>
              {proxyRunning ? "RUNNING" : "STOPPED"}
            </span>
          </span>
        </div>

        {/* Status detail row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 24,
            background: COLORS.recessedBg,
            padding: "12px 16px",
            marginBottom: 16,
          }}
        >
          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>PORT</div>
            <div
              style={{
                fontSize: 13,
                fontFamily: MONO_FONT,
                color: COLORS.textPrimary,
              }}
            >
              {proxyStatus?.proxyPort ?? "--"}
            </div>
          </div>
          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>ROUTES</div>
            <div
              style={{
                fontSize: 13,
                fontFamily: MONO_FONT,
                color: COLORS.textPrimary,
              }}
            >
              {routeCount}
            </div>
          </div>
          {proxyStatus?.startedAt && (
            <div>
              <div style={{ ...LABEL_STYLE, marginBottom: 4 }}>SINCE</div>
              <div
                style={{
                  fontSize: 13,
                  fontFamily: MONO_FONT,
                  color: COLORS.textPrimary,
                }}
              >
                {formatTime(proxyStatus.startedAt)}
              </div>
            </div>
          )}
        </div>

        {/* Proxy error */}
        {proxyError && (
          <div role="alert" style={{ ...errorBoxStyle, marginBottom: 16 }}>
            {proxyError}
          </div>
        )}

        {/* Start / Stop button */}
        <button
          type="button"
          style={
            proxyRunning
              ? outlineButton({ color: COLORS.danger, borderColor: `${COLORS.danger}40` })
              : primaryButton()
          }
          disabled={proxyBusy}
          onClick={handleProxyToggle}
          aria-label={proxyRunning ? "Stop reverse proxy" : "Start reverse proxy"}
        >
          <ArrowsClockwise
            size={13}
            weight="bold"
            style={proxyBusy ? { animation: "spin 1s linear infinite" } : undefined}
          />
          {proxyBusy ? "..." : proxyRunning ? "STOP PROXY" : "START PROXY"}
        </button>
      </div>

      {/* ============ OAUTH ROUTING CARD ============ */}
      <div style={cardStyle()}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Shield size={20} weight="bold" style={{ color: COLORS.textPrimary }} />
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                color: COLORS.textPrimary,
              }}
            >
              Automatic OAuth Routing
            </span>
            <span
              title="When enabled, OAuth callbacks flowing through the proxy are automatically routed to the correct lane based on the state parameter."
              style={{
                fontSize: 10,
                fontFamily: MONO_FONT,
                color: COLORS.textDim,
                cursor: "help",
                borderBottom: `1px dotted ${COLORS.textDim}`,
              }}
            >
              (i)
            </span>
          </div>

          <span style={inlineBadge(oauthEnabled ? COLORS.success : COLORS.textMuted)}>
            {oauthEnabled ? "ACTIVE" : "DISABLED"}
          </span>
        </div>

        <div style={{ ...descriptionStyle, marginBottom: 16 }}>
          Automatic OAuth routing — callbacks are routed to the correct lane
          using the OAuth state parameter.
        </div>

        {oauthError && (
          <div role="alert" style={{ ...errorBoxStyle, marginBottom: 16 }}>
            {oauthError}
          </div>
        )}

        {/* Enable / Disable toggle row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: COLORS.recessedBg,
            padding: "12px 16px",
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontFamily: MONO_FONT,
              color: COLORS.textPrimary,
            }}
          >
            {oauthEnabled ? "Enabled" : "Disabled"}
          </span>
          <Toggle
            checked={oauthEnabled}
            onChange={handleOAuthToggle}
            disabled={oauthBusy}
            label="Automatic OAuth routing"
          />
        </div>
      </div>

      {/* ============ COPY REDIRECT URIS CARD ============ */}
      <div style={cardStyle()}>
        <div style={{ ...LABEL_STYLE, marginBottom: 12 }}>REDIRECT URIS</div>

        <div style={{ ...descriptionStyle, marginBottom: 16 }}>
          Copy these redirect URIs into your OAuth provider configuration.
        </div>

        {/* Provider selector */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <label htmlFor={providerSelectId} style={{ ...LABEL_STYLE, marginBottom: 0 }}>
            PROVIDER
          </label>
          <div style={{ position: "relative" }}>
            <select
              id={providerSelectId}
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value as ProviderName)}
              style={{ ...selectStyle, paddingRight: 28 }}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <CaretDown
              size={12}
              weight="bold"
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                color: COLORS.textDim,
                pointerEvents: "none",
              }}
            />
          </div>
        </div>

        {/* URI list */}
        {uriLoading ? (
          <div
            aria-live="polite"
            style={{
              fontSize: 11,
              fontFamily: MONO_FONT,
              color: COLORS.textMuted,
              padding: "12px 0",
            }}
          >
            Loading URIs...
          </div>
        ) : uriError ? (
          <div role="alert" style={{ ...errorBoxStyle, marginBottom: 8 }}>
            {uriError}
          </div>
        ) : uriInfo ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {uriInfo.uris.map((uri) => (
              <div
                key={uri}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: COLORS.recessedBg,
                  padding: "8px 12px",
                }}
              >
                <code
                  style={{
                    flex: 1,
                    fontSize: 11,
                    fontFamily: MONO_FONT,
                    color: COLORS.textPrimary,
                    wordBreak: "break-all",
                  }}
                >
                  {uri}
                </code>
                <CopyButton text={uri} />
              </div>
            ))}

            {/* Provider-specific instructions */}
            {uriInfo.instructions && (
              <div
                style={{
                  background: `${COLORS.info}08`,
                  border: `1px solid ${COLORS.info}20`,
                  padding: "10px 14px",
                  fontSize: 11,
                  fontFamily: MONO_FONT,
                  color: COLORS.textSecondary,
                  lineHeight: "18px",
                  marginTop: 4,
                }}
              >
                {uriInfo.instructions}
              </div>
            )}
          </div>
        ) : (
          <div
            style={{
              fontSize: 11,
              fontFamily: MONO_FONT,
              color: COLORS.textDim,
              padding: "12px 0",
            }}
          >
            No redirect URIs available.
          </div>
        )}
      </div>

      {/* ============ ACTIVE SESSIONS ============ */}
      {sessions.length > 0 && (
        <div style={cardStyle()}>
          <div style={{ ...LABEL_STYLE, marginBottom: 12 }}>
            OAUTH SESSIONS ({sessions.length})
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {sessions.map((session) => (
              <div
                key={session.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  background: COLORS.recessedBg,
                  padding: "10px 14px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <StatusDot color={statusColor(session.status)} />
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: MONO_FONT,
                        fontWeight: 700,
                        color: COLORS.textPrimary,
                      }}
                    >
                      {session.laneId}
                    </span>
                    {session.provider && (
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: MONO_FONT,
                          color: COLORS.textDim,
                        }}
                      >
                        {session.provider}
                      </span>
                    )}
                  </div>

                  <span style={inlineBadge(statusColor(session.status))}>
                    {session.status.toUpperCase()}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    fontSize: 10,
                    fontFamily: MONO_FONT,
                    color: COLORS.textDim,
                  }}
                >
                  <span>Path: {session.callbackPath}</span>
                  <span>Started: {formatTime(session.createdAt)}</span>
                  {session.completedAt && (
                    <span>Completed: {formatTime(session.completedAt)}</span>
                  )}
                </div>

                {/* Error detail for failed sessions */}
                {session.status === "failed" && session.error && (
                  <div
                    style={{
                      ...errorBoxStyle,
                      marginTop: 4,
                      fontSize: 10,
                      lineHeight: "16px",
                    }}
                  >
                    {session.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ ADVANCED SETTINGS (collapsible) ============ */}
      <div style={cardStyle()}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          aria-expanded={advancedOpen}
          aria-controls={advancedPanelId}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 0,
            width: "100%",
          }}
        >
          {advancedOpen ? (
            <CaretDown size={14} weight="bold" style={{ color: COLORS.textMuted }} />
          ) : (
            <CaretRight size={14} weight="bold" style={{ color: COLORS.textMuted }} />
          )}
          <span style={{ ...LABEL_STYLE, marginBottom: 0 }}>ADVANCED SETTINGS</span>
        </button>

        {advancedOpen && (
          <div
            id={advancedPanelId}
            style={{
              marginTop: 20,
              display: "flex",
              flexDirection: "column",
              gap: 20,
            }}
          >
            {/* Routing mode */}
            <div>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>ROUTING MODE</div>
              <div style={{ ...descriptionStyle, fontSize: 11, marginBottom: 10 }}>
                Controls how OAuth callbacks are matched to lanes.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {(["state-parameter", "hostname"] as OAuthRoutingMode[]).map(
                  (mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setRoutingMode(mode);
                        setAdvancedDirty(true);
                      }}
                      aria-pressed={routingMode === mode}
                      style={{
                        ...outlineButton({
                          color:
                            routingMode === mode
                              ? COLORS.accent
                              : COLORS.textSecondary,
                          borderColor:
                            routingMode === mode
                              ? COLORS.accent
                              : COLORS.outlineBorder,
                          background:
                            routingMode === mode
                              ? `${COLORS.accent}12`
                              : "transparent",
                        }),
                        fontSize: 10,
                      }}
                    >
                      {mode === "state-parameter"
                        ? "STATE PARAMETER"
                        : "HOSTNAME"}
                    </button>
                  ),
                )}
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontSize: 10,
                  fontFamily: MONO_FONT,
                  color: COLORS.textDim,
                  lineHeight: "16px",
                }}
              >
                {routingMode === "state-parameter"
                  ? "Encodes the lane ID in the OAuth state parameter. Works with any provider that preserves state."
                  : "Uses per-lane hostnames to route callbacks. Requires DNS or hosts file configuration."}
              </div>
            </div>

            {/* Callback paths */}
            <div>
              <label
                htmlFor={callbackPathsId}
                style={{ ...LABEL_STYLE, marginBottom: 8, display: "block" }}
              >
                CALLBACK PATHS
              </label>
              <div style={{ ...descriptionStyle, fontSize: 11, marginBottom: 10 }}>
                URL paths that are treated as OAuth callbacks (comma-separated).
              </div>
              <input
                id={callbackPathsId}
                type="text"
                value={callbackPathsDraft}
                onChange={(e) => {
                  setCallbackPathsDraft(e.target.value);
                  setAdvancedDirty(true);
                }}
                placeholder="/auth/callback, /oauth/callback, /api/auth/callback"
                style={inputStyle}
              />
            </div>

            {/* Save */}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={primaryButton()}
                disabled={advancedSaving}
                onClick={handleSaveAdvanced}
              >
                {advancedSaving ? "SAVING..." : "SAVE"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
