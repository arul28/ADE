import type { ImgHTMLAttributes } from "react";
import { useAppearanceStore, type ThemeId } from "../../state/appearanceStore";

/**
 * The ADE wordmark for a theme. The dark-theme logo has white letter faces,
 * which vanish on a light page, so the light theme swaps purple and white:
 * purple faces over a white middle layer, the same dark back layer.
 * `BASE_URL` keeps the path right on both the desktop (`./`) and the web
 * client (`/`, where routes are real paths).
 */
/** Width over height of both wordmark pictures (1012 x 493). */
export const ADE_WORDMARK_ASPECT = 1012 / 493;

export function adeWordmarkSrc(mode: ThemeId): string {
  return `${import.meta.env.BASE_URL}${mode === "light" ? "logo-light.png" : "logo.png"}`;
}

/** The current theme's wordmark source. */
export function useAdeWordmarkSrc(): string {
  return adeWordmarkSrc(useAppearanceStore((s) => s.theme));
}

/** An `<img>` of the ADE wordmark that follows the theme. */
export function AdeWordmark({ alt = "ADE", ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  return <img {...props} alt={alt} src={useAdeWordmarkSrc()} />;
}
