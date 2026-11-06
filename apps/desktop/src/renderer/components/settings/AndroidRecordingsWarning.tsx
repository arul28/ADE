import { WarningCircle } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { formatBytes } from "../../lib/format";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { useAndroidMachinePreferences } from "../android/useAndroidMachinePreferences";
import { SettingsCard } from "./primitives";

/**
 * Read-only Diagnostics row, the Android twin of `AppleRecordingsWarning`.
 * Shows only when this project's Android recordings on the machine pass that
 * machine's warning size. Both numbers come from one runtime read
 * (`getMachinePreferences`) with the page's pin, so it is right for whichever
 * machine Diagnostics shows. No delete action: ADE never deletes recordings.
 */
export function AndroidRecordingsWarning({ pin }: { pin: OpenProjectBinding | null }) {
  const { preferences, recordingsBytes } = useAndroidMachinePreferences(pin);
  const warnBytes = preferences?.recordingsWarnBytes ?? 0;
  if (recordingsBytes == null || warnBytes <= 0 || !(recordingsBytes > warnBytes)) return null;

  return (
    <SettingsCard
      anchor="android-recordings-size"
      title="Android recordings"
      description={`Using ${formatBytes(recordingsBytes)}, over the ${formatBytes(warnBytes)} warning size. ADE does not delete recordings.`}
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
          {formatBytes(recordingsBytes)}
        </span>
      }
    />
  );
}
