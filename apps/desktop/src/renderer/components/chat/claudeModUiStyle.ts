import type { CSSProperties } from "react";
import type { ClaudePluginUiPropValue } from "../../../shared/claudePluginUi";

/**
 * Maps the layout and colour props of a mod's terminal elements to CSS. Mods
 * lay out in terminal cells, so sizes are `ch` across and `lh` down. Every
 * value that reaches a style comes from a fixed list, a checked colour or a
 * number: no string of a mod's is ever used as CSS.
 */

export type ModProps = Record<string, ClaudePluginUiPropValue>;

const PERCENT = /^\d{1,3}%$/;

/** A size in terminal cells (`ch`) or rows (`lh`); a percentage passes through. */
function size(value: ClaudePluginUiPropValue | undefined, unit: "ch" | "lh"): string | undefined {
  if (typeof value === "number") return `${value}${unit}`;
  return typeof value === "string" && PERCENT.test(value) ? value : undefined;
}

const FG = "var(--color-fg)";
const BG = "var(--color-bg)";
const MUTED = "var(--kit-text-3)";

/** Terminal colour names and Claude Code's theme keys, in tones that read on light and dark themes. */
const NAMED_COLORS: Record<string, string> = {
  black: BG,
  white: FG,
  gray: MUTED,
  grey: MUTED,
  red: "var(--kit-crit)",
  green: "var(--kit-ok)",
  yellow: "var(--kit-warn)",
  blue: "#5b9dff",
  magenta: "#c678dd",
  cyan: "#39b8c9",
  text: FG,
  inverseText: BG,
  inactive: "color-mix(in srgb, var(--color-fg) 32%, transparent)",
  subtle: "color-mix(in srgb, var(--color-fg) 22%, transparent)",
  promptBorder: "color-mix(in srgb, var(--color-fg) 32%, transparent)",
  success: "var(--kit-ok)",
  diffAdded: "var(--kit-ok)",
  diffAddedWord: "var(--kit-ok)",
  error: "var(--kit-crit)",
  diffRemoved: "var(--kit-crit)",
  diffRemovedWord: "var(--kit-crit)",
  warning: "var(--kit-warn)",
  claude: "#d97757",
  suggestion: "#5b9dff",
  permission: "#5b9dff",
  remember: "#5b9dff",
  ide: "#5b9dff",
  planMode: "#39b8c9",
  autoAccept: "#c678dd",
  merged: "#c678dd",
  bashBorder: "#c678dd",
};

/** The 16 base terminal colours; black, white and the two greys follow the theme. */
const ANSI_16 = [
  BG, "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", MUTED,
  MUTED, "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", FG,
];

function ansi256(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return ANSI_16[index];
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const step = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  const cube = index - 16;
  return `rgb(${step(Math.floor(cube / 36))}, ${step(Math.floor(cube / 6) % 6)}, ${step(cube % 6)})`;
}

/** A colour a mod named: a theme key, a terminal name, hex, `rgb()` or `ansi256()`. Anything else is dropped. */
function color(value: ClaudePluginUiPropValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  const base = name.endsWith("Bright") ? name.slice(0, -"Bright".length) : name;
  if (Object.hasOwn(NAMED_COLORS, base)) return NAMED_COLORS[base];
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(name)) return name;
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(name);
  if (rgb) return `rgb(${Math.min(255, Number(rgb[1]))}, ${Math.min(255, Number(rgb[2]))}, ${Math.min(255, Number(rgb[3]))})`;
  const ansi = /^ansi256\(\s*(\d{1,3})\s*\)$/.exec(name);
  return ansi ? ansi256(Number(ansi[1])) : undefined;
}

const FLEX_DIRECTIONS = new Set(["row", "column", "row-reverse", "column-reverse"]);
const FLEX_WRAPS = new Set(["wrap", "nowrap", "wrap-reverse"]);
const ALIGNMENTS = new Set(["flex-start", "flex-end", "center", "stretch", "baseline"]);
const JUSTIFICATIONS = new Set(["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"]);
/** Terminal border styles that have a CSS line of their own; every other style is a solid line. */
const BORDER_LINES: Record<string, string> = { double: "3px double", dashed: "1px dashed" };

