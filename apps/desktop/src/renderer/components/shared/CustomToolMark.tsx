import React from "react";

/**
 * The mark for Custom — ADE's own saved agent-plus-model setups.
 *
 * Every other entry in the provider rail and the providers list is a company's
 * brand mark, so the one entry that is *yours* needs a mark of its own rather
 * than a second copy of the ADE logo: the ADE logo already sits in the title
 * bar, and reusing it made "Custom" read as "ADE the app" instead of "the ones
 * I built". A gear with a wrench inside it is the owner's chosen glyph for
 * built-here.
 *
 * Drawn rather than imported so it inherits the size every call site gives its
 * provider logos — the rail, the settings row, the manager page and the
 * wizard's default logo tile all pass the same `size` they pass `ProviderLogo`,
 * and the mark lands on the same baseline as the brand marks beside it. The
 * gear ring is one even-odd path (teeth plus the hole) and the wrench sits in
 * the hole with its handle running down into the ring, so the whole mark is
 * one colour and still reads at 14px.
 */
export function CustomToolMark({
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
      data-custom-mark=""
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
      {/* Gear ring — eight teeth, with the centre cut out (even-odd). */}
      <path
        fillRule="evenodd"
        d="M21.09 10.04 L23.30 10.48 L23.30 13.52 L21.09 13.96 L19.81 17.04 L21.06 18.92 L18.92 21.06 L17.04 19.81 L13.96 21.09 L13.52 23.30 L10.48 23.30 L10.04 21.09 L6.96 19.81 L5.08 21.06 L2.94 18.92 L4.19 17.04 L2.91 13.96 L0.70 13.52 L0.70 10.48 L2.91 10.04 L4.19 6.96 L2.94 5.08 L5.08 2.94 L6.96 4.19 L10.04 2.91 L10.48 0.70 L13.52 0.70 L13.96 2.91 L17.04 4.19 L18.92 2.94 L21.06 5.08 L19.81 6.96z M18.40 12.00 a6.4 6.4 0 1 0 -12.8 0 a6.4 6.4 0 1 0 12.8 0z"
        fill={color}
      />
      {/* Wrench head — a disc with the jaw slot cut from the top. Drawn as one
          outline (the long arc, then down into the slot and back) rather than
          an even-odd disc-minus-rectangle, because even-odd XORs: a slot that
          overhangs the disc's top edge leaves a stray bar above the head. */}
      <path
        d="M10.9 6.8 A3.2 3.2 0 1 0 13.1 6.8 L13.1 9.5 L10.9 9.5 Z"
        fill={color}
      />
      {/* Wrench handle — runs from the head down into the gear ring. */}
      <rect x="10.75" y="11.6" width="2.5" height="9.2" rx="1.1" fill={color} />
    </svg>
  );
}
