import { useEffect, useState, type CSSProperties } from "react";
import type { GitHubStatus } from "../../../shared/types";
import { GithubLogo, CheckCircle, Warning, ArrowsClockwise, ShieldCheck, LinkBreak, Key, Shield, GitPullRequest, Eye, GitBranch, ArrowSquareOut } from "@phosphor-icons/react";
import { getGitHubTokenAccessState, REQUIRED_GITHUB_CLASSIC_SCOPES } from "../../../shared/githubScopes";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, LABEL_STYLE, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

type TokenType = "classic" | "fine-grained" | "unknown";

const GITHUB_CLASSIC_TOKEN_NEW_URL = "https://github.com/settings/tokens/new?description=ADE%20desktop%20PR%20workflows&scopes=repo,workflow";
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

export function GitHubSection() {
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [githubBusy, setGithubBusy] = useState(false);
  const [tokenFocused, setTokenFocused] = useState(false);

  useEffect(() => {
    let cancelled = false;

    window.ade.github
      .getStatus()
      .then((status) => {
        if (!cancelled) setGithubStatus(status);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaveToken = () => {
    const token = githubTokenDraft.trim();
    if (!token) {
      setActionError("GitHub token is empty.");
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
          setSaveNotice("GitHub token saved and verified.");
          return;
        }
        // Token was persisted, but it isn't actually usable. Surface the reason
        // through `actionError` (red) rather than the green "saved" notice so
        // the user is not misled into thinking they are done.
        if (!status.userLogin) {
          setActionError("Token saved, but authentication failed. Re-check the token value.");
        } else if (status.tokenType === "fine-grained" && status.repoAccessOk === false) {
          const repoLabel = status.repo ? `${status.repo.owner}/${status.repo.name}` : "this repo";
          setActionError(
            `Token saved, but it cannot access ${repoLabel}` +
              (status.repoAccessError ? ` (${status.repoAccessError})` : "") +
              ". Grant this repo Contents (read), Pull requests (read/write), and Metadata (read) on the fine-grained token.",
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
        setSaveNotice("GitHub token cleared.");
      })
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGithubBusy(false));
  };

  const handleRefreshStatus = () => {
    setGithubBusy(true);
    setActionError(null);
    // forceRefresh: the user explicitly asked us to re-check, so bypass the
    // 30s status cache. Required for the "fix permissions on github.com →
    // come back and click REFRESH" recovery flow.
    window.ade.github
      .getStatus({ forceRefresh: true })
      .then((status) => setGithubStatus(status))
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGithubBusy(false));
  };

  // `tokenAuthenticated` = the token was decryptable AND identified a user. Not enough to claim
  // the integration "works" — fine-grained tokens authenticate the user even when they can't
  // read the active repo. `isConnected` (from the backend) is the real "GitHub is usable" gate.
  const tokenAuthenticated = Boolean(githubStatus?.tokenStored && githubStatus?.userLogin);
  const isConnected = Boolean(githubStatus?.connected);
  const isFineGrainedToken = githubStatus?.tokenType === "fine-grained";
  const hasInspectableScopes = !isFineGrainedToken || (githubStatus?.scopes?.length ?? 0) > 0;
  const accessState = getGitHubTokenAccessState(githubStatus?.scopes ?? []);
  const repoProbeFailed =
    tokenAuthenticated && githubStatus?.repoAccessOk === false;
  const hasMissingScopes =
    tokenAuthenticated && hasInspectableScopes && !accessState.hasRequiredAccess;
  const statusColor = isConnected ? COLORS.success : tokenAuthenticated ? COLORS.warning : COLORS.textMuted;
  const statusLabel = isConnected ? "CONNECTED" : tokenAuthenticated ? "LIMITED ACCESS" : "NOT CONNECTED";
  const openExternal = (url: string) => {
    void window.ade.app.openExternal(url);
  };

  const sectionGap: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  };

  const noticeStyle: CSSProperties = {
    background: `${COLORS.success}12`,
    border: `1px solid ${COLORS.success}30`,
    padding: "8px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.success,
    borderRadius: 0,
  };

  const errorStyle: CSSProperties = {
    background: `${COLORS.danger}12`,
    border: `1px solid ${COLORS.danger}30`,
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
        boxShadow: `0 0 0 3px ${COLORS.accent}22`,
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
    background: `${COLORS.info}08`,
    border: `1px solid ${COLORS.info}20`,
    borderRadius: 0,
    padding: "10px 14px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.textSecondary,
    lineHeight: "18px",
  };

  const linkButtonStyle: CSSProperties = {
    ...outlineButton({ height: 30 }),
    fontSize: 10,
    padding: "0 10px",
  };

  return (
    <div style={sectionGap}>
      {saveNotice ? <div style={noticeStyle}>{saveNotice}</div> : null}
      {actionError ? <div style={errorStyle}>{actionError}</div> : null}

      <div style={cardStyle({
        borderColor: isConnected ? `${COLORS.success}30` : tokenAuthenticated ? `${COLORS.warning}30` : undefined,
      })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <GithubLogo size={28} weight="fill" style={{ color: statusColor }} />
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              GitHub connection
            </span>
          </div>
          {githubStatus ? (
            <span style={inlineBadge(statusColor)}>
              {statusLabel}
            </span>
          ) : null}
        </div>

        {tokenAuthenticated ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div
              style={{
                background: COLORS.recessedBg,
                padding: 16,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                borderRadius: 0,
              }}
            >
              <div>
                <div style={LABEL_STYLE}>USER</div>
                <div style={{ marginTop: 4, fontSize: 13, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
                  {githubStatus?.userLogin ?? "Unknown"}
                </div>
              </div>
              <div>
                <div style={LABEL_STYLE}>REPOSITORY</div>
                <div style={{ marginTop: 4, fontSize: 13, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
                  {githubStatus?.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : "N/A"}
                </div>
              </div>
              <div>
                <div style={LABEL_STYLE}>TOKEN SCOPE</div>
                <div style={{ marginTop: 4, fontSize: 13, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
                  {githubStatus?.storageScope === "app" ? "App-wide" : "Project"}
                </div>
              </div>
            </div>

            <div>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>
                {isFineGrainedToken && !hasInspectableScopes ? "TOKEN PERMISSIONS" : "TOKEN SCOPES"}
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
                    GitHub does not expose granted fine-grained PAT permissions through the OAuth scopes header. Confirm this token was created with the permissions above.
                  </div>
                </div>
              ) : (
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
              )}
            </div>

            {hasMissingScopes ? (
              <div style={errorStyle}>
                Missing required {accessState.usesFineGrainedPermissions ? "permissions" : "scopes"}: {accessState.missingDescriptions.join(", ")}.
                {" "}
                Regenerate the token with the required permissions.
              </div>
            ) : null}

            {repoProbeFailed ? (
              <div style={errorStyle}>
                Token authenticated as <strong>{githubStatus?.userLogin}</strong>, but cannot access{" "}
                <strong>{githubStatus?.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : "this repo"}</strong>
                {githubStatus?.repoAccessError ? ` (${githubStatus.repoAccessError})` : ""}.
                {isFineGrainedToken ? (
                  <>
                    {" "}
                    Fine-grained tokens must explicitly include this repository under
                    {" "}<em>Repository access</em>, with Contents (Read), Pull requests (Read and write), and Metadata (Read) permissions.
                  </>
                ) : (
                  <> Make sure the token has access to this repository.</>
                )}
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={outlineButton()} disabled={githubBusy} onClick={handleRefreshStatus}>
                <ArrowsClockwise size={12} weight="bold" /> REFRESH
              </button>
              <button type="button" style={outlineButton()} disabled={githubBusy} onClick={handleClearToken}>
                <LinkBreak size={12} weight="bold" /> CLEAR TOKEN
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={infoBoxStyle}>
              Paste a GitHub personal access token to enable PR creation, review actions, and repository sync.
              The same encrypted token is reused across projects unless you replace it here.
              GitHub offers two token types — either works.
            </div>

            {/* Token type tabs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              {/* Classic PAT */}
              <div style={{ padding: "14px 16px", border: `1px solid ${COLORS.border}`, borderTop: `2px solid ${COLORS.accent}`, borderRadius: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <Shield size={18} weight="duotone" style={{ color: COLORS.accent }} />
                  <div style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                    Classic token
                  </div>
                </div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, marginBottom: 8 }}>
                  Prefix: ghp_...
                </div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px", marginBottom: 10 }}>
                  Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  <button type="button" style={linkButtonStyle} onClick={() => openExternal(GITHUB_CLASSIC_TOKEN_NEW_URL)}>
                    <ArrowSquareOut size={12} weight="bold" /> Create classic token
                  </button>
                  <button type="button" style={linkButtonStyle} onClick={() => openExternal(GITHUB_CLASSIC_TOKENS_URL)}>
                    Manage tokens
                  </button>
                </div>
                <div style={{ ...LABEL_STYLE, marginBottom: 6, letterSpacing: "0.05em" }}>REQUIRED SCOPES</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {REQUIRED_GITHUB_CLASSIC_SCOPES.map((scope) => (
                    <span key={scope} style={{
                      display: "inline-block",
                      fontSize: 10,
                      fontFamily: MONO_FONT,
                      color: COLORS.accent,
                      background: `${COLORS.accent}12`,
                      padding: "3px 8px",
                      borderRadius: 4,
                      fontWeight: 500,
                    }}>
                      {scope}
                    </span>
                  ))}
                </div>
              </div>

              {/* Fine-grained PAT */}
              <div style={{ padding: "14px 16px", border: `1px solid ${COLORS.border}`, borderTop: `2px solid ${COLORS.success}`, borderRadius: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <ShieldCheck size={18} weight="duotone" style={{ color: COLORS.success }} />
                  <div style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                    Fine-grained token
                  </div>
                </div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, marginBottom: 8 }}>
                  Prefix: github_pat_...
                </div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px", marginBottom: 10 }}>
                  Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  <button type="button" style={linkButtonStyle} onClick={() => openExternal(GITHUB_FINE_GRAINED_TOKEN_NEW_URL)}>
                    <ArrowSquareOut size={12} weight="bold" /> Create fine-grained token
                  </button>
                  <button type="button" style={linkButtonStyle} onClick={() => openExternal(GITHUB_FINE_GRAINED_TOKENS_URL)}>
                    Manage tokens
                  </button>
                </div>
                <div style={{ ...LABEL_STYLE, marginBottom: 6, letterSpacing: "0.05em" }}>REQUIRED PERMISSIONS</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {REQUIRED_GITHUB_FINE_GRAINED_PERMISSIONS.map((perm) => (
                    <span key={perm} style={{
                      display: "inline-block",
                      fontSize: 10,
                      fontFamily: MONO_FONT,
                      color: COLORS.success,
                      background: `${COLORS.success}10`,
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
                  Detected: {detectTokenType(githubTokenDraft.trim()) === "classic" ? "Classic token" : detectTokenType(githubTokenDraft.trim()) === "fine-grained" ? "Fine-grained token" : "Unknown format"}
                </span>
              ) : null}
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={primaryButton()} disabled={githubBusy} onClick={handleSaveToken}>
                <Key size={12} weight="bold" /> {githubBusy ? "SAVING..." : "SAVE TOKEN"}
              </button>
              <button type="button" style={outlineButton()} disabled={githubBusy} onClick={handleRefreshStatus}>
                <ArrowsClockwise size={12} weight="bold" /> CHECK STATUS
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <ShieldCheck size={18} color={COLORS.info} weight="fill" />
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            Why these permissions?
          </span>
        </div>
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "20px", marginBottom: 14 }}>
          ADE needs a few GitHub permissions to work on your behalf. Either token type works — fine-grained tokens are recommended for tighter control.
          Fine-grained tokens also need Metadata: Read. Workflows has write-only access in GitHub's fine-grained token form.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <GitPullRequest size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Pull requests</strong> — create PRs, request reviewers, and post review comments
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <GitBranch size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Contents</strong> — read repository files and push branch changes
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eye size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Workflows</strong> — push lane changes that edit GitHub workflow files
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eye size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Actions</strong> — inspect workflow runs and trigger failed job re-runs
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
