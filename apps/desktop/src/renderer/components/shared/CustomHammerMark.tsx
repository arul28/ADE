import React from "react";

/**
 * The mark for Custom — ADE's own saved agent-plus-model setups.
 *
 * Every other entry in the provider rail and the providers list is a company's
 * brand mark, so the one entry that is *yours* needs a mark of its own rather
 * than a second copy of the ADE logo: the ADE logo already sits in the title
 * bar, and reusing it made "Custom" read as "ADE the app" instead of "the ones
 * I built". A hammer is the shortest way to say built-here.
 *
 * Drawn rather than imported so it inherits the size every call site gives its
 * provider logos — the rail, the settings row, the manager page and the
 * wizard's default logo tile all pass the same `size` they pass `ProviderLogo`,
 * and the mark lands on the same baseline as the brand marks beside it.
 *
 * The tilt is deliberate and small: 18° reads as a tool in mid-swing at 16px,
 * where 45° just reads as a crooked icon.
 */
export function CustomHammerMark({
  size = 20,
  color = "#a78bfa",
  className,
  title,
}: {
  size?: number;
  /** Overridable so a preset's own accent can carry the mark. */
  color?: string;
  className?: string;
  /** Names the mark for a screen reader. Omitted leaves it decorative. */
  title?: string;
}) {
  return (
    <svg
      data-custom-hammer=""
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={{ display: "block", flexShrink: 0, overflow: "visible" }}
    >
      <g transform="rotate(18 12 12)">
        {/* Handle — rounded, tapering into the head. */}
        <path
          d="M11.1 10.6 L6.0 19.4a1.5 1.5 0 0 0 2.6 1.5l5.1-8.8"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Head — one solid block, so the mark still reads at 14px. */}
        <path
          d="M8.9 8.0 L15.3 4.3a2 2 0 0 1 2.7 0.7l1.9 3.3a2 2 0 0 1-0.7 2.7l-6.4 3.7z"
          fill={color}
          fillOpacity={0.9}
        />
        {/* Claw — the notch that tells a hammer from a mallet. */}
        <path
          d="M8.9 8.0 L6.6 9.3a1.6 1.6 0 0 0 0.3 2.9l1.7 0.6"
          stroke={color}
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
