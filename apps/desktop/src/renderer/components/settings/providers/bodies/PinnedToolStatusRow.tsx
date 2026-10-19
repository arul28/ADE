/**
 * The provider page's line about ADE's pinned copy of the provider: Ready
 * (pinned vX), Downloading…, Couldn't download (Retry), Not available on this
 * machine, or a Download button before the first use.
 *
 * Presentational: the page owns the {@link usePinnedToolStatus} handle (it is
 * read against the machine the Settings page shows) so it can also decide
 * whether the status sentence above would only repeat this line.
 */
import React from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { Banner } from "../../../ui/notice";
import { pinnedToolLine, type PinnedToolStatusHandle } from "../../../../hooks/usePinnedToolStatus";

const TONE_COLOR = {
  ready: COLORS.textSecondary,
  busy: COLORS.textSecondary,
  error: COLORS.danger,
  muted: COLORS.textMuted,
} as const;

export function PinnedToolStatusRow({
  handle,
  runtimeReady,
}: {
  handle: PinnedToolStatusHandle;
  runtimeReady: boolean;
}) {
  const { status, error, starting, download } = handle;
  if (!status) return null;
  const line = pinnedToolLine(status, { runtimeReady });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: TONE_COLOR[line.tone], lineHeight: 1.45, overflowWrap: "anywhere" }}>
        {line.text}
      </div>
      {line.action ? (
        <button
          type="button"
          disabled={starting}
          onClick={() => void download()}
          style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
        >
          <DownloadSimple size={13} />{" "}
          {starting ? "Starting…" : line.action === "retry" ? "Retry download" : `Download ${status.label}`}
        </button>
      ) : null}
      {error ? <Banner layout="inline" model={{ id: `pinned-tool-error-${status.provider}`, tone: "error", title: error }} /> : null}
    </div>
  );
}
