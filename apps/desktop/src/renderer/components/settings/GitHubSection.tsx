import React, { useEffect, useRef, useState } from "react";
import { issueWriteSourceLabel } from "../../../shared/githubOperationCredential";
import type { GitHubCredentialState, GitHubStatus } from "../../../shared/types";
import {
  CheckCircle,
  Warning,
  ArrowClockwise,
  Key,
  ArrowSquareOut,
  TerminalWindow,
  CaretDown,
  Code,
  WebhooksLogo,
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
  describeGitTransportFailure,
  gitTransportPushesWithLabel,
  GH_AUTH_LOGIN_COMMAND,
  type GithubAccountAuthState,
} from "../../lib/githubIntegrationStatus";
import { useGithubAppUserAuth } from "../../lib/useGithubAppUserAuth";
import { GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY } from "../../../shared/types";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { SettingsTextField } from "./primitives";
import {
  IntegrationCard,
  IntegrationColumns,
  IntegrationHero,
  IntegrationPage,
  type IntegrationFact,
} from "./integrations/IntegrationChrome";
import { setIssueTopBarVisible, useIssueTopBarPreferences } from "../issues/issueTopBarPreferences";
import { useGitHubIssueWriteAccess, useProjectGitHubRepo } from "../issues/githubIssueStore";
import type { GitHubIssueWriteAccess } from "../../../shared/types";

/** One line on which credential edits issues here, and what would change it. */
function issueAccessHint(access: GitHubIssueWriteAccess): string {
  const via = issueWriteSourceLabel(access.writeSource);
  if (access.app?.needsApproval) {
    return via
      ? `Edits go through ${via}. Approve the Issues permission for ADE for GitHub to edit with the app.`
      : "Approve the Issues permission for ADE for GitHub on GitHub before ADE can edit issues.";
  }
  return via ? `Edits go through ${via}.` : "Sign in with the GitHub CLI or a token to edit issues.";
}
import { useSettingsMachineScope } from "./SettingsMachineScope";
import "./IntegrationsSettings.css";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";

type TokenType = "classic" | "fine-grained" | "unknown";

const GH_AUTH_REFRESH_COMMAND = "gh auth refresh -h github.com -s repo -s workflow";
const GH_AUTH_LOGIN_WITH_GIST_COMMAND = "gh auth login -h github.com -s repo -s workflow -s gist";
const GH_AUTH_REFRESH_WITH_GIST_COMMAND = "gh auth refresh -h github.com -s repo -s workflow -s gist";
const GITHUB_CLASSIC_TOKEN_NEW_URL = "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow";
const GITHUB_CLASSIC_TOKEN_WITH_GIST_NEW_URL = "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow,gist";
const GITHUB_FINE_GRAINED_TOKEN_NEW_URL = "https://github.com/settings/personal-access-tokens/new?name=ADE&description=ADE%20desktop%20PR%20workflows&contents=write&pull_requests=write&metadata=read&actions=write&checks=write&statuses=read&workflows=write";

const REQUIRED_GITHUB_REPOSITORY_PERMISSIONS = [
  "Contents: Read and write",
  "Pull requests: Read and write",
  "Metadata: Read",
  "Actions: Read and write",
  "Checks: Read and write",
  "Commit statuses: Read",
  "Workflows: Write",
] as const;


function detectTokenType(token: string): TokenType {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  return "unknown";
}

function tokenTypeDetectionLabel(type: TokenType): string {
  switch (type) {
    case "classic":
      return "Looks like a classic token";
    case "fine-grained":
      return "Looks like a fine-grained token";
    default:
      return "Not a format ADE recognizes; it will still try it";
  }
}

