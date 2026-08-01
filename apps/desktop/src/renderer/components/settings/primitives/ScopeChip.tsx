import { useEffect, useRef, useState } from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import type { SettingScope } from "../settingsManifest";

/**
 * ADE persists settings to four different places that look identical in the
 * UI — committed team YAML, gitignored machine YAML, main-process services,
 * and renderer localStorage. Add the remote-machine banner and a user cannot
 * tell whether a switch affects their laptop, their team, or a different
 * computer entirely. The chip names the scope; clicking it names the file.
 */

type ScopeCopy = {
  label: string;
  color: string;
  storedIn: string;
  affects: string;
};

const SCOPE_COPY: Record<SettingScope, ScopeCopy> = {
  team: {
    label: "Team",
    color: COLORS.info,
    storedIn: ".ade/ade.yaml — committed to the repo",
    affects: "Everyone who works in this repository, once you push.",
  },
  machine: {
    label: "This Mac",
    color: COLORS.warning,
    storedIn: ".ade/local.yaml and ADE's local services — gitignored",
    affects: "Only this computer. Nothing here is shared or committed.",
  },
  app: {
    label: "This app",
    color: COLORS.textMuted,
    storedIn: "ADE's local app storage",
    affects: "Only this ADE install. It won't follow you to another device.",
  },
};

export function ScopeChip({ scope, remoteMachineName }: { scope: SettingScope; remoteMachineName?: string | null }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const copy = SCOPE_COPY[scope];

  // A machine-scoped setting viewed through the remote banner writes to *that*
  // machine, not this one. Saying "This Mac" there would be a lie.
  const isRemote = scope !== "team" && !!remoteMachineName?.trim();
  const label = isRemote ? remoteMachineName!.trim() : copy.label;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={containerRef} style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Scope: ${label}. Show where this is stored.`}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "2px 8px",
          fontSize: 10,
          fontWeight: 500,
          fontFamily: SANS_FONT,
          letterSpacing: "0.02em",
          color: copy.color,
          background: `color-mix(in srgb, ${copy.color} 12%, transparent)`,
          border: `1px solid color-mix(in srgb, ${copy.color} 26%, transparent)`,
          borderRadius: 999,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span
          aria-hidden
          style={{ width: 5, height: 5, borderRadius: 999, background: copy.color, flexShrink: 0 }}
        />
        {label}
      </button>

      {open ? (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 40,
            width: 264,
            padding: 12,
            textAlign: "left",
            background: "var(--color-card)",
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,0.36)",
            fontFamily: SANS_FONT,
          }}
        >
          <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>
            Stored in
          </span>
          <span style={{ display: "block", marginTop: 2, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
            {isRemote ? `${copy.storedIn}, on ${label}` : copy.storedIn}
          </span>
          <span style={{ display: "block", marginTop: 10, fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>
            Affects
          </span>
          <span style={{ display: "block", marginTop: 2, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
            {isRemote ? `Only ${label}. Nothing here is shared or committed.` : copy.affects}
          </span>
        </span>
      ) : null}
    </span>
  );
}
