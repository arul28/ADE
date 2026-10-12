import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CaretDown, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  CLAUDE_PLUGIN_UI_BAND_COLUMNS,
  claudePluginUiHasContent,
  safeClaudePluginUiHref,
  type ClaudePluginUiActArgs,
  type ClaudePluginUiElement,
  type ClaudePluginUiNode,
  type ClaudePluginUiPropValue,
  type ClaudePluginUiSite,
} from "../../../shared/claudePluginUi";
import { showToast } from "../app/toast/toastStore";
import { ChatMarkdown } from "./chatMarkdown";
import { claudeModUiApi, useClaudeModUi } from "./claudeModUiStore";
import "./ClaudeModUi.css";

/**
 * Draws what Claude Code mods put on screen for one chat, as one dock that sits
 * on the prompt box: a header with the mods' status lines, and under it the
 * open panes and the band a mod draws above the prompt. The header folds the
 * dock down to one row. Toasts go through the app's toast stack.
 *
 * Mods lay out in terminal cells, so every tree is monospace and sized in `ch`.
 * The host already reduced each tree to known elements and props; this draws
 * those and nothing else. A control acts only while its Claude process lives.
 */
export const ClaudeModUi = memo(function ClaudeModUi(props: {
  sessionId: string | null;
  pin: OpenProjectBinding | null | undefined;
}) {
  const { sessionId, pin } = props;
  const snapshot = useClaudeModUi(sessionId, pin);
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;

  // A toast already in the first snapshot of a chat is old news.
  const shownToast = useRef<{ sessionId: string | null; id: string | null } | null>(null);
  const toast = snapshot.toast;
  useEffect(() => {
    const seen = shownToast.current;
    if (!seen || seen.sessionId !== sessionId) {
      shownToast.current = { sessionId, id: toast?.id ?? null };
      return;
    }
    if (!toast || seen.id === toast.id) return;
    seen.id = toast.id;
    showToast({ title: toast.plugin, message: toast.text, durationMs: toast.timeoutMs });
  }, [sessionId, toast]);

  const generation = snapshot.generation;
  const live = snapshot.live;
  const act = useCallback((action: ModAction) => {
    const api = claudeModUiApi();
    if (!api || !sessionId || !live) return;
    void api.act({ sessionId, generation, ...action } as ClaudePluginUiActArgs, pinRef.current ?? null).catch(() => {
      // The process that drew the control is gone; the next snapshot says so.
    });
  }, [sessionId, generation, live]);

  // Status lines alone are one row: there is nothing to fold away.
  const hasBody = snapshot.band !== null || snapshot.panes.length > 0;
  const folded = hasBody && collapsed;
  // A folded body is out of the tab order and hidden from assistive tools.
  // React 18 does not know the attribute, so it is set on the element.
  useEffect(() => {
    bodyRef.current?.toggleAttribute("inert", folded);
  }, [folded, hasBody]);

  if (!sessionId || !claudePluginUiHasContent(snapshot)) return null;

  const statuses = snapshot.statuses.map((status) => (
    <span key={status.plugin} className="ade-mod-status" title={status.plugin}>
      {status.text}
    </span>
  ));

  return (
    <div
      className="ade-mod-ui"
      style={COLUMNS_STYLE}
      data-live={live ? "true" : "false"}
      data-collapsed={folded ? "true" : "false"}
      data-testid="claude-mod-ui"
    >
      <div className="ade-mod-dock">
        {hasBody ? (
          <button
            type="button"
            className="ade-mod-head"
            aria-expanded={!folded}
            aria-controls={bodyId}
            title={folded ? "Show what your Claude mods draw" : "Hide what your Claude mods draw"}
            onClick={() => writeCollapsed(!collapsed)}
          >
            <span className="kit-eyebrow ade-mod-head-label">Mods</span>
            <span className="ade-mod-head-statuses">{statuses}</span>
            <CaretDown size={11} weight="bold" className="ade-mod-caret" aria-hidden />
          </button>
        ) : (
          <div className="ade-mod-head" data-static="true">
            <span className="kit-eyebrow ade-mod-head-label">Mods</span>
            <span className="ade-mod-head-statuses">{statuses}</span>
          </div>
        )}
        {hasBody ? (
          <div id={bodyId} ref={bodyRef} className="ade-mod-body">
            <div className="ade-mod-body-inner">
              {snapshot.panes.map((pane) => (
                <section key={pane.id} className="ade-mod-pane">
                  <header className="ade-mod-pane-head">
                    <span className="ade-mod-pane-title">{pane.title}</span>
                    {pane.plugin ? <span className="ade-mod-pane-plugin">{pane.plugin}</span> : null}
                    <button
                      type="button"
                      className="kit-icon-btn ade-mod-pane-close"
                      aria-label={`Close ${pane.title}`}
                      title="Close"
                      disabled={!live}
                      onClick={() => act({ kind: "closePane", paneId: pane.id })}
                    >
                      <X size={12} />
                    </button>
                  </header>
                  {pane.tree ? (
                    <div className="ade-mod-surface ade-mod-pane-body">
                      <div className="ade-mod-fit">
                        <ModNode node={pane.tree} site={{ component: "Pane", paneId: pane.id }} act={act} live={live} />
                      </div>
                    </div>
                  ) : null}
                </section>
              ))}
              {snapshot.band ? (
                <div className="ade-mod-surface ade-mod-band">
                  <div className="ade-mod-fit">
                    <ModNode node={snapshot.band} site={BAND_SITE} act={act} live={live} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/**
 * Whether the mod dock is folded down to its header. One choice for every
 * chat in this window, kept across restarts.
 */
const COLLAPSED_KEY = "ade.chat.claudeModUi.collapsed";
const collapsedListeners = new Set<() => void>();

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(COLLAPSED_KEY, "1");
    else window.localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    // Storage is unavailable: the choice lasts until the window closes.
  }
  for (const listener of collapsedListeners) listener();
}

function subscribeCollapsed(listener: () => void): () => void {
  collapsedListeners.add(listener);
  return () => collapsedListeners.delete(listener);
}

const BAND_SITE: ClaudePluginUiSite = { component: "AbovePrompt" };
/** For the font fit in CSS: the columns the host asked mods to lay out for. */
const COLUMNS_STYLE = { "--ade-mod-columns": CLAUDE_PLUGIN_UI_BAND_COLUMNS } as CSSProperties;

type ModAction =
  | { kind: "press"; target: { plugin: string; handle: number }; key?: string }
  | { kind: "input" | "select"; target: { plugin: string; handle: number }; key?: string; value: string; site: ClaudePluginUiSite }
  | { kind: "closePane"; paneId: string };

type Props = Record<string, ClaudePluginUiPropValue>;

const str = (value: ClaudePluginUiPropValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A horizontal size in terminal cells; a percentage passes through. */
function cells(value: ClaudePluginUiPropValue | undefined): string | undefined {
  if (typeof value === "number") return `${value}ch`;
  return typeof value === "string" && /^\d{1,3}%$/.test(value) ? value : undefined;
}

/** A vertical size in terminal rows. */
function rows(value: ClaudePluginUiPropValue | undefined): string | undefined {
  if (typeof value === "number") return `${value}lh`;
  return typeof value === "string" && /^\d{1,3}%$/.test(value) ? value : undefined;
}

/** Terminal colour names, in tones that read on light and dark themes. */
const NAMED_COLORS: Record<string, string> = {
  black: "var(--color-bg)",
  white: "var(--color-fg)",
  gray: "var(--kit-text-3)",
  grey: "var(--kit-text-3)",
  red: "var(--kit-crit)",
  green: "var(--kit-ok)",
  yellow: "var(--kit-warn)",
  blue: "#5b9dff",
  magenta: "#c678dd",
  cyan: "#39b8c9",
  // Names from Claude Code's own theme that mods reuse.
  success: "var(--kit-ok)",
  error: "var(--kit-crit)",
  warning: "var(--kit-warn)",
  text: "var(--color-fg)",
  secondaryText: "var(--kit-text-2)",
  inactive: "color-mix(in srgb, var(--color-fg) 32%, transparent)",
  subtle: "color-mix(in srgb, var(--color-fg) 22%, transparent)",
  claude: "#d97757",
  suggestion: "#5b9dff",
  permission: "#5b9dff",
};

const ANSI_16 = [
  "#1e1e1e", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
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

/** A colour a mod named: a terminal name, hex, `rgb()` or `ansi256()`. Anything else is dropped. */
export function claudeModUiColor(value: ClaudePluginUiPropValue | undefined): string | undefined {
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

function oneOf<T extends string>(allowed: Set<string>, value: ClaudePluginUiPropValue | undefined): T | undefined {
  return typeof value === "string" && allowed.has(value) ? (value as T) : undefined;
}

/** Maps a terminal Box's layout props to flexbox. */
function boxStyle(props: Props): CSSProperties {
  const style: CSSProperties = {
    display: props.display === "none" ? "none" : "flex",
    flexDirection: oneOf<"row">(FLEX_DIRECTIONS, props.flexDirection) ?? "row",
  };
  const set = <K extends keyof CSSProperties>(key: K, value: CSSProperties[K] | undefined) => {
    if (value !== undefined) style[key] = value;
  };
  set("flexWrap", oneOf<"wrap">(FLEX_WRAPS, props.flexWrap));
  set("alignItems", oneOf<"center">(ALIGNMENTS, props.alignItems));
  set("alignSelf", oneOf<"center">(ALIGNMENTS, props.alignSelf));
  set("justifyContent", oneOf<"center">(JUSTIFICATIONS, props.justifyContent));
  const direction = style.flexDirection === "column" || style.flexDirection === "column-reverse" ? "column" : "row";
  if (typeof props.gap === "number") set("gap", direction === "column" ? rows(props.gap) : cells(props.gap));
  set("columnGap", cells(props.columnGap));
  set("rowGap", rows(props.rowGap));
  set("paddingLeft", cells(props.paddingLeft ?? props.paddingX ?? props.padding));
  set("paddingRight", cells(props.paddingRight ?? props.paddingX ?? props.padding));
  set("paddingTop", rows(props.paddingTop ?? props.paddingY ?? props.padding));
  set("paddingBottom", rows(props.paddingBottom ?? props.paddingY ?? props.padding));
  set("marginLeft", cells(props.marginLeft ?? props.marginX ?? props.margin));
  set("marginRight", cells(props.marginRight ?? props.marginX ?? props.margin));
  set("marginTop", rows(props.marginTop ?? props.marginY ?? props.margin));
  set("marginBottom", rows(props.marginBottom ?? props.marginY ?? props.margin));
  set("width", cells(props.width));
  set("minWidth", cells(props.minWidth));
  set("height", rows(props.height));
  set("minHeight", rows(props.minHeight));
  set("flexGrow", typeof props.flexGrow === "number" ? props.flexGrow : undefined);
  set("flexShrink", typeof props.flexShrink === "number" ? props.flexShrink : undefined);
  set("backgroundColor", claudeModUiColor(props.backgroundColor));
  if (typeof props.borderStyle === "string") {
    const edge = claudeModUiColor(props.borderColor) ?? "var(--kit-rule)";
    style.border = `1px ${props.borderStyle === "double" ? "double" : props.borderStyle === "dashed" ? "dashed" : "solid"} ${edge}`;
    if (props.borderStyle === "double") style.borderWidth = 3;
    if (props.borderStyle === "round") style.borderRadius = 6;
    style.paddingLeft ??= "1ch";
    style.paddingRight ??= "1ch";
  }
  return style;
}

/** Maps a terminal Text's colour and style props to CSS. */
function textStyle(props: Props): CSSProperties {
  const inverse = props.inverse === true;
  const fg = claudeModUiColor(props.color);
  const bg = claudeModUiColor(props.backgroundColor);
  const decorations = [props.underline === true ? "underline" : "", props.strikethrough === true ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  const truncated = typeof props.wrap === "string" && props.wrap.startsWith("truncate");
  return {
    ...(truncated ? { whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" } : { whiteSpace: "pre-wrap" }),
    ...(inverse ? { color: bg ?? "var(--color-bg)", backgroundColor: fg ?? "var(--color-fg)" } : {}),
    ...(!inverse && fg ? { color: fg } : {}),
    ...(!inverse && bg ? { backgroundColor: bg } : {}),
    ...(props.bold === true ? { fontWeight: 600 } : {}),
    ...(props.italic === true ? { fontStyle: "italic" } : {}),
    ...(props.dimColor === true ? { opacity: 0.6 } : {}),
    ...(decorations ? { textDecoration: decorations } : {}),
  };
}

type NodeProps = {
  node: ClaudePluginUiNode;
  site: ClaudePluginUiSite;
  act: (action: ModAction) => void;
  live: boolean;
};

function ModChildren({ nodes, site, act, live }: Omit<NodeProps, "node"> & { nodes: ClaudePluginUiNode[] | undefined }): ReactNode {
  // A mod's tree is positional: its children carry no ids of their own.
  return nodes?.map((child, index) => <ModNode key={index} node={child} site={site} act={act} live={live} />);
}

/** Draws one node of a mod's tree; an element this surface does not know draws nothing. */
function ModNode({ node, site, act, live }: NodeProps): ReactNode {
  if (typeof node === "string") return node;
  const { props } = node;
  const key = str(props.key);
  switch (node.type) {
    case "Box":
      return (
        <div style={boxStyle(props)}>
          <ModChildren nodes={node.children} site={site} act={act} live={live} />
        </div>
      );
    case "Text":
      return (
        <span style={textStyle(props)}>
          <ModChildren nodes={node.children} site={site} act={act} live={live} />
        </span>
      );
    case "Button": {
      const target = node.target;
      return (
        <button
          type="button"
          className="ade-mod-button"
          data-variant={props.plain === true ? "plain" : props.variant === "primary" ? "primary" : "default"}
          data-dim={props.dimColor === true ? "true" : undefined}
          disabled={!live || !target}
          onClick={() => target && act({ kind: "press", target, key })}
        >
          {props.role === "dismiss" && !str(props.label) ? "×" : str(props.label) ?? ""}
        </button>
      );
    }
    case "Link": {
      const href = safeClaudePluginUiHref(props.href);
      const label = str(props.label);
      const body = label ?? (node.children?.length ? <ModChildren nodes={node.children} site={site} act={act} live={live} /> : href);
      if (!href) return <span>{body}</span>;
      return (
        <a
          className="ade-mod-link"
          href={href}
          title={href}
          onClick={(event) => {
            // Never navigate this window; the system browser opens web links.
            event.preventDefault();
            void window.ade.app.openExternal(href);
          }}
        >
          {body}
        </a>
      );
    }
    case "Code":
      return <pre className="ade-mod-code" data-wrap={props.wrap === true ? "true" : undefined}>{str(props.source) ?? ""}</pre>;
    case "Markdown":
      return (
        <div className="ade-mod-markdown" data-dim={props.dimColor === true ? "true" : undefined}>
          <ChatMarkdown>{str(props.text) ?? ""}</ChatMarkdown>
        </div>
      );
    case "Input":
      return <ModInput element={node} site={site} act={act} live={live} />;
    case "Select": {
      const target = node.target;
      const options = Array.isArray(props.options) ? props.options : [];
      const label = str(props.label);
      return (
        <label className="ade-mod-field">
          {label ? <span className="ade-mod-field-label">{label}</span> : null}
          <select
            className="ade-mod-select"
            value={str(props.value) ?? ""}
            disabled={!live || !target}
            onChange={(event) => target && act({ kind: "select", target, key, value: event.target.value, site })}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      );
    }
    default:
      return null;
  }
}

function ModInput({ element, site, act, live }: Omit<NodeProps, "node"> & { element: ClaudePluginUiElement }): ReactNode {
  const { props, target } = element;
  const hostValue = str(props.value) ?? "";
  const [value, setValue] = useState(hostValue);
  // The mod's own value wins when it changes (a submit it accepted or cleared).
  useEffect(() => setValue(hostValue), [hostValue]);
  const label = str(props.label);
  const disabled = !live || !target;
  return (
    <form
      className="ade-mod-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (target && !disabled) act({ kind: "input", target, key: str(props.key), value, site });
      }}
    >
      {label ? <span className="ade-mod-field-label">{label}</span> : null}
      <input
        className="ade-mod-input"
        type="text"
        value={value}
        placeholder={str(props.placeholder)}
        aria-label={label ?? str(props.placeholder) ?? "Mod input"}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="ade-mod-button" data-variant="default" disabled={disabled}>
        {str(props.submitLabel) ?? "Submit"}
      </button>
    </form>
  );
}
