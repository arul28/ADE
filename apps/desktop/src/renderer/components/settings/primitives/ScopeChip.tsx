import { useEffect, useRef, useState } from "react";
import { THIS_MACHINE_NAME } from "../../../../shared/machineIdentity";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import type { SettingScope } from "../settingsManifest";

/**
 * Names where a setting saves, and therefore who it affects.
 *
 * ADE used to persist settings in four places that looked identical in the UI —
 * committed team YAML, gitignored machine YAML, main-process services, and
 * renderer localStorage — and the chip was the only thing that said which. It
 * was also, for most of its life, wrong: the scope was hand-typed at each call
 * site rather than read from the manifest, so two shipping rows claimed "only
 * this computer" for settings that reached every machine. The chip now takes
 * its answer from the same manifest the sidebar and the palette read, which is
 * what makes it trustworthy rather than decorative.
 */

type ScopeCopy = {
  label: string;
  color: string;
  storedIn: string;
  affects: string;
};

const SCOPE_COPY: Record<SettingScope, ScopeCopy> = {
  account: {
    label: "Account",
    color: COLORS.accent,
    storedIn: "Your ADE account",
    affects: "Every computer you sign in on.",
  },
  "account-repo": {
    label: "Account · this repo",
    color: COLORS.accent,
    storedIn: "Your ADE account, filed under this repository",
    affects: "Every computer you sign in on, but only inside this repository.",
  },
  machine: {
    // Sourced, never spelled out. A hardcoded "This Mac" made one object claim
    // two different machines, and lied outright on Windows.
    label: THIS_MACHINE_NAME,
    color: COLORS.warning,
    storedIn: "This computer only",
    affects: "Only this computer. It holds a path, a port, or a piece of hardware, so it would mean nothing anywhere else.",
  },
  "machine-repo": {
    label: `${THIS_MACHINE_NAME} · this repo`,
    color: COLORS.warning,
    storedIn: "This computer, filed under this repository",
    affects: "Only this computer, and only inside this repository.",
  },
};

export function ScopeChip({ scope, remoteMachineName }: { scope: SettingScope; remoteMachineName?: string | null }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const copy = SCOPE_COPY[scope];

  // A machine-scoped setting viewed through the remote banner writes to *that*
  // machine, not this one. Naming the local machine there would be a lie.
  const isRemote = scope.startsWith("machine") && !!remoteMachineName?.trim();
  const label = isRemote
    ? (scope === "machine-repo"
      ? `${remoteMachineName!.trim()} · this repo`
      : remoteMachineName!.trim())
    : copy.label;

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
        data-scope={scope}
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
            {isRemote ? `${copy.storedIn}, on ${remoteMachineName!.trim()}` : copy.storedIn}
          </span>
          <span style={{ display: "block", marginTop: 10, fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>
            Affects
          </span>
          <span style={{ display: "block", marginTop: 2, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>
            {isRemote ? `Only ${remoteMachineName!.trim()}.` : copy.affects}
          </span>
        </span>
      ) : null}
    </span>
  );
}
