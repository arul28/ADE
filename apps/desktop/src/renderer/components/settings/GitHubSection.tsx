import { useEffect, useState, type CSSProperties } from "react";
import type { GitHubStatus } from "../../../shared/types";
import { GithubLogo, CheckCircle, Warning, ArrowsClockwise, ShieldCheck, LinkBreak, Key, Shield, GitPullRequest, Eye, GitBranch, UsersThree } from "@phosphor-icons/react";
import { getGitHubTokenAccessState, REQUIRED_GITHUB_CLASSIC_SCOPES } from "../../../shared/githubScopes";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, LABEL_STYLE, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

type TokenType = "classic" | "fine-grained" | "unknown";

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
        const accessState = getGitHubTokenAccessState(status.scopes ?? []);
        setSaveNotice(
          accessState.hasRequiredAccess
            ? "GitHub token saved and verified."
            : "GitHub token saved. Additional GitHub permissions are still required.",
        );
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
    window.ade.github
      .getStatus()
      .then((status) => setGithubStatus(status))
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setGithubBusy(false));
  };

  const isConnected = Boolean(githubStatus?.tokenStored && githubStatus?.userLogin);
  const accessState = getGitHubTokenAccessState(githubStatus?.scopes ?? []);
  const hasFullAccess = isConnected && accessState.hasRequiredAccess;
  const hasMissingScopes = isConnected && !accessState.hasRequiredAccess;
  const statusColor = hasFullAccess ? COLORS.success : isConnected ? COLORS.warning : COLORS.textMuted;
  const statusLabel = hasFullAccess ? "CONNECTED" : isConnected ? "LIMITED ACCESS" : "NOT CONNECTED";

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
    border: `1px solid ${COLORS.border}`,
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

  return (
    <div style={sectionGap}>
      {saveNotice ? <div style={noticeStyle}>{saveNotice}</div> : null}
      {actionError ? <div style={errorStyle}>{actionError}</div> : null}

      <div style={cardStyle({
        borderColor: hasFullAccess ? `${COLORS.success}30` : isConnected ? `${COLORS.warning}30` : undefined,
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

        {isConnected ? (
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
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>TOKEN SCOPES</div>
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
            </div>

            {hasMissingScopes ? (
              <div style={errorStyle}>
                Missing required {accessState.usesFineGrainedPermissions ? "permissions" : "scopes"}: {accessState.missingDescriptions.join(", ")}.
                {" "}
                Regenerate the token with the required permissions.
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
                <div style={{ ...LABEL_STYLE, marginBottom: 6, letterSpacing: "0.05em" }}>REQUIRED PERMISSIONS</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {[
                    "Contents: Read & Write",
                    "Pull requests: Read & Write",
                    "Metadata: Read",
                    "Workflows: Read & Write",
                    "Members (org): Read",
                  ].map((perm) => (
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
          Fine-grained tokens also need Metadata: Read so ADE can inspect repository metadata alongside the other permissions below.
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
              <strong style={{ color: COLORS.textPrimary }}>Workflows</strong> — inspect CI check results and trigger re-runs
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <UsersThree size={16} weight="duotone" style={{ color: COLORS.info, flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              <strong style={{ color: COLORS.textPrimary }}>Organization</strong> — read org members to suggest reviewers
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
