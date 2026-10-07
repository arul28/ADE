import { useEffect, useState } from "react";
import type { GitHubCredentialState, GitHubStatus } from "../../../shared/types";
import {
  CheckCircle,
  Warning,
  ArrowsClockwise,
  ShieldCheck,
  LinkBreak,
  Key,
  Shield,
  GitPullRequest,
  Eye,
  GitBranch,
  ArrowSquareOut,
  TerminalWindow,
  GithubLogo,
  FlowArrow,
} from "@phosphor-icons/react";
import { getGitHubTokenAccessState, REQUIRED_GITHUB_CLASSIC_SCOPES } from "../../../shared/githubScopes";
import { GitHubAppInstallPanel } from "../github/GitHubAppInstallPanel";
import {
  describeGithubPatVerification,
  describeGithubAppCredentialBadge,
  describeGithubAuthFailure,
  deriveGithubAccountAuthState,
  formatGithubShortTime,
  githubCredentialPresentation,
  describeGithubOutage,
  type GithubAccountAuthState,
} from "../../lib/githubIntegrationStatus";
import { useGithubAppUserAuth } from "../../lib/useGithubAppUserAuth";
import { GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY } from "../../../shared/types";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { ModernSection, SettingsTextField } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import "./IntegrationsSettings.css";
import { Banner } from "../ui/notice";

type TokenType = "classic" | "fine-grained" | "unknown";

const GH_AUTH_LOGIN_COMMAND = "gh auth login -h github.com -s repo -s workflow";
const GH_AUTH_REFRESH_COMMAND = "gh auth refresh -h github.com -s repo -s workflow";
const GH_AUTH_LOGIN_WITH_GIST_COMMAND = "gh auth login -h github.com -s repo -s workflow -s gist";
const GH_AUTH_REFRESH_WITH_GIST_COMMAND = "gh auth refresh -h github.com -s repo -s workflow -s gist";
const GITHUB_CLASSIC_TOKEN_NEW_URL = "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow";
const GITHUB_CLASSIC_TOKEN_WITH_GIST_NEW_URL = "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow,gist";
const GITHUB_CLASSIC_TOKENS_URL = "https://github.com/settings/tokens";
const GITHUB_FINE_GRAINED_TOKEN_NEW_URL = "https://github.com/settings/personal-access-tokens/new?name=ADE&description=ADE%20desktop%20PR%20workflows&contents=write&pull_requests=write&metadata=read&actions=write&checks=write&statuses=read&workflows=write";
const GITHUB_FINE_GRAINED_TOKENS_URL = "https://github.com/settings/personal-access-tokens";

function sentenceCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const REQUIRED_GITHUB_REPOSITORY_PERMISSIONS = [
  "Contents: Read and write",
  "Pull requests: Read and write",
  "Metadata: Read",
  "Actions: Read and write",
  "Checks: Read and write",
  "Commit statuses: Read",
  "Workflows: Write",
] as const;

const PERMISSION_USES = [
  { title: "Pull requests", detail: "Create PRs, request reviewers, and post review comments.", icon: <GitPullRequest size={15} weight="duotone" /> },
  { title: "Contents", detail: "Read repository files and push branch changes.", icon: <GitBranch size={15} weight="duotone" /> },
  { title: "Workflows", detail: "Push lane changes that edit GitHub workflow files.", icon: <FlowArrow size={15} weight="duotone" /> },
  { title: "Actions", detail: "Inspect workflow runs and re-run failed jobs.", icon: <Eye size={15} weight="duotone" /> },
];

function detectTokenType(token: string): TokenType {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  return "unknown";
}

function tokenTypeDetectionLabel(type: TokenType): string {
  switch (type) {
    case "classic":
      return "Classic token";
    case "fine-grained":
      return "Fine-grained token";
    default:
      return "Unknown format";
  }
}

function credentialSourceLabel(source: GitHubStatus["authSource"] | undefined): string {
  switch (source) {
    case "app":
      return "ADE GitHub App";
    case "gh":
      return "GitHub CLI";
    case "pat":
      return "Personal access token";
    case "environment":
      return "Environment token";
    default:
      return "Not connected";
  }
}

