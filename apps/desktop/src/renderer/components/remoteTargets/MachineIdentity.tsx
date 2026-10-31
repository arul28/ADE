import "./machines.css";
import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { AppleLogo as PhosphorAppleLogo, Desktop, LinuxLogo, WindowsLogo } from "@phosphor-icons/react";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

/**
 * How a machine is recognised at a glance: a drawing of the kind of computer
 * it is, tinted with the machine's own color.
 *
 * The platform comes from what the machine reports, so a new machine looks
 * right with no setup. The color starts as one picked from the machine's
 * stable key, which every device computes the same way, so "the teal one" is
 * the same machine on the laptop, the desktop and the phone. A color picked by
 * hand overrides it on this computer.
 */

export type MachinePlatform = "mac" | "windows" | "linux" | "unknown";

/** Platform from an arch label ("darwin-arm64", "win32-x64", "macOS"…) or a directory platform. */
export function machinePlatform(...hints: Array<string | null | undefined>): MachinePlatform {
  for (const hint of hints) {
    const value = hint?.trim().toLowerCase() ?? "";
    if (!value || value === "unknown") continue;
    if (/darwin|mac|osx|apple/.test(value)) return "mac";
    if (/win/.test(value)) return "windows";
    if (/linux|ubuntu|debian|fedora|arch/.test(value)) return "linux";
  }
  return "unknown";
}

/**
 * The shape of the computer. A laptop reports a battery; a desktop reports
 * wall power and no battery. The name splits desktops further, since a Mac
 * Studio, a Mac mini and an iMac look nothing alike.
 */
export type MachineFormFactor = "laptop" | "box" | "all-in-one" | "desktop";

export function machineFormFactor(args: {
  name?: string | null;
  /** The machine's last power report: `{ battery }` on a laptop, none on a desktop. */
  power?: { battery?: unknown } | null;
}): MachineFormFactor {
  const name = args.name ?? "";
  if (/mac\s*studio|mac\s*mini|mac\s*pro\b(?!.*book)/i.test(name) && !/macbook/i.test(name)) return "box";
  if (/\bimac\b/i.test(name)) return "all-in-one";
  if (/macbook|laptop|notebook|thinkpad|surface\s*laptop|xps\s*1[3-7]/i.test(name)) return "laptop";
  if (args.power) return args.power.battery ? "laptop" : "desktop";
  return "desktop";
}

/** Distinct in dark and light themes, and none of them read as an error or a warning. */
const MACHINE_COLOR_NAMES = {
  "#7c83ff": "Indigo",
  "#2bc4b4": "Teal",
  "#e8a33d": "Amber",
  "#e26fb1": "Pink",
  "#3aa8e8": "Sky",
  "#8fc93a": "Lime",
  "#f08a4b": "Orange",
} as const;

export const MACHINE_COLORS = Object.keys(MACHINE_COLOR_NAMES) as Array<keyof typeof MACHINE_COLOR_NAMES>;

