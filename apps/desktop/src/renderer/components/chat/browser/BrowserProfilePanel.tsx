/**
 * The profile drawer: what the shared authenticated profile currently holds,
 * and which sites have a remembered permission decision.
 *
 * Its own file because it is the pane's only two-column read-out — a
 * diagnostics column and a scrolling permissions list — and it has nothing to
 * do with the browser chrome it used to sit inside.
 */
import { ShieldCheck } from "@phosphor-icons/react";
import type {
  BuiltInBrowserPermissionDecision,
  BuiltInBrowserProfileDiagnostics,
} from "../../../../shared/types/builtInBrowser";
import { formatBytes } from "../../../lib/format";
import { cn } from "../../ui/cn";

export type BrowserProfilePanelProps = {
  diagnostics: BuiltInBrowserProfileDiagnostics | null;
  permissionDecisions: BuiltInBrowserPermissionDecision[];
  busy: boolean;
  onRefresh: () => void;
  onClearPermission: (
    decision?: Pick<BuiltInBrowserPermissionDecision, "origin" | "permission">,
  ) => void;
};

export function BrowserProfilePanel({
  diagnostics,
  permissionDecisions,
  busy,
  onRefresh,
  onClearPermission,
}: BrowserProfilePanelProps) {
  return (
    <div className="grid max-h-[190px] shrink-0 grid-cols-[minmax(220px,0.9fr)_minmax(280px,1.1fr)] overflow-hidden border-b border-emerald-300/12 bg-emerald-950/15 text-[10px]">
      <section className="min-w-0 border-r border-white/[0.06] px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-100/90">
          <ShieldCheck size={13} />
          Global authenticated profile
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="ml-auto rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] text-fg/65 hover:bg-white/[0.06] disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
        {diagnostics ? (
          <div className="mt-1.5 space-y-1 text-muted-fg/70">
            <div>
              {diagnostics.cookieCount} cookies · {diagnostics.persistentCookieCount} persistent · {diagnostics.sessionCookieCount} session
            </div>
            <div>
              Cache {diagnostics.cacheSizeBytes == null ? "unavailable" : formatBytes(diagnostics.cacheSizeBytes)} · {diagnostics.persistedPermissionDecisionCount} remembered permissions
            </div>
            <div>
              Last safe flush {diagnostics.lastStorageFlushAt
                ? new Date(diagnostics.lastStorageFlushAt).toLocaleString()
                : "not yet recorded this run"}
            </div>
            <div className="truncate" title={diagnostics.cookieDomains.join(", ")}>
              Signed-in domains: {diagnostics.cookieDomains.length > 0
                ? diagnostics.cookieDomains.slice(0, 8).join(", ")
                : "none detected"}
              {diagnostics.cookieDomains.length > 8
                ? ` +${diagnostics.cookieDomains.length - 8}`
                : ""}
            </div>
          </div>
        ) : (
          <div className="mt-2 text-muted-fg/55">Loading profile diagnostics…</div>
        )}
      </section>
      <section className="min-w-0 overflow-y-auto px-2.5 py-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-fg/82">
          Remembered site permissions
          {permissionDecisions.length > 0 ? (
            <button
              type="button"
              onClick={() => onClearPermission()}
              disabled={busy}
              className="ml-auto rounded border border-rose-300/15 px-1.5 py-0.5 text-[9px] text-rose-100/70 hover:bg-rose-500/10 disabled:opacity-40"
            >
              Clear all
            </button>
          ) : null}
        </div>
        {permissionDecisions.length > 0 ? (
          <div className="mt-1.5 space-y-1">
            {permissionDecisions.map((decision) => (
              <div
                key={`${decision.origin}:${decision.embeddingOrigin ?? ""}:${decision.permission}`}
                className="flex min-w-0 items-center gap-2 rounded border border-white/[0.05] bg-black/15 px-1.5 py-1"
              >
                <span className={cn(
                  "rounded px-1 py-0.5 text-[8px] font-semibold uppercase",
                  decision.decision === "allow"
                    ? "bg-emerald-400/10 text-emerald-100/70"
                    : "bg-rose-400/10 text-rose-100/70",
                )}>
                  {decision.decision}
                </span>
                <span className="min-w-0 flex-1 truncate" title={`${decision.origin} · ${decision.permission}`}>
                  {decision.origin} · {decision.permission}
                </span>
                <button
                  type="button"
                  onClick={() => onClearPermission(decision)}
                  disabled={busy}
                  className="shrink-0 rounded px-1 py-0.5 text-[9px] text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg/80 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-muted-fg/55">No remembered allow or block decisions.</div>
        )}
      </section>
    </div>
  );
}
