import { useEffect, useState, type CSSProperties } from "react";
import type { GitHubStatus } from "../../../shared/types";
import { GithubLogo, CheckCircle, Warning, XCircle, ArrowsClockwise, ShieldCheck, LinkBreak, Key } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, LABEL_STYLE, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const REQUIRED_SCOPES = ["repo", "workflow", "read:org"];

export function GitHubSection() {
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubTokenDraft, setGithubTokenDraft] = useState("");
  const [githubBusy, setGithubBusy] = useState(false);
  const [autoRebaseDraft, setAutoRebaseDraft] = useState(false);
  const [autoRebaseBusy, setAutoRebaseBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    window.ade.projectConfig
      .get()
      .then((snapshot) => {
        if (!cancelled) {
          const localAutoRebase = typeof snapshot.local.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.local.git.autoRebaseOnHeadChange : null;
          const effectiveAutoRebase =
            typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.effective.git.autoRebaseOnHeadChange : null;
          setAutoRebaseDraft(localAutoRebase ?? effectiveAutoRebase ?? false);
        }
      })
      .catch(() => {});

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

  const refreshConfigState = async () => {
    const snapshot = await window.ade.projectConfig.get();
    const localAutoRebase = typeof snapshot.local.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.local.git.autoRebaseOnHeadChange : null;
    const effectiveAutoRebase =
      typeof snapshot.effective.git?.autoRebaseOnHeadChange === "boolean" ? snapshot.effective.git.autoRebaseOnHeadChange : null;
    setAutoRebaseDraft(localAutoRebase ?? effectiveAutoRebase ?? false);
  };

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

  const saveAutoRebaseSettings = async () => {
    setActionError(null);
    setSaveNotice(null);
    setAutoRebaseBusy(true);
    try {
      const snapshot = await window.ade.projectConfig.get();
      const currentGit = isRecord(snapshot.local.git) ? snapshot.local.git : {};
      const nextGit: Record<string, unknown> = {
        ...currentGit,
        autoRebaseOnHeadChange: autoRebaseDraft,
      };
      const nextLocal = {
        ...snapshot.local,
        git: nextGit,
      };
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: nextLocal,
      });
      await refreshConfigState();
      setSaveNotice("Auto-rebase settings saved.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutoRebaseBusy(false);
    }
  };

  const isConnected = githubStatus?.tokenStored && githubStatus?.userLogin;
  const missingScopes = REQUIRED_SCOPES.filter((s) => !(githubStatus?.scopes ?? []).includes(s));
  const hasMissingScopes = isConnected && missingScopes.length > 0;

  // --- Styles ---

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
      {/* Notices */}
      {saveNotice && <div style={noticeStyle}>{saveNotice}</div>}
      {actionError && <div style={errorStyle}>{actionError}</div>}

      {/* ========== GITHUB CONNECTION STATUS ========== */}
      <div style={cardStyle()}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <GithubLogo size={28} weight="fill" style={{ color: COLORS.textPrimary }} />
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              GitHub Connection
            </span>
          </div>
          {githubStatus && (
            <span style={inlineBadge(isConnected ? COLORS.success : COLORS.textMuted)}>
              {isConnected ? "CONNECTED" : "NOT CONNECTED"}
            </span>
          )}
        </div>

        {isConnected ? (
          /* ---- Connected State ---- */
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* User & Repo info */}
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
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 13,
                    fontFamily: MONO_FONT,
                    color: COLORS.textPrimary,
                  }}
                >
                  {githubStatus.userLogin}
                </div>
              </div>
              <div>
                <div style={LABEL_STYLE}>REPOSITORY</div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 13,
                    fontFamily: MONO_FONT,
                    color: COLORS.textPrimary,
                  }}
                >
                  {githubStatus.repo ? `${githubStatus.repo.owner}/${githubStatus.repo.name}` : "N/A"}
                </div>
              </div>
            </div>

            {/* Scopes */}
            <div>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>TOKEN SCOPES</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {REQUIRED_SCOPES.map((scope) => {
                  const present = (githubStatus.scopes ?? []).includes(scope);
                  return (
                    <div key={scope} style={scopeRowStyle(present)}>
                      {present ? (
                        <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} />
                      ) : (
                        <XCircle size={14} weight="fill" style={{ color: COLORS.warning }} />
                      )}
                      <span style={{ fontWeight: 600 }}>{scope}</span>
                      {!present && (
                        <span style={{ color: COLORS.warning, fontSize: 10 }}>MISSING</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Missing scopes warning */}
            {hasMissingScopes && (
              <div
                style={{
                  background: `${COLORS.warning}12`,
                  border: `1px solid ${COLORS.warning}30`,
                  borderRadius: 0,
                  padding: "10px 14px",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                }}
              >
                <Warning size={16} weight="fill" style={{ color: COLORS.warning, flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.warning, lineHeight: "18px" }}>
                  Missing required scope{missingScopes.length > 1 ? "s" : ""}: <strong>{missingScopes.join(", ")}</strong>.
                  Reconnect with a token that includes all required scopes.
                </div>
              </div>
            )}

            {/* Checked at */}
            {githubStatus.checkedAt && (
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                Last verified: {new Date(githubStatus.checkedAt).toLocaleString()}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                style={outlineButton()}
                disabled={githubBusy}
                onClick={handleRefreshStatus}
              >
                <ArrowsClockwise size={13} weight="bold" />
                {githubBusy ? "CHECKING..." : "REFRESH"}
              </button>
              <button
                style={{
                  ...outlineButton({ color: COLORS.danger, borderColor: `${COLORS.danger}40` }),
                }}
                disabled={githubBusy}
                onClick={handleClearToken}
              >
                <LinkBreak size={13} weight="bold" />
                DISCONNECT
              </button>
            </div>
          </div>
        ) : (
          /* ---- Not Connected State ---- */
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Token decryption failure warning */}
            {githubStatus?.tokenDecryptionFailed && (
              <div
                style={{
                  background: `${COLORS.warning}12`,
                  border: `1px solid ${COLORS.warning}30`,
                  borderRadius: 0,
                  padding: "10px 14px",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                }}
              >
                <Warning size={16} weight="fill" style={{ color: COLORS.warning, flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.warning, lineHeight: "18px" }}>
                  GitHub token exists but could not be decrypted. It may be corrupted. Please re-authenticate by saving a new token below.
                </div>
              </div>
            )}

            {/* Prompt */}
            <div style={{ fontSize: 13, fontFamily: MONO_FONT, color: COLORS.textSecondary, lineHeight: "20px" }}>
              Connect a GitHub Personal Access Token to enable PR management, branch operations, and repository integrations.
            </div>

            {/* Token input */}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ flex: 1, position: "relative" }}>
                <Key
                  size={14}
                  weight="bold"
                  style={{
                    position: "absolute",
                    left: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: COLORS.textDim,
                  }}
                />
                <input
                  type="password"
                  style={{ ...inputStyle, paddingLeft: 30 }}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  value={githubTokenDraft}
                  onChange={(e) => setGithubTokenDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveToken();
                  }}
                />
              </div>
              <button
                style={primaryButton({ minWidth: 110 })}
                disabled={githubBusy || !githubTokenDraft.trim()}
                onClick={handleSaveToken}
              >
                <ShieldCheck size={14} weight="bold" />
                {githubBusy ? "SAVING..." : "SAVE TOKEN"}
              </button>
            </div>

            {/* Instructions info box */}
            <div style={infoBoxStyle}>
              <div style={{ marginBottom: 6, fontWeight: 700, color: COLORS.textSecondary, letterSpacing: "0.5px" }}>
                HOW TO CREATE A TOKEN
              </div>
              <div>
                1. Go to{" "}
                <span style={{ color: COLORS.accent }}>github.com/settings/tokens</span>
                {" "}(classic tokens)
              </div>
              <div style={{ marginTop: 2 }}>
                2. Generate a new token with these scopes:{" "}
                <span style={{ color: COLORS.textPrimary, fontWeight: 600 }}>repo</span>,{" "}
                <span style={{ color: COLORS.textPrimary, fontWeight: 600 }}>workflow</span>,{" "}
                <span style={{ color: COLORS.textPrimary, fontWeight: 600 }}>read:org</span>
              </div>
              <div style={{ marginTop: 2 }}>
                3. Paste the token above and click Save Token
              </div>
              <div style={{ marginTop: 8, color: COLORS.textDim, fontSize: 10 }}>
                Token is encrypted using OS secure storage and stored locally under .ade/
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ========== AUTO-REBASE ========== */}
      <div style={cardStyle()}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 3,
                height: 20,
                background: autoRebaseDraft ? COLORS.accent : COLORS.border,
                flexShrink: 0,
              }}
            />
            <span style={LABEL_STYLE}>AUTO-REBASE</span>
          </div>
        </div>

        {/* Description */}
        <div
          style={{
            fontSize: 12,
            fontFamily: MONO_FONT,
            color: COLORS.textSecondary,
            lineHeight: "20px",
            marginBottom: 16,
          }}
        >
          Automatically rebase dependent lanes when a parent or main branch advances. Keeps feature lanes up to date without manual intervention.
        </div>

        {/* Toggle row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: COLORS.recessedBg,
            padding: "12px 16px",
            borderRadius: 0,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
            {autoRebaseDraft ? "Enabled" : "Disabled"}
          </span>

          {/* Toggle switch */}
          <button
            onClick={() => setAutoRebaseDraft(!autoRebaseDraft)}
            style={{
              position: "relative",
              width: 44,
              height: 24,
              background: autoRebaseDraft ? COLORS.accent : COLORS.border,
              border: "none",
              borderRadius: 0,
              cursor: "pointer",
              transition: "background 0.15s ease",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 3,
                left: autoRebaseDraft ? 23 : 3,
                width: 18,
                height: 18,
                background: autoRebaseDraft ? COLORS.pageBg : COLORS.textMuted,
                borderRadius: 0,
                transition: "left 0.15s ease",
              }}
            />
          </button>
        </div>

        {/* Save button */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            style={primaryButton()}
            disabled={autoRebaseBusy}
            onClick={() => void saveAutoRebaseSettings()}
          >
            {autoRebaseBusy ? "SAVING..." : "SAVE"}
          </button>
        </div>

        {/* Info note */}
        <div
          style={{
            marginTop: 14,
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textDim,
            lineHeight: "16px",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <Warning size={12} weight="fill" style={{ color: COLORS.textDim, flexShrink: 0, marginTop: 1 }} />
          When conflicts are predicted, ADE skips the rebase and marks the lane for manual resolution.
        </div>
      </div>
    </div>
  );
}