function hashKey(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function defaultMachineColor(key: string): string {
  return MACHINE_COLORS[hashKey(key) % MACHINE_COLORS.length]!;
}

const STORAGE_KEY = "ade.machineColors.v1";
let overrides: Record<string, string> = readOverrides();
const listeners = new Set<() => void>();

function readOverrides(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && (MACHINE_COLORS as readonly string[]).includes(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    overrides = readOverrides();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setMachineColor(key: string, color: string | null): void {
  const next = { ...overrides };
  if (color && color !== defaultMachineColor(key)) next[key] = color;
  else delete next[key];
  overrides = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The color still applies for this session.
  }
  for (const listener of listeners) listener();
}

export function useMachineColor(key: string): string {
  const current = useSyncExternalStore(subscribe, () => overrides, () => overrides);
  return current[key] ?? defaultMachineColor(key);
}

function tint(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/**
 * A machine's platform logo. `platform` is a `MachinePlatform` or any raw hint
 * `machinePlatform` reads ("darwin", "win32-x64"…). An unknown platform draws
 * `fallback` (a plain desktop when `true`), else nothing.
 */
export function MachinePlatformLogo({
  platform,
  size,
  weight = "fill",
  fallback = false,
}: {
  platform: string | null | undefined;
  size: number;
  weight?: "fill" | "bold";
  fallback?: boolean;
}) {
  const props = { size, weight };
  const kind = machinePlatform(platform);
  if (kind === "mac") return <PhosphorAppleLogo {...props} />;
  if (kind === "windows") return <WindowsLogo {...props} />;
  if (kind === "linux") return <LinuxLogo {...props} />;
  return fallback ? <Desktop {...props} /> : null;
}

/**
 * The computer as a thin outline, in the same 1.5px stroke as the app's other
 * icons, with the platform's logo where its screen (or face) is.
 */
function DeviceGlyph({ platform, formFactor, size }: { platform: MachinePlatform; formFactor: MachineFormFactor; size: number }) {
  // Where the logo sits, in the 24-unit grid, and how big it is.
  const face = formFactor === "laptop"
    ? { cx: 12, cy: 10.5, logo: 7.5 }
    : formFactor === "box"
      ? { cx: 12, cy: 13.5, logo: 6.5 }
      : formFactor === "all-in-one"
        ? { cx: 12, cy: 8.5, logo: 7 }
        : { cx: 12, cy: 10, logo: 8 };
  const unit = size / 24;
  const logoSize = Math.round(face.logo * unit);
  return (
    <span style={{ position: "relative", display: "inline-block", width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {formFactor === "laptop" ? (
          <>
            <rect x="4.5" y="5" width="15" height="11" rx="1.5" />
            <path d="M2.5 19h19" />
          </>
        ) : formFactor === "box" ? (
          <>
            <rect x="3.5" y="8" width="17" height="11" rx="2.5" />
            <path d="M7.5 21h9" opacity={0.5} />
          </>
        ) : formFactor === "all-in-one" ? (
          <>
            <rect x="3" y="3.5" width="18" height="13" rx="2" />
            <path d="M3 13.5h18" opacity={0.5} />
            <path d="M10 16.5 9.5 20.5h5l-.5-4" />
          </>
        ) : (
          <>
            <rect x="3" y="4" width="18" height="12" rx="1.5" />
            <path d="M12 16v4M8.5 20h7" />
          </>
        )}
      </svg>
      {platform !== "unknown" ? (
        <span
          style={{
            position: "absolute",
            left: (face.cx * unit) - logoSize / 2,
            top: (face.cy * unit) - logoSize / 2,
            width: logoSize,
            height: logoSize,
            display: "grid",
            placeItems: "center",
          }}
        >
          <MachinePlatformLogo platform={platform} size={logoSize} />
        </span>
      ) : null}
    </span>
  );
}

const PLATFORM_LABEL: Record<MachinePlatform, string> = {
  mac: "Mac",
  windows: "Windows",
  linux: "Linux",
  unknown: "Computer",
};

const FORM_FACTOR_LABEL: Record<MachineFormFactor, string> = {
  laptop: "laptop",
  box: "desktop",
  "all-in-one": "all-in-one",
  desktop: "desktop",
};

export function machineKindLabel(platform: MachinePlatform, formFactor: MachineFormFactor): string {
  return `${PLATFORM_LABEL[platform]} ${FORM_FACTOR_LABEL[formFactor]}`;
}

/**
 * The machine's tile: its platform's logo, flat, in the machine's color, on a
 * plain square. With `editable`, a click opens a small swatch row.
 */
export function MachineAvatar({
  colorKey,
  name,
  platform,
  formFactor = "desktop",
  size = 40,
  editable = false,
  dimmed = false,
}: {
  colorKey: string;
  name: string;
  platform: MachinePlatform;
  formFactor?: MachineFormFactor;
  size?: number;
  editable?: boolean;
  dimmed?: boolean;
}) {
  const color = useMachineColor(colorKey);
  const [picking, setPicking] = useState(false);
  const tile: CSSProperties = {
    position: "relative",
    flexShrink: 0,
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.26),
    display: "grid",
    placeItems: "center",
    color: dimmed ? COLORS.textMuted : color,
    background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
    boxShadow: `inset 0 0 0 1px ${COLORS.border}`,
    padding: 0,
    border: "none",
    cursor: editable ? "pointer" : "default",
  };
  const drawing = <DeviceGlyph platform={platform} formFactor={formFactor} size={Math.round(size * 0.8)} />;
  if (!editable) {
    return (
      <span style={tile} role="img" aria-label={`${name}, ${machineKindLabel(platform, formFactor)}`}>
        {drawing}
      </span>
    );
  }
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        style={tile}
        aria-label={`${name}, ${machineKindLabel(platform, formFactor)}. Change color`}
        aria-expanded={picking}
        title="Change color"
        onClick={() => setPicking((open) => !open)}
      >
        {drawing}
      </button>
      {picking ? (
        <span
          role="group"
          aria-label={`${name} color`}
          onMouseLeave={() => setPicking(false)}
          style={{
            position: "absolute",
            top: size + 6,
            left: 0,
            zIndex: 5,
            display: "flex",
            gap: 6,
            padding: 8,
            borderRadius: 10,
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.border}`,
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          }}
        >
          {MACHINE_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={MACHINE_COLOR_NAMES[swatch]}
              aria-pressed={swatch === color}
              onClick={() => {
                setMachineColor(colorKey, swatch);
                setPicking(false);
              }}
              style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                padding: 0,
                cursor: "pointer",
                background: swatch,
                border: "none",
                boxShadow: swatch === color ? `0 0 0 2px ${COLORS.cardBgSolid}, 0 0 0 4px ${swatch}` : "none",
              }}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** A version as a small mono pill; `from → to` when the machine is behind. */
export function VersionChip({ version, target, tone = "muted" }: { version: string | null; target?: string | null; tone?: "muted" | "success" | "accent" }) {
  if (!version && !target) return null;
  const color = tone === "success" ? COLORS.success : tone === "accent" ? COLORS.accent : COLORS.textMuted;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 7px",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        lineHeight: "15px",
        whiteSpace: "nowrap",
        color,
        border: `1px solid ${tone === "muted" ? COLORS.border : tint(tone === "success" ? "var(--color-success)" : "var(--color-accent)", 0.4)}`,
      }}
    >
      {version ?? "?"}
      {target && target !== version ? (
        <>
          <span aria-hidden style={{ opacity: 0.7 }}>→</span>
          <span style={{ color: COLORS.textPrimary }}>{target}</span>
        </>
      ) : null}
    </span>
  );
}

/** The status dot beside a machine's name. */
export function PresenceDot({ state }: { state: "online" | "busy" | "offline" | "error" }) {
  const color = state === "online"
    ? COLORS.success
    : state === "busy"
      ? COLORS.accent
      : state === "error"
        ? COLORS.danger
        : "transparent";
  return (
    <span
      aria-hidden
      className={state === "busy" ? "ade-machine-pulse" : undefined}
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        flexShrink: 0,
        background: color,
        boxShadow: state === "offline" ? `inset 0 0 0 1.5px ${COLORS.textMuted}` : state === "online" ? `0 0 0 3px ${tint("var(--color-success)", 0.18)}` : "none",
        fontFamily: SANS_FONT,
      }}
    />
  );
}
