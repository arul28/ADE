import React from "react";
import { ScreenShell } from "./ScreenShell";
import { COLORS, SANS_FONT, primaryButton } from "./shellTokens";

/** Shown when no machine has been paired yet. */
export function Welcome({ onPair }: { onPair: () => void }) {
  return (
    <ScreenShell
      title="ADE in your browser"
      subtitle="Pair a machine running ADE desktop to work from any browser — your lanes, chats, files, and PRs, synced live."
      footer={
        <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>
          <li>Open ADE desktop and go to Settings &gt; Sync &gt; Web client.</li>
          <li>Enable the cloud relay so this page can reach your machine.</li>
          <li>Scan the QR or copy the pairing link, then pair here.</li>
        </ol>
      }
    >
      <button type="button" style={primaryButton({ height: 38, justifySelf: "start" })} onClick={onPair}>
        Pair a machine
      </button>
    </ScreenShell>
  );
}
