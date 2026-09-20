import React from "react";
import type { HarnessPresetLogo } from "../../../shared/harnessPresets";
import { CustomToolMark } from "./CustomToolMark";
import { ProviderLogo } from "./ProviderLogos";

/**
 * A harness preset's mark, in every place a preset is listed.
 *
 * Four kinds render as one component so the settings table, the wizard preview
 * and the model picker cannot drift into three different ideas of what a preset
 * looks like. The accent is the ring rather than the fill: a preset is
 * recognised by its logo, and a coloured disc behind ten different marks makes
 * them all read as the same badge.
 *
 * The default is the Custom mark, in the preset's own accent. It used to be
 * the ADE app logo, which made every unbranded preset look like a copy of the
 * title-bar mark rather than like something you built — and left the settings
 * row, the rail tab and the wizard's default tile wearing three different
 * pictures of the same idea. The ADE mark still belongs to the app; this one
 * belongs to Custom.
 */
export function HarnessLogo({
  logo,
  size = 20,
  accentColor,
  className,
}: {
  logo: HarnessPresetLogo;
  size?: number;
  /** Ring colour. Omitted draws no ring, which is right inside a dense row. */
  accentColor?: string | null;
  className?: string;
}) {
  const ring = accentColor
    ? { boxShadow: `0 0 0 1.5px ${accentColor}`, borderRadius: size / 2 }
    : undefined;

  if (logo.kind === "provider") {
    return (
      <span
        data-harness-logo="provider"
        className={className}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", ...ring }}
      >
        <ProviderLogo family={logo.providerId} size={size} />
      </span>
    );
  }

  if (logo.kind === "upload" || logo.kind === "generated") {
    return (
      <img
        data-harness-logo={logo.kind}
        src={logo.dataUrl}
        alt=""
        width={size}
        height={size}
        draggable={false}
        className={className}
        style={{ borderRadius: size / 2, objectFit: "cover", ...ring }}
      />
    );
  }

  return (
    <span
      data-harness-logo={logo.kind}
      className={className}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", ...ring }}
    >
      <CustomToolMark size={size} {...(accentColor ? { color: accentColor } : {})} />
    </span>
  );
}
