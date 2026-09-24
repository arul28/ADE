import { useCallback, useEffect, useState } from "react";
import { GithubLogo } from "@phosphor-icons/react";
import type { AutomationIngressStatus, AutomationLinearIngressStatus } from "../../../../shared/types";
import { LINEAR_BRAND, LinearMark } from "../../lanes/linearBrand";
import { Banner, noticeTone, type NoticeAction } from "../../ui/notice";
import { formatDate } from "../../../lib/format";
import { linearIngressApi } from "../linearIngressApi";
import { useAsyncAction } from "../../../hooks/useAsyncAction";

function Dot({ tone }: { tone: "ok" | "warn" | "off" }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: 999,
        flexShrink: 0,
        background: noticeTone(tone === "ok" ? "success" : tone === "warn" ? "warning" : "neutral").color,
      }}
    />
  );
}

function githubSummary(status: AutomationIngressStatus | null): { tone: "ok" | "warn" | "off"; label: string } {
  if (!status) return { tone: "off", label: "Not receiving" };
  const relay = status.githubRelay;
  const local = status.localWebhook;
  if (relay.status === "ready" && relay.healthy) return { tone: "ok", label: "via relay" };
  if (relay.status === "polling") return { tone: "ok", label: "polling" };
  if (local.listening) return { tone: "ok", label: "via webhook" };
  if (relay.status === "error" || local.status === "error") return { tone: "warn", label: "Error — check setup" };
  return { tone: "off", label: "Not receiving" };
}

export function IngressStatusStrip({ ingressStatus }: { ingressStatus: AutomationIngressStatus | null }) {
  const [dismissed, setDismissed] = useState(false);
  const [linear, setLinear] = useState<AutomationLinearIngressStatus | null>(null);
  const api = linearIngressApi();

  const refreshLinear = useCallback(async () => {
    if (!api?.getStatus) return;
    try {
      setLinear(await api.getStatus());
    } catch {
      // Ignore — the strip degrades to hiding the Linear row.
    }
  }, [api]);

  useEffect(() => {
    void refreshLinear();
  }, [refreshLinear]);

  const { run: setupLinear, pending: busy } = useAsyncAction({
    action: async () => {
      if (!api?.setup) return;
      try {
        await api.setup();
      } finally {
        // The service records lastError; the refresh surfaces it either way.
        await refreshLinear().catch(() => {});
      }
    },
  });

  if (dismissed) return null;

  const gh = githubSummary(ingressStatus);
  const linearAvailable = Boolean(api?.getStatus) && linear != null && linear.state !== "disabled";

  const linearError = linearAvailable && linear?.state === "error";
  const linearConnect = linearAvailable && linear?.state !== "ready" && linear?.state !== "error" && !linear?.appManaged;
  const actions: NoticeAction[] = linearConnect
    ? [{ label: "Connect", icon: <LinearMark size={12} />, onClick: () => void setupLinear(), disabled: busy }]
    : [];

  const segment = { display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 } as const;

  return (
    <Banner
      layout="inline"
      style={{ margin: "6px 12px", flexShrink: 0 }}
      model={{
        id: "automations-ingress-status",
        tone: gh.tone === "warn" || linearError ? "warning" : "neutral",
        icon: <GithubLogo size={13} weight="fill" />,
        ariaLabel: `GitHub events: ${gh.label}`,
        title: (
          <span style={segment} title={`GitHub events: ${gh.label}`}>
            <span>GitHub</span>
            <Dot tone={gh.tone} />
            <span style={{ fontWeight: 500, color: gh.tone === "off" ? "var(--color-muted-fg)" : undefined }}>
              {gh.label}
            </span>
          </span>
        ),
        detail: linearAvailable ? (
          <span style={segment} title={linear?.lastError ?? undefined}>
            <span style={{ display: "inline-flex", flexShrink: 0, color: LINEAR_BRAND.primary }}>
              <LinearMark size={12} />
            </span>
            <span>Linear</span>
            {linear?.state === "ready" ? (
              <>
                <Dot tone="ok" />
                <span style={{ color: "var(--color-fg)" }}>
                  {linear.appManaged ? "Connected via ADE app" : "Connected"}
                  {linear.lastEventAt ? ` · last ${formatDate(linear.lastEventAt, "—")}` : ""}
                </span>
              </>
            ) : linear?.state === "error" ? (
              <>
                <Dot tone="warn" />
                <span style={{ color: noticeTone("warning").text }}>Error</span>
              </>
            ) : linear?.appManaged ? (
              // App-connected workspaces self-configure on the first poll after
              // a linear.* rule is enabled — no manual connect step.
              <span>Via ADE app</span>
            ) : null}
          </span>
        ) : undefined,
        actions,
        dismiss: { onDismiss: () => setDismissed(true) },
      }}
    />
  );
}
