import React, { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { RecordingsWarningCard } from "./deviceSettingsCards";
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

  return (
    <RecordingsWarningCard
      anchor="apple-recordings-size"
      title="Apple recordings"
      totalBytes={totalBytes}
      warnBytes={warnBytes}
    />
  );
}
