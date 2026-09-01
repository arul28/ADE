import { useCallback, useEffect, useState } from "react";
import { GithubLogo, X } from "@phosphor-icons/react";
import type { AutomationIngressStatus, AutomationLinearIngressStatus } from "../../../../shared/types";
import { LINEAR_BRAND, LinearMark } from "../../lanes/linearBrand";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { formatDate } from "../../../lib/format";
import { linearIngressApi } from "../linearIngressApi";
import { useAsyncAction } from "../../../hooks/useAsyncAction";
import { useBuiltinSurfaceVisible } from "../../plugins/useBuiltinTabs";

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
  const api = linearIngressApi();
  /**
   * Gated inside the strip rather than at `RuleList`, the one place that draws
   * it today: the row is a Linear connection status and a Connect button, and a
   * second call site added later would leak both onto a machine where
   * `ade-linear` owns Linear. Same reason `LinearIssueBadge` carries its own
   * gate. The plugin declares a `webhookIngress` channel of its own and reports
   * its own delivery state, so ADE's row would be the second answer to one
   * question.
   */
  const linearSurfaceVisible = useBuiltinSurfaceVisible("linear");

  const refreshLinear = useCallback(async () => {
    // No poll once the plugin owns the surface. The row cannot be drawn, and
    // `getStatus` is one of the compiled Linear verbs ADE stops advertising on
    // such a machine.
    if (!linearSurfaceVisible) return;
    if (!api?.getStatus) return;
    try {
      setLinear(await api.getStatus());
    } catch {
      // Ignore — the strip degrades to hiding the Linear row.
    }
  }, [api, linearSurfaceVisible]);

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
  // The status itself rather than a boolean beside it: three of the four
  // conditions are about whether there is a Linear status worth drawing, so
  // narrowing to it once means the row below never re-asks whether `linear` is
  // there. `disabled` is the workspace saying it wants no row at all.
  const linearStatus = linearSurfaceVisible
    && Boolean(api?.getStatus)
    && linear != null
    && linear.state !== "disabled"
    ? linear
    : null;

  /**
   * The Linear row's one state, flat. Four outcomes that a nested ternary chain
   * read as one expression: connected, errored, self-configuring under the ADE
   * app, and the manual connect step for everyone else.
   */
  const linearRow = (status: AutomationLinearIngressStatus) => {
    if (status.state === "ready") {
      return (
        <>
          <Dot tone="ok" />
          <span className="text-fg/80">
            {status.appManaged ? "Connected via ADE app" : "Connected"}
            {status.lastEventAt ? ` · last ${formatDate(status.lastEventAt, "—")}` : ""}
          </span>
        </>
      );
    }
    if (status.state === "error") {
      return (
        <>
          <Dot tone="warn" />
          <span className="text-amber-200">Error</span>
        </>
      );
    }
    // App-connected workspaces self-configure on the first poll after a
    // linear.* rule is enabled — no manual connect step.
    if (status.appManaged) return <span className="text-muted-fg/70">Via ADE app</span>;
    return (
      <Button size="sm" variant="outline" disabled={busy} onClick={setupLinear}>
        Connect
      </Button>
    );
  };

  return (
    <div className="flex items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-4 py-2 text-[11px]">
      <div className="flex items-center gap-1.5" title={`GitHub events: ${gh.label}`}>
        <GithubLogo size={13} weight="fill" className="text-fg/80" />
        <span className="text-muted-fg/70">GitHub</span>
        <Dot tone={gh.tone} />
        <span className={cn(gh.tone === "off" ? "text-muted-fg/55" : "text-fg/80")}>{gh.label}</span>
      </div>

      {linearStatus ? (
        <div className="flex items-center gap-1.5" title={linearStatus.lastError ?? undefined}>
          <span className="shrink-0" style={{ color: LINEAR_BRAND.primary }}>
            <LinearMark size={13} />
          </span>
          <span className="text-muted-fg/70">Linear</span>
          {linearRow(linearStatus)}
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
