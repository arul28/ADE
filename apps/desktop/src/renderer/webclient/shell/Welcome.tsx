import React from "react";
import { ScreenShell } from "./ScreenShell";
import { COLORS, SANS_FONT, primaryButton } from "./shellTokens";

const INSTALL_DESKTOP_URL = "https://ade-app.dev/download";

/** Shown when no machine has been paired yet. */
export function Welcome({ onPair }: { onPair: () => void }) {
  return (
    <ScreenShell
      title="ADE Web"
      subtitle="Work in ADE from any browser — your lanes, files, chats, and PRs, live from your machine. Pair once to get started."
    >
      <button type="button" style={primaryButton({ height: 40, width: "100%" })} onClick={onPair}>
        Pair a machine
      </button>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Get a pairing link and code from
        </div>
        <PairSource
          label="ADE desktop"
          detail="Settings › Sync › Web client — scan the QR or copy the link and code."
        />
        <PairSource
          label="The ADE iPhone app"
          detail="Settings › Pair a browser — for the machine your phone is connected to."
        />
      </div>

      <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
          No machine yet?
        </span>
        <a
          href={INSTALL_DESKTOP_URL}
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--color-accent)", fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, textDecoration: "none" }}
        >
          Install the desktop app ↗
        </a>
      </div>
    </ScreenShell>
  );
}

function PairSource({ label, detail }: { label: string; detail: string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600 }}>{label}</div>
      <div style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 12.5, lineHeight: 1.5 }}>{detail}</div>
    </div>
  );
}
