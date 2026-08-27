import React from "react";
import { ArrowSquareOut, WarningCircle } from "@phosphor-icons/react";

import { COLORS, RADII, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { openAdeDeeplink } from "../../lib/openExternal";
import {
  VocabBadge,
  VocabButton,
  VocabChart,
  VocabDivider,
  VocabEmptyState,
  VocabForm,
  VocabImage,
  VocabInvalid,
  VocabKeyValue,
  VocabList,
  VocabSegmented,
  VocabTable,
  VocabText,
  VocabUnknown,
  VocabVideo,
  stackGap,
  type VocabRenderContext,
} from "./vocabularyComponents";
import {
  parsePluginPanel,
  readVocabFallback,
  type VocabError,
  type VocabFallback,
  type VocabNode,
  type VocabPanel,
} from "../../../shared/plugins/vocabulary";

/**
 * The desktop interpreter for plugin vocabulary v1.
 *
 * It turns validated schema into React and does nothing else — no fetching, no
 * subscriptions, no navigation of its own. `PluginPanelHost` supplies the data
 * and the action dispatcher; this file only decides what a node looks like.
 *
 * The contract it upholds, in one sentence: **a panel is never blank and never
 * crashes the tab.** Three layers guarantee it —
 *
 * 1. A schema that fails to parse renders {@link PluginFallbackCard} with the
 *    plugin's own fallback text.
 * 2. A node the parser could not validate, or a component this build does not
 *    know, renders a small inline affordance in place; its siblings are
 *    unaffected.
 * 3. A leaf that throws during render is caught by {@link VocabularyBoundary},
 *    which swaps the whole panel for the same fallback card rather than letting
 *    the error escape to the route's `PageErrorBoundary` and blank the tab.
 */

export type { VocabRenderContext } from "./vocabularyComponents";

/* ── Node dispatch ──────────────────────────────────────────────────────── */

function VocabNodeView({
  node,
  context,
}: {
  node: VocabNode;
  context: VocabRenderContext;
}) {
  switch (node.component) {
    case "stack": {
      const horizontal = node.direction === "horizontal";
      return (
        <div
          style={{
            display: "flex",
            flexDirection: horizontal ? "row" : "column",
            gap: stackGap(node.gap),
            alignItems: horizontal
              ? (node.align ?? "center")
              : (node.align ?? "stretch"),
            ...(node.wrap ? { flexWrap: "wrap" } : {}),
            minWidth: 0,
          }}
        >
          {node.children.map((child, index) => (
            <VocabNodeView key={index} node={child} context={context} />
          ))}
        </div>
      );
    }
    case "text":
      return <VocabText node={node} />;
    case "badge":
      return <VocabBadge node={node} />;
    case "button":
      return <VocabButton node={node} context={context} />;
    case "list":
      return <VocabList node={node} context={context} />;
    case "table":
      return <VocabTable node={node} context={context} />;
    case "form":
      return <VocabForm node={node} context={context} />;
    case "chart":
      return <VocabChart node={node} />;
    case "video":
      return <VocabVideo node={node} context={context} />;
    case "image":
      return <VocabImage node={node} />;
    case "divider":
      return <VocabDivider node={node} />;
    case "keyValue":
      return <VocabKeyValue node={node} context={context} />;
    case "emptyState":
      return <VocabEmptyState node={node} context={context} />;
    case "segmented":
      return <VocabSegmented node={node} context={context} />;
    case "__unknown":
      return <VocabUnknown node={node} />;
    case "__invalid":
      return <VocabInvalid node={node} />;
    default:
      // The parser only emits the cases above, so this is unreachable — but a
      // component added to the vocabulary without a case here must degrade,
      // not render nothing.
      return <VocabUnknown node={{ component: "__unknown", name: "unknown" }} />;
  }
}

/** Render a parsed panel's body. Assumes validation already happened. */
export function VocabularyRenderer({
  panel,
  context,
}: {
  panel: VocabPanel;
  context: VocabRenderContext;
}) {
  return (
    <div
      data-tour={`plugin:${context.pluginId}.panel`}
      style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}
    >
      {panel.body.map((node, index) => (
        <VocabNodeView key={index} node={node} context={context} />
      ))}
    </div>
  );
}

/* ── Fallback ───────────────────────────────────────────────────────────── */

/**
 * What a panel becomes when it cannot be rendered.
 *
 * It leads with the plugin's own `fallback.text` rather than an error, because
 * that sentence is the plugin author's summary of the content — the reader
 * usually wants the answer, not the diagnosis. The diagnosis is available
 * behind `Details`, where it helps the person debugging without shouting at
 * the person who just opened a tab.
 */
