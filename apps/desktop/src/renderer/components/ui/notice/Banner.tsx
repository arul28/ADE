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
 * Four layouts, one look:
 * - `docked`     an app-level state that lasts (signed out, update stuck, relay
 *                down). In flow under the top bar; pushes content, never covers it.
 * - `floating`   a short, one-line prompt you act on or wave away (a link in the
 *                clipboard). Top center, over the app.
 * - `inline`     a banner about one surface (a lane needs a rebase), placed by
 *                that surface inside its own layout.
 * - `suggestion` a situational suggestion: ADE saw a signal that a feature
 *                would help now. A small card in the bottom-right corner
 *                (`AppSuggestionStack`): a quiet eyebrow, a title that says
 *                what the feature is, one "why now" line, one primary action
 *                and "Not now".
 *
 * Feature code never styles a banner; it picks a tone, an icon, words, actions.
 */

export type BannerLayout = "docked" | "floating" | "inline" | "suggestion";

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
  /** Inline failure line under the text ("Rebase failed: …"). */
  error?: string;
  /** The quiet label above a `suggestion` card's title. Defaults to "Suggestion". */
  eyebrow?: string;
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
  testId,
}: {
  model: BannerModel;
  layout?: BannerLayout;
  /** Called for a durable dismiss; the host records it. */
  onDurableDismiss?: (dismiss: { key: string; fingerprint: string }) => void;
  /** Outer spacing only (margins, width). Never colours or type. */
  style?: CSSProperties;
  /** `data-testid` on the banner's root. */
  testId?: string;
}): JSX.Element {
  if (layout === "suggestion") return <SuggestionCard model={model} style={style} testId={testId} />;
  const tokens = noticeTone(model.tone);
  const floating = layout === "floating";
  // Docked banners share the inline wrapping row: in a narrow window the
  // actions drop under the text instead of crushing it.
  const inline = layout !== "floating";
  const compactPill = floating && !model.detail && !model.extra && !model.error;
  const hasBody = Boolean(model.detail || model.extra || model.error);
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
        // 18px reads as a full pill at one line (~34px tall) and degrades to a
        // rounded card when a long prompt wraps, instead of a stretched lozenge.
        borderRadius: compactPill ? 18 : 14,
        padding: compactPill ? "5px 6px 5px 14px" : "10px 10px 10px 12px",
        border: `1px solid ${tokens.edge}`,
      }
    : {
        ...NOTICE_DOCKED_SURFACE,
        borderRadius: 10,
        padding: hasBody ? "8px 8px 8px 9px" : "6px 8px 6px 9px",
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
          // Wrap rather than truncate (a clipped error loses its meaning), and
          // let an unbroken URL, path or token break instead of spilling out.
          overflowWrap: "anywhere",
        }}
      >
        {model.title}
      </span>
      {model.detail ? (
        <span style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--color-muted-fg)", overflowWrap: "anywhere" }}>
          {model.detail}
        </span>
      ) : null}
      {model.extra ? <div style={{ marginTop: 4 }}>{model.extra}</div> : null}
      {model.error ? (
        <span style={{ fontSize: 11.5, fontWeight: 500, lineHeight: 1.45, color: noticeTone("error").text, overflowWrap: "anywhere" }}>
          {model.error}
        </span>
      ) : null}
    </div>
  );

  return (
    <div
      role={model.tone === "error" ? "alert" : "status"}
      aria-label={model.ariaLabel}
      data-testid={testId}
      data-notice-tone={model.tone}
      data-banner-id={model.id}
      data-banner-layout={layout}
      className={floating ? "ade-notice-float-enter" : layout === "docked" ? "ade-notice-dock-enter" : undefined}
      style={{
        display: "flex",
        alignItems: compactPill || !hasBody ? "center" : "flex-start",
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

/**
 * The `suggestion` layout. Not a state and not an alarm, so it reads quieter
 * than a banner: the tone shows only on the small icon tile and the primary
 * action. The owner passes exactly two actions, the primary and "Not now";
 * "Not now" is the dismissal, so the card draws no ×.
 */
function SuggestionCard({
  model,
  style,
  testId,
}: {
  model: BannerModel;
  style?: CSSProperties;
  testId?: string;
}): JSX.Element {
  const tokens = noticeTone(model.tone);
  return (
    <section
      role="status"
      aria-label={model.ariaLabel ?? (typeof model.title === "string" ? model.title : "Suggestion")}
      data-testid={testId}
      data-notice-tone={model.tone}
      data-banner-id={model.id}
      data-banner-layout="suggestion"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 0,
        padding: "12px 14px 14px",
        borderRadius: 14,
        border: `1px solid ${tokens.edge}`,
        fontFamily: "var(--font-sans)",
        color: "var(--color-fg)",
        ...NOTICE_FLOAT_SURFACE,
        // A suggestion sits over the page for a while, often over a picture,
        // where the theme's card colour is itself translucent. Mix from the
        // background instead, so its words always read (as the onboarding
        // hint card does with `.kit-card[data-float]`).
        background: "color-mix(in srgb, var(--color-bg) 90%, transparent)",
        backdropFilter: "blur(18px) saturate(1.2)",
        WebkitBackdropFilter: "blur(18px) saturate(1.2)",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <NoticeIcon tone={model.tone} icon={model.icon} busy={model.busy} size="sm" />
        <span className="kit-eyebrow" style={{ color: "var(--kit-text-3, var(--color-muted-fg))" }}>
          {model.eyebrow ?? "Suggestion"}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, letterSpacing: "-0.005em", overflowWrap: "anywhere" }}>
          {model.title}
        </span>
        {model.detail ? (
          <span style={{ fontSize: 12, lineHeight: 1.5, color: "var(--color-muted-fg)", overflowWrap: "anywhere" }}>
            {model.detail}
          </span>
        ) : null}
        {model.extra ? <div style={{ marginTop: 4 }}>{model.extra}</div> : null}
        {model.error ? (
          <span style={{ fontSize: 11.5, fontWeight: 500, lineHeight: 1.45, color: noticeTone("error").text, overflowWrap: "anywhere" }}>
            {model.error}
          </span>
        ) : null}
      </div>
      <NoticeActions actions={model.actions} tone={model.tone} size="md" style={{ marginTop: 2 }} />
    </section>
  );
}