function credentialSourceLabel(source: GitHubStatus["authSource"] | undefined): string {
  switch (source) {
    case "app":
      return "ADE for GitHub";
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

/** Where a sign-in comes from, in a few words. */
function credentialSourceDetail(source: GitHubStatus["authSource"] | undefined): string {
  switch (source) {
    case "app":
      return "ADE's GitHub app";
    case "gh":
      return "Your gh auth login";
    case "pat":
      return "Saved in ADE on this machine";
    case "environment":
      return "GITHUB_TOKEN or GH_TOKEN variable";
    default:
      return "";
  }
}

function credentialSourceIcon(source: GitHubStatus["authSource"] | undefined) {
  switch (source) {
    case "app":
      return <WebhooksLogo size={15} weight="duotone" />;
    case "gh":
      return <TerminalWindow size={15} weight="duotone" />;
    case "pat":
      return <Key size={15} weight="duotone" />;
    default:
      return <Code size={15} weight="bold" />;
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

export function GitHubSection() {
  const issueTopBar = useIssueTopBarPreferences();
  const { repo: issueRepo } = useProjectGitHubRepo();
  const issueAccess = useGitHubIssueWriteAccess(issueRepo);
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

  // A credential can change while this page stays open (gh logs out, a token
  // is saved elsewhere), so read the status again when ADE comes back to the
  // front and when any surface reports a change. The reads are cached in the
  // main process for 30 seconds, so this costs little.
  const pinRef = useRef(pin);
  pinRef.current = pin;
  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      window.ade.github
        .getStatus(undefined, pinRef.current)
        .then((status) => {
          if (!cancelled) setGithubStatus(status);
        })
        .catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisibility);
    const offStatus = window.ade.github.onStatusChanged?.(() => reload()) ?? (() => {});
    return () => {
      cancelled = true;
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisibility);
      offStatus();
    };
  }, [pin?.key]);

  const handleSaveToken = () => {
    const token = githubTokenDraft.trim();
    if (!token) {
      setActionError("Paste a token first.");
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
      .catch((err) => setActionError(extractError(err)))
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
        setSaveNotice(status.authSource === "gh" ? "Token removed. ADE is using your GitHub CLI sign-in." : "Token removed.");
      })
      .catch((err) => setActionError(extractError(err)))
      .finally(() => setGithubBusy(false));
  };

  const handleRefreshStatus = () => {
    setGithubBusy(true);
    setActionError(null);
    window.ade.github
      .getStatus({ forceRefresh: true }, pin)
      .then((status) => setGithubStatus(status))
      .catch((err) => setActionError(extractError(err)))
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
  // An older remote runtime reports no credential chain. The token row still
  // has to be there, since it is where a token is added, replaced or removed.
  const signInRows: GitHubCredentialState[] = githubStatus && !credentialStates.some((credential) => credential.source === "pat")
    ? [...credentialStates, {
      source: "pat",
      available: githubStatus.tokenStored === true,
      capabilities: ["read", "write"],
      activeFor: [],
      state: githubStatus.tokenStored ? "ready" : "unavailable",
      failure: null,
      rateLimit: null,
    }]
    : credentialStates;
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
  } else if (isConnected && describeGitTransportFailure(githubStatus)) {
    // Pull requests load, but nothing can be pushed: green "Connected" would
    // be the half-truth this card used to tell.
    statusTone = "warn";
    statusLabel = "Connected · can't push";
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
  // Name the writer only when its credential is really there: a gh login that
  // lost its token must not read as "GitHub CLI".
  const writeCredentialState = credentialStates.find((credential) => credential.source === effectiveWriteAuthSource) ?? null;
  const writeCredentialMissing = writeCredentialState != null && !writeCredentialState.available;
  const writesWith = outage && effectiveWriteAuthSource === "none"
    ? "Unknown"
    : writeCredentialMissing
      ? `${credentialSourceLabel(effectiveWriteAuthSource)} · signed out`
      : credentialSourceLabel(effectiveWriteAuthSource);
  const pushesWith = gitTransportPushesWithLabel(githubStatus, credentialSourceLabel(effectiveWriteAuthSource));
  const gitTransportFailure = outage ? null : describeGitTransportFailure(githubStatus);

  const issueAccessLabel = !issueAccess
    ? null
    : issueAccess.app?.needsApproval && !issueAccess.writeSource
      ? "Needs approval"
      : issueAccess.writeSource ? "Can edit" : "Read-only";
  const heroFacts: IntegrationFact[] = [
    { label: "Repository", value: repoName ?? (githubStatus ? "None found" : "…"), mono: Boolean(repoName) },
    { label: "Reads with", value: githubStatus ? readsWith : "…" },
    { label: "Changes with", value: githubStatus ? writesWith : "…", tone: writeCredentialMissing ? "warn" : undefined },
    ...(gitTransportFailure && pushesWith
      ? [{
          label: "Pushes with",
          value: pushesWith,
          tone: "warn" as const,
          title: "Git signs in on its own for push, pull and fetch. When this computer has no git sign-in, ADE lends git its GitHub credential.",
        }]
      : []),
    ...(issueAccessLabel
      ? [{ label: "Issues", value: issueAccessLabel, tone: issueAccessLabel === "Needs approval" ? "warn" as const : undefined, title: issueAccess ? issueAccessHint(issueAccess) : undefined }]
      : []),
  ];
  const login = githubStatus?.userLogin ?? null;
  const activeWriteSource = credentialStates.find((credential) => credential.activeFor.includes("write"))?.source ?? null;

  const tokenForm = (
    <div className="ade-ig-method-extra">
      <div className="ade-ig-choice">
        <div className="ade-ig-choice-head">
          <b>1. Create a token on GitHub</b>
        </div>
        <p>
          Classic tokens need {REQUIRED_GITHUB_CLASSIC_SCOPES.map((scope, index) => (
            <React.Fragment key={scope}>{index ? " and " : ""}<code className="ade-ig-mono">{scope}</code></React.Fragment>
          ))}. Fine-grained tokens must include this repository; both links fill in the permissions for you.
        </p>
        <div className="ade-ig-step-actions" style={{ marginTop: 0 }}>
          <button type="button" className="ade-modern-btn" data-tone="primary" onClick={() => openExternal(classicTokenUrl)}>
            <ArrowSquareOut size={12} weight="bold" /> Classic token
          </button>
          <button type="button" className="ade-modern-btn" onClick={() => openExternal(GITHUB_FINE_GRAINED_TOKEN_NEW_URL)}>
            <ArrowSquareOut size={12} weight="bold" /> Fine-grained token
          </button>
        </div>
        <details className="ade-linear-link">
          <summary className="ade-ig-note">
            All fine-grained permissions <CaretDown size={11} className="ade-linear-links-caret" />
          </summary>
          <div className="ade-ig-chips" style={{ marginTop: 8 }}>
            {REQUIRED_GITHUB_REPOSITORY_PERMISSIONS.map((perm) => (
              <span key={perm} className="kit-tag">{perm}</span>
            ))}
          </div>
        </details>
      </div>
      <div className="ade-ig-choice">
        <div className="ade-ig-choice-head"><b>2. Paste it here</b></div>
        <div className="ade-ig-form-row">
          <SettingsTextField
            type="password"
            value={githubTokenDraft}
            onChange={setGithubTokenDraft}
            placeholder="ghp_… or github_pat_…"
            ariaLabel="GitHub personal access token"
            mono
          />
          <button type="button" className="ade-modern-btn" data-tone="primary" disabled={githubBusy || !githubTokenDraft.trim()} onClick={handleSaveToken}>
            {githubBusy ? "Saving…" : "Save"}
          </button>
        </div>
        {githubTokenDraft.trim() ? (
          <span className="ade-ig-note">{tokenTypeDetectionLabel(detectTokenType(githubTokenDraft.trim()))}</span>
        ) : null}
      </div>
    </div>
  );

  // The scopes a classic token or the CLI login grants, under the row that has them.
  const scopeChips = permissionMode === "scopes" && tokenAuthenticated ? (
    <div className="ade-ig-method-extra">
      <div className="ade-ig-chips">
        {REQUIRED_GITHUB_CLASSIC_SCOPES.map((scope) => {
          const present = accessState.requirements[scope].present;
          return (
            <span key={scope} className="kit-tag" data-tone={present ? "ok" : "warn"}>
              {present ? <CheckCircle size={11} weight="fill" /> : <Warning size={11} weight="fill" />} {scope}
            </span>
          );
        })}
      </div>
    </div>
  ) : permissionMode === "fine-grained" && tokenAuthenticated ? (
    <div className="ade-ig-method-extra">
      <span className="ade-ig-note">GitHub doesn&rsquo;t list a fine-grained token&rsquo;s permissions, so ADE checks the repository directly.</span>
    </div>
  ) : null;

  return (
    <IntegrationPage id="github">
      <IntegrationHero
        id="github"
        status={githubStatus ? { tone: statusTone, label: statusLabel } : { tone: "checking", label: "Checking…" }}
        account={login ? {
          avatar: login.charAt(0).toUpperCase(),
          title: `@${login}`,
          detail: `with ${credentialSourceLabel(effectiveWriteAuthSource === "none" ? githubStatus?.authSource : effectiveWriteAuthSource)}`,
        } : null}
        actions={(
          <button type="button" className="ade-modern-btn" data-size="sm" disabled={githubBusy} onClick={handleRefreshStatus}>
            <ArrowClockwise size={12} className={githubBusy ? "ade-icon-spin" : undefined} /> Check again
          </button>
        )}
        facts={heroFacts}
        topBar={{
          label: "GitHub issues",
          checked: issueTopBar.github,
          onChange: (next) => setIssueTopBarVisible("github", next),
          anchor: "github-issues-top-bar",
        }}
      />

      <div className="ade-ig-alerts">
        {saveNotice ? (
          <Banner layout="inline" model={{ id: "github-save-notice", tone: "success", title: saveNotice }} />
        ) : null}
        {actionError ? (
          <Banner layout="inline" model={{ id: "github-action-error", tone: "error", title: actionError }} />
        ) : null}
        {credentialStoreUnreadable ? (
          <Banner
            layout="inline"
            model={{
              id: "github-credential-store-unreadable",
              tone: "warning",
              title: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.title,
              detail: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.detail,
              actions: [{ label: GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.action, onClick: () => openConnectionsPanel("machines") }],
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
                  <strong>{credentialSourceLabel(credentialFallback.fromSource)}</strong> isn&rsquo;t answering, so ADE is using{" "}
                  <strong>{credentialSourceLabel(credentialFallback.toSource)}</strong> for now. It switches back on its own
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
                  Live updates are still on. Background refreshes are paused until {backgroundPausedUntil}, so GitHub keeps answering your own actions.
                </span>
              ),
            }}
          />
        ) : null}
        {gitTransportFailure && !shouldShowGhAuthInstructions ? (
          <Banner
            layout="inline"
            model={{
              id: "github-git-transport",
              tone: "warning",
              icon: <TerminalWindow size={15} weight="duotone" />,
              title: gitTransportFailure.title,
              detail: gitTransportFailure.settingsDetail,
              extra: gitTransportFailure.signInFixes ? <code className="ade-int-command">{GH_AUTH_LOGIN_COMMAND}</code> : undefined,
              actions: [{ label: "Check again", variant: "primary", onClick: handleRefreshStatus, busy: githubBusy }],
            }}
          />
        ) : null}
        {permissionMode === "auth-failure" && authFailurePresentation ? (
          <Banner
            layout="inline"
            model={{
              id: "github-auth-failure",
              // Neutral during an outage: a warning tone implies the user has
              // something to fix, and they don't.
              tone: outage ? "neutral" : "warning",
              title: authFailurePresentation.title,
              detail: authFailurePresentation.settingsDetail,
              actions: outage
                ? [{ label: "GitHub status", icon: <ArrowSquareOut size={12} />, onClick: () => openExternal(outage.actionUrl) }]
                : undefined,
            }}
          />
        ) : null}
        {hasMissingScopes ? (
          <Banner
            layout="inline"
            model={{
              id: "github-missing-scopes",
              tone: "error",
              // The token's scopes are the person's to fix, not a failure to report.
              report: false,
              title: <>Missing {accessState.usesFineGrainedPermissions ? "permissions" : "scopes"}: {accessState.missingDescriptions.join(", ")}.</>,
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
                  Signed in as <strong>{githubStatus?.userLogin}</strong>, but that account can&rsquo;t reach{" "}
                  <strong>{repoName ?? "this repository"}</strong>
                  {githubStatus?.repoAccessError ? ` (${githubStatus.repoAccessError})` : ""}.
                  {isFineGrainedToken ? <> Add the repository to the token.</> : <> Check that the token can see this repository.</>}
                </span>
              ),
            }}
          />
        ) : null}
        {issueAccess?.app?.needsApproval && issueAccess.app.manageUrl ? (
          <Banner
            layout="inline"
            model={{
              id: "github-issues-approval",
              tone: "neutral",
              title: "Approve the Issues permission for ADE for GitHub",
              detail: issueAccessHint(issueAccess),
              actions: [{
                label: "Approve on GitHub",
                icon: <ArrowSquareOut size={12} />,
                onClick: () => {
                  const url = issueAccess.app?.manageUrl;
                  if (url) void window.ade?.app?.openExternal?.(url);
                },
              }],
            }}
          />
        ) : null}
      </div>

      <IntegrationColumns>
        <IntegrationCard
          anchor="github-connection"
          icon={<Key size={16} weight="duotone" />}
          title="Your sign-in"
          hint="ADE uses the first of these that works. Changes to GitHub go through one that can write."
        >
          {shouldShowGhAuthInstructions ? (
            <div className="ade-ig-choice" data-primary="true">
              <div className="ade-ig-choice-head">
                <TerminalWindow size={16} weight="duotone" />
                <b>Sign in with the GitHub CLI</b>
                <span className="kit-tag">Recommended</span>
              </div>
              <p>{githubStatus?.ghAuthError ? githubStatus.ghAuthError : "Run this in a terminal, then press Check again."}</p>
              <code className="ade-int-command" style={{ marginTop: 0 }}>{ghCommand}</code>
            </div>
          ) : null}
          <div className="ade-ig-rows" style={{ marginBottom: -18 }}>
            {signInRows.length === 0 ? (
              <div className="ade-ig-row"><span className="ade-ig-note">Checking sign-ins…</span></div>
            ) : signInRows.map((credential) => {
              const badge = credentialStateBadge(credential, outage != null, appAccount);
              const isPat = credential.source === "pat";
              const active = credential.activeFor.length > 0;
              return (
                <div key={credential.source} className="ade-ig-method" data-active={active ? "true" : undefined}>
                  <span className="ade-ig-method-icon" aria-hidden>{credentialSourceIcon(credential.source)}</span>
                  <span className="ade-ig-method-name">
                    <b>{credentialSourceLabel(credential.source)}</b>
                    <small>
                      {credential.source === "app" ? "Reads only · set up on the right" : credentialSourceDetail(credential.source)}
                    </small>
                  </span>
                  <span className="ade-ig-method-side">
                    {isPat && githubStatus?.patTokenStored ? (
                      <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={githubBusy} onClick={handleClearToken}>
                        Remove
                      </button>
                    ) : null}
                    {isPat ? (
                      <button type="button" className="ade-modern-btn" data-size="sm" disabled={githubBusy} onClick={() => setShowPatSetup((value) => !value)}>
                        {showPatSetup ? "Cancel" : githubStatus?.patTokenStored ? "Replace" : "Add token"}
                      </button>
                    ) : null}
                    {tag(badge.tone, badge.label)}
                  </span>
                  {isPat && showPatSetup ? tokenForm : null}
                  {credential.source === activeWriteSource && !(isPat && showPatSetup) ? scopeChips : null}
                </div>
              );
            })}
          </div>
        </IntegrationCard>

        <GitHubAppInstallPanel pin={pin} />
      </IntegrationColumns>
    </IntegrationPage>
  );
}
