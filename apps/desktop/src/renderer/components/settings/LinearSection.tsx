import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Key,
  LinkSimple,
} from "@phosphor-icons/react";
import type { CtoLinearProject, GitHubAutolink, LinearConnectionStatus } from "../../../shared/types";
import { ADE_DEEPLINK_HTTPS_BASE_URL } from "../../../shared/deeplinks";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import {
  IntegrationCard,
  IntegrationColumns,
  IntegrationHero,
  IntegrationOr,
  IntegrationPage,
  type IntegrationFact,
} from "./integrations/IntegrationChrome";
import { setIssueTopBarVisible, useIssueTopBarPreferences } from "../issues/issueTopBarPreferences";
import { Banner } from "../ui/notice";
import { LinearMark } from "../lanes/linearBrand";
import "./IntegrationsSettings.css";
import { LinearAgentSection } from "./LinearAgentSection";
import { announceLinearConnectionChanged } from "../../lib/linearConnectionEvents";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { isImeComposing } from "../../lib/imeComposition";

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
    <>
      {showLogo ? (
        <img src={normalizedLogoUrl} alt="" onError={() => setFailedLogoUrl(normalizedLogoUrl)} />
      ) : monogram}
    </>
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

export function LinearSection() {
  const issueTopBar = useIssueTopBarPreferences();
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
        title: "ADE pull requests",
        desc: "Opens the pull request in ADE",
        keyPrefix: "ADEPR-",
        urlTemplate: adePrTemplate,
        isAlphanumeric: false,
      },
      ...teamKeys.map((teamKey) => ({
        id: `linear-${teamKey}`,
        title: `${teamKey} issues`,
        desc: `Opens the ${teamKey} issue in Linear`,
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
        setAutolinkError(null);
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
      setError("Linear sign-in timed out. Try again.");
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
      setError("Browser sign-in can't reach a project on another computer. Use an API key instead.");
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

  const facts: IntegrationFact[] = isConnected
    ? [
        ...(authModeLabel ? [{ label: "Method", value: authModeLabel }] : []),
        { label: "Projects", value: String(connection?.projectCount ?? projects.length) },
        { label: "Repository", value: githubRepoSlug ?? "None found", mono: Boolean(githubRepoSlug) },
      ]
    : [];
  const oauthDisabled = oauthStarting || validating || connection?.oauthAvailable === false || isRemoteRuntime;

  const connectCard = (
    <IntegrationCard
      anchor={isConnected ? undefined : "linear-connection"}
      icon={<LinearMark size={15} />}
      title="Connect Linear"
      hint="Sign in once on this machine. Lanes, chats and PRs can then use your Linear issues."
    >
      <div className="ade-ig-choice" data-primary="true">
        <div className="ade-ig-choice-head">
          <b>Sign in with Linear</b>
          <span className="kit-tag">Recommended</span>
        </div>
        <p>
          {isRemoteRuntime
            ? "Browser sign-in can't reach a project on another computer. Use an API key; it's saved on that computer."
            : connection?.oauthAvailable === false
              ? "Browser sign-in isn't available in this build of ADE. Use an API key."
              : "Opens Linear in your browser and connects the workspace you have selected there."}
        </p>
        <div className="ade-ig-form-row">
          <button type="button" className="ade-modern-btn" data-tone="primary" onClick={() => void handleStartOAuth()} disabled={oauthDisabled}>
            {oauthStarting ? <CircleNotch size={13} className="animate-spin" /> : <ArrowSquareOut size={13} />}
            {oauthStarting ? "Waiting for Linear…" : "Sign in with Linear"}
          </button>
        </div>
      </div>
      <IntegrationOr>or</IntegrationOr>
      <div className="ade-ig-choice">
        <div className="ade-ig-choice-head">
          <Key size={15} weight="duotone" />
          <b>Use an API key</b>
        </div>
        <p>
          Create a personal key in{" "}
          <a href={LINEAR_API_SETTINGS_URL} target="_blank" rel="noopener noreferrer" onClick={openApiSettings} className="ade-ig-link">
            Linear › Settings › API
          </a>{" "}
          and paste it here.
        </p>
        <div className="ade-ig-form-row">
          <input
            type="password"
            aria-label="Linear API key"
            placeholder="lin_api_…"
            className="ade-modern-field"
            data-mono="true"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
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
            {validating ? <CircleNotch size={12} className="animate-spin" /> : null}
            Connect
          </button>
        </div>
      </div>
    </IntegrationCard>
  );

  const linksCard = (
    <IntegrationCard
      icon={<LinkSimple size={16} weight="bold" />}
      title="Links on GitHub"
      hint={<>Issue keys like ENG-123 and ADE PR references become links in {githubRepoSlug ? <span className="ade-ig-mono">{githubRepoSlug}</span> : "this repository"}&rsquo;s PRs, commits and comments.</>}
      badge={autolinkCandidates.length > 0 ? (
        <span className="kit-tag" data-tone={configuredAutolinkCount === autolinkCandidates.length ? "ok" : undefined}>
          {configuredAutolinkCount === autolinkCandidates.length ? "All added" : `${configuredAutolinkCount} of ${autolinkCandidates.length} added`}
        </span>
      ) : null}
      actions={(
        <button
          type="button"
          className="ade-modern-btn"
          data-variant="ghost"
          data-icon="true"
          aria-label="Check again"
          title="Check again"
          onClick={() => void loadGithubAutolinks()}
          disabled={autolinksLoading || creatingAutolinkId !== null}
        >
          <ArrowClockwise size={13} className={autolinksLoading ? "ade-icon-spin" : undefined} />
        </button>
      )}
    >
      {!githubRepoSlug && !autolinksLoading ? (
        <p className="ade-ig-note">This project has no GitHub origin remote, so there is nowhere to add links.</p>
      ) : (
        <div className="ade-ig-mini-rows" style={{ marginTop: 0 }}>
          {autolinkCandidates.map((candidate) => {
            const busy = creatingAutolinkId === candidate.id;
            return (
              <details key={candidate.id} className="ade-linear-link">
                <summary className="ade-ig-mini-row" style={{ padding: "9px 12px" }}>
                  <code className="kit-tag" style={{ flex: "none" }}>{candidate.keyPrefix}123</code>
                  <span className="ade-ig-mini-detail">{candidate.desc}</span>
                  {candidate.configured ? (
                    <span className="kit-tag" data-tone="ok"><CheckCircle size={11} weight="fill" /> Added</span>
                  ) : (
                    <button
                      type="button"
                      className="ade-modern-btn"
                      data-size="sm"
                      onClick={(event) => {
                        event.preventDefault();
                        void handleCreateAutolink(candidate);
                      }}
                      disabled={!githubRepo || autolinksLoading || creatingAutolinkId !== null}
                    >
                      {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                      Add
                    </button>
                  )}
                  <CaretDown size={12} className="ade-linear-links-caret" aria-label="Show the gh command" />
                </summary>
                <code className="ade-int-command" style={{ margin: "0 12px 10px", color: "var(--color-muted-fg)" }}>
                  {candidate.command}
                </code>
              </details>
            );
          })}
        </div>
      )}
      {!teamKeys.length && githubRepoSlug ? (
        <p className="ade-ig-note">Links for your team keys appear once ADE has loaded the workspace&rsquo;s projects.</p>
      ) : null}
      {autolinkError ? (
        <Banner layout="inline" model={{ id: "linear-autolink-error", tone: "error", title: autolinkError }} />
      ) : null}
    </IntegrationCard>
  );

  return (
    <IntegrationPage id="linear">
      <IntegrationHero
        id="linear"
        anchor={isConnected ? "linear-connection" : undefined}
        status={connection == null && !error
          ? { tone: "checking", label: "Checking…" }
          : isConnected
            ? { tone: "ok", label: "Connected" }
            : { tone: "neutral", label: "Not connected" }}
        account={isConnected ? {
          avatar: <LinearWorkspaceAvatar organizationName={connection?.organizationName} logoUrl={connection?.organizationLogoUrl} />,
          title: workspaceLabel ?? "Linear",
          detail: connection?.viewerName ? `as ${connection.viewerName}` : connection?.organizationUrlKey ? `linear.app/${connection.organizationUrlKey}` : null,
        } : null}
        actions={isConnected ? (
          <>
            {!isRemoteRuntime ? (
              <button
                type="button"
                className="ade-modern-btn"
                data-size="sm"
                onClick={() => void handleStartOAuth()}
                disabled={oauthStarting || validating || connection?.oauthAvailable === false}
                title="Sign in again, for the workspace selected in Linear"
              >
                {oauthStarting ? <CircleNotch size={12} className="animate-spin" /> : null}
                {oauthStarting ? "Waiting for Linear…" : "Switch workspace"}
              </button>
            ) : null}
            <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => void handleDisconnect()} disabled={oauthStarting}>
              Disconnect
            </button>
          </>
        ) : null}
        facts={facts}
        topBar={{
          label: "Linear issues",
          checked: issueTopBar.linear,
          onChange: (next) => setIssueTopBarVisible("linear", next),
          anchor: "linear-top-bar",
        }}
      />

      {error ? (
        <Banner layout="inline" model={{ id: "linear-connection-error", tone: "error", title: error }} />
      ) : null}

      <IntegrationColumns>
        {isConnected ? null : connectCard}
        <LinearAgentSection connected={isConnected} pin={pin} />
        {isConnected ? linksCard : null}
      </IntegrationColumns>
    </IntegrationPage>
  );
}
