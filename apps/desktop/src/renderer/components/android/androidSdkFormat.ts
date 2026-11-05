import type { AndroidSdkInstallState } from "../../../shared/types/androidEmulator";

/** `16 MB`, `2.2 GB`: decimal units, as Google's download pages print them. */
export function formatAndroidBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** `40 s left`, `3 min left`, or null before the speed is known. */
export function formatAndroidTimeLeft(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  const hours = Math.floor(seconds / 3600);
  return `${hours} h ${Math.round((seconds - hours * 3600) / 60)} min left`;
}

const STEP_VERB: Record<"download" | "verify" | "unpack" | "finish", string> = {
  download: "Downloading",
  verify: "Checking",
  unpack: "Unpacking",
  finish: "Finishing",
};

/** One progress line: `Downloading Emulator · 61% · 2 min left`. */
export function androidInstallLine(install: Extract<AndroidSdkInstallState, { state: "running" }>): { text: string; fraction: number } {
  const fraction = install.overallTotal > 0 ? Math.min(1, install.overallDone / install.overallTotal) : 0;
  const stepFraction = install.bytesTotal > 0 ? Math.min(1, install.bytesDone / install.bytesTotal) : 0;
  const parts = [`${STEP_VERB[install.step]} ${install.partLabel}`];
  if (install.step === "download" || install.step === "unpack") parts.push(`${Math.round(stepFraction * 100)}%`);
  if (install.partCount > 1) parts.push(`${install.partIndex + 1} of ${install.partCount}`);
  const left = install.step === "download" ? formatAndroidTimeLeft(install.etaSeconds) : null;
  if (left) parts.push(left);
  return { text: install.cancelling ? "Stopping the install…" : parts.join(" · "), fraction };
}
