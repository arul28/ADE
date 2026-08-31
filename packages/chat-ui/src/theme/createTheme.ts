/**
 * Theming is CSS custom properties and nothing else. No Tailwind, no class
 * names to override, no runtime style objects to thread through props: the
 * host sets `--adechat-*` on any ancestor and every component follows.
 *
 * `createTheme` exists so a host only has to pick an accent and a background;
 * hovers, borders and subtle tints are derived from those.
 */

/** Every token this package reads. Nothing else is styleable. */
export const ADE_CHAT_TOKENS = [
  "--adechat-bg",
  "--adechat-bg-subtle",
  "--adechat-bg-raised",
  "--adechat-fg",
  "--adechat-muted",
  "--adechat-accent",
  "--adechat-accent-fg",
  "--adechat-accent-subtle",
  "--adechat-border",
  "--adechat-border-strong",
  "--adechat-hover",
  "--adechat-danger",
  "--adechat-danger-subtle",
  "--adechat-success",
  "--adechat-radius",
  "--adechat-radius-sm",
  "--adechat-font",
  "--adechat-font-mono",
  "--adechat-font-size",
  "--adechat-space",
] as const;

export type AdeChatToken = (typeof ADE_CHAT_TOKENS)[number];
export type AdeChatTheme = Record<AdeChatToken, string>;

export type CreateThemeInput = {
  /** Any CSS color. Hex (3/6/8 digit) unlocks derived tints. */
  accent?: string;
  background?: string;
  foreground?: string;
  muted?: string;
  danger?: string;
  success?: string;
  /** Number is treated as px. */
  radius?: string | number;
  fontFamily?: string;
  monoFontFamily?: string;
  fontSize?: string | number;
  /** Base spacing unit. */
  space?: string | number;
  /**
   * Drives whether derived surfaces lighten or darken. Inferred from
   * `background` when it is a hex color.
   */
  scheme?: "light" | "dark";
};

const DEFAULTS = {
  accent: "#5b8cff",
  darkBackground: "#101114",
  lightBackground: "#ffffff",
  danger: "#e5484d",
  success: "#30a46c",
  radius: 10,
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  monoFontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 14,
  space: 8,
} as const;

function parseHex(value: string): { r: number; g: number; b: number; a: number } | null {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a] = hex.split("").map((char) => parseInt(char + char, 16));
    return { r: r!, g: g!, b: b!, a: (a ?? 255) / 255 };
  }
  if (hex.length === 6 || hex.length === 8) {
    const parts = hex.match(/.{2}/g)!.map((pair) => parseInt(pair, 16));
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: (parts[3] ?? 255) / 255 };
  }
  return null;
}

function rgba(color: string, alpha: number): string {
  const parsed = parseHex(color);
  if (!parsed) {
    // Non-hex input (named color, var(), color-mix()) still themes correctly —
    // we just cannot derive a tint from it, so the raw color is used as-is.
    return color;
  }
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${round(alpha * parsed.a)})`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function relativeLuminance(color: string): number | null {
  const parsed = parseHex(color);
  if (!parsed) return null;
  const channel = (raw: number) => {
    const srgb = raw / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(parsed.r) + 0.7152 * channel(parsed.g) + 0.0722 * channel(parsed.b);
}

/** Blend `color` toward white or black by `amount` (0..1). */
function shade(color: string, amount: number, toward: "light" | "dark"): string {
  const parsed = parseHex(color);
  if (!parsed) return color;
  const target = toward === "light" ? 255 : 0;
  const mix = (channel: number) => Math.round(channel + (target - channel) * amount);
  return `rgb(${mix(parsed.r)}, ${mix(parsed.g)}, ${mix(parsed.b)})`;
}

function px(value: string | number | undefined, fallback: number): string {
  if (value === undefined) return `${fallback}px`;
  return typeof value === "number" ? `${value}px` : value;
}

/** Pick a readable foreground for text sitting on `background`. */
function contrastForeground(background: string, scheme: "light" | "dark"): string {
  const luminance = relativeLuminance(background);
  if (luminance === null) return scheme === "dark" ? "#f5f6f8" : "#16181d";
  return luminance > 0.5 ? "#16181d" : "#f5f6f8";
}

/**
 * Build the full token set from a handful of inputs. Every token is always
 * present, so the result can be spread straight onto a `style` prop.
 */
export function createTheme(input: CreateThemeInput = {}): AdeChatTheme {
  const backgroundLuminance = input.background ? relativeLuminance(input.background) : null;
  const scheme: "light" | "dark" =
    input.scheme ?? (backgroundLuminance === null ? "dark" : backgroundLuminance > 0.5 ? "light" : "dark");

  const background =
    input.background ?? (scheme === "light" ? DEFAULTS.lightBackground : DEFAULTS.darkBackground);
  const accent = input.accent ?? DEFAULTS.accent;
  const foreground = input.foreground ?? contrastForeground(background, scheme);
  const danger = input.danger ?? DEFAULTS.danger;
  const success = input.success ?? DEFAULTS.success;

  // Derived surfaces move away from the background: lighter on dark themes,
  // darker on light ones, so raised panels read as raised in both.
  const toward: "light" | "dark" = scheme === "dark" ? "light" : "dark";
  const contrastInk = scheme === "dark" ? "#ffffff" : "#000000";

  const radius = px(input.radius, DEFAULTS.radius);
  const radiusSm =
    typeof input.radius === "number"
      ? `${Math.max(2, Math.round(input.radius * 0.6))}px`
      : input.radius
        ? `calc(${radius} * 0.6)`
        : `${Math.round(DEFAULTS.radius * 0.6)}px`;

  return {
    "--adechat-bg": background,
    "--adechat-bg-subtle": shade(background, 0.04, toward),
    "--adechat-bg-raised": shade(background, 0.08, toward),
    "--adechat-fg": foreground,
    "--adechat-muted": input.muted ?? rgba(contrastInk, scheme === "dark" ? 0.56 : 0.52),
    "--adechat-accent": accent,
    "--adechat-accent-fg": contrastForeground(accent, scheme),
    "--adechat-accent-subtle": rgba(accent, 0.14),
    "--adechat-border": rgba(contrastInk, scheme === "dark" ? 0.1 : 0.12),
    "--adechat-border-strong": rgba(contrastInk, scheme === "dark" ? 0.2 : 0.24),
    "--adechat-hover": rgba(contrastInk, scheme === "dark" ? 0.06 : 0.05),
    "--adechat-danger": danger,
    "--adechat-danger-subtle": rgba(danger, 0.14),
    "--adechat-success": success,
    "--adechat-radius": radius,
    "--adechat-radius-sm": radiusSm,
    "--adechat-font": input.fontFamily ?? DEFAULTS.fontFamily,
    "--adechat-font-mono": input.monoFontFamily ?? DEFAULTS.monoFontFamily,
    "--adechat-font-size": px(input.fontSize, DEFAULTS.fontSize),
    "--adechat-space": px(input.space, DEFAULTS.space),
  };
}

/** The dark default, useful as a baseline to spread and override. */
export const defaultTheme: AdeChatTheme = createTheme();

/** Serialize a theme for a `<style>` block or a stylesheet string. */
export function themeToCss(theme: AdeChatTheme, selector = ":root"): string {
  const body = (Object.keys(theme) as AdeChatToken[])
    .map((token) => `  ${token}: ${theme[token]};`)
    .join("\n");
  return `${selector} {\n${body}\n}`;
}
