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
import {
  SettingsNumber,
  SettingsSecret,
  SettingsSelect,
  SettingsText,
  SettingsToggle,
} from "../settings/primitives";
import { pluginIcon } from "./pluginIcons";
import type { PluginCollectionRow } from "../../lib/pluginRuntimeBridge";
import type {
  VocabAction,
  VocabBadgeNode,
  VocabButtonNode,
  VocabChartNode,
  VocabDividerNode,
  VocabEmptyStateNode,
  VocabField,
  VocabFormNode,
  VocabImageNode,
  VocabInvalidNode,
  VocabKeyValueNode,
  VocabKeyValueRow,
  VocabListItem,
  VocabListNode,
  VocabTableNode,
  VocabTextNode,
  VocabTone,
  VocabUnknownNode,
  VocabVideoNode,
} from "../../../shared/plugins/vocabulary";
import { VOCAB_LIMITS, normalizeVocabTone } from "../../../shared/plugins/vocabulary";

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
 */

/** Merged into an action's own args when a form submits. */
export type VocabActionArgs = Record<string, string | number | boolean>;

export type VocabDispatch = (action: VocabAction, extraArgs?: VocabActionArgs) => Promise<void>;

export type VocabRenderContext = {
  pluginId: string;
  /** Rows already fetched for every binding in the panel, keyed by {@link bindingKey}. */
  rowsByBinding: ReadonlyMap<string, PluginCollectionRow[]>;
  dispatch: VocabDispatch;
  /**
   * False while the hosting surface is mounted but not visible. Media does not
   * load and animation does not run when false — the hidden-but-mounted perf law.
   */
  active: boolean;
};

export const TONE_COLOR: Record<VocabTone, string> = {
  neutral: COLORS.textMuted,
  accent: COLORS.accent,
  success: COLORS.success,
  warning: COLORS.warning,
};

const GAP_PX = { none: 0, sm: 6, md: 12, lg: 20 } as const;

export function stackGap(gap: keyof typeof GAP_PX | undefined): number {
  return GAP_PX[gap ?? "md"];
}

/**
 * Stable key for a binding, so one fetch serves every node that reads it.
 *
 * NUL separates the two halves because it is the one character neither a
 * collection name nor a key prefix can contain. With a printable separator,
 * `{collection: "a", keyPrefix: "b:c"}` and `{collection: "a:b", keyPrefix: "c"}`
 * would produce the same key and silently share one fetch.
 */
export function bindingKey(binding: { collection: string; keyPrefix?: string }): string {
  return `${binding.collection}\u0000${binding.keyPrefix ?? ""}`;
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

export function InlineError({ message }: { message: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: COLORS.warning,
      }}
    >
      <WarningCircle size={12} weight="regular" aria-hidden />
      {message}
    </span>
  );
}

/* ── Bound data helpers ─────────────────────────────────────────────────── */

function boundRows(
  node: { bind?: { collection: string; keyPrefix?: string; limit?: number } },
  context: VocabRenderContext,
): unknown[] | null {
  if (!node.bind) return null;
  const rows = context.rowsByBinding.get(bindingKey(node.bind));
  if (!rows) return null;
  const limit = node.bind.limit;
  const values = rows.map((row) => row.value);
  return typeof limit === "number" && limit > 0 ? values.slice(0, limit) : values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function EmptyLine({ text }: { text: string }) {
  return (
    <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>{text}</p>
  );
}

/* ── List ───────────────────────────────────────────────────────────────── */

function coerceListItem(value: unknown): VocabListItem | null {
  if (!isRecord(value)) return null;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title) return null;
  return {
    title,
    ...(typeof value.subtitle === "string" ? { subtitle: value.subtitle } : {}),
    ...(typeof value.meta === "string" ? { meta: value.meta } : {}),
    ...(value.tone !== undefined ? { tone: normalizeVocabTone(value.tone) } : {}),
    ...(typeof value.icon === "string" ? { icon: value.icon } : {}),
  };
}

