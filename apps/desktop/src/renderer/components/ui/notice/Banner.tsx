import type { CSSProperties, ReactNode } from "react";
import { NoticeActions, NoticeCloseButton, NoticeIcon, type NoticeAction } from "./NoticeParts";
import { NOTICE_DOCKED_SURFACE, NOTICE_FLOAT_SURFACE, noticeTone, type NoticeTone } from "./noticeTones";

/**
 * ADE's one banner. Every banner in the app — the app-wide ones the
 * `AppBannerHost` stacks under the top bar, the short floating prompts at the
 * top center, and the ones a single tab or panel shows about itself — renders
 * through this component, so they read as one family: a card surface, a
 * tone-tinted icon tile (or a logo), sans type, pill actions, a quiet ×.
 *
 * Three layouts, one look:
 * - `docked`   an app-level state that lasts (signed out, update stuck, relay
 *              down). In flow under the top bar; pushes content, never covers it.
 * - `floating` a short, one-line prompt you act on or wave away (a link in the
 *              clipboard). Top center, over the app.
 * - `inline`   a banner about one surface (a lane needs a rebase), placed by
 *              that surface inside its own layout.
 *
 * Feature code never styles a banner; it picks a tone, an icon, words, actions.
 */

export type BannerLayout = "docked" | "floating" | "inline";

export type BannerDismiss =
  | false
  /** Durable: remembered in `bannerDismiss.ts` until the fingerprint changes. */
  | { key: string; fingerprint: string }
  /** The owner decides what dismissing means (in-memory, a snooze, a store). */
  | {
      onDismiss: () => void;
      title?: string;
      /** Accessible name for the ×; defaults to `Dismiss: <title>`. */
      label?: string;
    };

export type BannerModel = {
  /** Stable identity for one logical banner (React key, registry key). */
  id: string;
  tone: NoticeTone;
  /** A logo or feature glyph; defaults to the tone's icon. */
  icon?: ReactNode;
  title: ReactNode;
  /** Secondary line. Wraps; in a floating pill it turns the pill into a card. */
  detail?: ReactNode;
  actions?: NoticeAction[];
  /** `false`/omitted = not dismissable. */
  dismiss?: BannerDismiss;
  /** Work is in flight (spinner in the icon tile). */
  busy?: boolean;
  /** Accessible name when `title` is not plain text. */
  ariaLabel?: string;
  /** Extra content under the text (chips, a progress line). Keep it small. */
  extra?: ReactNode;
};

export function isDurableDismiss(
  dismiss: BannerDismiss | undefined,
): dismiss is { key: string; fingerprint: string } {
  return Boolean(dismiss && "key" in dismiss);
}

export function Banner({
  model,
  layout = "inline",
  onDurableDismiss,
  style,
}: {
  model: BannerModel;
  layout?: BannerLayout;
  /** Called for a durable dismiss; the host records it. */
  onDurableDismiss?: (dismiss: { key: string; fingerprint: string }) => void;
  /** Outer spacing only (margins, width). Never colours or type. */
  style?: CSSProperties;
}): JSX.Element {
  const tokens = noticeTone(model.tone);
  const floating = layout === "floating";
  // Docked banners share the inline wrapping row: in a narrow window the
  // actions drop under the text instead of crushing it.
  const inline = layout !== "floating";
  const compactPill = floating && !model.detail && !model.extra;
  const name = model.ariaLabel ?? (typeof model.title === "string" ? model.title : "notice");

  const dismiss = model.dismiss || null;
  const handleDismiss = dismiss
    ? () => {
        if ("onDismiss" in dismiss) dismiss.onDismiss();
        else onDurableDismiss?.(dismiss);
      }
    : null;

  const surface: CSSProperties = floating
    ? {
        ...NOTICE_FLOAT_SURFACE,
        borderRadius: compactPill ? 999 : 14,
        padding: compactPill ? "5px 6px 5px 14px" : "10px 10px 10px 12px",
        border: `1px solid ${tokens.edge}`,
      }
    : {
        ...NOTICE_DOCKED_SURFACE,
        borderRadius: 10,
        padding: model.detail || model.extra ? "8px 8px 8px 9px" : "6px 8px 6px 9px",
        border: `1px solid ${tokens.edge}`,
      };

  const text = (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: inline ? "1 1 180px" : 1 }}
    >
      <span
        style={{
          fontSize: compactPill ? 12 : 12.5,
          fontWeight: compactPill ? 500 : 600,
          lineHeight: 1.35,
          color: "var(--color-fg)",
          overflow: compactPill ? "hidden" : undefined,
          textOverflow: compactPill ? "ellipsis" : undefined,
          whiteSpace: compactPill ? "nowrap" : undefined,
        }}
      >
        {model.title}
      </span>
      {model.detail ? (
        <span style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--color-muted-fg)" }}>{model.detail}</span>
      ) : null}
      {model.extra ? <div style={{ marginTop: 4 }}>{model.extra}</div> : null}
    </div>
  );

  return (
    <div
      role={model.tone === "error" ? "alert" : "status"}
      data-notice-tone={model.tone}
      data-banner-id={model.id}
      data-banner-layout={layout}
      className={floating ? "ade-notice-float-enter" : layout === "docked" ? "ade-notice-dock-enter" : undefined}
      style={{
        display: "flex",
        alignItems: compactPill || !(model.detail || model.extra) ? "center" : "flex-start",
        gap: compactPill ? 9 : 10,
        minWidth: 0,
        fontFamily: "var(--font-sans)",
        color: "var(--color-fg)",
        ...surface,
        ...style,
      }}
    >
      <NoticeIcon tone={model.tone} icon={model.icon} busy={model.busy} size="sm" bare={compactPill} />
      {inline ? (
        // Inline banners live in panes that can be ~320px wide: the text and the
        // actions share one wrapping row, so the actions drop under the text
        // instead of crushing it, while the × stays pinned top-right.
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            columnGap: 10,
            rowGap: 6,
            minWidth: 0,
            flex: 1,
          }}
        >
          {text}
          <NoticeActions actions={model.actions} tone={model.tone} size="sm" style={{ flexShrink: 0 }} />
        </div>
      ) : (
        <>
          {text}
          <NoticeActions
            actions={model.actions}
            tone={model.tone}
            size="sm"
            style={{ flexShrink: 0, flexWrap: "nowrap", alignSelf: "center" }}
          />
        </>
      )}
      {handleDismiss ? (
        <NoticeCloseButton
          onClick={handleDismiss}
          label={dismiss && "onDismiss" in dismiss && dismiss.label ? dismiss.label : `Dismiss: ${name}`}
          title={dismiss && "onDismiss" in dismiss && dismiss.title ? dismiss.title : "Dismiss"}
        />
      ) : null}
    </div>
  );
}
