import React, { useEffect, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { formatBytes } from "../../lib/format";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SettingsCard } from "./primitives";
import { readAppleRecordingsTotalBytes } from "./appleRecordingsFootprint";

/**
 * Read-only Diagnostics row. Shows only when Apple recordings on disk exceed
 * the warning size. No delete action — recordings stay until someone removes
 * them from the Apple column.
 */
export function AppleRecordingsWarning({ projectRoot }: { projectRoot: string | null }) {
  const warnBytes = useAppStore((s) => s.appleDevice.recordingsWarnBytes);
  const [totalBytes, setTotalBytes] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot) {
      setTotalBytes(0);
      return;
    }
    void readAppleRecordingsTotalBytes(projectRoot).then((bytes) => {
      if (!cancelled) setTotalBytes(bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  if (!(totalBytes > warnBytes) || warnBytes <= 0) return null;

  return (
    <SettingsCard
      anchor="apple-recordings-size"
      title="Apple recordings"
      description={`Using ${formatBytes(totalBytes)}, over the ${formatBytes(warnBytes)} warning size. ADE does not delete recordings.`}
      control={
        <span
          role="status"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 600,
            color: COLORS.warning,
          }}
        >
          <WarningCircle size={14} weight="fill" />
          {formatBytes(totalBytes)}
        </span>
      }
    />
  );
}
