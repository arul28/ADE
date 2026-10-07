import { useCallback, useEffect, useState } from "react";
import { CaretDown, CaretRight, CheckCircle, Copy, Key, WebhooksLogo, Warning } from "@phosphor-icons/react";
import type { AutomationWebhookDeliverySummary, AutomationWebhookListEntry } from "../../../shared/types";
import { webhookPresetDef } from "../../../shared/automationWebhooks";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { showToast } from "../app/toast/toastStore";
import { relativeWhen } from "../../lib/format";
import { OUTCOME_STYLES, dotCls, panelCls, rowHoverCls, tagCls, toneTextCls } from "./webhookSurface";
import { WebhookDeliveries } from "./builder/WebhookDeliveries";

/**
 * Read-only view of every webhook automation: its URL, whether its signing
 * secret is saved, and what has arrived. This is what a surface that cannot
 * build or run automations (the hosted web client) shows instead of the
 * builder, so the user can still see what their doorbells are doing.
 */
export function WebhookOverview({ intro }: { intro?: string }) {
  const [entries, setEntries] = useState<AutomationWebhookListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openHookId, setOpenHookId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<AutomationWebhookDeliverySummary[]>([]);

  const load = useCallback(async () => {
    try {
      setEntries((await window.ade.automations.webhooks.list()) ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (hookId: string) => {
    if (openHookId === hookId) {
      setOpenHookId(null);
      return;
    }
    setOpenHookId(hookId);
    setDeliveries([]);
    try {
      setDeliveries(await window.ade.automations.webhooks.listDeliveries({ hookId, limit: 20 }));
    } catch {
      setDeliveries([]);
    }
  };

  return (
    <div className="space-y-3">
      {intro ? <p className="max-w-[62ch] text-[12.5px] leading-[1.45] text-muted-fg">{intro}</p> : null}
      {error ? <Banner layout="inline" model={{ id: "webhook-overview-error", tone: "warning", title: error }} /> : null}
      {entries === null ? (
        <div className={cn(panelCls, "px-4 py-6 text-center text-[12px] text-muted-fg")}>Loading webhooks…</div>
      ) : entries.length === 0 ? (
        <div className={cn(panelCls, "flex items-center gap-2 px-4 py-5 text-[12.5px] text-muted-fg")}>
          <WebhooksLogo size={15} />
          No webhook automations yet. Make one in ADE on your computer: Automations → New → Webhook.
        </div>
      ) : (
        <ul className={cn(panelCls, "divide-y divide-[color-mix(in_srgb,var(--color-fg)_7%,transparent)]")}>
          {entries.map((entry) => {
            const open = openHookId === entry.hookId;
            const last = entry.lastDelivery;
            const service = webhookPresetDef(entry.preset).label;
            return (
              <li key={entry.hookId}>
                <button
                  type="button"
                  onClick={() => void toggle(entry.hookId)}
                  className={cn("flex w-full items-center gap-3 px-4 py-3 text-left", rowHoverCls)}
                  aria-expanded={open}
                >
                  {open ? <CaretDown size={12} className="text-muted-fg" /> : <CaretRight size={12} className="text-muted-fg" />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                      {entry.ruleName}
                      {!entry.enabled ? <span className={tagCls("neutral")}>OFF</span> : null}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] text-muted-fg">
                      {service === "Anything else" ? "Any service" : service}
                      {entry.filters.length ? ` · only when ${entry.filters.join(" and ")}` : " · every request"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 font-mono text-[10.5px] tabular-nums text-muted-fg">
                    {last ? (
                      <>
                        <span className={dotCls(OUTCOME_STYLES[last.outcome]?.tone ?? "neutral")} />
                        {(last.outcome === "ran" ? "ran" : last.outcome.replace(/_/g, " ")).toUpperCase()} · {relativeWhen(last.receivedAt)}
                      </>
                    ) : (
                      <>NO DELIVERIES YET</>
                    )}
                  </span>
                </button>
                {open ? (
                  <div className="space-y-2.5 px-4 pb-4">
                    {entry.url ? (
                      <div className="flex items-center gap-1.5">
                        <code className={cn(panelCls, "min-w-0 flex-1 truncate px-2.5 py-1.5 font-mono text-[11px] text-fg")}>{entry.url}</code>
                        <button
                          type="button"
                          className={cn(panelCls, "inline-flex items-center gap-1 px-2 py-1.5 text-[11.5px] text-fg", rowHoverCls)}
                          onClick={() => {
                            void copyTextToClipboard(entry.url!).then((ok) =>
                              ok
                                ? showToast({ tone: "success", title: "URL copied" })
                                : showToast({ tone: "error", title: "Couldn't copy the URL" }),
                            );
                          }}
                        >
                          <Copy size={11} />
                          Copy
                        </button>
                      </div>
                    ) : (
                      <div className="text-[11.5px] text-muted-fg">This URL belongs to another machine.</div>
                    )}
                    <div className="flex items-center gap-1.5 text-[11.5px]">
                      {entry.signatureRequired ? (
                        entry.secretSaved ? (
                          <span className={cn("inline-flex items-center gap-1", toneTextCls.ok)}>
                            <CheckCircle size={12} weight="fill" /> Signed · {entry.secretName} saved
                          </span>
                        ) : (
                          <span className={cn("inline-flex items-center gap-1", toneTextCls.warn)}>
                            <Warning size={12} weight="fill" /> Signing secret {entry.secretName} not saved yet
                          </span>
                        )
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted-fg">
                          <Key size={12} /> No signature required
                        </span>
                      )}
                    </div>
                    <WebhookDeliveries hookId={entry.hookId} deliveries={deliveries} readOnly onChanged={() => undefined} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
