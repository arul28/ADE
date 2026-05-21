import React from "react";
import { Link as LinkIcon, X } from "@phosphor-icons/react";

import {
  buildDeeplink,
  describeTarget,
  looksLikeAdeDeeplink,
  parseDeeplink,
} from "../../../shared/deeplinks";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

/**
 * Watches the system clipboard when the ADE window gains focus. If the
 * clipboard holds an `ade://` or `https://ade.app/open` URL that we haven't
 * already prompted on, shows a quiet banner offering to open it.
 */
export function ClipboardDeeplinkBanner(): React.ReactElement | null {
  const [candidate, setCandidate] = React.useState<{
    url: string;
    label: string;
  } | null>(null);
  const dismissedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    const readApi = (window.ade?.app as { readClipboardText?: () => Promise<string> } | undefined)
      ?.readClipboardText;
    if (typeof readApi !== "function") return;
    const check = async () => {
      try {
        const text = await readApi();
        if (!text || !looksLikeAdeDeeplink(text)) {
          setCandidate(null);
          return;
        }
        const parsed = parseDeeplink(text);
        if (!parsed.ok) {
          setCandidate(null);
          return;
        }
        if (dismissedRef.current.has(text)) return;
        setCandidate({ url: text, label: describeTarget(parsed.target) });
      } catch {
        // ignore
      }
    };
    void check();
    const onFocus = () => {
      void check();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (!candidate) return null;

  const onOpen = () => {
    const opener = window.ade?.app?.openExternal;
    if (typeof opener === "function") {
      const parsed = parseDeeplink(candidate.url);
      const url = parsed.ok ? buildDeeplink(parsed.target, { form: "ade" }) : candidate.url;
      void opener(url).catch(() => {});
    }
    dismissedRef.current.add(candidate.url);
    setCandidate(null);
  };

  const onDismiss = () => {
    dismissedRef.current.add(candidate.url);
    setCandidate(null);
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 150,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderRadius: 999,
        background: COLORS.cardBgSolid,
        border: `1px solid ${COLORS.border}`,
        boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
        fontFamily: SANS_FONT,
        fontSize: 12,
        color: COLORS.textPrimary,
      }}
    >
      <LinkIcon size={14} weight="bold" />
      <span>Found ADE link in clipboard — open {candidate.label}?</span>
      <button
        type="button"
        onClick={onOpen}
        style={{
          padding: "4px 10px",
          borderRadius: 999,
          border: "none",
          background: "var(--color-accent, #6ee7b7)",
          color: "var(--color-bg, #0a0a0a)",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Open
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          padding: 4,
          borderRadius: 999,
          border: "none",
          background: "transparent",
          color: COLORS.textSecondary,
          cursor: "pointer",
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
