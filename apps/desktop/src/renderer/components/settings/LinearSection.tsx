import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Key,
} from "@phosphor-icons/react";
import type { CtoLinearProject, GitHubAutolink, LinearConnectionStatus } from "../../../shared/types";
import { ADE_DEEPLINK_HTTPS_BASE_URL } from "../../../shared/deeplinks";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { ModernSection } from "./primitives";
import { Banner } from "../ui/notice";
import { LinearMark } from "../lanes/linearBrand";
import "./IntegrationsSettings.css";
import { LinearAgentSection } from "./LinearAgentSection";
import { announceLinearConnectionChanged } from "../../lib/linearConnectionEvents";
import { useSettingsMachineScope } from "./SettingsMachineScope";

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
    <div aria-hidden="true" className="ade-linear-avatar">
      {showLogo ? (
        <img src={normalizedLogoUrl} alt="" onError={() => setFailedLogoUrl(normalizedLogoUrl)} />
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
  // Every call below goes to this page's machine: its Linear credential, its
  // checkout's GitHub repo, its ADE agent membership.
  const { pin } = useSettingsMachineScope();
  // Linear OAuth uses a 127.0.0.1 loopback callback server. When the runtime is
  // on another computer that server runs there, but the browser opens locally
  // and redirects to localhost on THIS machine — so the callback never arrives.
  // Steer remote runtimes to the API-key path, which routes cleanly to the
  // remote machine's credential store. Pinned pages judge by their own pin;
  // unpinned ones follow the tab's binding.
  const tabBindingRemote = useAppStore((s) => s.projectBinding?.kind === "remote");
  const isRemoteRuntime = pin ? pin.kind === "remote" : tabBindingRemote;
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
      const nextProjects = await window.ade.cto.getLinearProjects(pin);
      if (!isCurrentLoadRequest(requestId)) return;
      setProjects(nextProjects);
    } catch {
      if (!isCurrentLoadRequest(requestId)) return;
      setProjects([]);
    }
  }, [invalidateLoadRequests, isCurrentLoadRequest, pin]);

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
      const repo = await github.detectRepo(pin);
      if (autolinksRequestIdRef.current !== requestId) return;
      setGithubRepo(repo);
      if (!repo) {
        setGithubAutolinks([]);
        setAutolinkError("No GitHub origin remote was detected for this project.");
        return;
      }
      const autolinks = await github.listRepoAutolinks(repo, pin);
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
  }, [pin]);

  const loadStatus = useCallback(async () => {
    if (!window.ade?.cto) return;
    const requestId = invalidateLoadRequests();
    try {
      const status = await window.ade.cto.getLinearConnectionStatus(pin);
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
  }, [invalidateLoadRequests, isCurrentLoadRequest, loadProjects, pin]);

  /* ── Initial load + reload on active-project or machine change ── */
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
        const session = await cto.getLinearOAuthSession({ sessionId: activeSessionId }, pin);
        if (!active || oauthSessionIdRef.current !== activeSessionId) return;
        if (session.status === "completed") {
          setOauthSessionIdState(null);
          setOauthStartingState(false);
          setConnection(session.connection ?? null);
          announceLinearConnectionChanged();
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
  }, [loadProjects, loadStatus, oauthSessionId, pin, setOauthSessionIdState, setOauthStartingState]);

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
      const status = await window.ade.cto.setLinearToken({ token: submittedToken }, pin);
      if (
        !validatingRef.current
        || oauthStartingRef.current
        || oauthSessionIdRef.current
        || !isCurrentLoadRequest(requestId)
      ) {
        return;
      }
      setConnection(status);
      announceLinearConnectionChanged();
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
  }, [invalidateLoadRequests, isCurrentLoadRequest, loadProjects, pin, setValidatingState, tokenInput]);

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
      const session = await cto.startLinearOAuth(pin);
      if (!oauthStartingRef.current || validatingRef.current) return;
      await openExternal(session.authUrl);
      if (!oauthStartingRef.current || validatingRef.current) return;
      setOauthSessionIdState(session.sessionId);
    } catch (err) {
      if (!oauthStartingRef.current) return;
      setOauthStartingState(false);
      setError(err instanceof Error ? err.message : "Unable to start OAuth.");
    }
  }, [invalidateLoadRequests, setOauthSessionIdState, setOauthStartingState, isRemoteRuntime, pin]);

  const handleDisconnect = useCallback(async () => {
    if (!window.ade?.cto) return;
    invalidateLoadRequests();
    try {
      const status = await window.ade.cto.clearLinearToken(pin);
      setConnection(status);
      announceLinearConnectionChanged();
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
  }, [invalidateLoadRequests, pin, setOauthSessionIdState, setOauthStartingState, setValidatingState]);

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
      }, pin);
      await loadGithubAutolinks();
    } catch (err) {
      setAutolinkError(err instanceof Error ? err.message : "Unable to create GitHub autolink.");
    } finally {
      setCreatingAutolinkId(null);
    }
  }, [githubRepo, loadGithubAutolinks, pin]);

  const openApiSettings = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const openExternal = window.ade?.app?.openExternal;
    if (!openExternal) return;
    event.preventDefault();
    void openExternal(LINEAR_API_SETTINGS_URL);
  };

  return (
    <div className="ade-int-page" style={{ maxWidth: embedded ? undefined : 780 }}>
      <ModernSection
        group="Linear"
        anchor="linear-connection"
        title="Connection"
        hint={
          embedded
            ? "Issues in lanes and chats, PR links, and the ADE agent."
            : "Connect Linear for issue routing, lane context, PR linkage, and CTO workflows."
        }
        actions={
          isConnected ? (
            <>
              <button
                type="button"
                className="ade-modern-btn ade-linear-remove"
                data-variant="ghost"
                onClick={() => void handleDisconnect()}
                disabled={oauthStarting}
              >
                Disconnect
              </button>
              {!isRemoteRuntime ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  onClick={() => void handleStartOAuth()}
                  disabled={oauthStarting || validating || connection?.oauthAvailable === false}
                >
                  {oauthStarting ? <CircleNotch size={12} className="animate-spin" /> : null}
                  {oauthStarting ? "Waiting for Linear..." : "Reconnect current workspace"}
                </button>
              ) : null}
            </>
          ) : null
        }
      >
        {error ? (
          <Banner layout="inline" model={{ id: "linear-connection-error", tone: "error", title: error }} />
        ) : null}

        {isConnected ? (
          <div className="ade-modern-rows">
            <div className="ade-int-hero">
              <LinearWorkspaceAvatar
                organizationName={connection?.organizationName}
                logoUrl={connection?.organizationLogoUrl}
              />
              <div className="ade-int-hero-id">
                <span className="ade-int-hero-name">{workspaceLabel ?? "Linear"}</span>
                {connection?.organizationUrlKey ? (
                  <span className="ade-int-hero-sub">{connection.organizationUrlKey}</span>
                ) : null}
              </div>
              <span className="kit-tag" data-tone="ok">Connected</span>
            </div>
            <div className="ade-int-facts">
              <div className="ade-int-fact">
                <span className="ade-int-fact-label">Signed in as</span>
                <span className="ade-int-fact-value">{connection?.viewerName ?? "Signed in"}</span>
              </div>
              {authModeLabel ? (
                <div className="ade-int-fact">
                  <span className="ade-int-fact-label">Method</span>
                  <span className="ade-int-fact-value">{authModeLabel}</span>
                </div>
              ) : null}
              <div className="ade-int-fact">
                <span className="ade-int-fact-label">Projects</span>
                <span className="ade-int-fact-value kit-num">{connection?.projectCount ?? projects.length}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="ade-int-token-grid">
            {/* OAuth — recommended */}
            <div className="ade-int-token-card">
              <div className="ade-int-token-head">
                <span className="ade-int-logo" aria-hidden style={{ width: 32, height: 32 }}><LinearMark size={16} /></span>
                <span style={{ flex: 1 }}>Sign in with Linear</span>
                <span className="kit-tag">Recommended</span>
              </div>
              <p className="ade-int-quiet">Connects the workspace currently selected in Linear.</p>
              <div className="ade-int-btn-row">
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-tone="primary"
                  onClick={() => void handleStartOAuth()}
                  disabled={oauthStarting || validating || connection?.oauthAvailable === false || isRemoteRuntime}
                  title={isRemoteRuntime ? "Browser sign-in isn't available over a remote connection — use an API key below." : undefined}
                >
                  {oauthStarting ? (
                    <CircleNotch size={13} className="animate-spin" />
                  ) : (
                    <ArrowSquareOut size={13} />
                  )}
                  {oauthStarting ? "Waiting for Linear..." : "Sign in with Linear"}
                </button>
              </div>
              {isRemoteRuntime ? (
                <p className="ade-int-quiet">
                  Browser sign-in isn&rsquo;t available over a remote connection. Use an API key — it&rsquo;s saved on the remote machine.
                </p>
              ) : connection?.oauthAvailable === false ? (
                <p className="ade-int-quiet">Browser sign-in is not available in this ADE build.</p>
              ) : null}
            </div>

            {/* API Key — manual */}
            <div className="ade-int-token-card">
              <div className="ade-int-token-head">
                <span className="ade-int-logo" aria-hidden style={{ width: 32, height: 32 }}><Key size={16} weight="duotone" /></span>
                <span>API key</span>
              </div>
              <p className="ade-int-quiet">
                Paste a personal API key from{" "}
                <a href={LINEAR_API_SETTINGS_URL} target="_blank" rel="noopener noreferrer" onClick={openApiSettings} className="ade-int-link">
                  linear.app/settings/api
                </a>
                . Good if OAuth isn&rsquo;t working.
              </p>
              <div className="ade-int-btn-row">
                <input
                  type="password"
                  aria-label="Linear API key"
                  placeholder="lin_api_..."
                  className="ade-modern-field"
                  data-mono="true"
                  style={{ flex: 1 }}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !validating && !oauthStarting && !oauthSessionId && tokenInput.trim()) {
                      e.preventDefault();
                      void handleValidate();
                    }
                  }}
                />
                <button
                  type="button"
                  className="ade-modern-btn"
                  onClick={() => void handleValidate()}
                  disabled={validating || oauthStarting || oauthSessionId !== null || !tokenInput.trim()}
                >
                  {validating ? <CircleNotch size={12} className="animate-spin" /> : "Connect"}
                </button>
              </div>
            </div>
          </div>
        )}
      </ModernSection>

      {isConnected ? <LinearAgentSection connected={isConnected} pin={pin} /> : null}

      <ModernSection
        group="Linear"
        title="GitHub reference links"
        hint="Make Linear issue keys (like ENG-123) and ADE PR refs clickable in PRs, commits and comments on this project's repo."
        actions={(
          <button
            type="button"
            className="ade-modern-btn"
            data-variant="ghost"
            onClick={() => void loadGithubAutolinks()}
            disabled={autolinksLoading || creatingAutolinkId !== null}
          >
            {autolinksLoading ? <CircleNotch size={12} className="animate-spin" /> : null}
            Refresh
          </button>
        )}
      >
        {/* Folded: set once, rarely revisited. */}
        <details className="ade-modern-rows ade-linear-links">
          <summary className="ade-int-row">
            <div className="ade-int-row-copy">
              <div className="ade-ap-rowtitle">Repository</div>
              <div className="ade-int-hero-sub">{githubRepoSlug ?? "No GitHub origin detected"}</div>
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span
                className="kit-tag"
                data-tone={autolinkCandidates.length > 0 && configuredAutolinkCount === autolinkCandidates.length ? "ok" : undefined}
              >
                {autolinkCandidates.length > 0 && configuredAutolinkCount === autolinkCandidates.length
                  ? "All set up"
                  : `${configuredAutolinkCount} of ${autolinkCandidates.length} set up`}
              </span>
              <CaretDown size={12} className="ade-linear-links-caret" style={{ color: "var(--color-muted-fg)" }} />
            </span>
          </summary>
          <p className="ade-int-note">
            Click <strong style={{ color: "var(--color-fg)", fontWeight: 500 }}>Create</strong> to add a link to this repo automatically, or copy the <code className="ade-int-mono">gh</code> command below it to run it yourself.
          </p>
          {/* Stacked rows, not a table: the command is long and the column
              is narrow, and a table this wide scrolled sideways and clipped
              its own Create button. */}
          {autolinkCandidates.map((candidate) => {
            const busy = creatingAutolinkId === candidate.id;
            return (
              <div key={candidate.id} className="ade-linear-link-row">
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {candidate.configured ? <CheckCircle size={13} weight="fill" style={{ color: "var(--kit-ok)" }} /> : null}
                      <span className="ade-ap-rowtitle">{candidate.title}</span>
                      <code className="kit-tag">{candidate.keyPrefix}</code>
                    </div>
                    <div className="ade-ap-rowhint">{candidate.desc}</div>
                  </div>
                  <button
                    type="button"
                    className="ade-modern-btn"
                    data-variant={candidate.configured ? "ghost" : undefined}
                    onClick={() => void handleCreateAutolink(candidate)}
                    disabled={!githubRepo || candidate.configured || autolinksLoading || creatingAutolinkId !== null}
                  >
                    {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                    {candidate.configured ? "Configured" : "Create"}
                  </button>
                </div>
                <code className="ade-int-command" style={{ marginTop: 0, color: "var(--color-muted-fg)" }}>
                  {candidate.command}
                </code>
              </div>
            );
          })}
          {!teamKeys.length ? (
            <p className="ade-int-note">
              Connect Linear and load projects to add team-key references such as TEAM-123 for this workspace.
            </p>
          ) : null}
        </details>
        {autolinkError ? (
          <Banner layout="inline" model={{ id: "linear-autolink-error", tone: "error", title: autolinkError }} />
        ) : null}
      </ModernSection>
    </div>
  );
}
