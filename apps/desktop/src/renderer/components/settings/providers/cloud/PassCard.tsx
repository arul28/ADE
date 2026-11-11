/**
 * One Claude pass on Claude's ADE Cloud page: its account, whether new cloud
 * chats use it, its state and use, its switch, and Renew and Remove. The look
 * of the sign-in cards; the page decides the words (`adeCloudClaudeModel.ts`)
 * and runs every write.
 */
import React, { useRef, useState } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { AnchoredMenu } from "../../../ui/AnchoredMenu";
import { Banner } from "../../../ui/notice/Banner";
import { NoticeBadge } from "../../../ui/notice/NoticeParts";
import { SettingsToggle } from "../../primitives";
import type { PassCardModel, PassUseModel } from "./adeCloudClaudeModel";

const lineStyle: React.CSSProperties = { fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 };

const toneColor = (tone: "warn" | "crit" | null) => (tone === "crit" ? COLORS.danger : tone === "warn" ? COLORS.warning : COLORS.textMuted);

export function PassCard({
  card,
  busy,
  smartBalance,
  onUse,
  onSwitch,
  onRenew,
  onRemove,
}: {
  card: PassCardModel;
  busy: boolean;
  /** Smart balance picks a pass for each new chat: no "New chats" badge and no Use button. */
  smartBalance: boolean;
  onUse: () => void;
  onSwitch: (next: boolean) => void;
  onRenew: () => void;
  onRemove: () => void;
}) {
  const pass = card.kind === "pass" ? card : null;
  const on = pass?.on ?? false;
  const marked = Boolean(pass && pass.newChats && !smartBalance && on);
  return (
    <div
      role="group"
      aria-label={card.title}
      data-testid={`ade-cloud-pass-${card.key}`}
      data-new-chats={marked ? "true" : undefined}
      data-off={pass && !on ? "true" : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${marked ? "color-mix(in srgb, var(--color-accent) 38%, transparent)" : COLORS.borderMuted}`,
        background: marked ? "color-mix(in srgb, var(--color-accent) 5%, transparent)" : COLORS.cardBg,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, minHeight: 26 }}>
        <span
          title={card.title}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: 500,
            fontFamily: SANS_FONT,
            color: pass && on ? COLORS.textPrimary : COLORS.textMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {card.title}
        </span>
        {/* P1 / P2: where new chats go, unless smart balance picks. */}
        {!pass || smartBalance ? null : !on ? (
          <NoticeBadge tone="neutral">Off for ADE Cloud</NoticeBadge>
        ) : pass.newChats ? (
          <NoticeBadge tone="accent">New chats</NoticeBadge>
        ) : pass.ended ? null : (
          <button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            aria-label={`Use ${card.title} for new chats`}
            onClick={onUse}
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12, flexShrink: 0 })}
          >
            Use for new chats
          </button>
        )}
        <PassMenu title={card.title} busy={busy} canRenew={Boolean(pass)} onRenew={onRenew} onRemove={onRemove} />
      </div>

      {pass ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, opacity: on ? 1 : 0.7 }}>
            {pass.checkLine ? <span style={{ ...lineStyle, color: COLORS.textSecondary }}>{pass.checkLine}</span> : null}
            <span style={lineStyle}>{pass.madeLine}</span>
            {pass.stateLine.text ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ ...lineStyle, color: toneColor(pass.stateLine.tone), flex: "1 1 160px" }}>{pass.stateLine.text}</span>
                {pass.renewNow ? (
                  <button type="button" onClick={onRenew} style={outlineButton({ height: 24, padding: "0 9px", fontSize: 12, flexShrink: 0 })}>
                    Renew
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          <PassUse use={pass.use} dim={!on} />
          {pass.uploadLine ? (
            <Banner layout="inline" model={{ id: `pass-upload-${card.key}`, tone: "neutral", title: pass.uploadLine }} />
          ) : null}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
            <span style={{ flex: 1, fontSize: 12, fontFamily: SANS_FONT, color: on ? COLORS.textSecondary : COLORS.textMuted }}>On for ADE Cloud</span>
            <SettingsToggle checked={on} disabled={busy} label={`On for ADE Cloud: ${card.title}`} onChange={onSwitch} />
          </div>
        </>
      ) : (
        <span style={lineStyle}>ADE can't read this pass. Remove it, or approve a new one.</span>
      )}
    </div>
  );
}

/** U1–U3: the bars, or "No use seen yet"; never 0 % for a number nobody saw. */
function PassUse({ use, dim }: { use: PassUseModel; dim: boolean }) {
  if (use.kind === "none") return <span style={{ ...lineStyle, color: COLORS.textDim }}>No use seen yet</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, opacity: dim ? 0.7 : 1 }}>
      {use.windows.map((window) => (
        <div key={window.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11.5, fontFamily: SANS_FONT }}>
            <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>{window.label}</span>
            {window.pct != null && window.tone !== "crit" ? <span style={{ color: COLORS.textPrimary }}>{Math.round(window.pct)} %</span> : null}
            {window.note ? (
              <span style={{ marginLeft: "auto", color: window.tone === "crit" ? COLORS.danger : COLORS.textDim, textAlign: "right" }}>{window.note}</span>
            ) : null}
          </span>
          <span
            aria-hidden
            style={{ position: "relative", height: 4, borderRadius: 999, background: "color-mix(in srgb, var(--color-fg) 9%, transparent)", overflow: "hidden" }}
          >
            {window.pct != null ? (
              <i
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${window.pct}%`,
                  borderRadius: 999,
                  background: window.tone === "crit" ? COLORS.danger : "var(--color-accent)",
                }}
              />
            ) : null}
          </span>
        </div>
      ))}
      {use.source ? <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>{use.source}</span> : null}
    </div>
  );
}

function PassMenu({ title, busy, canRenew, onRenew, onRemove }: { title: string; busy: boolean; canRenew: boolean; onRenew: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const item = (label: string, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={busy}
      onClick={() => {
        setOpen(false);
        run();
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 12px",
        border: "none",
        background: "transparent",
        fontSize: 12,
        fontFamily: SANS_FONT,
        color: danger ? COLORS.danger : COLORS.textSecondary,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <button
        ref={anchorRef}
        type="button"
        aria-label={`${title} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          padding: 0,
          border: "none",
          borderRadius: 6,
          background: open ? COLORS.hoverBg : "transparent",
          color: COLORS.textMuted,
          cursor: "pointer",
        }}
      >
        <DotsThree size={16} weight="bold" />
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        role="menu"
        aria-label={`${title} actions`}
        style={{
          minWidth: 150,
          padding: "4px 0",
          background: COLORS.cardBgSolid,
          border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 8,
          boxShadow: "0 14px 36px -20px rgba(0,0,0,0.85)",
        }}
      >
        {canRenew ? item("Renew", onRenew) : null}
        {item("Remove", onRemove, true)}
      </AnchoredMenu>
    </span>
  );
}
