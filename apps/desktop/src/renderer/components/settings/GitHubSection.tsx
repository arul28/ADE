import { useEffect, useState, type CSSProperties } from "react";
import type { GitHubStatus, ProjectConfigSnapshot } from "../../../shared/types";
import {
  GithubLogo,
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
} from "@phosphor-icons/react";
import { getGitHubTokenAccessState, REQUIRED_GITHUB_CLASSIC_SCOPES } from "../../../shared/githubScopes";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, LABEL_STYLE, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

type TokenType = "classic" | "fine-grained" | "unknown";

const GH_AUTH_LOGIN_COMMAND = "gh auth login -h github.com -s repo -s workflow";
const GH_AUTH_REFRESH_COMMAND = "gh auth refresh -h github.com -s repo -s workflow";
const GH_AUTH_LOGIN_WITH_GIST_COMMAND = "gh auth login -h github.com -s repo -s workflow -s gist";
const GH_AUTH_REFRESH_WITH_GIST_COMMAND = "gh auth refresh -h github.com -s repo -s workflow -s gist";
const GITHUB_CLASSIC_TOKEN_NEW_URL = "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow";
const GITHUB_CLASSIC_TOKEN_WITH_GIST_NEW_URL = "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow,gist";
const GITHUB_CLASSIC_TOKENS_URL = "https://github.com/settings/tokens";
const GITHUB_FINE_GRAINED_TOKEN_NEW_URL = "https://github.com/settings/personal-access-tokens/new?name=ADE&description=ADE%20desktop%20PR%20workflows&contents=write&pull_requests=write&metadata=read&actions=write&workflows=write";
const GITHUB_FINE_GRAINED_TOKENS_URL = "https://github.com/settings/personal-access-tokens";

const REQUIRED_GITHUB_FINE_GRAINED_PERMISSIONS = [
  "Contents: Read and write",
  "Pull requests: Read and write",
  "Metadata: Read",
  "Actions: Read and write",
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
      return "Classic token";
    case "fine-grained":
      return "Fine-grained token";
    default:
      return "Unknown format";
  }
}