export function PluginFallbackCard({
  fallback,
  errors = [],
  action,
}: {
  fallback: VocabFallback | null;
  errors?: readonly VocabError[];
  /** Extra affordance for the caller's own recovery, e.g. Restart. */
  action?: React.ReactNode;
}) {
  const [showDetails, setShowDetails] = React.useState(false);
  const title = fallback?.title ?? "This panel can’t be shown";
  const text = fallback?.text
    ?? "The plugin sent a layout this version of ADE doesn’t understand. Updating ADE may fix it.";

  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        padding: 16,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: RADII.lg,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <WarningCircle size={14} weight="regular" color={COLORS.warning} aria-hidden />
        <span style={{ fontFamily: SANS_FONT, fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary }}>
          {title}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontFamily: SANS_FONT,
          fontSize: 11.5,
          color: COLORS.textSecondary,
          lineHeight: 1.55,
          maxWidth: "62ch",
        }}
      >
        {text}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {fallback?.deeplink ? (
          <button
            type="button"
            onClick={() => openAdeDeeplink(fallback.deeplink)}
            style={outlineButton({ height: 28, padding: "0 10px", fontSize: 11 })}
          >
            <ArrowSquareOut size={12} weight="regular" aria-hidden />
            Open
          </button>
        ) : null}
        {action}
        {errors.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowDetails((previous) => !previous)}
            style={{
              ...outlineButton({ height: 28, padding: "0 10px", fontSize: 11 }),
              background: "transparent",
              border: "1px solid transparent",
              color: COLORS.textMuted,
            }}
          >
            {showDetails ? "Hide details" : "Details"}
          </button>
        ) : null}
      </div>
      {showDetails && errors.length > 0 ? (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "grid",
            gap: 4,
            fontFamily: SANS_FONT,
            fontSize: 11,
            color: COLORS.textDim,
          }}
        >
          {errors.slice(0, 8).map((error, index) => (
            <li key={index}>
              {error.path ? `${error.path} — ` : ""}
              {error.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ── Error boundary ─────────────────────────────────────────────────────── */

/**
 * Catches a throw from anywhere inside a panel.
 *
 * A plugin panel is third-party content on a first-party route. Without this,
 * one bad leaf reaches the route's `PageErrorBoundary` and takes the whole tab
 * down; with it, the failure is contained to the panel and the reader still
 * gets the fallback text.
 *
 * `resetKey` is what makes the containment temporary. A boundary that never
 * clears stays broken for the life of its mount, which here means a plugin that
 * has already published a fixed schema still shows the failure card, and so does
 * a completely different plugin's panel mounted in the same place. The key
 * carries both identities, so either changing gives the panel another go.
 */
export class VocabularyBoundary extends React.Component<
  {
    fallback: VocabFallback | null;
    action?: React.ReactNode;
    /** Schema + plugin identity. A new value retries the render. */
    resetKey?: string;
    children: React.ReactNode;
  },
  { error: Error | null; resetKey: string | undefined }
> {
  state: { error: Error | null; resetKey: string | undefined } = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { error: Error | null; resetKey: string | undefined },
  ) {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <PluginFallbackCard
        fallback={this.props.fallback}
        action={this.props.action}
        errors={[{ code: "invalid_node", path: "", message: error.message }]}
      />
    );
  }
}

/* ── Public entry ───────────────────────────────────────────────────────── */

/** Content identity for a raw schema. Empty for anything that will not serialize. */
function schemaSignature(schema: unknown): string {
  if (typeof schema === "string") return schema;
  try {
    return JSON.stringify(schema) ?? "";
  } catch {
    return "";
  }
}

/**
 * Parse a raw schema and render it, or render the fallback card.
 *
 * This is what every surface hosting a plugin panel should call — the tab page,
 * a detail-section socket, or the chat card renderer — so all of them get the
 * same parse rules and the same degradation.
 */
export function PluginPanelView({
  schema,
  context,
  recoveryAction,
}: {
  /** The `schema_json` value as stored, or an already-parsed object. */
  schema: unknown;
  context: VocabRenderContext;
  /** Rendered next to `Open` on the fallback card, e.g. a Restart button. */
  recoveryAction?: React.ReactNode;
}) {
  const parsed = React.useMemo(() => parsePluginPanel(schema), [schema]);
  const fallback = parsed.ok ? parsed.panel.fallback : (parsed.fallback ?? readVocabFallback(schema));
  // Content, not object identity: the host hands back a fresh record on every
  // poll, and resetting the boundary on each one would re-throw the same failing
  // schema several times a minute. A schema is capped at 64 KiB, so this is the
  // same cost class as the parse above.
  const resetKey = React.useMemo(
    () => `${context.pluginId}\u0000${schemaSignature(schema)}`,
    [context.pluginId, schema],
  );

  if (!parsed.ok) {
    return (
      <PluginFallbackCard fallback={fallback} errors={parsed.errors} action={recoveryAction} />
    );
  }

  return (
    <VocabularyBoundary fallback={fallback} action={recoveryAction} resetKey={resetKey}>
      <VocabularyRenderer panel={parsed.panel} context={context} />
    </VocabularyBoundary>
  );
}
