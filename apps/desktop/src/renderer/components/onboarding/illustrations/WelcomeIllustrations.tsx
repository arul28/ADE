import React from "react";

/**
 * Decorative SVG illustrations for the WelcomeWizard.
 * Intentionally simple so they render instantly and theme cleanly via CSS vars.
 * Light animation is applied via inline <style> so we can key off the illustration id.
 */

const ACCENT = "var(--color-accent, #A78BFA)";
const ACCENT_SOFT = "rgba(167, 139, 250, 0.22)";
const INK = "var(--color-fg, #F0F0F2)";
const MUTED = "rgba(255, 255, 255, 0.55)";
const LINE = "rgba(255, 255, 255, 0.22)";
const SURFACE = "rgba(255, 255, 255, 0.04)";

function Frame({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 320 160"
      width="320"
      height="160"
      role="img"
      aria-label={label}
      className={className}
      style={{ maxWidth: "100%", height: "auto" }}
    >
      {children}
    </svg>
  );
}

export function WelcomeIllustration() {
  return (
    <Frame label="ADE lets you juggle many changes at once">
      <defs>
        <radialGradient id="ade-glow" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.35" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="320" height="160" fill="url(#ade-glow)" />
      {/* Center orb */}
      <g style={{ transformOrigin: "160px 80px", animation: "ade-illo-pulse 3.6s ease-in-out infinite" }}>
        <circle cx="160" cy="80" r="28" fill={ACCENT_SOFT} />
        <circle cx="160" cy="80" r="18" fill={ACCENT} opacity="0.95" />
      </g>
      {/* Orbiting lanes */}
      <g fill="none" stroke={LINE} strokeWidth="1" strokeDasharray="2 4">
        <ellipse cx="160" cy="80" rx="70" ry="28" />
        <ellipse cx="160" cy="80" rx="110" ry="44" />
      </g>
      <g>
        <circle cx="90" cy="80" r="5" fill={INK} opacity="0.8">
          <animate attributeName="cx" values="90;230;90" dur="6s" repeatCount="indefinite" />
          <animate attributeName="cy" values="80;80;80" dur="6s" repeatCount="indefinite" />
        </circle>
        <circle cx="50" cy="80" r="4" fill={INK} opacity="0.5">
          <animate attributeName="cx" values="50;270;50" dur="9s" repeatCount="indefinite" />
        </circle>
        <circle cx="230" cy="80" r="4" fill={INK} opacity="0.7">
          <animate attributeName="cx" values="230;90;230" dur="7.2s" repeatCount="indefinite" />
        </circle>
      </g>
    </Frame>
  );
}

export function LanesIllustration() {
  // Three stacked lane tabs with a spotlight on the middle one.
  return (
    <Frame label="Three Lanes side by side">
      <defs>
        <linearGradient id="ade-lane-active" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.9" />
          <stop offset="100%" stopColor="#EC4899" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      {/* Background soft rails */}
      <g stroke={LINE} strokeWidth="1" fill="none" strokeDasharray="2 6">
        <line x1="0" y1="26" x2="320" y2="26" />
        <line x1="0" y1="134" x2="320" y2="134" />
      </g>
      {/* Three lane cards */}
      <g>
        {/* Lane 1 */}
        <rect x="20" y="38" width="86" height="88" rx="10" fill={SURFACE} stroke={LINE} />
        <rect x="28" y="48" width="50" height="6" rx="3" fill={MUTED} />
        <rect x="28" y="62" width="70" height="4" rx="2" fill={LINE} />
        <rect x="28" y="72" width="64" height="4" rx="2" fill={LINE} />
        <rect x="28" y="82" width="40" height="4" rx="2" fill={LINE} />
        <circle cx="94" cy="114" r="4" fill={MUTED} />
        {/* Lane 2 (active) */}
        <rect x="117" y="30" width="86" height="104" rx="10" fill={SURFACE}
              stroke="url(#ade-lane-active)" strokeWidth="1.5"
              style={{ filter: "drop-shadow(0 6px 14px rgba(167,139,250,0.28))" }} />
        <rect x="125" y="42" width="56" height="6" rx="3" fill={INK} opacity="0.9" />
        <rect x="125" y="56" width="68" height="4" rx="2" fill={ACCENT} opacity="0.8" />
        <rect x="125" y="66" width="56" height="4" rx="2" fill={LINE} />
        <rect x="125" y="76" width="60" height="4" rx="2" fill={LINE} />
        <rect x="125" y="86" width="40" height="4" rx="2" fill={LINE} />
        <g>
          <circle cx="188" cy="118" r="5" fill={ACCENT}>
            <animate attributeName="r" values="5;6.5;5" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;0.55;1" dur="1.6s" repeatCount="indefinite" />
          </circle>
        </g>
        {/* Lane 3 */}
        <rect x="214" y="38" width="86" height="88" rx="10" fill={SURFACE} stroke={LINE} />
        <rect x="222" y="48" width="44" height="6" rx="3" fill={MUTED} />
        <rect x="222" y="62" width="64" height="4" rx="2" fill={LINE} />
        <rect x="222" y="72" width="56" height="4" rx="2" fill={LINE} />
        <rect x="222" y="82" width="36" height="4" rx="2" fill={LINE} />
        <circle cx="288" cy="114" r="4" fill={MUTED} />
      </g>
    </Frame>
  );
}

export function MissionsIllustration() {
  // A chat bubble pointing at a target with a small bot figure.
  return (
    <Frame label="A Worker running a Mission on its own Lane">
      <defs>
        <linearGradient id="ade-mission-ring" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} />
          <stop offset="100%" stopColor="#EC4899" />
        </linearGradient>
      </defs>
      {/* Target on the right */}
      <g transform="translate(232, 80)">
        <circle r="36" fill="none" stroke={LINE} strokeWidth="1" />
        <circle r="24" fill="none" stroke={LINE} strokeWidth="1" />
        <circle r="12" fill="none" stroke="url(#ade-mission-ring)" strokeWidth="2" />
        <circle r="4" fill={ACCENT}>
          <animate attributeName="r" values="4;6;4" dur="2.4s" repeatCount="indefinite" />
        </circle>
      </g>
      {/* Worker bubble on the left */}
      <g transform="translate(30, 52)">
        <rect width="120" height="56" rx="12" fill={SURFACE} stroke={LINE} />
        {/* Bot head icon */}
        <g transform="translate(12, 14)">
          <rect x="0" y="3" width="22" height="20" rx="5" fill={ACCENT} opacity="0.9" />
          <circle cx="7" cy="13" r="2" fill={INK} />
          <circle cx="15" cy="13" r="2" fill={INK} />
          <rect x="-2" y="9" width="2" height="6" rx="1" fill={ACCENT} opacity="0.5" />
          <rect x="22" y="9" width="2" height="6" rx="1" fill={ACCENT} opacity="0.5" />
        </g>
        {/* Message bars */}
        <rect x="44" y="14" width="64" height="5" rx="2.5" fill={INK} opacity="0.8" />
        <rect x="44" y="24" width="52" height="4" rx="2" fill={LINE} />
        <rect x="44" y="33" width="44" height="4" rx="2" fill={LINE} />
        {/* Tail */}
        <path d="M120 42 L132 48 L120 54 Z" fill={SURFACE} stroke={LINE} />
      </g>
      {/* Travel dots from bubble to target */}
      <g>
        <circle cx="160" cy="80" r="3" fill={ACCENT}>
          <animate attributeName="cx" values="160;220;160" dur="2.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.9;0.1;0.9" dur="2.6s" repeatCount="indefinite" />
        </circle>
        <circle cx="180" cy="80" r="2" fill={ACCENT}>
          <animate attributeName="cx" values="180;220;180" dur="2.6s" begin="0.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0.1;0.7" dur="2.6s" begin="0.4s" repeatCount="indefinite" />
        </circle>
        <circle cx="200" cy="80" r="2" fill={ACCENT}>
          <animate attributeName="cx" values="200;220;200" dur="2.6s" begin="0.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.5;0.1;0.5" dur="2.6s" begin="0.8s" repeatCount="indefinite" />
        </circle>
      </g>
    </Frame>
  );
}