function authSourceLabel(status: GitHubStatus | null): string {
  switch (status?.authSource) {
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

function tokenTypeLabel(status: GitHubStatus | null): string {
  switch (status?.tokenType) {
    case "classic":
      return "Classic PAT";
    case "fine-grained":
      return "Fine-grained PAT";
    case "oauth":
      return "OAuth token";
    case "unknown":
      return "Unknown token";
    default:
      return "N/A";
  }
}

export function GitHubSection() {
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [githubBusy, setGithubBusy] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [tokenFocused, setTokenFocused] = useState(false);
  const [showPatSetup, setShowPatSetup] = useState(false);
  const [projectConfig, setProjectConfig] = useState<ProjectConfigSnapshot | null>(null);
  const [transcriptGistsEnabled, setTranscriptGistsEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    window.ade.github
      .getStatus()
      .then((status) => {
        if (!cancelled) setGithubStatus(status);
      })
      .catch(() => {});
    window.ade.projectConfig
      .get()
      .then((snapshot) => {
        if (cancelled) return;
        setProjectConfig(snapshot);
        setTranscriptGistsEnabled(snapshot.effective.github?.prTranscriptGists?.enabled === true);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

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
      .setToken(token)
      .then((status) => {
        setGithubStatus(status);
        setGithubTokenDraft("");
        if (status.connected) {
          setShowPatSetup(false);
          setSaveNotice("Personal access token saved and verified.");
          return;
        }
        if (!status.userLogin) {
          setActionError("Token saved, but authentication failed. Re-check the token value.");
        } else if (status.tokenType === "fine-grained" && status.repoAccessOk === false) {
          const repoLabel = status.repo ? `${status.repo.owner}/${status.repo.name}` : "this repo";
          setActionError(
            `Token saved, but it cannot access ${repoLabel}` +
              (status.repoAccessError ? ` (${status.repoAccessError})` : "") +
              ". Grant this repo Contents, Pull requests, Metadata, Actions, and Workflows permissions.",
          );
        } else {
          setActionError("Token saved, but it is missing required permissions. See the diagnostic below.");
        }
      })
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGithubBusy(false));
  };

  const handleClearToken = () => {
    setGithubBusy(true);
    setActionError(null);
    setSaveNotice(null);
    window.ade.github
      .clearToken()
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
      .getStatus({ forceRefresh: true })
      .then((status) => setGithubStatus(status))
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGithubBusy(false));
  };

  const handleToggleTranscriptGists = async (enabled: boolean) => {
    setConfigBusy(true);
    setActionError(null);
    setSaveNotice(null);
    try {
      const snapshot = await window.ade.projectConfig.get();
      const next = await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          github: {
            ...(snapshot.local.github ?? {}),
            prTranscriptGists: { enabled },
          },
        },
      });
      setProjectConfig(next);
      setTranscriptGistsEnabled(next.effective.github?.prTranscriptGists?.enabled === true);
      setSaveNotice(enabled ? "PR chat transcripts enabled." : "PR chat transcripts disabled.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConfigBusy(false);
    }
  };

  const tokenAuthenticated = Boolean(githubStatus?.tokenStored && githubStatus?.userLogin);
  const isConnected = Boolean(githubStatus?.connected);
  const isFineGrainedToken = githubStatus?.tokenType === "fine-grained";
  const hasInspectableScopes = !isFineGrainedToken || (githubStatus?.scopes?.length ?? 0) > 0;
  const accessState = getGitHubTokenAccessState(githubStatus?.scopes ?? []);
  const repoProbeFailed = tokenAuthenticated && githubStatus?.repoAccessOk === false;
  const hasMissingScopes = tokenAuthenticated && hasInspectableScopes && !accessState.hasRequiredAccess;
  let statusColor: string;
  let statusLabel: string;
  if (isConnected) {
    statusColor = COLORS.success;
    statusLabel = "Connected";
  } else if (tokenAuthenticated) {
    statusColor = COLORS.warning;
    statusLabel = "Needs permission";
  } else {
    statusColor = COLORS.textMuted;
    statusLabel = "Not connected";
  }
  const ghCommand = transcriptGistsEnabled
    ? tokenAuthenticated && githubStatus?.authSource === "gh" ? GH_AUTH_REFRESH_WITH_GIST_COMMAND : GH_AUTH_LOGIN_WITH_GIST_COMMAND
    : tokenAuthenticated && githubStatus?.authSource === "gh" ? GH_AUTH_REFRESH_COMMAND : GH_AUTH_LOGIN_COMMAND;
  const classicTokenUrl = transcriptGistsEnabled ? GITHUB_CLASSIC_TOKEN_WITH_GIST_NEW_URL : GITHUB_CLASSIC_TOKEN_NEW_URL;
  const openExternal = (url: string) => {
    void window.ade.app.openExternal(url);
  };

  const sectionGap: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  };

  const noticeStyle: CSSProperties = {
    background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)",
    padding: "8px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.success,
    borderRadius: 0,
  };

  const errorStyle: CSSProperties = {
    background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
    padding: "8px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.danger,
    borderRadius: 0,
  };

  const inputStyle: CSSProperties = {
    height: 40,
    background: COLORS.recessedBg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: "0 14px",
    fontSize: 12,
    fontFamily: MONO_FONT,
    color: COLORS.textPrimary,
    outline: "none",
    width: "100%",
    transition: "border-color 150ms ease, box-shadow 150ms ease",
  };

  const inputFocusedStyle: CSSProperties = tokenFocused
    ? {
        borderColor: COLORS.accent,
        boxShadow: `0 0 0 3px color-mix(in srgb, var(--color-accent) 22%, transparent)`,
      }
    : {};

  const scopeRowStyle = (present: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: present ? COLORS.success : COLORS.textMuted,
  });

  const infoBoxStyle: CSSProperties = {
    background: "color-mix(in srgb, var(--color-info) 8%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-info) 20%, transparent)",
    borderRadius: 0,
    padding: "10px 14px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.textSecondary,
    lineHeight: "18px",
  };

  const commandStyle: CSSProperties = {
    display: "block",
    marginTop: 8,
    padding: "8px 10px",
    border: `1px solid ${COLORS.border}`,
    background: COLORS.recessedBg,
    color: COLORS.textPrimary,
    fontFamily: MONO_FONT,
    fontSize: 11,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  const linkButtonStyle: CSSProperties = {
    ...outlineButton({ height: 30 }),
    fontSize: 10,
    padding: "0 10px",
  };

  const summaryCell = (label: string, value: string | null) => (
    <div>
      <div style={LABEL_STYLE}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 13, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
        {value ?? "N/A"}
      </div>
    </div>
  );

  return (
    <div style={sectionGap}>
      {saveNotice ? <div style={noticeStyle}>{saveNotice}</div> : null}
      {actionError ? <div style={errorStyle}>{actionError}</div> : null}

      <div style={cardStyle({
        borderColor: isConnected ? "color-mix(in srgb, var(--color-success) 30%, transparent)" : tokenAuthenticated ? "color-mix(in srgb, var(--color-warning) 30%, transparent)" : undefined,
      })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <GithubLogo size={28} weight="fill" style={{ color: statusColor }} />
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              GitHub connection
            </span>
          </div>
          {githubStatus ? <span style={inlineBadge(statusColor)}>{statusLabel}</span> : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              background: COLORS.recessedBg,
              padding: 16,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              borderRadius: 0,
            }}
          >
            {summaryCell("USER", githubStatus?.userLogin ?? null)}
            {summaryCell("REPOSITORY", githubStatus?.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : null)}
            {summaryCell("AUTH METHOD", authSourceLabel(githubStatus))}
            {summaryCell("TOKEN TYPE", tokenTypeLabel(githubStatus))}
          </div>

          <div>
            <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>
              {isFineGrainedToken && !hasInspectableScopes ? "TOKEN PERMISSIONS" : "DETECTED SCOPES"}
            </div>
            {isFineGrainedToken && !hasInspectableScopes ? (
              <div style={{ display: "grid", gap: 6 }}>
                {REQUIRED_GITHUB_FINE_GRAINED_PERMISSIONS.map((permission) => (
                  <div key={permission} style={{ ...scopeRowStyle(false), color: COLORS.textSecondary }}>
                    <ShieldCheck size={14} weight="fill" />
                    <span>{permission}</span>
                  </div>
                ))}
                <div style={{ ...infoBoxStyle, marginTop: 4 }}>
                  GitHub does not expose fine-grained PAT permissions through OAuth scope headers. ADE verifies repo access directly when an active GitHub remote is available.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "grid", gap: 6 }}>
                  {REQUIRED_GITHUB_CLASSIC_SCOPES.map((scope) => {
                    const present = accessState.requirements[scope].present;
                    return (
                      <div key={scope} style={scopeRowStyle(present)}>
                        {present ? <CheckCircle size={14} weight="fill" /> : <Warning size={14} weight="fill" />}
                        <span>{scope}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {accessState.normalizedScopes.length > 0 ? accessState.normalizedScopes.map((scope) => (
                    <span key={scope} style={{
                      display: "inline-block",
                      fontSize: 10,
                      fontFamily: MONO_FONT,
                      color: COLORS.textSecondary,
                      background: "color-mix(in srgb, var(--color-border) 55%, transparent)",
                      padding: "3px 7px",
                      borderRadius: 4,
                    }}>
                      {scope}
                    </span>
                  )) : (
                    <span style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                      No OAuth scopes detected yet.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {hasMissingScopes ? (
            <div style={errorStyle}>
              Missing required {accessState.usesFineGrainedPermissions ? "permissions" : "scopes"}: {accessState.missingDescriptions.join(", ")}.
            </div>
          ) : null}

          {repoProbeFailed ? (
            <div style={errorStyle}>
              Token authenticated as <strong>{githubStatus?.userLogin}</strong>, but cannot access{" "}
              <strong>{githubStatus?.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : "this repo"}</strong>
              {githubStatus?.repoAccessError ? ` (${githubStatus.repoAccessError})` : ""}.
              {isFineGrainedToken ? (
                <> Add this repository to the fine-grained token and grant Contents, Pull requests, Metadata, Actions, and Workflows permissions.</>
              ) : (
                <> Make sure the token has access to this repository.</>
              )}
            </div>
          ) : null}

          {githubStatus && !isConnected && githubStatus.authSource !== "pat" ? (
            <div style={{
              padding: 14,
              border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
              background: COLORS.recessedBg,
              borderRadius: 0,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <TerminalWindow size={16} weight="duotone" style={{ color: COLORS.warning }} />
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                  GitHub CLI auth
                </span>
              </div>
              <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
                {githubStatus?.ghAuthError
                  ? githubStatus.ghAuthError
                  : "Run this command in Terminal, then refresh this panel."}
                <code style={commandStyle}>{ghCommand}</code>
              </div>
            </div>
          ) : null}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" style={outlineButton()} disabled={githubBusy} onClick={handleRefreshStatus}>
              <ArrowsClockwise size={12} weight="bold" /> Refresh status
            </button>
            {githubStatus?.patTokenStored ? (
              <button type="button" style={outlineButton()} disabled={githubBusy} onClick={handleClearToken}>
                <LinkBreak size={12} weight="bold" /> Clear PAT
              </button>
            ) : null}
            <button type="button" style={outlineButton()} disabled={githubBusy} onClick={() => setShowPatSetup((value) => !value)}>
              <Key size={12} weight="bold" /> {showPatSetup ? "Hide PAT setup" : githubStatus?.patTokenStored ? "Replace PAT" : "Use PAT instead"}
            </button>
          </div>
        </div>
      </div>

      <div style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ShieldCheck size={18} color={transcriptGistsEnabled ? COLORS.success : COLORS.textMuted} weight="fill" />
            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              PR chat transcripts
            </span>
          </div>
          <span style={inlineBadge(transcriptGistsEnabled ? COLORS.success : COLORS.textMuted)}>
            {transcriptGistsEnabled ? "On" : "Off"}
          </span>
        </div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: configBusy ? "default" : "pointer" }}>
          <input
            type="checkbox"
            checked={transcriptGistsEnabled}
            disabled={configBusy}
            onChange={(event) => {
              void handleToggleTranscriptGists(event.currentTarget.checked);
            }}
            style={{ marginTop: 2 }}
          />
          <span style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              Attach ADE chat transcript links when creating or linking PRs.
            </span>
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
              Transcripts are published as secret gists, which are link-accessible. ADE publishes only structured chat turns, not raw terminal logs.
            </span>
          </span>
        </label>
        {transcriptGistsEnabled ? (
          <div style={{ ...infoBoxStyle, marginTop: 12 }}>
            GitHub CLI auth needs the gist scope. Classic PATs need gist, and fine-grained tokens need Gists read/write permission.
          </div>
        ) : null}
      </div>

      {showPatSetup ? (
        <div style={cardStyle()}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <Key size={18} color={COLORS.accent} weight="fill" />
            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              Personal access token
            </span>
          </div>
          <div style={{ ...infoBoxStyle, marginBottom: 14 }}>
            PAT setup is optional. Use it when you cannot or do not want to use GitHub CLI auth on this machine.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 16 }}>
            <div style={{ padding: "14px 16px", border: `1px solid ${COLORS.border}`, borderTop: `2px solid ${COLORS.accent}`, borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <Shield size={18} weight="duotone" style={{ color: COLORS.accent }} />
                <div style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                  Classic token
                </div>
              </div>
              <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px", marginBottom: 10 }}>
                Generate a classic token with repo and workflow scopes.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                <button type="button" style={linkButtonStyle} onClick={() => openExternal(classicTokenUrl)}>
                  <ArrowSquareOut size={12} weight="bold" /> Create classic token
                </button>
                <button type="button" style={linkButtonStyle} onClick={() => openExternal(GITHUB_CLASSIC_TOKENS_URL)}>
                  Manage tokens
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {REQUIRED_GITHUB_CLASSIC_SCOPES.map((scope) => (
                  <span key={scope} style={{
                    display: "inline-block",
                    fontSize: 10,
                    fontFamily: MONO_FONT,
                    color: COLORS.accent,
                    background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                    padding: "3px 8px",
                    borderRadius: 4,
                    fontWeight: 500,
                  }}>
                    {scope}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ padding: "14px 16px", border: `1px solid ${COLORS.border}`, borderTop: `2px solid ${COLORS.success}`, borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <ShieldCheck size={18} weight="duotone" style={{ color: COLORS.success }} />
                <div style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                  Fine-grained token
                </div>
              </div>
              <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px", marginBottom: 10 }}>
                Include this repository and grant the permissions below.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                <button type="button" style={linkButtonStyle} onClick={() => openExternal(GITHUB_FINE_GRAINED_TOKEN_NEW_URL)}>
                  <ArrowSquareOut size={12} weight="bold" /> Create fine-grained token
                </button>
                <button type="button" style={linkButtonStyle} onClick={() => openExternal(GITHUB_FINE_GRAINED_TOKENS_URL)}>
                  Manage tokens
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {REQUIRED_GITHUB_FINE_GRAINED_PERMISSIONS.map((perm) => (
                  <span key={perm} style={{
                    display: "inline-block",
                    fontSize: 10,
                    fontFamily: MONO_FONT,
                    color: COLORS.success,
                    background: "color-mix(in srgb, var(--color-success) 10%, transparent)",
                    padding: "3px 8px",
                    borderRadius: 4,
                    fontWeight: 500,
                    alignSelf: "flex-start",
                  }}>
                    {perm}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={LABEL_STYLE}>PERSONAL ACCESS TOKEN</span>
            <input
              type="password"
              value={githubTokenDraft}
              onChange={(event) => setGithubTokenDraft(event.target.value)}
              placeholder="ghp_... or github_pat_..."
              style={{ ...inputStyle, ...inputFocusedStyle }}
              onFocus={() => setTokenFocused(true)}
              onBlur={() => setTokenFocused(false)}
            />
            {githubTokenDraft.trim() ? (
              <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                Detected: {tokenTypeDetectionLabel(detectTokenType(githubTokenDraft.trim()))}
              </span>
            ) : null}
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" style={primaryButton()} disabled={githubBusy} onClick={handleSaveToken}>
              <Key size={12} weight="bold" /> {githubBusy ? "Saving..." : "Save token"}
            </button>
            <button type="button" style={outlineButton()} disabled={githubBusy} onClick={handleRefreshStatus}>
              <ArrowsClockwise size={12} weight="bold" /> Check status
            </button>
          </div>
        </div>
      ) : null}

      <div style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <ShieldCheck size={18} color={COLORS.info} weight="fill" />
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            Permission use
          </span>
        </div>
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "20px", marginBottom: 14 }}>
          ADE needs GitHub access to create PRs, post reviews, inspect CI, re-run failed jobs, and push branch updates. GitHub CLI auth and PAT auth use the same required access.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <GitPullRequest size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Pull requests</strong> - create PRs, request reviewers, and post review comments
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <GitBranch size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Contents</strong> - read repository files and push branch changes
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eye size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Workflows</strong> - push lane changes that edit GitHub workflow files
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eye size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Actions</strong> - inspect workflow runs and trigger failed job re-runs
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
