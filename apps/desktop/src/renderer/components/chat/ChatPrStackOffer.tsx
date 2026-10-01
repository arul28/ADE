import React from "react";
import { Stack } from "@phosphor-icons/react";
import type { StackLinkOffer } from "../../../shared/types";

export function ChatPrStackOffer({
  offer,
  busy,
  error,
  onLink,
  onDismiss,
}: {
  offer: StackLinkOffer;
  busy: boolean;
  error: string | null;
  onLink: () => void;
  onDismiss: () => void;
}): React.ReactElement {
  const unclaimed = offer.siblings
    .filter((sibling) => !sibling.claimedByOtherChat)
    .map((sibling) => `#${sibling.githubPrNumber}`)
    .join(", ");
  return (
    <div className="rounded-lg border border-violet-400/20 bg-violet-500/[0.08] px-2.5 py-2">
      <div className="flex items-start gap-2">
        <Stack size={13} weight="fill" className="mt-0.5 shrink-0 text-violet-200/80" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-fg/85">
            Also in GitHub Stack #{offer.stackNumber}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-fg/50">{unclaimed}</p>
          {error ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-red-300/85">{error}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={onLink}
              className="rounded-md bg-violet-500/20 px-2 py-1 text-[11px] font-medium text-violet-100/90 hover:bg-violet-500/30 disabled:opacity-50"
            >
              Link stack
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-fg/50 hover:text-fg/75"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
