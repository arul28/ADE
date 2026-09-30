import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Key,
  Plugs,
  XCircle,
} from "@phosphor-icons/react";
import type { CtoLinearProject, GitHubAutolink, LinearConnectionStatus } from "../../../shared/types";
import { ADE_DEEPLINK_HTTPS_BASE_URL } from "../../../shared/deeplinks";
import { COLORS, SANS_FONT, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import {
  SettingsManagerPage,
} from "./primitives/SettingsManagerPage";
import { LinearAgentSection } from "./LinearAgentSection";

const LINEAR_BRAND = "#5E6AD2";
const LINEAR_API_SETTINGS_URL = "https://linear.app/settings/api";

function LinearWorkspaceAvatar({
  organizationName,
  logoUrl,
}: {
  organizationName: string | null | undefined;
  logoUrl: string | null | undefined;
}) {
  const normalizedLogoUrl = logoUrl?.trim() || null;
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const showLogo = normalizedLogoUrl != null && failedLogoUrl !== normalizedLogoUrl;
  const monogram = organizationName?.trim().charAt(0).toUpperCase() || "L";

  return (
    <div
      aria-hidden="true"
      style={{
        width: 24,
        height: 24,
        flex: "0 0 24px",
        overflow: "hidden",
        borderRadius: 7,
        border: `1px solid color-mix(in srgb, ${LINEAR_BRAND} 28%, transparent)`,
        background: `color-mix(in srgb, ${LINEAR_BRAND} 14%, transparent)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: COLORS.textPrimary,
        fontFamily: SANS_FONT,
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {showLogo ? (
        <img
          src={normalizedLogoUrl}
          alt=""
          onError={() => setFailedLogoUrl(normalizedLogoUrl)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : monogram}
    </div>
  );
}

type GitHubAutolinkCandidate = {
  id: string;
  title: string;
  desc: string;
  keyPrefix: string;
  urlTemplate: string;
  isAlphanumeric: boolean;
  command: string;
  configured: boolean;
};

export function LinearSection({ embedded = false }: { embedded?: boolean }) {
  // Linear connection, GitHub repo, and team keys are all scoped to the active
  // project (credentials are project-scoped). Re-run the loaders whenever the
  // active project changes so the autolink commands target the right repo and
  // Linear workspace instead of a stale previously-loaded project.
  const projectRoot = useAppStore(selectActiveProjectRoot);
  // Linear OAuth uses a 127.0.0.1 loopback callback server. When the project is
  // bound to a remote runtime that server runs on the remote host, but the
  // browser opens locally and redirects to localhost on THIS machine — so the
  // callback never arrives. Steer remote sessions to the API-key path, which
  // routes cleanly to the remote machine's credential store.
  const isRemoteRuntime = useAppStore((s) => s.projectBinding?.kind === "remote");
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [projects, setProjects] = useState<CtoLinearProject[]>([]);
  const [githubRepo, setGithubRepo] = useState<{ owner: string; name: string } | null>(null);
  const [githubAutolinks, setGithubAutolinks] = useState<GitHubAutolink[]>([]);
  const [autolinksLoading, setAutolinksLoading] = useState(false);
  const [autolinkError, setAutolinkError] = useState<string | null>(null);
  const [creatingAutolinkId, setCreatingAutolinkId] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validatingRef = useRef(false);
  const oauthStartingRef = useRef(false);
  const oauthSessionIdRef = useRef<string | null>(null);
  const requestEpochRef = useRef(0);
  const autolinksRequestIdRef = useRef(0);

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
  const workspaceLabel = connection?.organizationName?.trim() || connection?.organizationUrlKey?.trim() || null;
  const workspaceUrlKey = connection?.organizationUrlKey?.trim() || "YOUR-WORKSPACE";
  const githubRepoSlug = githubRepo ? `${githubRepo.owner}/${githubRepo.name}` : null;
  const teamKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const project of projects) {
      const key = project.teamKey?.trim();
      if (key) keys.add(key.toUpperCase());
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [projects]);
  const autolinkCandidates = useMemo<GitHubAutolinkCandidate[]>(() => {
    const repoSlug = githubRepoSlug ?? "OWNER/REPO";
    const adePrTemplate = `${ADE_DEEPLINK_HTTPS_BASE_URL}?type=pr&repo=${encodeURIComponent(repoSlug)}&number=<num>`;
    const baseCandidates: Array<Omit<GitHubAutolinkCandidate, "configured" | "command">> = [
      {
        id: "ade-pr",
        title: "Open PRs in ADE",
        desc: "Turns ADEPR-123 in GitHub text into a link that opens that PR in this ADE project.",
        keyPrefix: "ADEPR-",
        urlTemplate: adePrTemplate,
        isAlphanumeric: false,
      },
      ...teamKeys.map((teamKey) => ({
        id: `linear-${teamKey}`,
        title: `${teamKey} Linear issues`,
        desc: `Turns ${teamKey}-123 in GitHub text into a Linear issue link.`,
        keyPrefix: `${teamKey}-`,
        urlTemplate: `https://linear.app/${encodeURIComponent(workspaceUrlKey)}/issue/${teamKey}-<num>`,
        isAlphanumeric: false,
      })),
    ];
    return baseCandidates.map((candidate) => {
      const configured = githubAutolinks.some((autolink) =>
        autolink.keyPrefix.toLowerCase() === candidate.keyPrefix.toLowerCase()
      );
      const command = [
        "gh",
        "repo",
        "autolink",
        "create",
        candidate.keyPrefix,
        `"${candidate.urlTemplate}"`,
        "--numeric",
        `--repo ${githubRepoSlug ?? "OWNER/REPO"}`,
      ].join(" ");
      return { ...candidate, configured, command };
    });
  }, [githubAutolinks, githubRepoSlug, teamKeys, workspaceUrlKey]);
  const configuredAutolinkCount = autolinkCandidates.filter((candidate) => candidate.configured).length;

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

  const loadGithubAutolinks = useCallback(async () => {
    const github = window.ade?.github;
    if (!github) return;
    // Guard against stale responses: if the active project changes while a
    // detectRepo()/listRepoAutolinks() call is in flight, an older response
    // must not repopulate the repo/autolinks (which would make the displayed
    // repo and generated `gh repo autolink` commands wrong for the new project).
    const requestId = ++autolinksRequestIdRef.current;
    setAutolinksLoading(true);
    setAutolinkError(null);
    try {
      const repo = await github.detectRepo();
      if (autolinksRequestIdRef.current !== requestId) return;
      setGithubRepo(repo);
      if (!repo) {
        setGithubAutolinks([]);
        setAutolinkError("No GitHub origin remote was detected for this project.");
        return;
      }
      const autolinks = await github.listRepoAutolinks(repo);
      if (autolinksRequestIdRef.current !== requestId) return;
      setGithubAutolinks(autolinks);
    } catch (err) {
      if (autolinksRequestIdRef.current !== requestId) return;
      setGithubAutolinks([]);
      setAutolinkError(err instanceof Error ? err.message : "Unable to load GitHub autolinks.");
    } finally {
      if (autolinksRequestIdRef.current === requestId) {
        setAutolinksLoading(false);
      }
    }
  }, []);

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

  /* ── Initial load + reload on active-project change ── */
  useEffect(() => {
    void loadStatus();
  }, [loadStatus, projectRoot]);

  useEffect(() => {
    void loadGithubAutolinks();
  }, [loadGithubAutolinks, projectRoot]);

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
    if (isRemoteRuntime) {
      setError("Browser sign-in isn't available over a remote connection. Use an API key instead.");
      return;
    }
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
  }, [invalidateLoadRequests, setOauthSessionIdState, setOauthStartingState, isRemoteRuntime]);

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

  const handleCreateAutolink = useCallback(async (candidate: GitHubAutolinkCandidate) => {
    const github = window.ade?.github;
    if (!github || !githubRepo) return;
    setCreatingAutolinkId(candidate.id);
    setAutolinkError(null);
    try {
      await github.createRepoAutolink({
        owner: githubRepo.owner,
        name: githubRepo.name,
        keyPrefix: candidate.keyPrefix,
        urlTemplate: candidate.urlTemplate,
        isAlphanumeric: candidate.isAlphanumeric,
      });
      await loadGithubAutolinks();
    } catch (err) {
      setAutolinkError(err instanceof Error ? err.message : "Unable to create GitHub autolink.");
    } finally {
      setCreatingAutolinkId(null);
    }
  }, [githubRepo, loadGithubAutolinks]);

  return (
    <div style={{ maxWidth: embedded ? undefined : 780 }}>
      <SettingsManagerPage
        anchor="linear-connection"
        title="Linear"
        description={
          embedded
            ? undefined
            : "Connect Linear for issue routing, lane context, PR linkage, and CTO workflows."
        }
        toolbar={
          isConnected ? (
            <>
              {!isRemoteRuntime ? (
                <button
                  type="button"
                  className="ade-settings-button"
                  onClick={() => void handleStartOAuth()}
                  disabled={oauthStarting || validating || connection?.oauthAvailable === false}
                >
                  {oauthStarting ? <CircleNotch size={12} className="animate-spin" /> : null}
                  {oauthStarting ? "Waiting for Linear..." : "Reconnect current workspace"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={oauthStarting}
                style={{
                  background: "none", border: "none", cursor: oauthStarting ? "default" : "pointer",
                  fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim,
                  padding: "4px 8px", borderRadius: 6,
                  transition: "color 0.15s",
                  opacity: oauthStarting ? 0.55 : 1,
                }}
                onMouseEnter={(e) => { if (!oauthStarting) e.currentTarget.style.color = COLORS.danger; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = COLORS.textDim; }}
              >
                Disconnect
              </button>
            </>
          ) : null
        }
      >
        {/* ── Connected: one workspace row, then the ADE agent ── */}
        {isConnected ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <LinearWorkspaceAvatar
                organizationName={connection?.organizationName}
                logoUrl={connection?.organizationLogoUrl}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                  {workspaceLabel ?? "Linear"}
                  {connection?.organizationUrlKey ? (
                    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                      {connection.organizationUrlKey}
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: 11.5, fontFamily: SANS_FONT, color: COLORS.textMuted, marginTop: 2 }}>
                  {connection?.viewerName ? `Signed in as ${connection.viewerName}` : "Signed in"}
                  {authModeLabel ? ` · ${authModeLabel}` : ""}
                  {` · ${connection?.projectCount ?? projects.length} projects`}
                </div>
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 16 }}>
              <LinearAgentSection connected={isConnected} />
            </div>
          </div>
        ) : (
          /* ── Disconnected: Connection Methods ── */
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
                  Connects the workspace currently selected in Linear.
                </div>
              </div>
              <button
                className="ade-settings-button"
                data-variant="primary"
                onClick={() => void handleStartOAuth()}
                disabled={oauthStarting || validating || connection?.oauthAvailable === false || isRemoteRuntime}
                title={isRemoteRuntime ? "Browser sign-in isn't available over a remote connection — use an API key below." : undefined}
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
              </button>
              {isRemoteRuntime ? (
                <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                  Browser sign-in isn&rsquo;t available over a remote connection. Use an API key below — it&rsquo;s saved on the remote machine.
                </div>
              ) : connection?.oauthAvailable === false ? (
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
                <button
                  className="ade-settings-button"
                  onClick={() => void handleValidate()}
                  disabled={validating || oauthStarting || oauthSessionId !== null || !tokenInput.trim()}
                >
                  {validating ? <CircleNotch size={12} className="animate-spin" /> : "Connect"}
                </button>
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
        )}

        {/* ── GitHub reference links (folded: set once, rarely revisited) ── */}
        <details className="ade-linear-github-links" style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
          <summary style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, cursor: "pointer", listStyle: "none" }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>GitHub reference links</span>
            <span style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap", fontSize: 11.5, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
              {autolinkCandidates.length > 0 && configuredAutolinkCount === autolinkCandidates.length
                ? "All set up"
                : `${configuredAutolinkCount} of ${autolinkCandidates.length} set up`}
              <CaretDown size={11} style={{ marginLeft: 6, flexShrink: 0 }} />
            </span>
          </summary>
          <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ ...LABEL_STYLE, fontSize: 12, marginBottom: 6 }}>
                GitHub reference links
              </div>
              <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "17px" }}>
                GitHub autolinks make Linear issue keys (like ENG-123) and ADE PR refs clickable wherever they appear in PRs, commits, and comments — no full URLs needed. Applies to the repo below for this project.
              </div>
            </div>
            <button
              type="button"
              className="ade-settings-button"
              onClick={() => void loadGithubAutolinks()}
              disabled={autolinksLoading || creatingAutolinkId !== null}
            >
              {autolinksLoading ? <CircleNotch size={12} className="animate-spin" /> : null}
              Refresh
            </button>
          </div>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "9px 11px",
            borderRadius: 8,
            background: "rgba(255,255,255,0.03)",
            border: `1px solid ${COLORS.border}`,
            marginBottom: 10,
          }}>
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              Repository
            </div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, minWidth: 0, overflowWrap: "anywhere" }}>
              {githubRepoSlug ?? "No GitHub origin detected"}
            </div>
          </div>
          <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: "15px", marginBottom: 8 }}>
            Click <strong style={{ color: COLORS.textSecondary, fontWeight: 600 }}>Create</strong> to add a link to this repo automatically, or copy the <code style={{ fontFamily: MONO_FONT }}>gh</code> command below it to run it yourself.
          </div>
          {/* Stacked rows, not a table: the command is long and the column
              is narrow, and a table this wide scrolled sideways and clipped
              its own Create button. */}
          <div className="ade-settings-panel">
            {autolinkCandidates.map((candidate) => {
              const busy = creatingAutolinkId === candidate.id;
              return (
                <div key={candidate.id} className="ade-settings-row" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        {candidate.configured ? <CheckCircle size={13} weight="fill" style={{ color: COLORS.success }} /> : null}
                        <span style={{ fontSize: 13, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                          {candidate.title}
                        </span>
                        <code className="ade-settings-chip" style={{ fontFamily: MONO_FONT }}>{candidate.keyPrefix}</code>
                      </div>
                      <div style={{ marginTop: 3, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 }}>
                        {candidate.desc}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ade-settings-button"
                      data-variant={candidate.configured ? "ghost" : undefined}
                      onClick={() => void handleCreateAutolink(candidate)}
                      disabled={!githubRepo || candidate.configured || autolinksLoading || creatingAutolinkId !== null}
                    >
                      {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                      {candidate.configured ? "Configured" : "Create"}
                    </button>
                  </div>
                  <code
                    style={{
                      display: "block",
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "color-mix(in srgb, var(--color-bg) 55%, transparent)",
                      fontSize: 11.5,
                      fontFamily: MONO_FONT,
                      color: COLORS.textMuted,
                      lineHeight: 1.5,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {candidate.command}
                  </code>
                </div>
              );
            })}
          </div>
          {!teamKeys.length ? (
            <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: "15px", marginTop: 10 }}>
              Connect Linear and load projects to add team-key references such as TEAM-123 for this workspace.
            </div>
          ) : null}
          {autolinkError ? (
            <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: "15px", marginTop: 10 }}>
              {autolinkError}
            </div>
          ) : null}
          </div>
        </details>

        {/* ── Error ── */}
        {error ? (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 14px", borderRadius: 10,
            background: "color-mix(in srgb, var(--color-error) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--color-error) 20%, transparent)",
            fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: "17px",
          }}>
            <XCircle size={14} weight="fill" style={{ flexShrink: 0 }} />
            {error}
          </div>
        ) : null}

      </SettingsManagerPage>
    </div>
  );
}
