import type { ReactNode } from "react";
import {
  NoticeActions,
  NoticeBadge,
  NoticeChip,
  NoticeCloseButton,
  NoticeIcon,
  type NoticeAction,
} from "./NoticeParts";
import { NOTICE_FLOAT_SURFACE, noticeTone, type NoticeTone } from "./noticeTones";

/**
 * ADE's one toast card — the bottom-right stack's only look. A lane event, a
 * failing PR check, an idle-session nudge and a batch launch all render through
 * it, so the stack never mixes a "small" and a "large" design again: the same
 * card simply shows more parts when a toast carries more.
 *
 * Anatomy, top to bottom: icon tile · (badge, eyebrow) · title · chips · body ·
 * custom content · error line · actions. Every part but the title is optional.
 */

export type ToastChip = {
  label: string;
  icon?: ReactNode;
  /** Tints the chip (a lane's colour). */
  color?: string | null;
  title?: string;
};

export type ToastCardAction = NoticeAction & {
  /** Keep the toast open after this action runs (e.g. Undo that can fail). */
  keepOpen?: boolean;
};

export type ToastCardModel = {
  tone: NoticeTone;
  title: ReactNode;
  message?: ReactNode;
  /** Logo or feature glyph for the tile; defaults to the tone icon. */
  icon?: ReactNode;
  /** Short tone pill above the title ("Checks failing"). */
  badge?: string;
  /** Quiet text beside the badge ("#1287"). */
  eyebrow?: ReactNode;
  /** Small colour dot before the title (a lane). */
  colorDot?: string;
  chips?: ToastChip[];
  /** Live custom body (a progress list). Rendered under the message. */
  content?: ReactNode;
  /** Inline failure line ("Couldn't undo the link"). */
  error?: string;
  busy?: boolean;
  actions?: ToastCardAction[];
  /** Default true. */
  dismissible?: boolean;
  closeTitle?: string;
};

export function ToastCard({
  model,
  onClose,
  onAction,
  onMouseEnter,
  onMouseLeave,
  className,
}: {
  model: ToastCardModel;
  onClose?: () => void;
  /** Runs after an action's own handler (the stack dismisses unless keepOpen). */
  onAction?: (action: ToastCardAction) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  className?: string;
}): JSX.Element {
  const tokens = noticeTone(model.tone);
  const titleText = typeof model.title === "string" ? model.title : "notification";
  const hasHead = Boolean(model.badge || model.eyebrow);

  return (
    <div
      role={model.tone === "error" ? "alert" : "status"}
      data-notice-tone={model.tone}
      className={className}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        ...NOTICE_FLOAT_SURFACE,
        pointerEvents: "auto",
        overflow: "hidden",
        borderRadius: 14,
        border: `1px solid ${tokens.edge}`,
        padding: "11px 10px 11px 11px",
        fontFamily: "var(--font-sans)",
        color: "var(--color-fg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <NoticeIcon tone={model.tone} icon={model.icon} busy={model.busy} size="md" />
        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
              {hasHead ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {model.badge ? <NoticeBadge tone={model.tone}>{model.badge}</NoticeBadge> : null}
                  {model.eyebrow ? (
                    <span style={{ fontSize: 11, fontWeight: 500, color: "var(--color-muted-fg)" }}>
                      {model.eyebrow}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minHeight: hasHead ? undefined : 28,
                }}
              >
                {model.colorDot ? (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      flexShrink: 0,
                      background: model.colorDot,
                    }}
                  />
                ) : null}
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: 1.3,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {model.title}
                </span>
              </div>
            </div>
            {model.dismissible === false || !onClose ? null : (
              <NoticeCloseButton
                onClick={onClose}
                label={`Dismiss: ${titleText}`}
                title={model.closeTitle ?? "Dismiss"}
              />
            )}
          </div>
          {model.chips && model.chips.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
              {model.chips.map((chip, index) => (
                <NoticeChip key={`${chip.label}-${index}`} icon={chip.icon} color={chip.color} title={chip.title}>
                  {chip.label}
                </NoticeChip>
              ))}
            </div>
          ) : null}
          {model.message ? (
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--color-muted-fg)",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                overflowWrap: "anywhere",
              }}
            >
              {model.message}
            </div>
          ) : null}
          {model.content ? <div style={{ minWidth: 0 }}>{model.content}</div> : null}
          {model.error ? (
            <div role="alert" style={{ fontSize: 11.5, fontWeight: 500, color: noticeTone("error").text }}>
              {model.error}
            </div>
          ) : null}
          <NoticeActions
            actions={model.actions}
            tone={model.tone}
            size="md"
            onAfterClick={onAction ? (action) => onAction(action as ToastCardAction) : undefined}
            style={{ justifyContent: "flex-end", marginTop: 3 }}
          />
        </div>
      </div>
    </div>
  );
}