export function HelpIllustration() {
  // Mock top-right with a highlighted ? button
  return (
    <Frame label="Help menu in the top right">
      {/* Fake window chrome */}
      <rect x="16" y="24" width="288" height="112" rx="10" fill={SURFACE} stroke={LINE} />
      {/* Traffic lights */}
      <g>
        <circle cx="30" cy="36" r="3" fill="#ff5f56" opacity="0.65" />
        <circle cx="40" cy="36" r="3" fill="#ffbd2e" opacity="0.65" />
        <circle cx="50" cy="36" r="3" fill="#27c93f" opacity="0.65" />
      </g>
      {/* Fake tabs row on the left */}
      <g>
        <rect x="70" y="30" width="36" height="14" rx="3" fill={LINE} />
        <rect x="112" y="30" width="36" height="14" rx="3" fill={LINE} />
        <rect x="154" y="30" width="36" height="14" rx="3" fill={LINE} />
      </g>
      {/* Right cluster: fake controls + highlighted ? */}
      <g>
        <rect x="230" y="30" width="14" height="14" rx="3" fill={LINE} />
        <rect x="250" y="30" width="14" height="14" rx="3" fill={LINE} />
        <g transform="translate(270, 30)">
          <rect width="14" height="14" rx="3" fill={ACCENT_SOFT} stroke={ACCENT} strokeWidth="1" />
          <text x="7" y="11" textAnchor="middle" fontFamily="inherit" fontSize="10"
                fontWeight="700" fill={ACCENT}>?</text>
          {/* Pulse ring */}
          <circle cx="7" cy="7" r="10" fill="none" stroke={ACCENT} strokeWidth="1.2">
            <animate attributeName="r" values="8;16;8" dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.8;0;0.8" dur="2s" repeatCount="indefinite" />
          </circle>
        </g>
      </g>
      {/* Callout dropdown from the ? button */}
      <g transform="translate(200, 62)">
        <rect width="92" height="56" rx="8" fill="var(--color-popup-bg, #141022)" stroke={LINE} />
        <rect x="8" y="10" width="60" height="5" rx="2.5" fill={INK} opacity="0.8" />
        <rect x="8" y="22" width="48" height="4" rx="2" fill={LINE} />
        <rect x="8" y="32" width="56" height="4" rx="2" fill={LINE} />
        <rect x="8" y="42" width="40" height="4" rx="2" fill={LINE} />
      </g>
      {/* Body placeholder */}
      <rect x="28" y="88" width="144" height="6" rx="3" fill={LINE} />
      <rect x="28" y="100" width="110" height="5" rx="2.5" fill={LINE} />
      <rect x="28" y="110" width="128" height="5" rx="2.5" fill={LINE} />
    </Frame>
  );
}