function authSourceLabel(status: GitHubStatus | null): string {
  return credentialSourceLabel(status?.authSource);
}


/**
 * One badge per credential row. Label and color are derived together because
 * they switch on the same states — deriving them apart let the cooldown branch
 * drift between the two.
 */
function credentialStateBadge(
  state: GitHubCredentialState,
  outage: boolean,
  /** The account axis, which knows why the App credential is idle. */
  appAccount: { state: GithubAccountAuthState; blockedUntil: string | null } | null,
): { label: string; tone: StatusTone } {
  if (state.activeFor.length === 2) return { label: "Reads & writes", tone: "ok" };
  if (state.activeFor[0] === "read") return { label: "Reads", tone: "ok" };
  if (state.activeFor[0] === "write") return { label: "Writes", tone: "ok" };
  // The App's own credential state outranks the generic ladder states: it is
  // the only place that can tell a paused renewal from a dead authorization,
  // and only the dead one may ask the user to re-authorize. It says nothing
  // about the other rows, so the row decides here rather than at the call site.
  if (appAccount && state.source === "app") {
    const badge = describeGithubAppCredentialBadge(appAccount.state, appAccount.blockedUntil);
    if (badge) return { label: badge.label, tone: badge.tone === "ok" ? "ok" : badge.tone === "warn" ? "warn" : "neutral" };
  }
  if (state.state === "cooldown") {
    // During a GitHub outage a cooldown says nothing about the credential —
    // it only records that GitHub failed to answer. "Reconnect needed" here
    // would be an outright false accusation.
    if (outage) return { label: "Waiting on GitHub", tone: "neutral" };
    const retryAt = formatGithubShortTime(state.failure?.retryAt);
    if (state.failure?.kind === "rate_limited") {
      return { label: retryAt ? `Paused until ${retryAt}` : "Paused", tone: "warn" };
    }
    if (state.failure?.kind === "invalid_token") return { label: "Reconnect needed", tone: "warn" };
    if (state.failure?.kind === "permission_denied") return { label: "Access unavailable", tone: "warn" };
    return { label: "Temporarily unavailable", tone: "warn" };
  }
  return { label: state.available ? "Fallback" : "Not set up", tone: "neutral" };
}

/** Colour carries status only: ok, needs attention, or nothing to say. */
type StatusTone = "ok" | "warn" | "neutral";

