import React from "react";
import { ArrowSquareOut, Globe } from "@phosphor-icons/react";
import type { DevServerRecord, OpenProjectBinding } from "../../../shared/types";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { refreshDevServersForMachine, useSessionDevServers } from "../../lib/laneDevServers";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MENU_LABEL_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { cn } from "../ui/cn";
import { workToolDefinition } from "./workTools";

/** `localhost:5173`, the way every surface names a dev server. */
export function devServerLabel(server: Pick<DevServerRecord, "url" | "port">): string {
  try {
    const parsed = new URL(server.url);
    return `${parsed.hostname === "127.0.0.1" ? "localhost" : parsed.hostname}:${server.port}`;
  } catch {
    return `localhost:${server.port}`;
  }
}

/** Swallow a press so the row under a portalled menu does not open or select. */
function keepFromRow(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * The dev servers a chat started, as one quiet mark on its Work row.
 *
 * The list is the machine's own (see `useSessionDevServers`): no request per
 * row, no timer. Nothing renders until the chat has a server. The mark opens
 * a small menu: a server opens in the ADE Browser, and Stop asks the chat's
 * machine to stop it (`runtimePin` is the row's machine; null keeps the tab's).
 * That machine checks again that the process on the port is still this
 * chat's, so a port taken over by something else is refused there.
 */
export function SessionDevServerBadge({
  sessionId,
  runtimePin,
  canStop,
  disabled = false,
  size = 11,
}: {
  sessionId: string;
  runtimePin: OpenProjectBinding | null;
  /** Only an agent's row offers Stop; a plain terminal's server is stopped in the terminal. */
  canStop: boolean;
  disabled?: boolean;
  size?: number;
}) {
  const servers = useSessionDevServers(sessionId, runtimePin);
  const [open, setOpen] = React.useState(false);
  const [stopping, setStopping] = React.useState<ReadonlySet<number>>(() => new Set());
  const anchorRef = React.useRef<HTMLButtonElement | null>(null);
  const pinRef = React.useRef(runtimePin);
  pinRef.current = runtimePin;

  React.useEffect(() => {
    if (servers.length === 0) setOpen(false);
  }, [servers.length]);

  const stop = React.useCallback(async (server: DevServerRecord) => {
    const stopDevServer = window.ade?.workTools?.stopDevServer;
    const label = devServerLabel(server);
    if (!stopDevServer) {
      showToast({ tone: "warning", title: `Could not stop ${label}`, message: "This version of ADE cannot stop servers." });
      return;
    }
    setStopping((current) => new Set(current).add(server.port));
    try {
      const result = await stopDevServer(
        { chatSessionId: sessionId, port: server.port, laneId: server.source.laneId },
        pinRef.current,
      );
      if (result.ok) {
        showToast({
          tone: "success",
          title: result.alreadyStopped ? `${label} had already stopped` : `Stopped ${label}`,
        });
      } else {
        showToast({ tone: "warning", title: `Did not stop ${label}`, message: result.error });
      }
    } catch (error) {
      showToast({
        tone: "error",
        title: `Could not stop ${label}`,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(server.port);
        return next;
      });
      refreshDevServersForMachine(pinRef.current);
    }
  }, [sessionId]);

  if (servers.length === 0) return null;
  const labels = servers.map(devServerLabel);
  const machine = machineNameForBinding(runtimePin);
  const title = servers.length === 1
    ? `${labels[0]} is running, started by this chat`
    : `${servers.length} servers running, started by this chat: ${labels.join(", ")}`;
  const color = workToolDefinition("browser")?.color;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="session-dev-server-badge"
        data-dev-server-ports={servers.map((server) => server.port).join(",")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        disabled={disabled}
        className="relative inline-flex shrink-0 items-center justify-center rounded-sm transition-opacity hover:opacity-100 disabled:opacity-40"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onContextMenu={keepFromRow}
      >
        <Globe size={size} weight="bold" style={color ? { color } : undefined} aria-hidden />
        <span
          aria-hidden
          className="pointer-events-none absolute -right-[2px] -top-[2px] h-[5px] w-[5px] rounded-full bg-emerald-400 ring-1 ring-black/40"
        />
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        role="menu"
        aria-label="Servers this chat started"
        data-testid="session-dev-server-menu"
        remeasureKey={servers.length}
        className={cn(MENU_SURFACE_CLASS, "min-w-[168px] max-w-[232px]")}
        onClick={keepFromRow}
        onPointerDown={keepFromRow}
        onMouseDown={keepFromRow}
        onContextMenu={keepFromRow}
        onDoubleClick={keepFromRow}
      >
        {/* The globe's tooltip already says who started these; a heading is
            only worth its row when the servers are on another machine. */}
        {runtimePin ? <div className={MENU_LABEL_CLASS}>{`On ${machine}`}</div> : null}
        {servers.map((server) => {
          const label = devServerLabel(server);
          const busy = stopping.has(server.port);
          return (
            <div key={`${server.source.laneId ?? ""}:${server.port}`} className="group/server flex items-center gap-0.5" data-dev-server-port={server.port}>
              <button
                type="button"
                role="menuitem"
                data-testid="session-dev-server-open"
                title={`Open ${label} in the Browser`}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-left transition-colors hover:bg-fg/[0.07] hover:text-fg"
                onClick={() => {
                  setOpen(false);
                  openUrlInAdeBrowser(server.url, { runtimePin: pinRef.current });
                }}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{label}</span>
                <ArrowSquareOut size={11} className="shrink-0 text-muted-fg/55 opacity-0 transition-opacity group-hover/server:opacity-100" aria-hidden />
              </button>
              {canStop ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="session-dev-server-stop"
                  disabled={busy}
                  title={busy ? `Stopping ${label}` : `Stop ${label}. Only processes this chat started are stopped.`}
                  aria-label={busy ? `Stopping ${label}` : `Stop ${label}`}
                  className="group/stop inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full disabled:cursor-default"
                  onClick={() => { void stop(server); }}
                >
                  {/* A ring says "running"; the square inside is the stop. */}
                  <span
                    aria-hidden
                    className={cn(
                      "relative inline-flex h-[16px] w-[16px] items-center justify-center rounded-full border-[1.5px] transition-colors",
                      busy
                        ? "border-fg/15 border-t-fg/60 motion-safe:animate-spin"
                        : "border-emerald-400/70 group-hover/stop:border-[color:var(--color-error)]",
                    )}
                  >
                    {busy ? null : (
                      <span className="h-[6px] w-[6px] rounded-[1.5px] bg-fg/70 transition-colors group-hover/stop:bg-[color:var(--color-error)]" />
                    )}
                  </span>
                </button>
              ) : (
                <span aria-hidden className="mx-2 h-[6px] w-[6px] shrink-0 rounded-full bg-emerald-400" />
              )}
            </div>
          );
        })}
      </AnchoredMenu>
    </>
  );
}
