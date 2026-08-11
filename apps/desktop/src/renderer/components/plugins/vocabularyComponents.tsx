import React from "react";
import { WarningCircle } from "@phosphor-icons/react";

import {
  COLORS,
  MONO_FONT,
  RADII,
  SANS_FONT,
  inlineBadge,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { pluginIcon } from "./pluginIcons";
import { EmptyLine, InlineError, TONE_COLOR } from "./vocabularyPrimitives";
import type { VocabRenderContext } from "./vocabularyPrimitives";
import type {
  VocabBadgeNode,
  VocabButtonNode,
  VocabDividerNode,
  VocabEmptyStateNode,
  VocabImageNode,
  VocabInvalidNode,
  VocabKeyValueNode,
  VocabKeyValueRow,
  VocabListItem,
  VocabListNode,
  VocabTableNode,
  VocabTextNode,
  VocabUnknownNode,
  VocabVideoNode,
} from "../../../shared/plugins/vocabulary";
import {
  VOCAB_LIMITS,
  bindingKey,
  boundRowValues,
  coerceBoundKeyValueRow,
  coerceBoundListItem,
  coerceBoundTableRow,
} from "../../../shared/plugins/vocabulary";

/**
 * The leaf renderers for plugin vocabulary v1.
 *
 * Every colour here resolves through `laneDesignTokens`, which is the TS facade
 * over the `--color-*` palette — so a panel follows the app theme, and a plugin
 * theme's token overrides reach panel content for free. There are no raw hex
 * values and no raw Tailwind palette classes in this file, by design: a plugin
 * that could paint outside the palette could paint outside the theme.
 *
 * On the choice of primitives: the chat transcript's `chatCardPrimitives` were
 * the obvious candidates, but they resolve `--chat-accent`, `--chat-font-size`
 * and `--chat-content-width`, which the chat surface sets *inline on its own
 * root element*. Outside a transcript those variables do not exist, so the cards
 * render unstyled. Panels therefore build on the settings/lanes token facade,
 * which is app-wide.
 *
 * The chart and the form are big enough to own their files; they are re-exported
 * here so every surface still imports leaf renderers from one place.
 */

export { TONE_COLOR, InlineError } from "./vocabularyPrimitives";
export type {
  VocabActionArgs,
  VocabDispatch,
  VocabRenderContext,
} from "./vocabularyPrimitives";
export { VocabChart } from "./vocabularyChart";
export { VocabForm, initialFormValues } from "./vocabularyForm";

const GAP_PX = { none: 0, sm: 6, md: 12, lg: 20 } as const;

export function stackGap(gap: keyof typeof GAP_PX | undefined): number {
  return GAP_PX[gap ?? "md"];
}

/* ── Text, badge, divider ───────────────────────────────────────────────── */

const TEXT_VARIANT: Record<
  NonNullable<VocabTextNode["variant"]>,
  React.CSSProperties
> = {
  title: { fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em", color: COLORS.textPrimary },
  subtitle: { fontSize: 12, fontWeight: 500, color: COLORS.textSecondary },
  body: { fontSize: 12, fontWeight: 400, color: COLORS.textSecondary, lineHeight: 1.55 },
  caption: { fontSize: 11, fontWeight: 400, color: COLORS.textMuted },
  // The only monospace in the vocabulary, and only because the content IS code.
  code: { fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary },
};

export function VocabText({ node }: { node: VocabTextNode }) {
  const variant = node.variant ?? "body";
  const style = TEXT_VARIANT[variant];
  return (
    <p
      style={{
        margin: 0,
        fontFamily: SANS_FONT,
        whiteSpace: "pre-wrap",
        ...style,
        ...(node.tone && node.tone !== "neutral" ? { color: TONE_COLOR[node.tone] } : {}),
      }}
    >
      {node.text}
    </p>
  );
}

export function VocabBadge({ node }: { node: VocabBadgeNode }) {
  const tone = node.tone ?? "neutral";
  const Icon = node.icon ? pluginIcon(node.icon) : null;
  return (
    <span style={inlineBadge(TONE_COLOR[tone], { gap: 5 })}>
      {Icon ? <Icon size={11} weight="regular" aria-hidden /> : null}
      {node.text}
    </span>
  );
}

export function VocabDivider({ node }: { node: VocabDividerNode }) {
  if (!node.label) {
    return <hr style={{ margin: 0, border: "none", borderTop: `1px solid ${COLORS.borderMuted}` }} />;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 11,
          fontWeight: 500,
          color: COLORS.textMuted,
          whiteSpace: "nowrap",
        }}
      >
        {node.label}
      </span>
      <span style={{ flex: 1, height: 1, background: COLORS.borderMuted }} />
    </div>
  );
}

