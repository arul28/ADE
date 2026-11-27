import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Key,
  LinkSimple,
} from "@phosphor-icons/react";
import type { CtoLinearProject, GitHubAutolink, LinearConnectionStatus } from "../../../shared/types";
import { GITHUB_AUTOLINKS_SIGN_IN_LACKS_ADMIN, isGithubAutolinksRefusal } from "../../../shared/githubAutolinks";
import { captureError } from "../../../shared/sentry/capture";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import {
  credentialStorageFact,
  IntegrationCard,
  IntegrationColumns,
  IntegrationHero,
  IntegrationOr,
  IntegrationPage,
  type IntegrationFact,
} from "./integrations/IntegrationChrome";
import { setIssueTopBarVisible, useIssueTopBarPreferences } from "../issues/issueTopBarPreferences";
import { showToast } from "../app/toast/toastStore";
import { Banner, type NoticeAction } from "../ui/notice";
import { LinearMark } from "../lanes/linearBrand";
import "./IntegrationsSettings.css";
import { LinearAgentSection } from "./LinearAgentSection";
import { announceLinearConnectionChanged } from "../../lib/linearConnectionEvents";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { isImeComposing } from "../../lib/imeComposition";
import { requirePin } from "../../state/repositoryScope";
import { plainError, plainErrorText, type PlainError } from "../../lib/plainError";

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
  desc: string;
  keyPrefix: string;
  urlTemplate: string;
  isAlphanumeric: boolean;
  configured: boolean;
};

// ADE adds a repository's links once, on its own, for an admin. Every link this
// computer added is remembered per repository and key, so one the admin later
// deletes on GitHub is not added again from here. (Another computer may add it
// once more; the repository itself is the truth, so nothing here is account state.)
const ADDED_STORAGE_PREFIX = "ade.linear.autolinkAdded.v1:";

function addedKey(repoSlug: string, keyPrefix: string): string {
  return `${ADDED_STORAGE_PREFIX}${repoSlug.toLowerCase()}:${keyPrefix.toUpperCase()}`;
}

function wasAdded(repoSlug: string, keyPrefix: string): boolean {
  try {
    return window.localStorage.getItem(addedKey(repoSlug, keyPrefix)) != null;
  } catch {
    return false;
  }
}

function rememberAdded(repoSlug: string, keyPrefix: string): void {
  try {
    window.localStorage.setItem(addedKey(repoSlug, keyPrefix), String(Date.now()));
  } catch {
    // Storage unavailable: at worst ADE offers the link again next time.
  }
}

/**
 * What a person GitHub refused to show the links sees. An admin whose sign-in
 * can't read them can fix that; anyone else learns who adds them, and that
 * ADE links the keys either way.
 */
