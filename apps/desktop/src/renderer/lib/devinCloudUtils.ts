// Shared helpers for Devin Cloud renderer components.

import { stripElectronErrorWrapper } from "../../shared/codedError";
import { devinCloudRepoMatchKey, repoMatchKey } from "../../shared/cursorCloudRepoMatch";
import type { DevinCloudFleetStatus, DevinCloudMode } from "../../shared/types/config";
import { formatCursorCloudAge } from "./cursorCloudUtils";

export { devinCloudRepoMatchKey, repoMatchKey };

export const DEVIN_BLUE = "#2563EB";

/** Fleet-status → status pill tone. needs_you is the loud attention tier. */
export function devinCloudStatusToneClass(status: DevinCloudFleetStatus | string | undefined | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "needs_you") return "border-amber-300/30 bg-amber-500/12 text-amber-100/90";
  if (s === "working") return "border-sky-300/25 bg-sky-500/10 text-sky-100/80";
  if (s === "starting") return "border-sky-300/20 bg-sky-500/[0.07] text-sky-100/70";
  if (s === "finished") return "border-emerald-400/22 bg-emerald-500/8 text-emerald-100/80";
  if (s === "error") return "border-red-400/22 bg-red-500/8 text-red-200/85";
  if (s === "suspended") return "border-white/[0.10] bg-white/[0.03] text-fg/45";
  if (s === "archived") return "border-white/[0.08] bg-transparent text-fg/40";
  return "border-white/[0.08] bg-white/[0.025] text-fg/55";
}

/** Human label for a `devin_mode` value (normal/fast/lite/ultra/fusion). */
export function devinCloudModeLabel(mode: DevinCloudMode | null | undefined): string {
  if (!mode) return "Normal";
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export const formatDevinCloudAge = formatCursorCloudAge;

/** `https://github.com/owner/repo` or `owner/repo` → `owner/repo` for compact display. */
export function devinCloudRepoLabel(ref: string): string {
  const key = repoMatchKey(ref) ?? ref.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = key.split("/");
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : key;
}

/**
 * Strip Electron's `Error invoking remote method '…':` wrapper so Devin Cloud
 * failures show the underlying message (token missing, org unresolved, etc.).
 */
export function devinCloudErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return stripElectronErrorWrapper(raw) || "Devin Cloud request failed.";
}

/** app.devin.ai session deep link — opens the session incl. its live Desktop view. */
export function devinCloudSessionWebUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
