import { useCallback, useState, type CSSProperties } from "react";
import { CircleNotch, GithubLogo, Key } from "@phosphor-icons/react";
import { extractError } from "../../lib/format";
import { describeGithubPatVerification } from "../../lib/githubIntegrationStatus";
import { isImeComposing } from "../../lib/imeComposition";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  fgTint,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { Banner, noticeKindModel, type NoticeKind } from "../ui/notice";

const inputStyle: CSSProperties = {
  height: 36,
  padding: "0 12px",
  fontSize: 13,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  background: fgTint(4),
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

/**
 * Asks for GitHub access when the repository list cannot load: `gh auth
 * login`, or a personal access token saved on this computer.
 */
export function ConnectGithubPrompt({
  statusError,
  onConnected,
  onCancel,
}: {
  statusError: string | null;
  onConnected: () => void;
  onCancel: () => void;
}) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);

  const [error, setError] = useState<{ message: string; kind: NoticeKind } | null>(null);

  const handleSave = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setError({ message: "Enter a token", kind: "hint" });
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await window.ade.github.setToken(trimmed);
      const verification = describeGithubPatVerification(result);
      if (!verification.verified) {
        setError({ message: verification.message, kind: "hint" });
        return;
      }
      onConnected();
    } catch (err) {
      setError({ message: extractError(err), kind: "failure" });
    } finally {
      setPending(false);
    }
  }, [onConnected, token]);

  return (
    <div
      style={cardStyle({
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      })}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            borderRadius: 8,
            background:
              "color-mix(in srgb, var(--color-accent) 15%, transparent)",
            color: COLORS.accent,
          }}
        >
          <GithubLogo size={18} weight="fill" />
        </span>
        <div>
          <div
            style={{
              fontFamily: SANS_FONT,
              fontSize: 14,
              fontWeight: 600,
              color: COLORS.textPrimary,
            }}
          >
            Connect GitHub to browse your repos
          </div>
          <div
            style={{
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textMuted,
              marginTop: 2,
            }}
          >
            Run gh auth login, then retry. You can also paste a personal access token.
          </div>
        </div>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ ...LABEL_STYLE, letterSpacing: "0.08em" }}>
          PERSONAL ACCESS TOKEN
        </span>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="ghp_... or github_pat_..."
          style={{ ...inputStyle, fontFamily: MONO_FONT, fontSize: 12 }}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "Enter" && !pending) {
              event.preventDefault();
              void handleSave();
            }
          }}
          disabled={pending}
        />
      </label>

      {error || statusError ? (
        <Banner
          layout="inline"
          model={{
            id: "clone-github-connect-error",
            ...noticeKindModel(error?.kind ?? "failure", error?.kind === "failure" || !error ? { surface: "clone_github_connect" } : undefined),
            title: error?.message ?? statusError,
          }}
        />
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          style={outlineButton()}
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="button"
          style={primaryButton({ minWidth: 130 })}
          onClick={() => {
            void handleSave();
          }}
          disabled={pending || token.trim().length === 0}
        >
          {pending ? (
            <>
              <CircleNotch size={12} weight="bold" className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Key size={12} weight="bold" />
              Save token
            </>
          )}
        </button>
      </div>
    </div>
  );
}
