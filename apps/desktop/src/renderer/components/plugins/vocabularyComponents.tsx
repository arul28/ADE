import React from "react";
import { CaretDown, WarningCircle } from "@phosphor-icons/react";

import {
  COLORS,
  MONO_FONT,
  RADII,
  SANS_FONT,
  inlineBadge,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { DEFAULT_PLUGIN_ICON, isPluginBrandIconName, pluginIcon } from "./pluginIcons";
import { EmptyLine, InlineError, TONE_COLOR } from "./vocabularyPrimitives";
import type { VocabRenderContext } from "./vocabularyPrimitives";
import type {
  VocabAction,
  VocabBadgeNode,
  VocabBinding,
  VocabButtonNode,
  VocabDividerNode,
  VocabEmptyStateNode,
  VocabImageNode,
  VocabInvalidNode,
  VocabKeyValueNode,
  VocabKeyValueRow,
  VocabListItem,
  VocabListItemAction,
  VocabListNode,
  VocabSegmentedNode,
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
  // Brand tokens deliberately do NOT draw here, and this is a parity contract
  // rather than a limitation of this file. The phone draws a badge glyph at 8pt
  // through `ADEGlassChip`, and a vendor's mark at that size is a smudge, not a
  // logo — so iOS degrades a `brand:` token to the chip's text-only form. A
  // token that drew the Cursor mark here and nothing there would be exactly the
  // one-manifest-two-pictures break the token list exists to prevent, so this
  // side degrades with it.
  const Icon = node.icon && !isPluginBrandIconName(node.icon) ? pluginIcon(node.icon) : null;
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

/* ── Action dispatch ────────────────────────────────────────────────────── */

/**
 * The one path from a control to `context.dispatch`, so a confirmation cannot
 * be skipped by a control that forgot about it.
 *
 * A list row used to call `dispatch` directly and so ran a destructive action
 * with no prompt, while the same action behind a button asked first. iOS routes
 * every action through one `perform` for this reason
 * (`PluginPaneStore.swift`); this is the desktop and web equivalent.
 */
function useVocabActionRunner(context: VocabRenderContext) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(
    async (action: VocabAction) => {
      if (action.confirm && !window.confirm(action.confirm)) return;
      setPending(true);
      setError(null);
      try {
        await context.dispatch(action);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "That action failed.");
      } finally {
        setPending(false);
      }
    },
    [context],
  );

  return { pending, error, run };
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
  const { pending, error, run } = useVocabActionRunner(context);
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

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void run(node.onPress)}
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

/* ── Segmented ──────────────────────────────────────────────────────────── */

/**
 * The one control in the vocabulary that changes what a panel shows without
 * asking the plugin anything.
 *
 * A press writes one string into panel state and returns; every bound node whose
 * binding names that key re-filters from rows already in memory. That is the
 * whole mechanism, and it is why this is a node rather than a `form` field: a
 * field's value only means something when a submit button sends it somewhere.
 *
 * `onChange` is optional and fires AFTER the state is set, never instead of it.
 * A plugin that wants to know which filter the reader picked gets told; a plugin
 * that does not declare it still gets a working filter, and neither case waits
 * on a round trip before redrawing.
 *
 * Radio semantics, not tabs: the options change what a list contains rather than
 * which panel is showing, so screen readers should announce it as a choice.
 */