/* ── Button ─────────────────────────────────────────────────────────────── */

/**
 * A button is the only place a panel can change something, so it owns the whole
 * outcome: pending while in flight, and the host's own error text inline on
 * failure. A plugin action that quietly does nothing is the failure this
 * feedback exists to prevent.
 */
export function VocabButton({
  node,
  context,
}: {
  node: VocabButtonNode;
  context: VocabRenderContext;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const Icon = node.icon ? pluginIcon(node.icon) : null;
  const kind = node.kind ?? "default";
  const disabled = node.disabled === true || pending;

  const base = kind === "primary" ? primaryButton() : outlineButton();
  const style: React.CSSProperties = kind === "quiet"
    ? {
        ...outlineButton(),
        background: "transparent",
        border: "1px solid transparent",
        color: COLORS.textMuted,
      }
    : base;

  const run = async () => {
    if (node.onPress.confirm && !window.confirm(node.onPress.confirm)) return;
    setPending(true);
    setError(null);
    try {
      await context.dispatch(node.onPress);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That action failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void run()}
        data-tour={`plugin:${context.pluginId}.action-${node.onPress.action}`}
        style={{ ...style, opacity: disabled ? 0.55 : 1, cursor: disabled ? "default" : "pointer" }}
      >
        {Icon ? <Icon size={13} weight="regular" aria-hidden /> : null}
        {pending ? "Working…" : node.label}
      </button>
      {error ? <InlineError message={error} /> : null}
    </span>
  );
}

/* ── Bound data helpers ─────────────────────────────────────────────────── */

function boundRows(
  node: { bind?: { collection: string; keyPrefix?: string; limit?: number } },
  context: VocabRenderContext,
): unknown[] | null {
  if (!node.bind) return null;
  return boundRowValues(node.bind, context.rowsByBinding.get(bindingKey(node.bind)));
}

/* ── List ───────────────────────────────────────────────────────────────── */

export function VocabList({
  node,
  context,
}: {
  node: VocabListNode;
  context: VocabRenderContext;
}) {
  const bound = boundRows(node, context);
  const items = bound
    ? bound.map(coerceBoundListItem).filter((item): item is VocabListItem => item !== null)
    : (node.items ?? []);

  if (items.length === 0) {
    return <EmptyLine text={node.emptyText ?? "Nothing here yet."} />;
  }

  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 1 }}>
      {items.slice(0, VOCAB_LIMITS.maxListItems).map((item, index) => (
        <VocabListRow
          key={`${item.title}:${index}`}
          item={item}
          context={context}
        />
      ))}
    </ul>
  );
}

function VocabListRow({ item, context }: { item: VocabListItem; context: VocabRenderContext }) {
  const [hovered, setHovered] = React.useState(false);
  const Icon = item.icon ? pluginIcon(item.icon) : null;
  const tone = item.tone ?? "neutral";
  const interactive = Boolean(item.onPress);

  const body = (
    <>
      {Icon ? (
        <Icon size={14} weight="regular" color={TONE_COLOR[tone]} aria-hidden style={{ flexShrink: 0 }} />
      ) : null}
      <span style={{ minWidth: 0, display: "grid", gap: 1 }}>
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: 500,
            color: tone === "neutral" ? COLORS.textPrimary : TONE_COLOR[tone],
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </span>
        {item.subtitle ? (
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              color: COLORS.textMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.subtitle}
          </span>
        ) : null}
      </span>
      {item.meta ? (
        <span
          style={{
            marginLeft: "auto",
            flexShrink: 0,
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textDim,
          }}
        >
          {item.meta}
        </span>
      ) : null}
    </>
  );

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 8px",
    textAlign: "left",
    background: hovered && interactive ? COLORS.hoverBg : "transparent",
    border: "none",
    borderRadius: RADII.sm,
    minWidth: 0,
  };

  if (!interactive) {
    return <li style={rowStyle}>{body}</li>;
  }
  return (
    <li style={{ display: "contents" }}>
      <button
        type="button"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => void context.dispatch(item.onPress!).catch(() => {})}
        style={{ ...rowStyle, cursor: "pointer" }}
      >
        {body}
      </button>
    </li>
  );
}

