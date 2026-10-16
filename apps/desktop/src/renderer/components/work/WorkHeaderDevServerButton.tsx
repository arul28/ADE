import { Globe } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { useAppStore } from "../../state/appStore";
import { useLaneDevServers } from "../../lib/laneDevServers";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { workToolDefinition } from "../terminals/workTools";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "./WorkHeaderPaneToggles";
import { cn } from "../ui/cn";

function portLabel(url: string, port: number): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname === "127.0.0.1" ? "localhost" : parsed.hostname}:${port}`;
  } catch {
    return `localhost:${port}`;
  }
}

/**
 * The Browser icon, lit, when the lane has a dev server running.
 *
 * Shown on whichever machine the user is on: a server started on the Mac
 * Studio lights this up on a MacBook showing that lane too, because the list
 * comes from the lane's machine. One click opens the newest server in the ADE
 * Browser, through the tunnel when the lane is elsewhere. Nothing opens on its
 * own.
 */
export function WorkHeaderDevServerButton({
  laneId,
  runtimePin,
}: {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
}) {
  const servers = useLaneDevServers(laneId, runtimePin);
  // Unpinned means the window's own machine, which may itself be another computer.
  // eslint-disable-next-line no-restricted-syntax -- naming the machine a null pin means; there is no chat scope here.
  const windowBinding = useAppStore((state) => state.projectBinding);
  if (servers.length === 0) return null;
  const primary = servers[0]!;
  const machine = machineNameForBinding(runtimePin ?? windowBinding);
  const label = portLabel(primary.url, primary.port);
  const others = servers.slice(1).map((server) => portLabel(server.url, server.port));
  const title = [
    `${label} is running on ${machine}. Open it in the Browser.`,
    others.length > 0 ? `Also running: ${others.join(", ")}.` : null,
  ].filter(Boolean).join(" ");
  const color = workToolDefinition("browser")?.color;
  return (
    <button
      type="button"
      className={cn(WORK_HEADER_ICON_BUTTON_CLASS, "relative")}
      title={title}
      aria-label={title}
      data-dev-server-port={primary.port}
      onClick={() => openUrlInAdeBrowser(primary.url, { runtimePin })}
    >
      <Globe size={15} weight="bold" style={color ? { color } : undefined} />
      <span className="pointer-events-none absolute right-0 top-0 inline-flex h-[7px] w-[7px]" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400/50 ade-thinking-pulse" />
        <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-emerald-400 ring-1 ring-black/40" />
      </span>
    </button>
  );
}
