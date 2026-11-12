import React, { useEffect, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { RecordingsWarningCard } from "./deviceSettingsCards";
import { readAppleRecordingsTotalBytes } from "./appleRecordingsFootprint";

/**
 * Read-only Diagnostics row. Shows only when Apple recordings on disk exceed
 * the warning size. No delete action — recordings stay until someone removes
 * them from the Apple column.
 */
export function AppleRecordingsWarning({ projectRoot, pin }: { projectRoot: string | null; pin: OpenProjectBinding | null }) {
  const warnBytes = useAppStore((s) => s.appleDevice.recordingsWarnBytes);
  const [totalBytes, setTotalBytes] = useState(0);
  // `pin` is the copy the page shows; its machine holds the recordings.
  const pinRef = React.useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot) {
      setTotalBytes(0);
      return;
    }
    void readAppleRecordingsTotalBytes(projectRoot, pinRef.current).then((bytes) => {
      if (!cancelled) setTotalBytes(bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, pinKey]);

  return (
    <RecordingsWarningCard
      anchor="apple-recordings-size"
      title="Apple recordings"
      totalBytes={totalBytes}
      warnBytes={warnBytes}
    />
  );
}