export function VocabSegmented({
  node,
  context,
}: {
  node: VocabSegmentedNode;
  context: VocabRenderContext;
}) {
  const current = context.state[node.stateKey] ?? node.default ?? node.options[0]?.value ?? "";
  const select = (value: string) => {
    if (value !== current) context.setStateValue(node.stateKey, value);
    // Dispatched even when the value did not change, because pressing the option
    // already selected is a legitimate "do that again" — the same reading a
    // refresh button gets.
    if (node.onChange) {
      void context.dispatch(node.onChange, { [node.stateKey]: value }).catch(() => {
        // A control whose only job is to filter must not strand itself on a
        // plugin's failure. The state is already set and the rows already
        // re-filtered; the banner under the panel carries the plugin's word.
      });
    }
  };

  return (
    <div
      role="radiogroup"
      {...(node.label ? { "aria-label": node.label } : {})}
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}
    >
      {node.label ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
          {node.label}
        </span>
      ) : null}
      <div
        style={{
          display: "inline-flex",
          padding: 2,
          gap: 2,
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.borderMuted}`,
          borderRadius: RADII.md,
          minWidth: 0,
        }}
      >
        {node.options.map((option) => {
          const selected = option.value === current;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => select(option.value)}
              data-tour={`plugin:${context.pluginId}.state-${node.stateKey}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 9px",
                fontFamily: SANS_FONT,
                fontSize: 11,
                fontWeight: selected ? 600 : 400,
                color: selected ? COLORS.textPrimary : COLORS.textMuted,
                background: selected ? COLORS.cardBgSolid : "transparent",
                border: "1px solid transparent",
                borderRadius: RADII.sm,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {option.label}
              {option.badge ? (
                <span style={{ color: COLORS.textDim, fontVariantNumeric: "tabular-nums" }}>
                  {option.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Bound data helpers ─────────────────────────────────────────────────── */

/**
 * The rows a bound node draws: the fetched values, filtered by the binding's
 * `where` against the panel's current state, then capped.
 *
 * Both steps live in `boundRowValues`, in `shared/plugins`, so the terminal and
 * the phone cannot end up with a different set of rows from the same schema and
 * the same data.
 */
function boundRows(node: { bind?: VocabBinding }, context: VocabRenderContext): unknown[] | null {
  if (!node.bind) return null;
  return boundRowValues(node.bind, context.rowsByBinding.get(bindingKey(node.bind)), context.state);
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
    ? bound
        .map((row) => coerceBoundListItem(row, node.bind?.allowActions))
        .filter((item): item is VocabListItem => item !== null)
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

/**
 * One list row.
 *
 * A row is a container rather than a single control, because it can carry a
 * press of its own AND trailing buttons, and a button inside a button is not
 * something a browser will render. The press area is the button when the row
 * declares `onPress`; the trailing actions are its siblings.
 *
 * One action runner for the whole row. Pressing anything on a row holds the
 * rest of it until the answer arrives, and one failure line under the row says
 * what went wrong. Two runners would let a reader start a second action against
 * data the first one is already changing.
 */
function VocabListRow({ item, context }: { item: VocabListItem; context: VocabRenderContext }) {
  const [hovered, setHovered] = React.useState(false);
  const { pending, error, run } = useVocabActionRunner(context);
  const Icon = item.icon ? pluginIcon(item.icon) : null;
  // Same 8pt chip as a standalone badge on the phone, so the same rule — see
  // {@link VocabBadge}. The row's own `icon` is a full-size slot and keeps them.
  const BadgeIcon = item.badge?.icon && !isPluginBrandIconName(item.badge.icon)
    ? pluginIcon(item.badge.icon)
    : null;
  const tone = item.tone ?? "neutral";
  const interactive = Boolean(item.onPress);
  const actions = item.actions ?? [];
  const overflow = item.overflow ?? [];

  const body = (
    <>
      {Icon ? (
        <Icon size={14} weight="regular" color={TONE_COLOR[tone]} aria-hidden style={{ flexShrink: 0 }} />
      ) : null}
      <span style={{ minWidth: 0, display: "grid", gap: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
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
          {item.badge ? (
            <span
              style={inlineBadge(TONE_COLOR[item.badge.tone ?? "neutral"], {
                gap: 4,
                padding: "1px 6px",
                fontSize: 10,
                flexShrink: 0,
              })}
            >
              {BadgeIcon ? <BadgeIcon size={10} weight="regular" aria-hidden /> : null}
              {item.badge.text}
            </span>
          ) : null}
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
        {/* Monospace, under the subtitle: the one place a row can put a value
            meant to be COMPARED against the row above it — an id, a branch, a
            short sha. `text` has `variant: "code"` for the same reason. */}
        {item.mono ? (
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10.5,
              color: COLORS.textDim,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.mono}
          </span>
        ) : null}
      </span>
      {item.meta ? (
        <span
          style={{
            marginLeft: "auto",
            flexShrink: 0,
            paddingLeft: 8,
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

  const readingStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
    padding: "7px 8px",
    textAlign: "left",
    background: hovered && interactive ? COLORS.hoverBg : "transparent",
    border: "none",
    borderRadius: RADII.sm,
  };

  return (
    <li style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, width: "100%", minWidth: 0 }}>
        {interactive ? (
          <button
            type="button"
            disabled={pending}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={() => void run(item.onPress!)}
            data-tour={`plugin:${context.pluginId}.action-${item.onPress!.action}`}
            style={{
              ...readingStyle,
              cursor: pending ? "default" : "pointer",
              opacity: pending ? 0.55 : 1,
            }}
          >
            {body}
          </button>
        ) : (
          <div style={readingStyle}>{body}</div>
        )}
        {actions.map((action, index) => (
          <VocabRowAction
            key={`${action.action}:${index}`}
            action={action}
            context={context}
            disabled={pending}
            onRun={run}
          />
        ))}
        {overflow.length > 0 ? (
          <VocabRowOverflow
            actions={overflow}
            context={context}
            disabled={pending}
            onRun={run}
          />
        ) : null}
      </div>
      {error ? <InlineError message={error} /> : null}
    </li>
  );
}

/**
 * A trailing button on a list row.
 *
 * Deliberately smaller and quieter than a `button` node: up to three of these
 * sit beside the row's own text, and at the weight of a real button a row would
 * read as a toolbar with a label attached. `primary` still fills, for the one
 * action a row is actually about.
 *
 * No pending text of its own — the row's runner holds the whole row while an
 * action is in flight, so a spinner here would be a second answer to a question
 * the row already answered.
 */
function VocabRowAction({
  action,
  context,
  disabled,
  onRun,
}: {
  action: VocabListItemAction;
  context: VocabRenderContext;
  disabled: boolean;
  onRun: (action: VocabAction) => Promise<void>;
}) {
  const Icon = action.icon ? pluginIcon(action.icon) : null;
  const kind = action.kind ?? "default";
  const compact: React.CSSProperties = { height: 24, padding: "0 8px", fontSize: 11, gap: 5 };
  const style: React.CSSProperties = kind === "primary"
    ? primaryButton(compact)
    : kind === "quiet"
      ? outlineButton({
          ...compact,
          background: "transparent",
          border: "1px solid transparent",
          color: COLORS.textMuted,
        })
      : outlineButton(compact);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onRun(action)}
      data-tour={`plugin:${context.pluginId}.action-${action.action}`}
      style={{
        ...style,
        flexShrink: 0,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {Icon ? <Icon size={12} weight="regular" aria-hidden /> : null}
      {action.label}
    </button>
  );
}

/**
 * The rest of a row's actions, behind a chevron.
 *
 * A menu rather than more buttons: a row that showed six controls would be a
 * form. The open menu closes on a press, on Escape and on a click anywhere
 * else, because a menu left open over the row below it is a menu that looks
 * like it belongs to the wrong row.
 */
function VocabRowOverflow({
  actions,
  context,
  disabled,
  onRun,
}: {
  actions: VocabListItemAction[];
  context: VocabRenderContext;
  disabled: boolean;
  onRun: (action: VocabAction) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const holder = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={holder} style={{ position: "relative", flexShrink: 0, display: "inline-flex" }}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((value) => !value)}
        style={{
          ...outlineButton({ height: 24, padding: "0 5px", background: "transparent" }),
          border: "1px solid transparent",
          color: COLORS.textMuted,
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <CaretDown size={12} weight="regular" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 20,
            display: "grid",
            gap: 1,
            minWidth: 160,
            padding: 4,
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADII.sm,
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
          }}
        >
          {actions.map((action, index) => {
            const Icon = action.icon ? pluginIcon(action.icon) : null;
            return (
              <button
                key={`${action.action}:${index}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void onRun(action);
                }}
                data-tour={`plugin:${context.pluginId}.action-${action.action}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  padding: "5px 7px",
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  textAlign: "left",
                  color: COLORS.textSecondary,
                  background: "transparent",
                  border: "none",
                  borderRadius: RADII.sm,
                  cursor: "pointer",
                }}
              >
                {Icon ? <Icon size={12} weight="regular" aria-hidden /> : null}
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
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
  // The hero mark of a whole empty page. iOS puts a symbol NAME through
  // `ADEEmptyStateView` and falls a `brand:` token to the puzzle piece rather
  // than blowing a vendor's logo up to hero size on a page that is about the
  // panel being empty, not about whose plugin it is. Same answer here, so the
  // two clients draw the same picture.
  const Icon = isPluginBrandIconName(node.icon) ? DEFAULT_PLUGIN_ICON : pluginIcon(node.icon);
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
