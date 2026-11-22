/**
 * One Claude pass on Claude's ADE Cloud page: its account, whether new cloud
 * chats use it, its state and use, its switch, and Renew and Remove. The look
 * of the sign-in cards; the page decides the words (`adeCloudClaudeModel.ts`)
 * and runs every write.
 */
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { Banner } from "../../../ui/notice/Banner";
import { NoticeBadge } from "../../../ui/notice/NoticeParts";
import { SettingsToggle } from "../../primitives";
import { AccountCardFrame, CardOverflowMenu, accountCardLine as lineStyle } from "./accountCardParts";
import type { PassCardModel, PassUseModel } from "./adeCloudClaudeModel";

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
    <AccountCardFrame
      title={card.title}
      marked={marked}
      dimTitle={!(pass && on)}
      testId={`ade-cloud-pass-${card.key}`}
      dataset={{ "new-chats": marked ? "true" : undefined, off: pass && !on ? "true" : undefined }}
      badge={
        /* P1 / P2: where new chats go, unless smart balance picks. */
        !pass || smartBalance ? null : !on ? (
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
        )
      }
      menu={(
        <CardOverflowMenu
          title={card.title}
          busy={busy}
          items={[...(pass ? [{ label: "Renew", onSelect: onRenew }] : []), { label: "Remove", onSelect: onRemove, danger: true }]}
        />
      )}
    >
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
        // Remove is the only thing to do here, so it is on the card, not only in the menu.
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ ...lineStyle, flex: "1 1 200px" }}>ADE can't read this pass. Remove it, or approve a new one.</span>
          <button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            aria-label={`Remove ${card.title}`}
            onClick={onRemove}
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12, flexShrink: 0 })}
          >
            Remove
          </button>
        </div>
      )}
    </AccountCardFrame>
  );
}

/** U1–U3: the bars, or "No use seen yet"; never 0 % for a number nobody saw. */
function PassUse({ use, dim }: { use: PassUseModel; dim: boolean }) {
  if (use.kind === "none") return <span style={{ ...lineStyle, color: COLORS.textDim }}>No use seen yet</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, opacity: dim ? 0.7 : 1 }}>
      {use.windows.map((window) => window.pct == null ? (
        // No number: one line, never an empty bar that reads as 0 %.
        <span key={window.label} style={{ fontSize: 11.5, fontFamily: SANS_FONT, color: COLORS.textDim }}>
          <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>{window.label}</span>
          {window.note ? `: ${window.note}` : ""}
        </span>
      ) : (
        <div key={window.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 11.5, fontFamily: SANS_FONT }}>
            <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>{window.label}</span>
            {window.tone !== "crit" ? <span style={{ color: COLORS.textPrimary }}>{Math.round(window.pct)} %</span> : null}
            {window.note ? (
              <span style={{ marginLeft: "auto", color: window.tone === "crit" ? COLORS.danger : COLORS.textDim, textAlign: "right" }}>{window.note}</span>
            ) : null}
          </span>
          <span
            aria-hidden
            style={{ position: "relative", height: 4, borderRadius: 999, background: "color-mix(in srgb, var(--color-fg) 9%, transparent)", overflow: "hidden" }}
          >
            <i
              style={{
                position: "absolute",
                inset: 0,
                width: `${window.pct}%`,
                borderRadius: 999,
                background: window.tone === "crit" ? COLORS.danger : "var(--color-accent)",
              }}
            />
          </span>
        </div>
      ))}
      {use.source ? <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>{use.source}</span> : null}
    </div>
  );
}

