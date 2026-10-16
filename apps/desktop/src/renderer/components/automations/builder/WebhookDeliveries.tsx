import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowCounterClockwise, ChatCircleText, CheckCircle, Copy, Tray } from "@phosphor-icons/react";
import type {
  AutomationWebhookDelivery,
  AutomationWebhookDeliveryOutcome,
  AutomationWebhookDeliverySummary,
  OpenProjectBinding,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Dialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { relativeWhen } from "../../../lib/format";
import { eyebrowCls, OUTCOME_STYLES, panelCls, rowHoverCls, ruleCls, tagCls, toneTextCls } from "../webhookSurface";

const VIA_LABELS: Record<AutomationWebhookDeliverySummary["via"], string> = {
  relay: "via relay",
  local: "direct",
  replay: "replay",
  test: "test",
};

function OutcomePill({ outcome }: { outcome: AutomationWebhookDeliveryOutcome }) {
  const style = OUTCOME_STYLES[outcome] ?? OUTCOME_STYLES.error;
  return <span className={tagCls(style.tone)}>{style.label}</span>;
}

function CodeBlock({ title, text, empty }: { title: string; text: string; empty?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className={eyebrowCls}>{title}</div>
        {text ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[10px] text-muted-fg/60 hover:text-fg"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(
                () => showToast({ tone: "success", title: `${title} copied` }),
                () => undefined,
              );
            }}
          >
            <Copy size={10} />
            Copy
          </button>
        ) : null}
      </div>
      <pre className={cn(panelCls, "max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg/90")}>
        {text || <span className="text-muted-fg/50">{empty ?? "(empty)"}</span>}
      </pre>
    </div>
  );
}

function DeliveryDetail({
  id,
  runtimePin,
  readOnly,
  onClose,
  onReplayed,
}: {
  id: string;
  runtimePin: OpenProjectBinding | null;
  readOnly: boolean;
  onClose: () => void;
  onReplayed: () => void;
}) {
  const navigate = useNavigate();
  const [delivery, setDelivery] = useState<AutomationWebhookDelivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.ade.automations.webhooks
      .getDelivery({ id }, runtimePin)
      .then((value) => {
        if (!cancelled) setDelivery(value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, runtimePin]);

  const replay = async () => {
    setReplaying(true);
    try {
      const result = await window.ade.automations.webhooks.replayDelivery({ id }, runtimePin);
      showToast({
        tone: result?.outcome === "ran" ? "success" : "info",
        title: result?.outcome === "ran" ? "Running it again" : `Replayed: ${OUTCOME_STYLES[result?.outcome ?? "error"].label.toLowerCase()}`,
        message: result?.detail ?? "It uses the automation as it is now, so prompt and filter changes apply.",
      });
      onReplayed();
      onClose();
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't replay it", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setReplaying(false);
    }
  };

  const headerText = delivery
    ? Object.entries(delivery.headers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n")
    : "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Delivery"
      titleContent={
        delivery ? (
          <span className="flex items-center gap-2">
            <OutcomePill outcome={delivery.outcome} />
            <span className="text-[13px] font-semibold text-fg">
              {delivery.method} {delivery.eventLabel ? `· ${delivery.eventLabel}` : ""}
            </span>
          </span>
        ) : undefined
      }
      description={
        delivery
          ? `${relativeWhen(delivery.receivedAt)} · ${VIA_LABELS[delivery.via]}${
              delivery.signature === "verified"
                ? " · signature verified"
                : delivery.signature === "not_required"
                  ? " · no signature required"
                  : delivery.signature === "unchecked"
                    ? " · signature not checked (no secret saved)"
                    : ""
            }`
          : undefined
      }
      size="lg"
      footerStart={
        delivery?.chatSessionId ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onClose();
              const params = new URLSearchParams({ sessionId: delivery.chatSessionId! });
              if (delivery.chatLaneId) params.set("laneId", delivery.chatLaneId);
              navigate(`/work?${params.toString()}`);
            }}
          >
            <ChatCircleText size={12} />
            Open the run's chat
          </Button>
        ) : undefined
      }
      actions={[
        ...(delivery && !delivery.bodyTruncated && !readOnly && delivery.signature !== "failed" && delivery.signature !== "missing"
          ? [{ label: replaying ? "Replaying…" : "Run it again", onClick: () => void replay(), disabled: replaying, variant: "secondary" as const }]
          : []),
        { label: "Done", onClick: onClose, variant: "primary" as const },
      ]}
    >
      {loading ? (
        <div className="py-6 text-center text-[11px] text-muted-fg/60">Loading…</div>
      ) : error ? (
        <div className="py-6 text-center text-[11px] text-muted-fg/60">{`Couldn't load this delivery: ${error}`}</div>
      ) : !delivery ? (
        <div className="py-6 text-center text-[11px] text-muted-fg/60">This delivery is no longer in the log.</div>
      ) : (
        <div className="space-y-3">
          {delivery.detail ? (
            <div className={cn(panelCls, "px-3 py-2 text-[12px] leading-relaxed text-fg/90")}>{delivery.detail}</div>
          ) : delivery.outcome === "ran" ? (
            <div className={cn(panelCls, "flex items-center gap-1.5 px-3 py-2 text-[12px] text-fg/90")}>
              <CheckCircle size={13} weight="fill" className={toneTextCls.ok} />
              Passed every check and started a run.
            </div>
          ) : null}
          <CodeBlock
            title="Prompt the agent got"
            text={delivery.prompt ?? ""}
            empty={delivery.outcome === "ran" ? "This automation has no prompt of its own." : "No run started, so no prompt was sent."}
          />
          <CodeBlock title="Body" text={delivery.body} />
          {delivery.bodyTruncated ? <div className={cn("text-[11px]", toneTextCls.warn)}>The body was larger than 64 KB; ADE kept the first 64 KB.</div> : null}
          <CodeBlock title="Headers" text={headerText} />
        </div>
      )}
    </Dialog>
  );
}

