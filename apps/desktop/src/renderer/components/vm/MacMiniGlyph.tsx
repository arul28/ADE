import type { CSSProperties } from "react";

export function MacMiniGlyph({
  width = 120,
  height = 80,
  className,
  style,
}: {
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 120 80"
      role="img"
      aria-label="Mac mini"
      className={className}
      style={style}
    >
      <defs>
        <linearGradient id="ade-mac-mini-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2a2530" />
          <stop offset="100%" stopColor="#1a1620" />
        </linearGradient>
      </defs>
      {/* Soft ground shadow */}
      <ellipse cx="60" cy="68" rx="44" ry="3" fill="#000" opacity="0.35" />
      {/* Body — squat aluminum box with rounded corners */}
      <rect
        x="14"
        y="22"
        width="92"
        height="40"
        rx="6"
        ry="6"
        fill="url(#ade-mac-mini-top)"
        stroke="#3a3340"
        strokeWidth="1.25"
      />
      {/* Subtle top highlight to suggest a beveled lid */}
      <path
        d="M 20 24 Q 60 20 100 24"
        fill="none"
        stroke="#52525B"
        strokeWidth="0.75"
        strokeLinecap="round"
        opacity="0.55"
      />
      {/* Front face panel line */}
      <line
        x1="14"
        y1="56"
        x2="106"
        y2="56"
        stroke="#0c0a10"
        strokeWidth="0.75"
        opacity="0.65"
      />
      {/* Power LED dot */}
      <circle cx="22" cy="59" r="1.2" fill="#7dd3a8" opacity="0.85" />
    </svg>
  );
}
