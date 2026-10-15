import { ArrowsInLineVertical } from "@phosphor-icons/react";
import type { CompactFirstOffer } from "../../../shared/compactFirst";
import { StatusChip } from "../ui/notice";
import { formatContextTokens } from "./usage/contextUsageModel";

/**
 * The composer chip for a supported chat whose prompt cache has expired: the
 * next message re-sends the whole chat unless it compacts first. One action
 * turns that on for the next send, the same action cancels it, and × hides the
 * chip until the next turn ends. Claude, Codex, and Pi/OpenCode models with a
 * known cache vendor can offer this; the window shown comes from the offer.
 */
export function CompactFirstChip({ offer, enabled, onToggle, onDismiss }: {
  offer: CompactFirstOffer;
  enabled: boolean;
  onToggle: () => void;
  onDismiss: () => void;
}) {
  const full = formatContextTokens(offer.contextTokens);
  const compacted = formatContextTokens(offer.estimatedPostTokens);
  const idle = offer.idleMs < 3_600_000 ? `${Math.round(offer.idleMs / 60_000)} minutes` : "an hour";
  return (
    <StatusChip
      tone={enabled ? "accent" : "warning"}
      icon={<ArrowsInLineVertical size={10} weight="bold" />}
      label={enabled ? "Compacts on next send" : "Cache expired"}
      detail={full}
      tooltip={enabled
        ? `Your next message compacts this chat first — about ${compacted} tokens instead of ${full}.`
        : `The cache expired after ${idle} — your next message re-sends all ${full} tokens. Compact first to send about ${compacted}.`}
      actions={[{
        label: enabled ? "Cancel" : "Compact first",
        title: enabled ? "Send the full chat instead" : undefined,
        onClick: onToggle,
        testId: "chat-compact-first-toggle",
      }]}
      onDismiss={onDismiss}
      testId="chat-compact-first-chip"
    />
  );
}
