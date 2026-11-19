import { WifiLow } from "@phosphor-icons/react";
import { closeSlowLinkChip, useLinkRoundTripMs, useSlowLinkChipShown } from "../../state/projectMachines";
import { StatusChip } from "../ui/notice";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * A chip on the composer's top edge while the link to the chat's machine is
 * in slow-connection mode. Its hover says what the number is and why
 * pictures wait for a tap; its X hides it in every chat on that machine until
 * the link recovers. Nothing for this computer's own chats, nor on a good link.
 */
export function ChatSlowLinkChip() {
  const scope = useChatRuntimeScope();
  const targetId = scope.binding?.kind === "remote" ? scope.binding.targetId : null;
  const shown = useSlowLinkChipShown(targetId);
  const rttMs = useLinkRoundTripMs(shown ? targetId : null);
  if (!shown || !targetId) return null;
  return (
    <StatusChip
      tone="info"
      icon={<WifiLow size={10} weight="bold" />}
      label={`Slow connection to ${scope.machineName}`}
      detail={typeof rttMs === "number" ? `${Math.round(rttMs)} ms` : undefined}
      tooltip={[
        typeof rttMs === "number" ? `Round trip to ${scope.machineName}: ${Math.round(rttMs)} ms.` : null,
        "Pictures load when you click them, and terminals show what you type before the machine echoes it.",
      ].filter(Boolean).join(" ")}
      onDismiss={() => closeSlowLinkChip(targetId)}
      testId="chat-slow-link-chip"
    />
  );
}
