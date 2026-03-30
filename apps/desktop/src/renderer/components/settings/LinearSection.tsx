import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsLeftRight,
  ArrowsClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Key,
  Lightning,
  Plugs,
  XCircle,
} from "@phosphor-icons/react";
import type { CtoLinearProject, LinearConnectionStatus } from "../../../shared/types";
import { COLORS, SANS_FONT, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";

const LINEAR_BRAND = "#5E6AD2";
const LINEAR_API_SETTINGS_URL = "https://linear.app/settings/api";
const FEATURES = [
  { icon: ArrowsLeftRight, title: "Issue Routing", desc: "Link Linear issues to ADE lanes automatically" },
  { icon: Lightning, title: "CTO Workflows", desc: "Dispatch missions directly from Linear" },
  { icon: ArrowsClockwise, title: "Status Sync", desc: "Keep statuses in sync across both tools" },
];

export function LinearSection() {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [projects, setProjects] = useState<CtoLinearProject[]>([]);
  const [tokenInput, setTokenInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validatingRef = useRef(false);
  const oauthStartingRef = useRef(false);
  const oauthSessionIdRef = useRef<string | null>(null);
  const requestEpochRef = useRef(0);

  const invalidateLoadRequests = useCallback(() => {
    requestEpochRef.current += 1;
    return requestEpochRef.current;
  }, []);

  const isCurrentLoadRequest = useCallback((requestId: number) => requestEpochRef.current === requestId, []);

  const setValidatingState = useCallback((value: boolean) => {
    validatingRef.current = value;
    setValidating(value);
  }, []);

  const setOauthStartingState = useCallback((value: boolean) => {
    oauthStartingRef.current = value;
    setOauthStarting(value);
  }, []);

  const setOauthSessionIdState = useCallback((value: string | null) => {
    if (oauthSessionIdRef.current !== value) {
      invalidateLoadRequests();
    }
    oauthSessionIdRef.current = value;
    setOauthSessionId(value);
  }, [invalidateLoadRequests]);

  const isConnected = Boolean(connection?.connected);
  const authModeLabel = useMemo(() => {
    if (!connection?.authMode) return null;
    return connection.authMode === "oauth" ? "OAuth" : "API key";
  }, [connection?.authMode]);

  /* ── Load helpers ── */
  const loadProjects = useCallback(async (requestIdArg?: number) => {
    if (!window.ade?.cto) return;
    const requestId = requestIdArg ?? invalidateLoadRequests();
    try {
      const nextProjects = await window.ade.cto.getLinearProjects();
      if (!isCurrentLoadRequest(requestId)) return;
      setProjects(nextProjects);
    } catch {
      if (!isCurrentLoadRequest(requestId)) return;
      setProjects([]);
    }
  }, [invalidateLoadRequests, isCurrentLoadRequest]);

  const loadStatus = useCallback(async () => {
    if (!window.ade?.cto) return;
    const requestId = invalidateLoadRequests();
    try {
      const status = await window.ade.cto.getLinearConnectionStatus();
      if (!isCurrentLoadRequest(requestId)) return;
      setConnection(status);
      if (status.connected) {
        if (isCurrentLoadRequest(requestId)) {
          void loadProjects(requestId);
        }
      } else {
        setProjects([]);
      }
    } catch {
      if (!isCurrentLoadRequest(requestId)) return;
      setConnection(null);
      setProjects([]);
    }
  }, [invalidateLoadRequests, isCurrentLoadRequest, loadProjects]);

  /* ── Initial load ── */
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /* ── OAuth polling ── */
  useEffect(() => {
    if (!oauthSessionId) return;
    const activeSessionId = oauthSessionId;
    const cto = window.ade?.cto;
    if (!cto) {
      setOauthSessionIdState(null);
      setOauthStartingState(false);
      setError("Linear integration is unavailable in this environment.");
      return;
    }

    let active = true;
    let timer: number | null = null;
    let timeout: number | null = null;

    const poll = async () => {
      try {
        const session = await cto.getLinearOAuthSession({ sessionId: activeSessionId });
        if (!active || oauthSessionIdRef.current !== activeSessionId) return;
        if (session.status === "completed") {
          setOauthSessionIdState(null);
          setOauthStartingState(false);
          setConnection(session.connection ?? null);
          setError(null);
          if (session.connection?.connected) void loadProjects();
          else void loadStatus();
          return;
        }
        if (session.status === "failed" || session.status === "expired") {
          setOauthSessionIdState(null);
          setOauthStartingState(false);
          setError(session.error ?? "OAuth failed.");
        }
      } catch (err) {
        if (!active || oauthSessionIdRef.current !== activeSessionId) return;
        setOauthSessionIdState(null);
        setOauthStartingState(false);
        setError(err instanceof Error ? err.message : "OAuth failed.");
      }
    };
    void poll();
    timer = window.setInterval(() => void poll(), 1500);
    timeout = window.setTimeout(() => {
      if (!active || oauthSessionIdRef.current !== activeSessionId) return;
      setOauthSessionIdState(null);
      setOauthStartingState(false);
      setError("OAuth timed out. Please try again.");
    }, 5 * 60 * 1000);
    return () => {
      active = false;
      if (timer != null) clearInterval(timer);
      if (timeout != null) clearTimeout(timeout);
    };
  }, [loadProjects, loadStatus, oauthSessionId, setOauthSessionIdState, setOauthStartingState]);

  /* ── Handlers ── */
  const handleValidate = useCallback(async () => {
    const submittedToken = tokenInput.trim();
    if (
      !window.ade?.cto
      || !submittedToken
      || validatingRef.current
      || oauthStartingRef.current
      || oauthSessionIdRef.current
    ) {
      return;
    }
    const requestId = invalidateLoadRequests();
    setValidatingState(true);
    setError(null);
    try {
      const status = await window.ade.cto.setLinearToken({ token: submittedToken });
      if (
        !validatingRef.current
        || oauthStartingRef.current
        || oauthSessionIdRef.current
        || !isCurrentLoadRequest(requestId)
      ) {
        return;
      }
      setConnection(status);
      if (status.connected) {
        void loadProjects(requestId);
        setTokenInput("");
      } else {
        setError(status.message ?? "Token validation failed.");
      }
    } catch (err) {
      if (
        !validatingRef.current
        || oauthStartingRef.current
        || oauthSessionIdRef.current
        || !isCurrentLoadRequest(requestId)
      ) {
        return;
      }
      setError(err instanceof Error ? err.message : "Validation failed.");
    } finally {
      if (validatingRef.current) {
        setValidatingState(false);
      }
    }
  }, [invalidateLoadRequests, isCurrentLoadRequest, loadProjects, setValidatingState, tokenInput]);

  const handleStartOAuth = useCallback(async () => {
    if (oauthSessionIdRef.current) {
      setOauthSessionIdState(null);
      setOauthStartingState(false);
      return;
    }
    const cto = window.ade?.cto;
    const openExternal = window.ade?.app?.openExternal;
    if (!cto || validatingRef.current || oauthStartingRef.current) return;
    if (!openExternal) {
      setOauthSessionIdState(null);
      setOauthStartingState(false);
      setError("Browser sign-in is not available in this ADE build.");
      return;
    }
    invalidateLoadRequests();
    setOauthStartingState(true);
    setError(null);
    try {
      const session = await cto.startLinearOAuth();
      if (!oauthStartingRef.current || validatingRef.current) return;
      await openExternal(session.authUrl);
      if (!oauthStartingRef.current || validatingRef.current) return;
      setOauthSessionIdState(session.sessionId);
    } catch (err) {
      if (!oauthStartingRef.current) return;
      setOauthStartingState(false);
      setError(err instanceof Error ? err.message : "Unable to start OAuth.");
    }
  }, [invalidateLoadRequests, setOauthSessionIdState, setOauthStartingState]);

  const handleDisconnect = useCallback(async () => {
    if (!window.ade?.cto) return;
    invalidateLoadRequests();
    try {
      const status = await window.ade.cto.clearLinearToken();
      setConnection(status);
      setProjects([]);
      setTokenInput("");
      setError(null);
      setOauthSessionIdState(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect Linear.");
    } finally {
      setValidatingState(false);
      setOauthStartingState(false);
    }
  }, [invalidateLoadRequests, setOauthSessionIdState, setOauthStartingState, setValidatingState]);

  return (
    <div style={{ display: "flex", maxWidth: 780, flexDirection: "column", gap: 20 }}>

      {/* ── Connected State ── */}
      {isConnected ? (
        <div style={{
          padding: 20,
          background: `linear-gradient(135deg, ${COLORS.success}08, ${COLORS.success}04)`,
          border: `1px solid ${COLORS.success}25`,
          borderRadius: 14,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: `linear-gradient(135deg, ${LINEAR_BRAND}, ${LINEAR_BRAND}CC)`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <CheckCircle size={18} weight="fill" color="#fff" />
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                  Connected to Linear
                </div>
                <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary, marginTop: 2 }}>
                  {connection?.viewerName ? `Signed in as ${connection.viewerName}` : "Signed in"}
                  {authModeLabel ? ` via ${authModeLabel}` : ""}
                  {connection?.projectCount ? ` · ${connection.projectCount} project${connection.projectCount === 1 ? "" : "s"}` : ""}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim,
                padding: "4px 8px", borderRadius: 6,
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = COLORS.danger; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
            >
              Disconnect
            </button>
          </div>

          {/* Project list */}
          {projects.length > 0 ? (
            <div>
              <div style={{ ...LABEL_STYLE, fontSize: 10, marginBottom: 8 }}>
                PROJECTS ({projects.length})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {projects.map((p) => (
                  <span key={p.id} style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 10px", borderRadius: 6,
                    background: "rgba(255,255,255,0.04)", border: `1px solid ${COLORS.border}`,
                    fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary,
                  }}>
                    {p.name}
                    <span style={{ fontSize: 10, color: COLORS.textDim }}>{p.teamName}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* ── Disconnected: Connection Methods ── */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
          }}>
            {/* OAuth — recommended */}
            <div style={{
              padding: 20,
              background: `linear-gradient(180deg, ${LINEAR_BRAND}0A 0%, transparent 100%)`,
              border: `1px solid ${LINEAR_BRAND}25`,
              borderRadius: 14,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              position: "relative",
            }}>
              <div style={{
                position: "absolute", top: 12, right: 12,
                padding: "2px 8px", borderRadius: 4,
                background: `${LINEAR_BRAND}18`, fontSize: 9, fontWeight: 600,
                fontFamily: SANS_FONT, color: LINEAR_BRAND,
                letterSpacing: "0.05em", textTransform: "uppercase",
              }}>
                Recommended
              </div>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: `linear-gradient(135deg, ${LINEAR_BRAND}20, ${LINEAR_BRAND}10)`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Plugs size={20} weight="duotone" style={{ color: LINEAR_BRAND }} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 4 }}>
                  Sign in with Linear
                </div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "17px" }}>
                  Opens Linear in your browser for a secure OAuth flow. No keys to manage.
                </div>
              </div>
              <Button
                size="md"
                variant="primary"
                onClick={() => void handleStartOAuth()}
                disabled={oauthStarting || validating || connection?.oauthAvailable === false}
                style={{
                  background: LINEAR_BRAND,
                  width: "100%",
                  justifyContent: "center",
                  gap: 6,
                  marginTop: "auto",
                }}
              >
                {oauthStarting ? (
                  <CircleNotch size={13} className="animate-spin" />
                ) : (
                  <ArrowSquareOut size={13} />
                )}
                {oauthStarting ? "Waiting for Linear..." : "Sign in with Linear"}
              </Button>
              {connection?.oauthAvailable === false ? (
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                  Browser sign-in is not available in this ADE build.
                </div>
              ) : null}
            </div>

            {/* API Key — manual */}
            <div style={{
              padding: 20,
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: "rgba(255,255,255,0.04)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Key size={20} weight="duotone" style={{ color: COLORS.textMuted }} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 4 }}>
                  API Key
                </div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "17px" }}>
                  Paste a personal API key from your Linear settings. Good if OAuth isn't working.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                <input
                  type="password"
                  aria-label="Linear API key"
                  placeholder="lin_api_..."
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !validating && !oauthStarting && !oauthSessionId && tokenInput.trim()) {
                      e.preventDefault();
                      void handleValidate();
                    }
                  }}
                  style={{
                    flex: 1, height: 36, borderRadius: 8,
                    background: "rgba(255,255,255,0.03)",
                    border: `1px solid ${COLORS.border}`,
                    padding: "0 12px", fontSize: 12, fontFamily: MONO_FONT,
                    color: COLORS.textPrimary, outline: "none",
                    transition: "border-color 0.15s",
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = `${LINEAR_BRAND}50`; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = COLORS.border; }}
                />
                <Button
                  size="md"
                  variant="outline"
                  onClick={() => void handleValidate()}
                  disabled={validating || oauthStarting || oauthSessionId !== null || !tokenInput.trim()}
                >
                  {validating ? <CircleNotch size={12} className="animate-spin" /> : "Connect"}
                </Button>
              </div>
              <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                Get one at{" "}
                <a
                  href={LINEAR_API_SETTINGS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    const openExternal = window.ade?.app?.openExternal;
                    if (!openExternal) return;
                    event.preventDefault();
                    void openExternal(LINEAR_API_SETTINGS_URL);
                  }}
                  style={{ color: COLORS.textMuted }}
                >
                  linear.app/settings/api
                </a>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Error ── */}
      {error ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", borderRadius: 10,
          background: `${COLORS.danger}08`, border: `1px solid ${COLORS.danger}20`,
          fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: "17px",
        }}>
          <XCircle size={14} weight="fill" style={{ flexShrink: 0 }} />
          {error}
        </div>
      ) : null}

      {/* ── Feature Preview ── */}
      <div style={{
        padding: 18,
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 14,
      }}>
        <div style={{ ...LABEL_STYLE, fontSize: 10, marginBottom: 12, letterSpacing: "0.06em" }}>
          WHAT LINEAR INTEGRATION ENABLES
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "10px 12px",
              background: `${LINEAR_BRAND}06`,
              borderRadius: 10,
              border: `1px solid ${LINEAR_BRAND}12`,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                background: `${LINEAR_BRAND}14`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Icon size={14} weight="duotone" style={{ color: LINEAR_BRAND }} />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 2 }}>
                  {title}
                </div>
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "15px" }}>
                  {desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