function oneOf<T extends string>(allowed: Set<string>, value: ClaudePluginUiPropValue | undefined): T | undefined {
  return typeof value === "string" && allowed.has(value) ? (value as T) : undefined;
}

/** Maps a terminal Box's layout props to flexbox. */
export function boxStyle(props: ModProps): CSSProperties {
  const direction = oneOf<"row" | "column" | "row-reverse" | "column-reverse">(FLEX_DIRECTIONS, props.flexDirection) ?? "row";
  const style: CSSProperties = { display: props.display === "none" ? "none" : "flex", flexDirection: direction };
  const set = <K extends keyof CSSProperties>(key: K, value: CSSProperties[K] | undefined) => {
    if (value !== undefined) style[key] = value;
  };
  set("flexWrap", oneOf<"wrap">(FLEX_WRAPS, props.flexWrap));
  set("alignItems", oneOf<"center">(ALIGNMENTS, props.alignItems));
  set("alignSelf", oneOf<"center">(ALIGNMENTS, props.alignSelf));
  set("justifyContent", oneOf<"center">(JUSTIFICATIONS, props.justifyContent));
  set("gap", size(props.gap, direction.startsWith("column") ? "lh" : "ch"));
  set("columnGap", size(props.columnGap, "ch"));
  set("rowGap", size(props.rowGap, "lh"));
  set("paddingLeft", size(props.paddingLeft ?? props.paddingX ?? props.padding, "ch"));
  set("paddingRight", size(props.paddingRight ?? props.paddingX ?? props.padding, "ch"));
  set("paddingTop", size(props.paddingTop ?? props.paddingY ?? props.padding, "lh"));
  set("paddingBottom", size(props.paddingBottom ?? props.paddingY ?? props.padding, "lh"));
  set("marginLeft", size(props.marginLeft ?? props.marginX ?? props.margin, "ch"));
  set("marginRight", size(props.marginRight ?? props.marginX ?? props.margin, "ch"));
  set("marginTop", size(props.marginTop ?? props.marginY ?? props.margin, "lh"));
  set("marginBottom", size(props.marginBottom ?? props.marginY ?? props.margin, "lh"));
  set("width", size(props.width, "ch"));
  set("minWidth", size(props.minWidth, "ch"));
  set("height", size(props.height, "lh"));
  set("minHeight", size(props.minHeight, "lh"));
  set("flexGrow", typeof props.flexGrow === "number" ? props.flexGrow : undefined);
  set("flexShrink", typeof props.flexShrink === "number" ? props.flexShrink : undefined);
  set("backgroundColor", color(props.backgroundColor));
  if (typeof props.borderStyle === "string") {
    style.border = `${BORDER_LINES[props.borderStyle] ?? "1px solid"} ${color(props.borderColor) ?? "var(--kit-rule)"}`;
    if (props.borderStyle === "round") style.borderRadius = 6;
    style.paddingLeft ??= "1ch";
    style.paddingRight ??= "1ch";
  }
  return style;
}

/** Maps a terminal Text's colour and style props to CSS. */
export function textStyle(props: ModProps): CSSProperties {
  const named = { fg: color(props.color), bg: color(props.backgroundColor) };
  // `inverse` swaps the two, with the theme's own pair as the default.
  const { fg, bg } = props.inverse === true ? { fg: named.bg ?? BG, bg: named.fg ?? FG } : named;
  const decorations = [props.underline === true ? "underline" : "", props.strikethrough === true ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  const truncated = typeof props.wrap === "string" && props.wrap.startsWith("truncate");
  return {
    ...(truncated ? { whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" } : { whiteSpace: "pre-wrap" }),
    ...(fg ? { color: fg } : {}),
    ...(bg ? { backgroundColor: bg } : {}),
    ...(props.bold === true ? { fontWeight: 600 } : {}),
    ...(props.italic === true ? { fontStyle: "italic" } : {}),
    ...(props.dimColor === true ? { opacity: 0.6 } : {}),
    ...(decorations ? { textDecoration: decorations } : {}),
  };
}