export function VocabList({
  node,
  context,
}: {
  node: VocabListNode;
  context: VocabRenderContext;
}) {
  const bound = boundRows(node, context);
  const items = bound
    ? bound.map(coerceListItem).filter((item): item is VocabListItem => item !== null)
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
  const rows = bound
    ? bound.filter(isRecord).map((row) => row as Record<string, unknown>)
    : ((node.rows ?? []) as Record<string, unknown>[]);
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
                  const value = row[column.key];
                  const text = typeof value === "string" || typeof value === "number"
                    ? String(value)
                    : typeof value === "boolean"
                      ? (value ? "Yes" : "No")
                      : "—";
                  return (
                    <td
                      key={column.key}
                      style={{
                        padding: "7px 10px",
                        textAlign: column.align === "right" ? "right" : "left",
                        color: text === "—" ? COLORS.textDim : COLORS.textSecondary,
                        borderBottom: `1px solid ${COLORS.borderMuted}`,
                        ...(column.align === "right" ? { fontVariantNumeric: "tabular-nums" } : {}),
                      }}
                    >
                      {text}
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

function coerceKeyValueRow(value: unknown): VocabKeyValueRow | null {
  if (!isRecord(value)) return null;
  const key = typeof value.key === "string" ? value.key.trim() : "";
  if (!key) return null;
  return {
    key,
    value: typeof value.value === "string" || typeof value.value === "number"
      ? String(value.value)
      : "",
    ...(value.tone !== undefined ? { tone: normalizeVocabTone(value.tone) } : {}),
  };
}

export function VocabKeyValue({
  node,
  context,
}: {
  node: VocabKeyValueNode;
  context: VocabRenderContext;
}) {
  const bound = boundRows(node, context);
  const rows = bound
    ? bound.map(coerceKeyValueRow).filter((row): row is VocabKeyValueRow => row !== null)
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

/* ── Form ───────────────────────────────────────────────────────────────── */

type FormValues = Record<string, string | number | boolean>;

function initialFormValues(fields: VocabField[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.value !== undefined) values[field.id] = field.value;
    else if (field.kind === "toggle") values[field.id] = false;
    else if (field.kind === "number") values[field.id] = field.min ?? 0;
    else values[field.id] = "";
  }
  return values;
}

export function VocabForm({
  node,
  context,
}: {
  node: VocabFormNode;
  context: VocabRenderContext;
}) {
  const [values, setValues] = React.useState<FormValues>(() => initialFormValues(node.fields));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const setValue = (id: string, value: string | number | boolean) => {
    setSaved(false);
    setValues((previous) => ({ ...previous, [id]: value }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (node.submit.onPress.confirm && !window.confirm(node.submit.onPress.confirm)) return;
    setPending(true);
    setError(null);
    try {
      await context.dispatch(node.submit.onPress, values);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That action failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 14, minWidth: 0 }}>
      {node.fields.map((field) => (
        <VocabFormField
          key={field.id}
          field={field}
          value={values[field.id]}
          onChange={(next) => setValue(field.id, next)}
          disabled={pending}
        />
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="submit"
          disabled={pending}
          style={{ ...primaryButton(), opacity: pending ? 0.55 : 1, cursor: pending ? "default" : "pointer" }}
          data-tour={`plugin:${context.pluginId}.submit-${node.submit.onPress.action}`}
        >
          {pending ? "Saving…" : node.submit.label}
        </button>
        {error ? <InlineError message={error} /> : null}
        {saved && !error ? (
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.success }}>Saved</span>
        ) : null}
      </div>
    </form>
  );
}

function VocabFormField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: VocabField;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean) => void;
  disabled: boolean;
}) {
  const controlId = `plugin-field-${field.id}`;
  const control = (() => {
    switch (field.kind) {
      case "toggle":
        return (
          <SettingsToggle
            id={controlId}
            label={field.label}
            checked={value === true}
            onChange={onChange}
            disabled={disabled}
          />
        );
      case "select":
        return (
          <SettingsSelect
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "string" ? value : (field.options?.[0]?.value ?? "")}
            options={(field.options ?? []).map((option) => ({
              value: option.value,
              label: option.label ?? option.value,
            }))}
            onChange={onChange}
            disabled={disabled}
          />
        );
      case "number":
        return (
          <SettingsNumber
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "number" ? value : 0}
            onChange={onChange}
            {...(field.min !== undefined ? { min: field.min } : {})}
            {...(field.max !== undefined ? { max: field.max } : {})}
            {...(field.step !== undefined ? { step: field.step } : {})}
            disabled={disabled}
          />
        );
      case "secret":
        return (
          <SettingsSecret
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "string" ? value : ""}
            onChange={onChange}
            disabled={disabled}
          />
        );
      default:
        return (
          <SettingsText
            id={controlId}
            ariaLabel={field.label}
            value={typeof value === "string" ? value : ""}
            onChange={onChange}
            {...(field.placeholder ? { placeholder: field.placeholder } : {})}
            disabled={disabled}
          />
        );
    }
  })();

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <label
        htmlFor={controlId}
        style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 500, color: COLORS.textSecondary }}
      >
        {field.label}
      </label>
      {control}
      {field.help ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>{field.help}</span>
      ) : null}
    </div>
  );
}

/* ── Chart ──────────────────────────────────────────────────────────────── */

