import type { McpRegistryState, McpRegistryTransport } from "../../../shared/mcpRegistry";
import { relativeWhen } from "../../lib/format";

type McpMentionState = McpRegistryState | "needs-sign-in" | (string & {});

const STATE_LABEL: Record<string, string> = {
  on: "On",
  "off-account": "Off in account settings",
  "off-machine": "Off on this machine",
  "off-project": "Off in this project",
  "needs-sign-in": "Needs sign-in",
};

export function McpMentionCardBody({
  name,
  state,
  transport,
  toolNames,
  toolCount,
  lastError,
  lastErrorAt,
}: {
  name: string;
  state: McpMentionState;
  transport: McpRegistryTransport | (string & {});
  toolNames: string[];
  toolCount?: number | null;
  lastError: string | null;
  lastErrorAt?: number | null;
}) {
  return (
    <div className="max-w-[260px]">
      <div className="truncate text-[12px] font-medium text-fg/90">{name}</div>
      <div className="mt-1 flex gap-2 text-[11px] text-fg/60">
        <span>{STATE_LABEL[state] ?? state}</span>
        <span className="uppercase">{transport}</span>
        {toolCount != null ? <span>{toolCount} tools</span> : null}
      </div>
      {toolNames.length ? <div className="mt-1 line-clamp-3 text-[11px] text-fg/65">{toolNames.slice(0, 8).join(", ")}</div> : null}
      {lastError ? (
        <div className="mt-1 line-clamp-2 text-[11px] text-rose-300">
          {lastErrorAt != null ? `Last error ${relativeWhen(new Date(lastErrorAt).toISOString())}: ` : "Last error: "}{lastError}
        </div>
      ) : null}
    </div>
  );
}
