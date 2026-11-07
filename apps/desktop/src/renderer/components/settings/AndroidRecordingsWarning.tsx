import type { OpenProjectBinding } from "../../../shared/types";
import { useAndroidMachinePreferences } from "../android/useAndroidMachinePreferences";
import { RecordingsWarningCard } from "./deviceSettingsCards";

/**
 * Read-only Diagnostics row, the Android twin of `AppleRecordingsWarning`.
 * Shows only when this project's Android recordings on the machine pass that
 * machine's warning size. Both numbers come from one runtime read
 * (`getMachinePreferences`) with the page's pin, so it is right for whichever
 * machine Diagnostics shows.
 */
export function AndroidRecordingsWarning({ pin }: { pin: OpenProjectBinding | null }) {
  const { preferences, recordingsBytes } = useAndroidMachinePreferences(pin);
  if (recordingsBytes == null) return null;
  return (
    <RecordingsWarningCard
      anchor="android-recordings-size"
      title="Android recordings"
      totalBytes={recordingsBytes}
      warnBytes={preferences?.recordingsWarnBytes ?? 0}
    />
  );
}