/* ── Table ──────────────────────────────────────────────────────────────── */

export function VocabTable({
  node,
  context,
}: {
  node: VocabTableNode;
  context: VocabRenderContext;
}) {
  const bound = boundRows(node, context);
  const source: unknown[] = bound ?? (node.rows ?? []);
  const rows = source
    .map((row) => coerceBoundTableRow(row, node.columns))
    .filter((row): row is Record<string, string> => row !== null);
  const visible = rows.slice(0, VOCAB_LIMITS.maxTableRows);
  const hidden = rows.length - visible.length;

  if (visible.length === 0) {
    return <EmptyLine text={node.emptyText ?? "No rows."} />;
  }

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div style={{ overflowX: "auto", minWidth: 0 }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: SANS_FONT,
            fontSize: 11.5,
          }}
        >
          <thead>
            <tr>
              {node.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  style={{
                    padding: "0 10px 6px",
                    textAlign: column.align === "right" ? "right" : "left",
                    fontWeight: 500,
                    color: COLORS.textMuted,
                    borderBottom: `1px solid ${COLORS.borderMuted}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr key={index}>
                {node.columns.map((column) => {
                  const text = row[column.key] ?? "";
                  return (
                    <td
                      key={column.key}
                      style={{
                        padding: "7px 10px",
                        textAlign: column.align === "right" ? "right" : "left",
                        color: text ? COLORS.textSecondary : COLORS.textDim,
                        borderBottom: `1px solid ${COLORS.borderMuted}`,
                        ...(column.align === "right" ? { fontVariantNumeric: "tabular-nums" } : {}),
                      }}
                    >
                      {text || "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? <EmptyLine text={`+${hidden} more`} /> : null}
    </div>
  );
}

/* ── Key / value ────────────────────────────────────────────────────────── */

export function VocabKeyValue({
  node,
  context,
}: {
  node: VocabKeyValueNode;
  context: VocabRenderContext;
}) {
  const bound = boundRows(node, context);
  const rows = bound
    ? bound.map(coerceBoundKeyValueRow).filter((row): row is VocabKeyValueRow => row !== null)
    : (node.rows ?? []);

  if (rows.length === 0) return <EmptyLine text={node.emptyText ?? "No details."} />;

  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "minmax(0, auto) minmax(0, 1fr)",
        columnGap: 16,
        rowGap: 6,
        fontFamily: SANS_FONT,
        fontSize: 11.5,
      }}
    >
      {rows.slice(0, VOCAB_LIMITS.maxKeyValueRows).map((row, index) => (
        <React.Fragment key={`${row.key}:${index}`}>
          <dt style={{ color: COLORS.textMuted, whiteSpace: "nowrap" }}>{row.key}</dt>
          <dd
            style={{
              margin: 0,
              minWidth: 0,
              color: row.tone && row.tone !== "neutral" ? TONE_COLOR[row.tone] : COLORS.textPrimary,
              overflowWrap: "anywhere",
            }}
          >
            {row.value || "—"}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/* ── Media ──────────────────────────────────────────────────────────────── */

/**
 * Schemes a panel may point media at.
 *
 * A `src` is a string from another machine that this renderer turns into a
 * fetch. `https:` is the network case and `data:` is the self-contained one;
 * everything else a browser will happily load is a capability the plugin was
 * never granted — `file:` reads the disk this app can see, and a custom scheme
 * hands the OS a launch. The same rule is enforced on iOS in
 * `PluginVocabularyMediaViews.swift`.
 */
const MEDIA_SCHEMES = ["https:", "data:"];

function mediaSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  // Relative URLs have no scheme and would resolve against the app's own
  // origin, so they are refused here rather than resolved.
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(src.trim())?.[1]?.toLowerCase();
  return scheme && MEDIA_SCHEMES.includes(scheme) ? src.trim() : undefined;
}

/**
 * Plain HTML5 video. `src` is withheld until the hosting surface is visible:
 * a `<video>` in a mounted-but-hidden panel would otherwise fetch and decode
 * for a tab nobody is looking at.
 */
export function VocabVideo({ node, context }: { node: VocabVideoNode; context: VocabRenderContext }) {
  const src = mediaSrc(node.src);
  const poster = mediaSrc(node.poster);
  if (!src) return <EmptyLine text={node.title ?? "This video can’t be played here."} />;

  return (
    <figure style={{ margin: 0, display: "grid", gap: 6, minWidth: 0 }}>
      <video
        controls
        preload="metadata"
        {...(context.active ? { src } : {})}
        {...(poster ? { poster } : {})}
        style={{
          width: "100%",
          maxHeight: 420,
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.borderMuted}`,
          borderRadius: RADII.md,
        }}
      />
      {node.title ? (
        <figcaption style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
          {node.title}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function VocabImage({ node }: { node: VocabImageNode }) {
  const src = mediaSrc(node.src);
  if (!src) return <EmptyLine text={node.alt} />;

  return (
    <img
      src={src}
      alt={node.alt}
      loading="lazy"
      style={{
        display: "block",
        maxWidth: "100%",
        ...(node.maxHeight ? { maxHeight: node.maxHeight } : {}),
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: RADII.md,
      }}
    />
  );
}

/* ── Empty state ────────────────────────────────────────────────────────── */

/**
 * A panel's own empty state.
 *
 * Not `ui/EmptyState`: that component hard-codes a dark background and a
 * monospace description, so it reads as a foreign card inside a light theme and
 * breaks the "no monospace outside code" rule this vocabulary keeps.
 */
export function VocabEmptyState({
  node,
  context,
}: {
  node: VocabEmptyStateNode;
  context: VocabRenderContext;
}) {
  const Icon = pluginIcon(node.icon);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "32px 20px",
        textAlign: "center",
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: RADII.lg,
      }}
    >
      <Icon size={22} weight="regular" color={COLORS.textDim} aria-hidden />
      <span style={{ fontFamily: SANS_FONT, fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary }}>
        {node.title}
      </span>
      {node.description ? (
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 11.5,
            color: COLORS.textMuted,
            maxWidth: "46ch",
            lineHeight: 1.5,
          }}
        >
          {node.description}
        </span>
      ) : null}
      {node.action ? (
        <span style={{ marginTop: 4 }}>
          <VocabButton
            node={{ component: "button", label: node.action.label, onPress: node.action.onPress }}
            context={context}
          />
        </span>
      ) : null}
    </div>
  );
}

/* ── Degradation affordances ────────────────────────────────────────────── */

/**
 * A component this build does not know. Says so in place, at the size of the
 * thing it replaces — the panel around it keeps working, which is the entire
 * point of the open component union.
 */
export function VocabUnknown({ node }: { node: VocabUnknownNode }) {
  return (
    <span
      title={`This build does not render "${node.name}". Updating ADE may add it.`}
      style={inlineBadge(COLORS.textDim, { gap: 5, fontStyle: "normal" })}
    >
      Not supported here
    </span>
  );
}

/** A known component whose payload did not validate. */
export function VocabInvalid({ node }: { node: VocabInvalidNode }) {
  return (
    <span title={`${node.name}: ${node.reason}`} style={inlineBadge(COLORS.warning, { gap: 5 })}>
      <WarningCircle size={11} weight="regular" aria-hidden />
      Can’t show this
    </span>
  );
}
