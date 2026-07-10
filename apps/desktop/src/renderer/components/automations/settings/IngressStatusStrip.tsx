import { useCallback, useEffect, useState } from "react";
import { GithubLogo, Tag, X } from "@phosphor-icons/react";
import type { AutomationIngressStatus, AutomationLinearIngressStatus } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { formatDate } from "../../../lib/format";

type LinearIngressApi = typeof window.ade.automations.linearIngress;

/**
 * The Linear ingress IPC is part of the preload contract, but a remote runtime
 * on an older build may not expose it — probe defensively so the row hides
 * rather than throwing.
 */
function linearIngressApi(): Partial<LinearIngressApi> | null {
  return window.ade?.automations?.linearIngress ?? null;
}

function Dot({ tone }: { tone: "ok" | "warn" | "off" }) {
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 rounded-full",
        tone === "ok" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-400" : "bg-muted-fg/40",
      )}
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
  const [busy, setBusy] = useState(false);
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

  if (dismissed) return null;

  const gh = githubSummary(ingressStatus);
  const linearAvailable = Boolean(api?.getStatus) && linear != null && linear.state !== "disabled";

  const setupLinear = async () => {
    if (!api?.setup) return;
    setBusy(true);
    try {
      await api.setup();
      await refreshLinear();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2 text-[11px]">
      <div className="flex items-center gap-1.5" title={`GitHub events: ${gh.label}`}>
        <GithubLogo size={13} weight="fill" className="text-muted-fg/70" />
        <span className="text-muted-fg/70">GitHub</span>
        <Dot tone={gh.tone} />
        <span className={cn(gh.tone === "off" ? "text-muted-fg/55" : "text-fg/80")}>{gh.label}</span>
      </div>

      {linearAvailable ? (
        <div className="flex items-center gap-1.5" title={linear?.lastError ?? undefined}>
          <Tag size={13} weight="fill" className="text-muted-fg/70" />
          <span className="text-muted-fg/70">Linear</span>
          {linear?.state === "ready" ? (
            <>
              <Dot tone="ok" />
              <span className="text-fg/80">
                {linear.appManaged ? "Connected via ADE app" : "Connected"}
                {linear.lastEventAt ? ` · last ${formatDate(linear.lastEventAt, "—")}` : ""}
              </span>
            </>
          ) : linear?.state === "error" ? (
            <>
              <Dot tone="warn" />
              <span className="text-amber-200">Error</span>
            </>
          ) : linear?.appManaged ? (
            // App-connected workspaces self-configure on the first poll after
            // a linear.* rule is enabled — no manual connect step.
            <span className="text-muted-fg/70">Via ADE app</span>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void setupLinear()}>
              Connect
            </Button>
          )}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-auto rounded p-0.5 text-muted-fg/50 hover:text-fg"
        title="Dismiss"
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}