function refusedLinksNote(refusal: string, repoSlug: string | null, exampleIssueKey: string): string {
  if (GITHUB_AUTOLINKS_SIGN_IN_LACKS_ADMIN.test(refusal)) return refusal;
  return `Only an admin of ${repoSlug ?? "this repository"} can add these on GitHub. In ADE's PR view, keys like ${exampleIssueKey} already open the issue.`;
}

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
  // GitHub listed the repository's links, so `githubAutolinks` is the truth.
  const [autolinksRead, setAutolinksRead] = useState(false);
  // Why the links could not be read or added, in plain words.
  const [autolinkError, setAutolinkError] = useState<PlainError | null>(null);
  const [creatingAutolinkId, setCreatingAutolinkId] = useState<string | null>(null);
  // Why ADE's own add (nobody pressed anything) failed: a quiet note, not an error banner.
  const [autoAddFailure, setAutoAddFailure] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  // The status read itself failed, so the page cannot say connected or not.
  const [statusReadFailed, setStatusReadFailed] = useState(false);
  const validatingRef = useRef(false);
  const oauthStartingRef = useRef(false);
  const oauthSessionIdRef = useRef<string | null>(null);
  const requestEpochRef = useRef(0);
  const autolinksRequestIdRef = useRef(0);
  const autoAddTriedRef = useRef(new Set<string>());

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
  // Without it a link would point at a placeholder workspace, so nothing is added.
  const hasWorkspaceKey = workspaceUrlKey !== "YOUR-WORKSPACE";
  const githubRepoSlug = githubRepo ? `${githubRepo.owner}/${githubRepo.name}` : null;
  const teamKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const project of projects) {
      const key = project.teamKey?.trim();
      if (key) keys.add(key.toUpperCase());
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [projects]);
  const autolinkCandidates = useMemo<GitHubAutolinkCandidate[]>(() => (
    teamKeys.map((teamKey) => {
      const keyPrefix = `${teamKey}-`;
      return {
        id: `linear-${teamKey}`,
        desc: `Opens the ${teamKey} issue in Linear`,
        keyPrefix,
        urlTemplate: `https://linear.app/${encodeURIComponent(workspaceUrlKey)}/issue/${teamKey}-<num>`,
        isAlphanumeric: false,
        configured: githubAutolinks.some((autolink) => autolink.keyPrefix.toLowerCase() === keyPrefix.toLowerCase()),
      };
    })
  ), [githubAutolinks, teamKeys, workspaceUrlKey]);
  const exampleIssueKey = `${teamKeys[0] ?? "ENG"}-123`;
  const configuredAutolinkCount = autolinkCandidates.filter((candidate) => candidate.configured).length;
  // GitHub refused to show the links (not an admin, or a sign-in without
  // Administration access). What is added is unknown, so no rows and no Add:
  // pressing it could only fail the same way. Not a warning either: inside
  // ADE the keys link anyway (PR markdown and chat).
  const autolinksRefused = autolinkError != null && isGithubAutolinksRefusal(autolinkError.text);

  /* ── Load helpers ── */
  const loadProjects = useCallback(async (requestIdArg?: number) => {
    if (!window.ade?.cto) return;
    const requestId = requestIdArg ?? invalidateLoadRequests();
    try {
      const nextProjects = await window.ade.cto.getLinearProjects(requirePin(pin));
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
    setAutolinksRead(false);
    setAutolinkError(null);
    setAutoAddFailure(null);
    try {
      const repo = await github.detectRepo(requirePin(pin));
      if (autolinksRequestIdRef.current !== requestId) return;
      setGithubRepo(repo);
      if (!repo) {
        setGithubAutolinks([]);
        setAutolinkError(null);
        return;
      }
      const autolinks = await github.listRepoAutolinks(repo, requirePin(pin));
      if (autolinksRequestIdRef.current !== requestId) return;
      setGithubAutolinks(autolinks);
      setAutolinksRead(true);
    } catch (err) {
      if (autolinksRequestIdRef.current !== requestId) return;
      setGithubAutolinks([]);
      setAutolinkError(plainError(err, { fallback: "ADE couldn't read this repository's links on GitHub." }));
    } finally {
      if (autolinksRequestIdRef.current === requestId) {
        setAutolinksLoading(false);
      }
    }
  }, [pin]);

  const loadStatus = useCallback(async () => {
    if (!window.ade?.cto) {
      setStatusReadFailed(true);
      return;
    }
    const requestId = invalidateLoadRequests();
    try {
      const status = await window.ade.cto.getLinearConnectionStatus(requirePin(pin));
      if (!isCurrentLoadRequest(requestId)) return;
      setStatusReadFailed(false);
      setConnection(status);
      if (status.connected) {
        if (isCurrentLoadRequest(requestId)) {
          void loadProjects(requestId);
        }
      } else {
        setProjects([]);
      }
    } catch (err) {
      captureError(err, {
        tags: { feature: "linear_settings", action: "read_status" },
        fingerprint: ["linear_settings", "read_status"],
        handled: true,
      });
      if (!isCurrentLoadRequest(requestId)) return;
      setStatusReadFailed(true);
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
      showToast({ tone: "error", title: "Linear is unavailable", message: "Linear integration is unavailable in this environment." });
      return;
    }

    let active = true;
    let timer: number | null = null;
    let timeout: number | null = null;

    const poll = async () => {
      try {
        const session = await cto.getLinearOAuthSession({ sessionId: activeSessionId }, requirePin(pin));
        if (!active || oauthSessionIdRef.current !== activeSessionId) return;
        if (session.status === "completed") {
          setOauthSessionIdState(null);
          setOauthStartingState(false);
          setConnection(session.connection ?? null);
          announceLinearConnectionChanged();
          if (session.connection?.connected) void loadProjects();
          else void loadStatus();
          return;
        }
        if (session.status === "failed" || session.status === "expired") {
          setOauthSessionIdState(null);
          setOauthStartingState(false);
          showToast({ tone: "error", title: "Linear sign-in failed", message: session.error ?? "OAuth failed." });
        }
      } catch (err) {
        if (!active || oauthSessionIdRef.current !== activeSessionId) return;
        setOauthSessionIdState(null);
        setOauthStartingState(false);
        showToast({ tone: "error", title: "Linear sign-in failed", message: plainErrorText(err, "OAuth failed.") });
      }
    };
    void poll();
    timer = window.setInterval(() => void poll(), 1500);
    timeout = window.setTimeout(() => {
      if (!active || oauthSessionIdRef.current !== activeSessionId) return;
      setOauthSessionIdState(null);
      setOauthStartingState(false);
      showToast({ tone: "error", title: "Linear sign-in timed out", message: "Linear sign-in timed out. Try again." });
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
    try {
      const status = await window.ade.cto.setLinearToken({ token: submittedToken }, requirePin(pin));
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
        showToast({ tone: "error", title: "Linear didn't accept the token", message: status.message ?? "Token validation failed.", report: false });
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
      showToast({ tone: "error", title: "Couldn't validate the token", message: plainErrorText(err, "Validation failed.") });
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
      showToast({ tone: "error", title: "Browser sign-in unavailable", message: "Browser sign-in can't reach a project on another computer. Use an API key instead." });
      return;
    }
    if (!openExternal) {
      setOauthSessionIdState(null);
      setOauthStartingState(false);
      showToast({ tone: "error", title: "Browser sign-in unavailable", message: "Browser sign-in is not available in this ADE build." });
      return;
    }
    invalidateLoadRequests();
    setOauthStartingState(true);
    try {
      const session = await cto.startLinearOAuth(requirePin(pin));
      if (!oauthStartingRef.current || validatingRef.current) return;
      await openExternal(session.authUrl);
      if (!oauthStartingRef.current || validatingRef.current) return;
      setOauthSessionIdState(session.sessionId);
    } catch (err) {
      if (!oauthStartingRef.current) return;
      setOauthStartingState(false);
      showToast({ tone: "error", title: "Couldn't start Linear sign-in", message: plainErrorText(err, "Unable to start OAuth.") });
    }
  }, [invalidateLoadRequests, setOauthSessionIdState, setOauthStartingState, isRemoteRuntime, pin]);

  const handleDisconnect = useCallback(async () => {
    if (!window.ade?.cto) return;
    invalidateLoadRequests();
    try {
      const status = await window.ade.cto.clearLinearToken(requirePin(pin));
      setConnection(status);
      announceLinearConnectionChanged();
      setProjects([]);
      setTokenInput("");
      setOauthSessionIdState(null);
    } catch (err) {
      showToast({ tone: "error", title: "Couldn't disconnect Linear", message: plainErrorText(err, "Failed to disconnect Linear.") });
    } finally {
      setValidatingState(false);
      setOauthStartingState(false);
    }
  }, [invalidateLoadRequests, pin, setOauthSessionIdState, setOauthStartingState, setValidatingState]);

  /**
   * Adds each link, carrying on past a failure so one refused key does not
   * strand the rest. Each added link joins the list at once (so its row says
   * Added) and is remembered. Returns the first failure, or null.
   */
  const addAutolinks = useCallback(async (candidates: GitHubAutolinkCandidate[]): Promise<PlainError | null> => {
    const github = window.ade?.github;
    if (!github || !githubRepo) return null;
    const repoSlug = `${githubRepo.owner}/${githubRepo.name}`;
    let failure: PlainError | null = null;
    for (const candidate of candidates) {
      setCreatingAutolinkId(candidate.id);
      try {
        const created = await github.createRepoAutolink({
          owner: githubRepo.owner,
          name: githubRepo.name,
          keyPrefix: candidate.keyPrefix,
          urlTemplate: candidate.urlTemplate,
          isAlphanumeric: candidate.isAlphanumeric,
        }, requirePin(pin));
        rememberAdded(repoSlug, candidate.keyPrefix);
        setGithubAutolinks((current) => [...current, created]);
      } catch (err) {
        failure ??= plainError(err, { fallback: `ADE couldn't add the ${candidate.keyPrefix} link on GitHub.` });
      }
    }
    setCreatingAutolinkId(null);
    return failure;
  }, [githubRepo, pin]);

  const addAutolinkByHand = useCallback(async (candidate: GitHubAutolinkCandidate) => {
    setAutolinkError(null);
    setAutoAddFailure(null);
    setAutolinkError(await addAutolinks([candidate]));
  }, [addAutolinks]);

  // An admin never has to press Add: once the links are read (only an admin can
  // read them) and the workspace's team keys are known, ADE adds the missing
  // ones. Each key is tried once per page visit, and never again once added.
  useEffect(() => {
    if (!githubRepoSlug || !hasWorkspaceKey) return;
    if (!autolinksRead || autolinksLoading || autolinkError || creatingAutolinkId !== null) return;
    const missing = autolinkCandidates.filter((candidate) => {
      const key = addedKey(githubRepoSlug, candidate.keyPrefix);
      return !candidate.configured && !autoAddTriedRef.current.has(key) && !wasAdded(githubRepoSlug, candidate.keyPrefix);
    });
    if (!missing.length) return;
    for (const candidate of missing) autoAddTriedRef.current.add(addedKey(githubRepoSlug, candidate.keyPrefix));
    void addAutolinks(missing).then((failure) => {
      if (failure) setAutoAddFailure(`ADE couldn't add these on GitHub: ${failure.text}`);
    });
  }, [addAutolinks, autolinkCandidates, autolinkError, autolinksLoading, autolinksRead, creatingAutolinkId, githubRepoSlug, hasWorkspaceKey]);

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
        ...[credentialStorageFact(connection?.credentialStorage)].filter((fact): fact is IntegrationFact => fact != null),
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

  // A failure that may pass offers another try.
  const autolinkActions: NoticeAction[] | undefined = autolinkError?.next === "retry"
    ? [{ label: "Reload links", onClick: () => void loadGithubAutolinks() }]
    : undefined;
  const autolinksRefusedNote = autolinksRefused ? refusedLinksNote(autolinkError.text, githubRepoSlug, exampleIssueKey) : null;

  const linksCard = (
    <IntegrationCard
      icon={<LinkSimple size={16} weight="bold" />}
      title="Links on GitHub"
      hint={<>Issue keys like {exampleIssueKey} become links to Linear in {githubRepoSlug ? <span className="ade-ig-mono">{githubRepoSlug}</span> : "this repository"}&rsquo;s PRs, commits and comments on GitHub.</>}
      badge={autolinkCandidates.length > 0 && !autolinksRefused ? (
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
      ) : autolinksRefusedNote ? (
        <p className="ade-ig-note">{autolinksRefusedNote}</p>
      ) : autolinkCandidates.length > 0 ? (
        <div className="ade-ig-mini-rows" style={{ marginTop: 0 }}>
          {autolinkCandidates.map((candidate) => {
            const busy = creatingAutolinkId === candidate.id;
            return (
              <div key={candidate.id} className="ade-ig-mini-row" style={{ padding: "9px 12px" }}>
                <code className="kit-tag" style={{ flex: "none" }}>{candidate.keyPrefix}123</code>
                <span className="ade-ig-mini-detail">{candidate.desc}</span>
                {candidate.configured ? (
                  <span className="kit-tag" data-tone="ok"><CheckCircle size={11} weight="fill" /> Added</span>
                ) : busy ? (
                  <span className="kit-tag"><CircleNotch size={11} className="animate-spin" /> Adding</span>
                ) : autolinksRead && !autolinksLoading && githubRepo && hasWorkspaceKey ? (
                  <button
                    type="button"
                    className="ade-modern-btn"
                    data-size="sm"
                    onClick={() => void addAutolinkByHand(candidate)}
                    disabled={creatingAutolinkId !== null}
                  >
                    Add
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {autoAddFailure ? <p className="ade-ig-note">{autoAddFailure}</p> : null}
      {!teamKeys.length && githubRepoSlug ? (
        <p className="ade-ig-note">Links for your team keys appear once ADE has loaded the workspace&rsquo;s projects.</p>
      ) : null}
      {autolinkError && !autolinksRefused ? (
        <Banner
          layout="inline"
          model={{
            id: "linear-autolink-error",
            tone: "error",
            title: autolinkError.text,
            actions: autolinkActions,
          }}
        />
      ) : null}
    </IntegrationCard>
  );

  return (
    <IntegrationPage id="linear">
      <IntegrationHero
        id="linear"
        anchor={isConnected ? "linear-connection" : undefined}
        status={statusReadFailed && !connection
          ? { tone: "warn", label: "Couldn't check" }
          : connection == null
          ? { tone: "checking", label: "Checking…" }
          : isConnected
            ? { tone: "ok", label: "Connected" }
            : { tone: "neutral", label: "Not connected" }}
        accountNote={statusReadFailed && !connection ? "ADE couldn't read this machine's Linear connection." : undefined}
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
        ) : statusReadFailed && !connection ? (
          <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => void loadStatus()}>
            Check again
          </button>
        ) : null}
        facts={facts}
        topBar={{
          label: "Linear issues",
          checked: issueTopBar.linear,
          onChange: (next) => setIssueTopBarVisible("linear", next),
          anchor: "linear-top-bar",
        }}
      />

      <IntegrationColumns>
        {isConnected ? null : connectCard}
        <LinearAgentSection connected={isConnected} viewerIsAdmin={connection?.viewerIsAdmin ?? null} pin={pin} />
        {isConnected ? linksCard : null}
      </IntegrationColumns>
    </IntegrationPage>
  );
}
