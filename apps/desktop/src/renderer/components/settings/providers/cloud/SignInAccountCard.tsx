/**
 * One sign-in in the ADE account: its name, where it came from, who renewed
 * it, whether ADE Cloud uses it, its switch, and Remove. The look of
 * `AccountCard`; the page decides what it says (`adeCloudPageModel.ts`) and
 * runs every write.
 *
 * Three places draw it (`where`):
 *  - the ADE Cloud page: "In use on ADE Cloud" or "Use on ADE Cloud", and the switch;
 *  - an own computer's page: "In use here" for the sign-in that computer
 *    uses. Until own computers can take a sign-in from the account, the
 *    others say how to use them there, with no button that would fail;
 *  - a cloud computer's page: "In use here" for the one it applied, and "Use
 *    on ADE Cloud" on the others (the choice is account-wide).
 */
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { NoticeBadge } from "../../../ui/notice/NoticeParts";
import { SettingsToggle } from "../../primitives";
import { AccountCardFrame, CardOverflowMenu, accountCardLine as line } from "./accountCardParts";
import type { SignInCardModel } from "./adeCloudPageModel";

export type SignInCardPlace =
  | { kind: "ade-cloud" }
  /** `machineWords`: "this computer", or the page's computer by name. */
  | { kind: "own-computer"; inUseHere: boolean; machineWords: string }
  | { kind: "cloud-computer"; inUseHere: boolean };

export function SignInAccountCard({
  card,
  busy,
  onUse,
  onSwitch,
  onRemove,
  where = { kind: "ade-cloud" },
}: {
  card: SignInCardModel;
  /** A write for this card waits: its controls wait too. */
  busy: boolean;
  onUse?: () => void;
  /** The "On for ADE Cloud" switch; without it the card has none. */
  onSwitch?: (next: boolean) => void;
  onRemove: () => void;
  where?: SignInCardPlace;
}) {
  const onComputer = where.kind !== "ade-cloud";
  const inUseHere = onComputer && where.inUseHere;
  // The accent marks the sign-in the place in front of the person uses.
  const marked = onComputer ? inUseHere : card.inUse;

  return (
    <AccountCardFrame
      title={card.title}
      marked={marked}
      dimTitle={!card.on}
      testId={`ade-cloud-sign-in-${card.key}`}
      dataset={{ "in-use": marked ? "true" : undefined, place: where.kind, off: card.on ? undefined : "true" }}
      badge={
        /* K7 on a computer; K1 / K3 / K2 on ADE Cloud: in use, off, or the button that picks it. */
        inUseHere ? (
          <NoticeBadge tone="accent">In use here</NoticeBadge>
        ) : where.kind === "own-computer" ? null : card.inUse ? (
          // On a cloud computer's page the line below says it; the badge is for the place in front.
          where.kind === "ade-cloud" ? <NoticeBadge tone="accent">In use on ADE Cloud</NoticeBadge> : null
        ) : !card.on ? (
          <NoticeBadge tone="neutral">Off for ADE Cloud</NoticeBadge>
        ) : !onUse ? null : (
          <button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onUse}
            aria-label={`Use ${card.title} on ADE Cloud`}
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12, flexShrink: 0 })}
          >
            Use on ADE Cloud
          </button>
        )
      }
      menu={<CardOverflowMenu title={card.title} busy={busy} items={[{ label: "Remove", onSelect: onRemove, danger: true }]} />}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, opacity: card.on ? 1 : 0.7 }}>
        <span style={line}>{card.sourceLine}</span>
        {card.renewedLine ? <span style={line}>{card.renewedLine}</span> : null}
        {card.renewsNowLine ? <span style={{ ...line, color: COLORS.textSecondary }}>{card.renewsNowLine}</span> : null}
        {/* K8: an own computer takes a sign-in from the account later; until then, how to use it there. */}
        {where.kind === "own-computer" && !inUseHere ? (
          <span style={{ ...line, color: COLORS.textSecondary }}>To use it here, sign in on {where.machineWords}.</span>
        ) : null}
        {onComputer && card.inUse ? <span style={line}>In use on ADE Cloud</span> : null}
      </div>

      {onSwitch ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
          <span style={{ flex: 1, fontSize: 12, fontFamily: SANS_FONT, color: card.on ? COLORS.textSecondary : COLORS.textMuted }}>
            On for ADE Cloud
          </span>
          <SettingsToggle checked={card.on} disabled={busy} label={`On for ADE Cloud: ${card.title}`} onChange={onSwitch} />
        </div>
      ) : null}
    </AccountCardFrame>
  );
}
