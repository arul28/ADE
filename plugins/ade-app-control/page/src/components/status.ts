/**
 * The status vocabulary, moved out of `ChatAppControlPanel.tsx` unchanged.
 *
 * `statusInfo`, the two tone tables and the two element labellers are the
 * compiled pane's own (lines 199..264 and 190..197). They are copied rather
 * than reworded because the words themselves are the product: "Disconnected"
 * versus "Running" is the difference between the reader quitting the app and
 * the reader waiting for it, and the rule that tells them apart — a session
 * that once connected and now has no CDP endpoint — is subtle enough that
 * rewriting it would have been rewriting the diagnosis.
 */

import type { AppControlElement, AppControlSession } from "../types";

export type StatusTone = "idle" | "active" | "warn" | "muted" | "error";
export type StatusInfo = { label: string; detail: string; tone: StatusTone };

function shortId(value: string | null | undefined): string | null {
  return value ? value.slice(0, 8) : null;
}

export function statusInfo(session: AppControlSession | null): StatusInfo {
  if (!session) {
    return { label: "Idle", detail: "No active session", tone: "idle" };
  }
  const terminal = shortId(session.terminalSessionId);
  const waitingForCdp = session.cdpPort && !session.cdpEndpoint
    ? `waiting for CDP on 127.0.0.1:${session.cdpPort}`
    : null;
  const suffix = [waitingForCdp, terminal ? `terminal ${terminal}` : null].filter(Boolean).join(" · ");
  // The launch terminal is alive but the controlled app's CDP target is gone —
  // either it never connected yet or the user quit it after we attached.
  const lostConnection = session.status === "running" && Boolean(session.connectedAt) && !session.cdpEndpoint;
  switch (session.status) {
    case "connected":
      return {
        label: "Connected",
        detail: session.cdpPort ? `${session.label} on CDP port ${session.cdpPort}` : session.label,
        tone: "active",
      };
    case "starting":
      return { label: "Starting", detail: `${session.label} is starting${suffix ? ` · ${suffix}` : ""}`, tone: "warn" };
    case "running":
      if (lostConnection) {
        return {
          label: "Disconnected",
          detail: session.lastError ?? `${session.label} stopped responding. The app may have quit while the launch terminal is still running.`,
          tone: "error",
        };
      }
      return { label: "Running", detail: `${session.label} is running${suffix ? ` · ${suffix}` : " in the terminal"}`, tone: "warn" };
    case "stopping":
      return { label: "Stopping", detail: `${session.label} is stopping`, tone: "warn" };
    case "exited":
      return { label: "Exited", detail: `${session.label} has exited`, tone: "muted" };
    case "stopped":
      return { label: "Stopped", detail: `${session.label} stopped`, tone: "muted" };
    case "failed":
      return { label: "Failed", detail: session.lastError ?? `${session.label} failed`, tone: "error" };
    default:
      return { label: session.status, detail: session.label, tone: "muted" };
  }
}

export const STATUS_PILL_TONE: Record<StatusTone, string> = {
  idle: "border-white/[0.08] bg-white/[0.03] text-muted-fg/65",
  active: "border-emerald-400/25 bg-emerald-500/10 text-emerald-100/85",
  warn: "border-amber-400/25 bg-amber-500/10 text-amber-100/85",
  muted: "border-white/[0.08] bg-white/[0.03] text-muted-fg/55",
  error: "border-rose-400/30 bg-rose-500/10 text-rose-200/85",
};

export const STATUS_DOT_TONE: Record<StatusTone, string> = {
  idle: "bg-muted-fg/45",
  active: "bg-emerald-300",
  warn: "bg-amber-300",
  muted: "bg-muted-fg/40",
  error: "bg-rose-300",
};

export function elementLabel(element: AppControlElement): string {
  return element.label ?? element.value ?? element.testId ?? element.role ?? element.tagName ?? "element";
}

export function elementSubLabel(element: AppControlElement): string | null {
  if (element.role && (element.label || element.value)) return element.role;
  if (element.tagName && element.label) return element.tagName.toLowerCase();
  return null;
}

/**
 * A target's line in the window picker, moved unchanged.
 *
 * Deliberately NOT numbered positionally: `/json/list` order is not stable
 * across polls, so a "Window N" label would point at a different underlying
 * target between refreshes. URL plus a short id suffix, which is always unique.
 */
export function targetLabel(target: { id: string; title: string | null; url: string | null }): string {
  const baseTitle = (target.title ?? "").trim();
  const url = (target.url ?? "").trim();
  const urlLabel = url ? url.replace(/^https?:\/\//, "").replace(/^file:\/\//, "") : "";
  const idSuffix = target.id.length > 6 ? `…${target.id.slice(-6)}` : target.id;
  return [baseTitle || null, urlLabel || null, idSuffix]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join(" · ")
    .slice(0, 130);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
