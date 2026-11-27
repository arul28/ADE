import type { ImgHTMLAttributes } from "react";
import { useAppearanceStore, type ThemeId } from "../../state/appearanceStore";
import { BRAND } from "../../../shared/brand";

/**
 * The Daex mark (the "æ" glyph) for a theme. The dark-theme picture is a
 * white glyph, which vanishes on a light page, so the light theme uses the
 * brand violet glyph instead. Both are made from
 * `assets/brand/daex/glyph-mask.png`.
 * `BASE_URL` keeps the path right on both the desktop (`./`) and the web
 * client (`/`, where routes are real paths).
 */
/** Width over height of both mark pictures (1138 x 868). */
export const ADE_WORDMARK_ASPECT = 1138 / 868;

export function adeWordmarkSrc(mode: ThemeId): string {
  return `${import.meta.env.BASE_URL}${mode === "light" ? "logo-light.png" : "logo.png"}`;
}

/** The current theme's wordmark source. */
export function useAdeWordmarkSrc(): string {
  return adeWordmarkSrc(useAppearanceStore((s) => s.theme));
}

/** An `<img>` of the ADE wordmark that follows the theme. */
export function AdeWordmark({ alt = BRAND.NAME, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  return <img {...props} alt={alt} src={useAdeWordmarkSrc()} />;
}