const CHART_VIEWBOX_WIDTH = 600;
const CHART_VIEWBOX_HEIGHT = 120;

/**
 * A deliberately small hand-rolled SVG chart, in the house style of
 * `usage/UsageDailyChart.tsx` — no charting dependency, one `<svg>`, geometry
 * computed in a memo.
 *
 * The plot stretches with `preserveAspectRatio="none"` and every stroke carries
 * `vector-effect="non-scaling-stroke"`, so a wide panel does not smear the
 * lines. Nothing textual lives inside the SVG for the same reason: labels are
 * HTML around it, where they stay the size they were asked to be.
 */
export function VocabChart({ node }: { node: VocabChartNode }) {
  const geometry = React.useMemo(() => {
    const points = node.series.flatMap((series) => series.points);
    const max = points.reduce((highest, point) => Math.max(highest, point.y), 0);
    const longest = node.series.reduce((count, series) => Math.max(count, series.points.length), 0);
    return { max: max > 0 ? max : 1, longest };
  }, [node.series]);

  const hasPoints = geometry.longest > 0;
  if (!hasPoints) return <EmptyLine text={node.emptyText ?? "No data yet."} />;

  const xAt = (index: number) =>
    geometry.longest <= 1
      ? CHART_VIEWBOX_WIDTH / 2
      : (index / (geometry.longest - 1)) * CHART_VIEWBOX_WIDTH;
  const yAt = (value: number) =>
    CHART_VIEWBOX_HEIGHT - (Math.max(0, value) / geometry.max) * CHART_VIEWBOX_HEIGHT;

  const first = node.series[0]?.points[0];
  const last = node.series[0]?.points[geometry.longest - 1];

  return (
    <figure style={{ margin: 0, display: "grid", gap: 8, minWidth: 0 }}>
      {node.title || node.series.length > 1 ? (
        <figcaption
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textMuted,
          }}
        >
          {node.title ? <span style={{ color: COLORS.textSecondary }}>{node.title}</span> : null}
          {node.series.length > 1
            ? node.series.map((series) => (
                <span key={series.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 2,
                      borderRadius: 1,
                      background: TONE_COLOR[series.tone ?? "accent"],
                    }}
                  />
                  {series.label ?? series.id}
                </span>
              ))
            : null}
        </figcaption>
      ) : null}

      <svg
        role="img"
        aria-label={node.title ?? `${node.kind} chart`}
        width="100%"
        height={CHART_VIEWBOX_HEIGHT}
        viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ display: "block", overflow: "visible" }}
      >
        <line
          x1={0}
          x2={CHART_VIEWBOX_WIDTH}
          y1={CHART_VIEWBOX_HEIGHT}
          y2={CHART_VIEWBOX_HEIGHT}
          stroke={COLORS.borderMuted}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {node.series.map((series) => {
          const color = TONE_COLOR[series.tone ?? "accent"];
          if (node.kind === "bar") {
            const slot = CHART_VIEWBOX_WIDTH / Math.max(1, geometry.longest);
            const width = Math.max(1, slot * 0.55);
            return (
              <g key={series.id}>
                {series.points.map((point, index) => {
                  const y = yAt(point.y);
                  return (
                    <rect
                      key={index}
                      x={xAt(index) - width / 2}
                      y={y}
                      width={width}
                      height={Math.max(0, CHART_VIEWBOX_HEIGHT - y)}
                      fill={color}
                      fillOpacity={0.55}
                    />
                  );
                })}
              </g>
            );
          }
          const path = series.points
            .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index)},${yAt(point.y)}`)
            .join(" ");
          return (
            <path
              key={series.id}
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: SANS_FONT,
          fontSize: 10.5,
          color: COLORS.textDim,
        }}
      >
        <span>{first ? String(first.x) : ""}</span>
        <span>peak {geometry.max.toLocaleString()}</span>
        <span>{last ? String(last.x) : ""}</span>
      </div>
    </figure>
  );
}

/* ── Media ──────────────────────────────────────────────────────────────── */

/**
 * Plain HTML5 video. `src` is withheld until the hosting surface is visible:
 * a `<video>` in a mounted-but-hidden panel would otherwise fetch and decode
 * for a tab nobody is looking at.
 */
export function VocabVideo({ node, context }: { node: VocabVideoNode; context: VocabRenderContext }) {
  return (
    <figure style={{ margin: 0, display: "grid", gap: 6, minWidth: 0 }}>
      <video
        controls
        preload="metadata"
        {...(context.active ? { src: node.src } : {})}
        {...(node.poster ? { poster: node.poster } : {})}
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
  return (
    <img
      src={node.src}
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