export function WebhookDeliveries({
  deliveries,
  runtimePin = null,
  readOnly = false,
  onChanged,
}: {
  hookId: string;
  deliveries: AutomationWebhookDeliverySummary[];
  runtimePin?: OpenProjectBinding | null;
  /** Surfaces that can only look (the web client) hide "Run it again". */
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className={panelCls}>
      <div className={cn("flex h-9 items-center justify-between border-b px-3", ruleCls)}>
        <span className={eyebrowCls}>Deliveries</span>
        <span className="font-mono text-[10.5px] tabular-nums text-muted-fg">{Math.min(deliveries.length, 20)} · kept on this computer</span>
      </div>
      {deliveries.length === 0 ? (
        <div className="flex items-center gap-2 px-3 py-4 text-[11.5px] text-muted-fg">
          <Tray size={14} />
          Nothing yet. Requests show up here the moment they arrive, including ones ADE skipped and why.
        </div>
      ) : (
        <ul className={cn("divide-y", "divide-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]")}>
          {deliveries.map((delivery) => (
            <li key={delivery.id}>
              <button
                type="button"
                data-testid={`webhook-delivery-${delivery.outcome}`}
                onClick={() => setOpenId(delivery.id)}
                className={cn("flex min-h-8 w-full items-center gap-2.5 px-3 py-1.5 text-left", rowHoverCls)}
              >
                <OutcomePill outcome={delivery.outcome} />
                <span className="font-mono text-[10.5px] text-muted-fg">{delivery.method}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                  {delivery.eventLabel ?? <span className="text-muted-fg">request</span>}
                  {delivery.detail && delivery.outcome !== "ran" ? (
                    <span className="ml-2 text-[11.5px] text-muted-fg">{delivery.detail}</span>
                  ) : null}
                </span>
                {delivery.via === "replay" || delivery.via === "test" ? (
                  <span className="shrink-0 font-mono text-[10px] text-muted-fg">
                    {delivery.via === "replay" ? <ArrowCounterClockwise size={10} className="mr-0.5 inline" /> : null}
                    {VIA_LABELS[delivery.via]}
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-fg">{relativeWhen(delivery.receivedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {openId ? (
        <DeliveryDetail id={openId} runtimePin={runtimePin} readOnly={readOnly} onClose={() => setOpenId(null)} onReplayed={onChanged} />
      ) : null}
    </div>
  );
}
