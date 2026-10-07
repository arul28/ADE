import React, { useCallback, useState } from "react";
import type { AgentChatNoticeDetail } from "../../../shared/types";
import { cn } from "../ui/cn";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * An ACP provider CLI older than the range ADE has tested, with the way to fix
 * it. The button installs the newest tested version, and is offered only when
 * the host resolved the install and exposes the updater. A successful update
 * replaces the button so it cannot run twice; a failed one keeps it as "Try
 * again" beside the reason.
 */
export function ProviderOutdatedNoticeRow({
  message,
  update,
  className,
  icon,
  chipLabel,
}: {
  message: string;
  update: NonNullable<AgentChatNoticeDetail["providerUpdate"]>;
  className?: string;
  icon: React.ReactNode;
  chipLabel: string;
}) {
  const [updating, setUpdating] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  // The CLI lives on the machine that ran this chat, which need not be the one
  // showing it. An unpinned call would update this computer's copy instead.
  const { binding } = useChatRuntimeScope();
  const run = window.ade?.ai?.acpProviderUpdate;
  // A failed attempt keeps the button so the user can try again.
  const canUpdate = update.canUpdate && typeof run === "function" && !outcome?.ok;
  const start = useCallback(async () => {
    const call = window.ade?.ai?.acpProviderUpdate;
    if (!call) return;
    setUpdating(true);
    try {
      const result = await call({ provider: update.provider }, binding);
      setOutcome({ ok: result.ok, text: result.ok ? `${result.message} Start a new chat to use it.` : result.message });
    } catch (error) {
      setOutcome({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setUpdating(false);
    }
  }, [binding, update.provider]);
  return (
    <div className={cn(
      "inline-flex max-w-[var(--chat-content-width,52rem)] flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10/14)]",
      className,
    )}>
      {icon}
      <span className="text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em]">{chipLabel}</span>
      <span className="normal-case tracking-normal text-fg/55">{message}</span>
      {canUpdate ? (
        <button
          type="button"
          disabled={updating}
          onClick={() => { void start(); }}
          data-testid="acp-provider-update"
          className="rounded border border-border/30 px-1.5 py-[1px] text-[length:calc(var(--chat-font-size)*9/14)] font-medium normal-case tracking-normal text-fg/70 hover:bg-fg/[0.06] disabled:opacity-50"
        >
          {updating ? "Updating…" : outcome ? "Try again" : `Update to ${update.targetVersion}`}
        </button>
      ) : null}
      {!canUpdate && !outcome && update.note ? (
        <span className="normal-case tracking-normal text-fg/42">{update.note}</span>
      ) : null}
      {outcome ? (
        <span className="normal-case tracking-normal text-fg/42">{outcome.text}</span>
      ) : null}
    </div>
  );
}