export function GitHubSection({ embedded = false }: { embedded?: boolean }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [githubBusy, setGithubBusy] = useState(false);
  const [showPatSetup, setShowPatSetup] = useState(false);
  const [transcriptGistsEnabled, setTranscriptGistsEnabled] = useState(false);
  // Every read and write below goes to this page's machine: its credential
  // store, its gh login, its App authorization.
  const { pin } = useSettingsMachineScope();
  // The App row in the ladder below reports why the App credential is idle, and
  // only this status can tell a paused renewal from a dead authorization. Shared
  // with the install panel on this same page, which is where it is disconnected.
  const { appAuth } = useGithubAppUserAuth(pin);

  useEffect(() => {
    let cancelled = false;

    window.ade.github
      .getStatus(undefined, pin)
      .then((status) => {
        if (!cancelled) setGithubStatus(status);
      })
      .catch(() => {});
    window.ade.projectConfig
      .get(pin)
      .then((snapshot) => {
        if (cancelled) return;
        setTranscriptGistsEnabled(snapshot.effective.github?.prTranscriptGists?.enabled === true);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [pin]);

  const handleSaveToken = () => {
    const token = githubTokenDraft.trim();
    if (!token) {
      setActionError("Personal access token is empty.");
      return;
    }
    setGithubBusy(true);
    setActionError(null);
    setSaveNotice(null);
    window.ade.github
      .setToken(token, pin)
      .then((status) => {
        setGithubStatus(status);
        setGithubTokenDraft("");
        const verification = describeGithubPatVerification(status);
        if (verification.verified) {
          setShowPatSetup(false);
          setSaveNotice(verification.message);
          return;
        }
        setActionError(verification.message);
      })
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGithubBusy(false));
  };

  const handleClearToken = () => {
    setGithubBusy(true);
    setActionError(null);
    setSaveNotice(null);
    window.ade.github
      .clearToken(pin)
      .then((status) => {
        setGithubStatus(status);
        setShowPatSetup(false);
        setSaveNotice(status.authSource === "gh" ? "Personal access token cleared. ADE is using gh auth." : "Personal access token cleared.");
      })
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGithubBusy(false));
  };

  const handleRefreshStatus = () => {
    setGithubBusy(true);
    setActionError(null);
    window.ade.github
      .getStatus({ forceRefresh: true }, pin)
      .then((status) => setGithubStatus(status))
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGithubBusy(false));
  };

  const tokenAuthenticated = Boolean(githubStatus?.tokenStored && githubStatus?.userLogin);
  const isConnected = Boolean(githubStatus?.connected);
  const credentialPresentation = githubCredentialPresentation(githubStatus);
  const permissionMode = credentialPresentation.permissionMode;
  const isFineGrainedToken = githubStatus?.tokenType === "fine-grained";
  const authFailure = githubStatus?.authFailure ?? null;
  const authFailurePresentation = githubStatus ? describeGithubAuthFailure(githubStatus) : null;
  const credentialFallback = githubStatus?.credentialFallback ?? null;
  const credentialStates = githubStatus?.credentialStates ?? [];
  const activeReadCredential = credentialStates.find((credential) => credential.activeFor.includes("read")) ?? null;
  const effectiveWriteAuthSource = githubStatus?.writeAuthSource
    ?? (githubStatus?.authSource && githubStatus.authSource !== "app" ? githubStatus.authSource : "none");
  const backgroundPausedUntil = formatGithubShortTime(githubStatus?.backgroundRefreshPausedUntil);
  const appAccount = appAuth
    ? { state: deriveGithubAccountAuthState(appAuth), blockedUntil: appAuth.refreshBlockedUntil ?? null }
    : null;
  // The ladder's own retryAt is often absent for the App, because the pause
  // lives in the credential's refresh ledger rather than in the request budget.
  // Show that deadline instead of leaving the sentence open-ended.
  const credentialFallbackRetryAt = formatGithubShortTime(
    credentialFallback?.retryAt
      ?? (credentialFallback?.fromSource === "app" ? appAccount?.blockedUntil : null),
  );
  const hasInspectableScopes = credentialPresentation.hasInspectableScopes;
  const accessState = getGitHubTokenAccessState(githubStatus?.scopes ?? []);
  const repoProbeFailed = tokenAuthenticated && githubStatus?.repoAccessOk === false;
  const hasMissingScopes = permissionMode === "scopes"
    && tokenAuthenticated
    && hasInspectableScopes
    && !accessState.hasRequiredAccess;
  let readsWithLabel = authSourceLabel(githubStatus);
  if (authFailure?.kind === "rate_limited") readsWithLabel = "Paused";
  if (activeReadCredential) readsWithLabel = credentialSourceLabel(activeReadCredential.source);
  // An unreadable credential store empties every stored-credential signal below
  // it, so "Not connected" here would be a guess drawn from credentials ADE
  // could not read. Say what is actually true instead.
  const credentialStoreUnreadable = githubStatus?.credentialStoreUnreadable === true;
  // A corroborated GitHub outage explains every red state on this card. While
  // one is active the card stops reading as "your setup is broken": the chip
  // goes neutral, the ladder's failure badges are held back, and the gh-auth
  // instructions are hidden so nobody re-runs `gh auth login` and replaces a
  // credential that was working fine.
  const outage = describeGithubOutage(githubStatus);
  let statusTone: StatusTone;
  let statusLabel: string;
  // Unreadable store first, ahead of the outage: it is a LOCAL fact with a
  // repair control two clicks away, and it stays true after GitHub recovers.
  // An outage is transient and has no action; letting it mask the one state
  // the user can actually fix would hide the fix for the duration of someone
  // else's incident.
  if (credentialStoreUnreadable) {
    statusTone = "warn";
    statusLabel = GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.statusLabel;
  } else if (outage) {
    statusTone = "neutral";
    statusLabel = outage.statusLabel;
  } else if (isConnected && credentialFallback) {
    statusTone = "warn";
    statusLabel = "Connected · fallback";
  } else if (isConnected) {
    statusTone = "ok";
    statusLabel = "Connected";
  } else if (authFailurePresentation) {
    statusTone = "warn";
    statusLabel = authFailurePresentation.statusLabel;
  } else if (tokenAuthenticated) {
    statusTone = "warn";
    statusLabel = "Needs permission";
  } else {
    statusTone = "neutral";
    statusLabel = "Not connected";
  }
  const ghAuthAlreadyConfigured =
    githubStatus?.tokenStored === true
    && githubStatus.authSource === "gh"
    && authFailure?.kind !== "invalid_token";
  const ghCommand = transcriptGistsEnabled
    ? ghAuthAlreadyConfigured ? GH_AUTH_REFRESH_WITH_GIST_COMMAND : GH_AUTH_LOGIN_WITH_GIST_COMMAND
    : ghAuthAlreadyConfigured ? GH_AUTH_REFRESH_COMMAND : GH_AUTH_LOGIN_COMMAND;
  const shouldShowGhAuthInstructions =
    githubStatus != null
    && !isConnected
    && githubStatus.authSource !== "pat"
    // Nothing here is worth reading while the store is unreadable: the setup
    // steps would be answering a question ADE has not actually asked.
    && !credentialStoreUnreadable
    && (
      // A missing token is a local fact that an outage cannot explain away, so
      // that one instruction still stands. The other two are inferred from
      // GitHub's answers and are unreliable while GitHub is failing.
      !githubStatus.tokenStored
      || (!outage && (authFailure?.kind === "invalid_token" || hasMissingScopes))
    );
  const classicTokenUrl = transcriptGistsEnabled ? GITHUB_CLASSIC_TOKEN_WITH_GIST_NEW_URL : GITHUB_CLASSIC_TOKEN_NEW_URL;
  const openExternal = (url: string) => {
    void window.ade.app.openExternal(url);
  };

  const tag = (tone: StatusTone, label: string) => (
    <span className="kit-tag" data-tone={tone === "neutral" ? undefined : tone}>{label}</span>
  );
  const repoName = githubStatus?.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : null;
  const readsWith = outage && !activeReadCredential ? "Unknown" : readsWithLabel;
  // While GitHub is down ADE can't resolve which credential would win, so it
  // reports the honest "Unknown" rather than the false-negative "Not connected".
  const writesWith = outage && effectiveWriteAuthSource === "none"
    ? "Unknown"
    : credentialSourceLabel(effectiveWriteAuthSource);

  return (
    <div className="ade-int-page">
      {saveNotice ? (
        <Banner layout="inline" model={{ id: "github-save-notice", tone: "success", title: saveNotice }} />
      ) : null}
      {actionError ? (
        <Banner layout="inline" model={{ id: "github-action-error", tone: "error", title: actionError }} />
      ) : null}

      <ModernSection
        group="GitHub"
        anchor="github-connection"
        title="Connection"
        hint={
          embedded
            ? "Sign in with the GitHub CLI or a personal access token."
            : "Authenticate with GitHub CLI or a personal access token, and install ADE for GitHub for webhook-backed PR updates."
        }
        actions={(
          <>
            <button type="button" className="ade-modern-btn" data-variant="ghost" disabled={githubBusy} onClick={handleRefreshStatus}>
              <ArrowsClockwise size={12} weight="bold" /> Refresh
            </button>
            {githubStatus?.patTokenStored ? (
              <button type="button" className="ade-modern-btn" disabled={githubBusy} onClick={handleClearToken}>
                <LinkBreak size={12} weight="bold" /> Clear PAT
              </button>
            ) : null}
            <button type="button" className="ade-modern-btn" disabled={githubBusy} onClick={() => setShowPatSetup((value) => !value)}>
              <Key size={12} weight="bold" /> {showPatSetup ? "Hide PAT setup" : githubStatus?.patTokenStored ? "Replace PAT" : "Use PAT instead"}
            </button>
          </>
        )}
      >
        <div className="ade-modern-rows">
          <div className="ade-int-hero">
            <span className="ade-int-logo" aria-hidden><GithubLogo size={20} weight="fill" /></span>
            <div className="ade-int-hero-id">
              <span className="ade-int-hero-name">{githubStatus?.userLogin ?? (githubStatus ? "Not signed in" : "Checking…")}</span>
              <span className="ade-int-hero-sub">{repoName ?? "No GitHub repository detected"}</span>
            </div>
            {githubStatus ? tag(statusTone, statusLabel) : null}
          </div>
          <div className="ade-int-facts">
            <div className="ade-int-fact">
              <span className="ade-int-fact-label">Reads with</span>
              <span className="ade-int-fact-value">{readsWith}</span>
            </div>
            <div className="ade-int-fact">
              <span className="ade-int-fact-label">Writes with</span>
              <span className="ade-int-fact-value">{writesWith}</span>
            </div>
          </div>
        </div>

        {credentialStoreUnreadable ? (
          <Banner
            layout="inline"
            model={{
              id: "github-credential-store-unreadable",
              tone: "warning",
              title: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.title,
              detail: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.detail,
              actions: [
                {
                  label: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.action,
                  onClick: () => openConnectionsPanel("machines"),
                },
              ],
            }}
          />
        ) : null}

        {credentialFallback ? (
          <Banner
            layout="inline"
            model={{
              id: "github-credential-fallback",
              tone: "warning",
              title: (
                <span style={{ fontWeight: 500 }}>
                  <strong>{credentialSourceLabel(credentialFallback.fromSource)}</strong> is temporarily unavailable. ADE is using{" "}
                  <strong>{credentialSourceLabel(credentialFallback.toSource)}</strong> and will try the preferred connection again automatically
                  {credentialFallbackRetryAt ? ` after ${credentialFallbackRetryAt}` : ""}.
                </span>
              ),
            }}
          />
        ) : null}

        {!credentialFallback && backgroundPausedUntil && authFailure?.kind !== "rate_limited" ? (
          <Banner
            layout="inline"
            model={{
              id: "github-background-paused",
              tone: "warning",
              title: (
                <span style={{ fontWeight: 500 }}>
                  Real-time updates remain on. ADE paused background catch-up until {backgroundPausedUntil} to protect GitHub access for your own actions.
                </span>
              ),
            }}
          />
        ) : null}

        {shouldShowGhAuthInstructions ? (
          <Banner
            layout="inline"
            model={{
              id: "github-cli-auth-instructions",
              tone: "warning",
              icon: <TerminalWindow size={15} weight="duotone" />,
              title: "GitHub CLI auth",
              detail: githubStatus?.ghAuthError
                ? githubStatus.ghAuthError
                : "Run this command in Terminal, then refresh this panel.",
              extra: <code className="ade-int-command">{ghCommand}</code>,
            }}
          />
        ) : null}
      </ModernSection>

      {showPatSetup ? (
        <ModernSection
          group="GitHub"
          title="Personal access token"
          hint="Optional. Use it when you cannot or do not want to use GitHub CLI auth on this machine."
        >
          <div className="ade-int-token-grid">
            <div className="ade-int-token-card">
              <div className="ade-int-token-head">
                <Shield size={16} weight="duotone" />
                <span>Classic token</span>
              </div>
              <p className="ade-int-quiet">Generate a classic token with repo and workflow scopes.</p>
              <div className="ade-int-chip-row">
                {REQUIRED_GITHUB_CLASSIC_SCOPES.map((scope) => (
                  <span key={scope} className="kit-tag">{scope}</span>
                ))}
              </div>
              <div className="ade-int-btn-row">
                <button type="button" className="ade-modern-btn" onClick={() => openExternal(classicTokenUrl)}>
                  <ArrowSquareOut size={12} weight="bold" /> Create classic token
                </button>
                <button type="button" className="ade-modern-btn" data-variant="ghost" onClick={() => openExternal(GITHUB_CLASSIC_TOKENS_URL)}>
                  Manage tokens
                </button>
              </div>
            </div>

            <div className="ade-int-token-card">
              <div className="ade-int-token-head">
                <ShieldCheck size={16} weight="duotone" />
                <span>Fine-grained token</span>
              </div>
              <p className="ade-int-quiet">Include this repository and grant the permissions below.</p>
              <div className="ade-int-chip-row">
                {REQUIRED_GITHUB_REPOSITORY_PERMISSIONS.map((perm) => (
                  <span key={perm} className="kit-tag">{perm}</span>
                ))}
              </div>
              <div className="ade-int-btn-row">
                <button type="button" className="ade-modern-btn" onClick={() => openExternal(GITHUB_FINE_GRAINED_TOKEN_NEW_URL)}>
                  <ArrowSquareOut size={12} weight="bold" /> Create fine-grained token
                </button>
                <button type="button" className="ade-modern-btn" data-variant="ghost" onClick={() => openExternal(GITHUB_FINE_GRAINED_TOKENS_URL)}>
                  Manage tokens
                </button>
              </div>
            </div>
          </div>

          <div className="ade-ap-rowcard" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="ade-ap-rowtitle">Token</span>
              <SettingsTextField
                type="password"
                value={githubTokenDraft}
                onChange={setGithubTokenDraft}
                placeholder="ghp_... or github_pat_..."
                mono
              />
              {githubTokenDraft.trim() ? (
                <span className="ade-int-quiet">
                  Detected: {tokenTypeDetectionLabel(detectTokenType(githubTokenDraft.trim()))}
                </span>
              ) : null}
            </label>
            <div className="ade-int-btn-row">
              <button type="button" className="ade-modern-btn" data-tone="primary" disabled={githubBusy} onClick={handleSaveToken}>
                <Key size={12} weight="bold" /> {githubBusy ? "Saving..." : "Save token"}
              </button>
              <button type="button" className="ade-modern-btn" disabled={githubBusy} onClick={handleRefreshStatus}>
                <ArrowsClockwise size={12} weight="bold" /> Check status
              </button>
            </div>
          </div>
        </ModernSection>
      ) : null}

      <GitHubAppInstallPanel pin={pin} />

      {credentialStates.length > 0 ? (
        <ModernSection
          group="GitHub"
          title="Access order"
          hint="ADE uses the first working connection. Reads can use the GitHub App; writes skip it and use the first connection that can write."
        >
          <div className="ade-modern-rows">
            {credentialStates.map((credential, index) => {
              const badge = credentialStateBadge(credential, outage != null, appAccount);
              return (
                <div key={credential.source} className="ade-int-order-row">
                  <span className="ade-int-order-num kit-num">{index + 1}</span>
                  <span className="ade-int-order-name">{credentialSourceLabel(credential.source)}</span>
                  <span className="ade-int-order-cap">
                    {credential.capabilities.length === 1 ? "Read-only" : "Read and write"}
                  </span>
                  {tag(badge.tone, badge.label)}
                </div>
              );
            })}
          </div>
        </ModernSection>
      ) : null}

      <ModernSection
        group="GitHub"
        // The model names the heading in capitals; the page reads in sentence case.
        title={sentenceCase(credentialPresentation.permissionHeading)}
        hint="Pull requests, reviews, CI re-runs and branch pushes all need this access. GitHub CLI and PAT auth need the same."
      >
        {permissionMode === "auth-failure" ? (
          <Banner
            layout="inline"
            model={{
              id: "github-auth-failure",
              // Neutral during an outage: a warning tone implies the user has
              // something to fix, and they don't.
              tone: outage ? "neutral" : "warning",
              title: authFailurePresentation?.title ?? "",
              detail: authFailurePresentation?.settingsDetail,
              actions: outage
                ? [
                    {
                      label: "GitHub status",
                      icon: <ArrowSquareOut size={12} />,
                      onClick: () => openExternal(outage.actionUrl),
                    },
                  ]
                : undefined,
            }}
          />
        ) : permissionMode === "app" ? (
          <div className="ade-modern-rows">
            <div className="ade-int-perm-row">
              <span className="ade-int-perm-icon" data-tone={githubStatus?.repoAccessOk === true ? "ok" : undefined}>
                <ShieldCheck size={14} weight="fill" />
              </span>
              <span className="ade-int-perm-name">{credentialPresentation.repoAccessLabel}</span>
            </div>
            <p className="ade-int-note">
              The ADE GitHub App is read-only. ADE uses it for pull request data and real-time updates, then uses GitHub CLI or a personal access token for actions that change GitHub.
            </p>
          </div>
        ) : permissionMode === "fine-grained" ? (
          <div className="ade-modern-rows">
            <div className="ade-int-perm-list">
              {REQUIRED_GITHUB_REPOSITORY_PERMISSIONS.map((permission) => (
                <span key={permission} className="ade-int-perm-item">
                  <ShieldCheck size={13} weight="fill" />
                  {permission}
                </span>
              ))}
            </div>
            <p className="ade-int-note">
              GitHub does not expose fine-grained PAT permissions through OAuth scope headers. ADE verifies repo access directly when an active GitHub remote is available.
            </p>
          </div>
        ) : (
          <div className="ade-modern-rows">
            <div className="ade-int-perm-list">
              {REQUIRED_GITHUB_CLASSIC_SCOPES.map((scope) => {
                const present = accessState.requirements[scope].present;
                return (
                  <span key={scope} className="ade-int-perm-item" data-tone={present ? "ok" : "warn"}>
                    {present ? <CheckCircle size={13} weight="fill" /> : <Warning size={13} weight="fill" />}
                    <span className="ade-int-mono">{scope}</span>
                  </span>
                );
              })}
            </div>
            <div className="ade-int-scope-row">
              <span className="ade-int-fact-label">Granted</span>
              {accessState.normalizedScopes.length > 0 ? accessState.normalizedScopes.map((scope) => (
                <span key={scope} className="kit-tag">{scope}</span>
              )) : (
                <span className="ade-int-quiet">No OAuth scopes detected yet.</span>
              )}
            </div>
          </div>
        )}

        {hasMissingScopes ? (
          <Banner
            layout="inline"
            model={{
              id: "github-missing-scopes",
              tone: "error",
              title: (
                <>
                  Missing required {accessState.usesFineGrainedPermissions ? "permissions" : "scopes"}: {accessState.missingDescriptions.join(", ")}.
                </>
              ),
            }}
          />
        ) : null}

        {repoProbeFailed ? (
          <Banner
            layout="inline"
            model={{
              id: "github-repo-probe",
              tone: "error",
              title: (
                <span style={{ fontWeight: 500 }}>
                  Token authenticated as <strong>{githubStatus?.userLogin}</strong>, but cannot access{" "}
                  <strong>{repoName ?? "this repo"}</strong>
                  {githubStatus?.repoAccessError ? ` (${githubStatus.repoAccessError})` : ""}.
                  {isFineGrainedToken ? (
                    <> Add this repository to the fine-grained token and grant Contents, Pull requests, Metadata, Actions, and Workflows permissions.</>
                  ) : (
                    <> Make sure the token has access to this repository.</>
                  )}
                </span>
              ),
            }}
          />
        ) : null}

        <div className="ade-int-uses">
          {PERMISSION_USES.map((use) => (
            <div key={use.title} className="ade-int-use-row">
              <span className="ade-modern-glyph" aria-hidden>{use.icon}</span>
              <div style={{ minWidth: 0 }}>
                <div className="ade-ap-rowtitle">{use.title}</div>
                <div className="ade-ap-rowhint">{use.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </ModernSection>

    </div>
  );
}
