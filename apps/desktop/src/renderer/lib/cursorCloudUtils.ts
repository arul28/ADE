// Shared helpers for Cursor Cloud renderer components.

import { repoMatchKey } from "../../shared/cursorCloudRepoMatch";

export { repoMatchKey };

/** Superset tone map for cloud-agent status pills across cloud surfaces. */
export function cursorCloudStatusToneClass(status: string | undefined | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "running") return "border-violet-300/30 bg-violet-500/10 text-violet-100/85";
  if (s === "creating") return "border-sky-300/25 bg-sky-500/10 text-sky-100/80";
  if (s === "finished" || s === "completed") return "border-emerald-400/22 bg-emerald-500/8 text-emerald-100/80";
  if (s === "error" || s === "failed" || s === "expired") return "border-red-400/22 bg-red-500/8 text-red-200/85";
  if (s === "cancelled") return "border-white/[0.10] bg-white/[0.03] text-fg/45";
  if (s === "archived") return "border-white/[0.08] bg-transparent text-fg/40";
  return "border-white/[0.08] bg-white/[0.025] text-fg/55";
}

export function formatCursorCloudAge(value: number | string | null | undefined): string | null {
  const ts = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const delta = Date.now() - ts;
  if (delta < 0) return null;
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** `https://github.com/owner/repo` → `owner/repo` for compact row display. */
export function cursorCloudRepoLabel(url: string): string {
  const key = repoMatchKey(url);
  if (!key) return url;
  const parts = key.split("/");
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : key;
}

/**
 * Strip Electron's `Error invoking remote method '…':` wrapper so Cursor Cloud
 * failures show the underlying message (API key missing, repo access, etc.).
 */
export function cursorCloudErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim()
    || "Cursor Cloud request failed.";
}

export type CursorCloudExistingPr = {
  prUrl: string;
  prNumber: number | null;
  title: string | null;
};

/**
 * `prUrl` and `autoCreatePR` are create-time only. If the branch already has a
 * PR, attach to it — do not also ask Cursor to open another.
 */
export function resolveCursorCloudPrCreateFields(input: {
  existingPrUrl?: string | null;
  autoCreatePR?: boolean;
}): { autoCreatePR: boolean; prUrl?: string } {
  const prUrl = input.existingPrUrl?.trim() || "";
  if (prUrl) return { autoCreatePR: false, prUrl };
  return { autoCreatePR: input.autoCreatePR === true };
}

/** Public Cursor Cloud agent URL. The in-app `#/cloud` route is not shipped. */
export function cursorCloudAgentWebUrl(agentId: string | null | undefined): string | null {
  const id = agentId?.trim();
  if (!id) return null;
  return `https://cursor.com/agents?id=${encodeURIComponent(id)}`;
}
