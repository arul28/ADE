import { ArrowClockwise } from "@phosphor-icons/react";
import { Banner, type NoticeAction } from "../ui/notice";
import { isMachineStateConnectError, type MachineErrorCard } from "./remoteMachineModel";

type RemoteErrorCardProps = {
  card: MachineErrorCard;
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * One explicit recovery step for failures that retrying cannot fix — today,
   * "Pair again" when the machine rejected the saved pairing. Never runs on its
   * own; the user has to press it.
   */
  action?: { label: string; onClick: () => void } | null;
};

/**
 * A machine's connection failure, on the shared failure banner: the message's
 * first sentence is the title and the rest its detail line, the raw error sits
 * under them, and "Report" sends it to ADE. Try again re-runs connect.
 */
export function RemoteErrorCard({ card, onRetry, retrying, action = null }: RemoteErrorCardProps) {
  const actions: NoticeAction[] = [
    ...(action ? [{ label: action.label, onClick: action.onClick, variant: "secondary" as const }] : []),
    ...(onRetry
      ? [{
          label: retrying ? "Retrying…" : "Try again",
          onClick: onRetry,
          busy: retrying,
          icon: <ArrowClockwise size={12} weight="bold" />,
          variant: "secondary" as const,
        }]
      : []),
  ];
  // "Couldn't reach windows. It may be asleep…" reads as a title and a reason;
  // as one bold title it wraps to three lines beside the actions.
  const [lead, ...rest] = card.message.trim().split(/(?<=[.!?])\s+/);
  const title = rest.length > 0 ? lead.replace(/\.$/, "") : card.message;
  return (
    <Banner
      layout="inline"
      model={{
        id: "machine-connection-error",
        tone: isMachineStateConnectError(card.kind) ? "warning" : "error",
        title,
        detail: rest.length > 0 ? rest.join(" ") : undefined,
        ariaLabel: card.message,
        actions,
        report: {
          surface: "machine_connection",
          code: card.failure ? `connect_${card.failure}` : null,
          technicalDetail: card.detail,
        },
      }}
    />
  );
}
