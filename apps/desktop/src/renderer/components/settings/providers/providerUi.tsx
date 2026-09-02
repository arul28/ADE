/** Small shared pieces every provider tile, detail page, and body draws from. */
import React from "react";
import { CheckCircle, Copy, X, XCircle } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import type { ApiKeySource } from "../OpenCodeProviderDetailModal";
import type { ProviderStatusState } from "./types";

export function prettifyProviderId(id: string): string {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const STATUS_COLORS: Record<ProviderStatusState, string> = {
  checking: COLORS.info,
  connected: COLORS.success,
  "sign-in": COLORS.warning,
  attention: COLORS.danger,
  "not-installed": COLORS.textDim,
  disabled: COLORS.textDim,
};

export function providerStatusColor(state: ProviderStatusState): string {
  return STATUS_COLORS[state];
}

/**
 * Dot + sentence-case word. The only status vocabulary on this page.
 *
 * Deliberately NOT an uppercase letterspaced chip: at "Sign in required" that
 * treatment was the widest thing in a tile header and it pushed provider names
 * ("GitHub Copilot") into an ellipsis. A dot and a normal sentence carry the
 * same state in roughly half the width, and read as English rather than as a
 * console banner.
 */
export function ProviderStatusChip({
  state,
  label,
}: {
  state: ProviderStatusState;
  label: string;
}) {
  const color = providerStatusColor(state);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: 999, background: color, flexShrink: 0 }}
      />
      <span
        style={{
          fontSize: 11,
          fontFamily: SANS_FONT,
          color,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * The version core a provider page and tile should print.
 *
 * Vendors do not agree on what `--version` means: Pi answers `0.84.0`, Grok
 * answers `grok 1.0.13 (5e9a58528b76) [stable]`, and the tile used to bolt a
 * `v` onto whatever arrived — which is how a tile ended up rendering
 * `vgrok 1.0.13 (5e9a58528b76) [stable]`, wider than the tile itself. The only
 * part a user acts on is the dotted number, so that is what is kept: the first
 * semver-shaped token, with the binary name, the leading `v`, the commit hash,
 * and the channel tag dropped.
 *
 * A ` · ` annotation ADE itself appended (Pi's `· cached`) survives, because it
 * is ADE's claim about the number rather than vendor noise around it.
 */
export function normalizeProviderVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const [head = "", ...notes] = raw.split("·").map((part) => part.trim());
  const core = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?/.exec(head)?.[0] ?? null;
  if (!core) return null;
  const kept = notes.filter(Boolean);
  return kept.length > 0 ? `${core} · ${kept.join(" · ")}` : core;
}

export function AlertBanner({
  tone,
  message,
  onDismiss,
}: {
  tone: "success" | "error" | "warning";
  message: string;
  onDismiss: () => void;
}) {
  const color = tone === "success" ? COLORS.success : tone === "warning" ? COLORS.warning : COLORS.danger;
  const token = tone === "success" ? "success" : tone === "warning" ? "warning" : "error";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        padding: "8px 10px 8px 12px",
        fontSize: 11,
        fontFamily: SANS_FONT,
        lineHeight: 1.5,
        color,
        background: `color-mix(in srgb, var(--color-${token}) 12%, transparent)`,
        border: `1px solid color-mix(in srgb, var(--color-${token}) 30%, transparent)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{message}</span>
      <button
        type="button"
        aria-label={`Dismiss ${tone} message`}
        onClick={onDismiss}
        style={{
          border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
          background: "transparent",
          color,
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}

const SOURCE_BADGE_MAP: Record<ApiKeySource, { color: string; label: string }> = {
  store: { color: COLORS.success, label: "Local store" },
  env: { color: COLORS.info, label: "Environment" },
  config: { color: COLORS.warning, label: "Project config" },
};

export function SourceBadge({ source }: { source: ApiKeySource }) {
  const { color, label } = SOURCE_BADGE_MAP[source];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        fontSize: 10,
        fontWeight: 600,
        fontFamily: SANS_FONT,
        color,
        background: `${color}18`,
        border: `1px solid ${color}30`,
      }}
    >
      {label}
    </span>
  );
}

export function CopyableCommand({ command }: { command: string }) {
  const { copy, copied } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => void copy(command)}
      title="Copy"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        width: "100%",
        textAlign: "left",
        fontSize: 11,
        fontFamily: MONO_FONT,
        color: COLORS.textSecondary,
        background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)",
        border: `1px solid ${COLORS.border}`,
        padding: "8px 10px",
        cursor: "pointer",
      }}
    >
      <code style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>{command}</code>
      {copied ? (
        <CheckCircle size={13} weight="fill" style={{ flexShrink: 0, color: COLORS.success }} />
      ) : (
        <Copy size={13} weight="bold" style={{ flexShrink: 0 }} />
      )}
    </button>
  );
}

/**
 * Copy a block of diagnostic text.
 *
 * Distinct from `CopyableCommand`: that renders what it copies, which is right
 * for a one-line install command and wrong for a twenty-line report.
 */
export function CopyReportButton({ report, label }: { report: string; label: string }) {
  const { copy, copied } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => void copy(report)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: 28,
        width: "100%",
        fontSize: 11,
        fontFamily: SANS_FONT,
        color: COLORS.textSecondary,
        background: "transparent",
        border: `1px solid ${COLORS.border}`,
        cursor: "pointer",
      }}
    >
      {copied ? <CheckCircle size={12} weight="fill" /> : <Copy size={12} weight="bold" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** A filesystem path or a command. The only place mono type is load-bearing. */
export function PathLine({ value }: { value: string }) {
  return (
    <code
      style={{
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        minWidth: 0,
        fontSize: 10,
        fontFamily: MONO_FONT,
        color: COLORS.textSecondary,
        background: "color-mix(in srgb, var(--color-muted-fg) 12%, transparent)",
        border: `1px solid ${COLORS.border}`,
        padding: "6px 8px",
        overflowWrap: "anywhere",
        wordBreak: "break-all",
      }}
    >
      {value}
    </code>
  );
}

/** The Settings-only tier label. Pickers never show it. */
export function PreviewChip() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 6px",
        fontSize: 10,
        fontFamily: SANS_FONT,
        whiteSpace: "nowrap",
        flexShrink: 0,
        color: COLORS.info,
        border: `1px solid color-mix(in srgb, var(--color-info) 30%, transparent)`,
        background: "color-mix(in srgb, var(--color-info) 12%, transparent)",
      }}
    >
      Preview
    </span>
  );
}

export function SubsectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontFamily: SANS_FONT,
        fontWeight: 700,
        color: COLORS.textSecondary,
      }}
    >
      {children}
    </div>
  );
}

/** The one-line error a failed enumerate renders as. */
export function ProviderErrorRow({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        padding: "6px 8px",
        fontSize: 11,
        fontFamily: SANS_FONT,
        lineHeight: 1.5,
        color: COLORS.danger,
        background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-error) 26%, transparent)",
        overflowWrap: "anywhere",
      }}
    >
      <XCircle size={12} weight="fill" style={{ flexShrink: 0, marginTop: 2 }} />
      <span>{message}</span>
    </div>
  );
}
