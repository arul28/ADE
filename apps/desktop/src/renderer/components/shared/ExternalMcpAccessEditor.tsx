import React from "react";
import type { ExternalMcpAccessPolicy } from "../../../shared/types";

const EMPTY_POLICY: ExternalMcpAccessPolicy = {
  allowAll: false,
  allowedServers: [],
  blockedServers: [],
};

function normalizePolicy(value?: ExternalMcpAccessPolicy | null): ExternalMcpAccessPolicy {
  return {
    allowAll: value?.allowAll === true,
    allowedServers: [...new Set(value?.allowedServers ?? [])],
    blockedServers: [...new Set(value?.blockedServers ?? [])],
  };
}

function toggleValue(list: string[], value: string, enabled: boolean): string[] {
  const next = new Set(list);
  if (enabled) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return [...next].sort((a, b) => a.localeCompare(b));
}

export function ExternalMcpAccessEditor({
  value,
  availableServers,
  onChange,
  title = "ADE-managed MCP access",
  description,
}: {
  value?: ExternalMcpAccessPolicy | null;
  availableServers: string[];
  onChange: (next: ExternalMcpAccessPolicy) => void;
  title?: string;
  description?: string;
}) {
  const policy = normalizePolicy(value ?? EMPTY_POLICY);
  const serverNames = [...new Set(availableServers)].sort((a, b) => a.localeCompare(b));

  const update = (patch: Partial<ExternalMcpAccessPolicy>) => {
    onChange(normalizePolicy({ ...policy, ...patch }));
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/60">{title}</div>
        {description && <div className="mt-1 font-mono text-[10px] text-muted-fg/60">{description}</div>}
      </div>

      <label className="flex items-center gap-2 text-xs text-fg">
        <input
          type="checkbox"
          checked={policy.allowAll}
          onChange={(event) => update({ allowAll: event.target.checked })}
        />
        Allow all configured ADE-managed MCP servers by default
      </label>

      {serverNames.length === 0 ? (
        <div className="rounded border border-dashed border-border/30 bg-surface/40 px-3 py-2 font-mono text-[10px] text-muted-fg/60">
          Add an ADE-managed MCP server in Settings before assigning access here.
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded border border-border/20 bg-card/60 p-3">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/60">
              Allowed Servers
            </div>
            <div className="mt-2 space-y-2">
              {serverNames.map((serverName) => (
                <label key={`allow-${serverName}`} className="flex items-center gap-2 text-xs text-fg">
                  <input
                    type="checkbox"
                    checked={policy.allowedServers.includes(serverName)}
                    disabled={policy.allowAll}
                    onChange={(event) => {
                      const allowedServers = toggleValue(policy.allowedServers, serverName, event.target.checked);
                      const blockedServers = event.target.checked
                        ? toggleValue(policy.blockedServers, serverName, false)
                        : policy.blockedServers;
                      update({ allowedServers, blockedServers });
                    }}
                  />
                  <span className={policy.allowAll ? "opacity-50" : undefined}>{serverName}</span>
                </label>
              ))}
            </div>
            <div className="mt-2 font-mono text-[10px] text-muted-fg/50">
              {policy.allowAll
                ? "Allowlist is bypassed while allow-all is enabled."
                : "When allow-all is off, only checked servers are visible."}
            </div>
          </div>

          <div className="rounded border border-border/20 bg-card/60 p-3">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/60">
              Blocked Servers
            </div>
            <div className="mt-2 space-y-2">
              {serverNames.map((serverName) => (
                <label key={`block-${serverName}`} className="flex items-center gap-2 text-xs text-fg">
                  <input
                    type="checkbox"
                    checked={policy.blockedServers.includes(serverName)}
                    onChange={(event) => {
                      const blockedServers = toggleValue(policy.blockedServers, serverName, event.target.checked);
                      const allowedServers = event.target.checked
                        ? toggleValue(policy.allowedServers, serverName, false)
                        : policy.allowedServers;
                      update({ blockedServers, allowedServers });
                    }}
                  />
                  {serverName}
                </label>
              ))}
            </div>
            <div className="mt-2 font-mono text-[10px] text-muted-fg/50">
              Blocked servers always win over the allowlist.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
