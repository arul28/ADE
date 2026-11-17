import { WifiLow } from "@phosphor-icons/react";
import { useLinkRoundTripMs, useSlowLinkActive } from "../../state/projectMachines";
import { StatusChip } from "../ui/notice";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * A chip on the composer's top edge while the link to the chat's machine is
 * in slow-connection mode. Its hover says why pictures wait for a tap.
 * Nothing for this computer's own chats, nor on a good link.
 */
export function ChatSlowLinkChip() {
  const scope = useChatRuntimeScope();
  const targetId = scope.binding?.kind === "remote" ? scope.binding.targetId : null;
  const slow = useSlowLinkActive(targetId);
  const rttMs = useLinkRoundTripMs(slow ? targetId : null);
  if (!slow) return null;
  return (
    <StatusChip
      tone="info"
      icon={<WifiLow size={10} weight="bold" />}
      label="Slow connection"
      detail={typeof rttMs === "number" ? `${Math.round(rttMs)} ms` : undefined}
      tooltip={`Pictures load when you click them, and terminals show what you type before the machine echoes it (${scope.machineName}).`}
      testId="chat-slow-link-chip"
    />
  );
}
