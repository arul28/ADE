import { useEffect, useSyncExternalStore } from "react";
import { WifiLow } from "@phosphor-icons/react";
import { useLinkRoundTripMs, useSlowLinkActive } from "../../state/projectMachines";
import { StatusChip } from "../ui/notice";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * Machines whose chip the person closed. It stays closed in every chat on that
 * machine until the link is good again; the next slow spell shows it again.
 */
const dismissedTargets = new Set<string>();
const dismissListeners = new Set<() => void>();

function setDismissed(targetId: string, dismissed: boolean): void {
  if (dismissedTargets.has(targetId) === dismissed) return;
  if (dismissed) dismissedTargets.add(targetId);
  else dismissedTargets.delete(targetId);
  for (const listener of dismissListeners) listener();
}

function subscribeDismissed(listener: () => void): () => void {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}

/**
 * A chip on the composer's top edge while the link to the chat's machine is
 * in slow-connection mode. Its hover says what the number is and why
 * pictures wait for a tap; its X hides it until the link recovers.
 * Nothing for this computer's own chats, nor on a good link.
 */
export function ChatSlowLinkChip() {
  const scope = useChatRuntimeScope();
  const targetId = scope.binding?.kind === "remote" ? scope.binding.targetId : null;
  const slow = useSlowLinkActive(targetId);
  const rttMs = useLinkRoundTripMs(slow ? targetId : null);
  const dismissed = useSyncExternalStore(
    subscribeDismissed,
    () => (targetId ? dismissedTargets.has(targetId) : false),
    () => false,
  );
  useEffect(() => {
    if (targetId && !slow) setDismissed(targetId, false);
  }, [slow, targetId]);
  if (!slow || !targetId || dismissed) return null;
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
      onDismiss={() => setDismissed(targetId, true)}
      testId="chat-slow-link-chip"
    />
  );
}
