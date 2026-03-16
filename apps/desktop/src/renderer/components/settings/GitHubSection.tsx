import { useEffect, useState, type CSSProperties } from "react";
import type { GitHubStatus } from "../../../shared/types";
import { GithubLogo, CheckCircle, Warning, ArrowsClockwise, ShieldCheck, LinkBreak, Key } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, LABEL_STYLE, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

const REQUIRED_SCOPES = ["repo", "workflow", "read:org"];

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
        setSaveNotice("GitHub token saved and verified.");
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

  const isConnected = githubStatus?.tokenStored && githubStatus?.userLogin;
  const missingScopes = REQUIRED_SCOPES.filter((scope) => !(githubStatus?.scopes ?? []).includes(scope));
  const hasMissingScopes = isConnected && missingScopes.length > 0;

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
    height: 36,
    background: COLORS.recessedBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 0,
    padding: "0 12px",
    fontSize: 12,
    fontFamily: MONO_FONT,
    color: COLORS.textPrimary,
    outline: "none",
    width: "100%",
  };

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

      <div style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <GithubLogo size={28} weight="fill" style={{ color: COLORS.textPrimary }} />
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              GitHub connection
            </span>
          </div>
          {githubStatus ? (
            <span style={inlineBadge(isConnected ? COLORS.success : COLORS.textMuted)}>
              {isConnected ? "CONNECTED" : "NOT CONNECTED"}
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
                  {githubStatus.userLogin}
                </div>
              </div>
              <div>
                <div style={LABEL_STYLE}>REPOSITORY</div>
                <div style={{ marginTop: 4, fontSize: 13, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
                  {githubStatus.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : "N/A"}
                </div>
              </div>
              <div>
                <div style={LABEL_STYLE}>TOKEN SCOPE</div>
                <div style={{ marginTop: 4, fontSize: 13, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
                  {githubStatus.storageScope === "app" ? "App-wide" : "Project"}
                </div>
              </div>
            </div>

            <div>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>TOKEN SCOPES</div>
              <div style={{ display: "grid", gap: 6 }}>
                {REQUIRED_SCOPES.map((scope) => {
                  const present = (githubStatus?.scopes ?? []).includes(scope);
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
                Missing required scopes: {missingScopes.join(", ")}. Regenerate the token with the required permissions.
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, border: `1px solid ${COLORS.border}`, borderRadius: 0, overflow: "hidden" }}>
              {/* Classic PAT */}
              <div style={{ padding: "12px 14px", borderRight: `1px solid ${COLORS.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 8 }}>
                  Classic token
                </div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, marginBottom: 8 }}>
                  Prefix: ghp_...
                </div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px", marginBottom: 8 }}>
                  Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token
                </div>
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>REQUIRED SCOPES</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {REQUIRED_SCOPES.map((scope) => (
                    <div key={scope} style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                      ● {scope}
                    </div>
                  ))}
                </div>
              </div>

              {/* Fine-grained PAT */}
              <div style={{ padding: "12px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 8 }}>
                  Fine-grained token
                </div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, marginBottom: 8 }}>
                  Prefix: github_pat_...
                </div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px", marginBottom: 8 }}>
                  Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
                </div>
                <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>REQUIRED PERMISSIONS</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {[
                    "Contents: Read & Write",
                    "Pull requests: Read & Write",
                    "Metadata: Read",
                    "Workflows: Read & Write",
                    "Members (org): Read",
                  ].map((perm) => (
                    <div key={perm} style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                      ● {perm}
                    </div>
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
                style={inputStyle}
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
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <ShieldCheck size={18} color={COLORS.info} weight="fill" />
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            Why these permissions?
          </span>
        </div>
        <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary, lineHeight: "20px" }}>
          ADE uses your token to create PRs, inspect CI checks, and request reviewers.{" "}
          <strong style={{ color: COLORS.textPrimary }}>Classic tokens</strong> use broad scopes
          (<span style={{ color: COLORS.textPrimary }}>repo</span>,{" "}
          <span style={{ color: COLORS.textPrimary }}>workflow</span>,{" "}
          <span style={{ color: COLORS.textPrimary }}>read:org</span>).{" "}
          <strong style={{ color: COLORS.textPrimary }}>Fine-grained tokens</strong> let you grant narrower,
          per-repository permissions — they are the newer GitHub recommendation.
          Either type works; fine-grained tokens won't show traditional scopes in the verification above.
        </div>
      </div>
    </div>
  );
}
