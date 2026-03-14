import React, { useMemo } from "react";
import { Brain, Robot, Plus, CaretRight } from "@phosphor-icons/react";
import type { AgentIdentity, AgentBudgetSnapshot } from "../../../shared/types";
import { AgentStatusDot } from "./shared/AgentStatusBadge";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const AgentRow = React.memo(function AgentRow({
  agent,
  isSelected,
  depth,
  budgetInfo,
  onSelectAgent,
}: {
  agent: AgentIdentity;
  isSelected: boolean;
  depth: number;
  budgetInfo?: AgentBudgetSnapshot["workers"][number];
  onSelectAgent: (id: string) => void;
}) {
  const budgetBreached =
    (budgetInfo?.budgetMonthlyCents ?? 0) > 0 &&
    (budgetInfo?.spentMonthlyCents ?? 0) >= (budgetInfo?.budgetMonthlyCents ?? 0);

  return (
    <button
      type="button"
      onClick={() => onSelectAgent(agent.id)}
      data-testid={`worker-row-${agent.id}`}
      className={cn(
        "group w-full text-left px-3 py-2 transition-all duration-200",
        isSelected
          ? "bg-[rgba(167,139,250,0.08)]"
          : "hover:bg-white/[0.03]",
      )}
      style={{
        paddingLeft: `${12 + depth * 16}px`,
        ...(isSelected ? { borderLeft: "2px solid #A78BFA" } : { borderLeft: "2px solid transparent" }),
      }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <AgentStatusDot status={agent.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn(
              "truncate text-xs font-medium",
              isSelected ? "text-fg" : "text-fg/70 group-hover:text-fg",
            )}>
              {agent.name}
            </span>
            {budgetBreached && (
              <span className="text-[10px] text-warning font-medium">$</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] text-muted-fg/40">
              {agent.role}
            </span>
            {budgetInfo && (
              <>
                <span className="text-white/[0.08]">&middot;</span>
                <span className="text-[10px] text-muted-fg/35">
                  {dollars(budgetInfo.spentMonthlyCents)}
                </span>
              </>
            )}
          </div>
        </div>
        {isSelected && (
          <CaretRight size={9} weight="bold" className="shrink-0" style={{ color: "#A78BFA" }} />
        )}
      </div>
    </button>
  );
});

type WorkerTreeNode = {
  agent: AgentIdentity;
  depth: number;
};

const AgentSidebarBudgetFooter = React.memo(function AgentSidebarBudgetFooter({
  budgetSnapshot,
}: {
  budgetSnapshot: AgentBudgetSnapshot | null;
}) {
  return (
    <div className="shrink-0 border-t border-white/[0.05] px-3 py-2" data-testid="budget-company-row">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-fg/35 uppercase tracking-wider font-medium">Budget</span>
        <span className="text-[10px] text-muted-fg/50">
          {dollars(budgetSnapshot?.companySpentMonthlyCents ?? 0)}
          {(budgetSnapshot?.companyBudgetMonthlyCents ?? 0) > 0
            ? ` / ${dollars(budgetSnapshot!.companyBudgetMonthlyCents)}`
            : ""}
        </span>
      </div>
    </div>
  );
});

export const AgentSidebar = React.memo(function AgentSidebar({
  agents,
  selectedAgentId,
  onSelectAgent,
  onSelectCto,
  isCtoSelected,
  budgetSnapshot,
  onHireWorker,
  ctoModelInfo,
}: {
  agents: AgentIdentity[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onSelectCto: () => void;
  isCtoSelected: boolean;
  budgetSnapshot: AgentBudgetSnapshot | null;
  onHireWorker: () => void;
  ctoModelInfo?: { provider: string; model: string } | null;
}) {
  const budgetByWorkerId = useMemo(() => {
    const map = new Map<string, AgentBudgetSnapshot["workers"][number]>();
    for (const w of budgetSnapshot?.workers ?? []) map.set(w.agentId, w);
    return map;
  }, [budgetSnapshot?.workers]);

  const workerTree = useMemo(() => {
    const byParent = new Map<string | null, AgentIdentity[]>();
    for (const agent of agents) {
      const parentId = agent.reportsTo ?? null;
      const siblings = byParent.get(parentId);
      if (siblings) {
        siblings.push(agent);
      } else {
        byParent.set(parentId, [agent]);
      }
    }
    for (const siblings of byParent.values()) {
      siblings.sort((a, b) => a.name.localeCompare(b.name));
    }

    const flattened: WorkerTreeNode[] = [];
    const appendNodes = (parentId: string | null, depth: number) => {
      for (const agent of byParent.get(parentId) ?? []) {
        flattened.push({ agent, depth });
        appendNodes(agent.id, depth + 1);
      }
    };
    appendNodes(null, 0);
    return flattened;
  }, [agents]);

  return (
    <aside
      className="flex flex-col h-full select-none"
      style={{ width: 220, minWidth: 220, borderRight: "1px solid rgba(167, 139, 250, 0.06)", background: "rgba(12, 10, 20, 0.5)" }}
    >
      {/* CTO entry */}
      <button
        type="button"
        onClick={onSelectCto}
        className={cn(
          "w-full text-left px-3 py-3 transition-all duration-200",
          isCtoSelected
            ? "bg-[rgba(167,139,250,0.08)]"
            : "hover:bg-white/[0.03]",
        )}
        style={isCtoSelected ? { borderLeft: "2px solid #A78BFA" } : { borderLeft: "2px solid transparent" }}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg" style={{ background: "rgba(167, 139, 250, 0.1)", border: "1px solid rgba(167, 139, 250, 0.18)" }}>
            <Brain size={13} weight="duotone" style={{ color: "#A78BFA" }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-fg">CTO</div>
            {ctoModelInfo && (
              <div className="text-[10px] text-muted-fg/35 mt-0.5 truncate">
                {ctoModelInfo.provider}/{ctoModelInfo.model}
              </div>
            )}
          </div>
        </div>
      </button>

      {/* Separator */}
      <div className="mx-3 my-1" style={{ borderTop: "1px solid rgba(167, 139, 250, 0.06)" }} />

      {/* Workers header */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/35">
          Workers
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="!h-5 !px-1.5 !text-[9px]"
          onClick={onHireWorker}
          data-testid="worker-create-btn"
        >
          <Plus size={10} weight="bold" />
        </Button>
      </div>

      {/* Worker tree */}
      <div className="flex-1 overflow-y-auto min-h-0" data-testid="worker-tree">
        {workerTree.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Robot size={24} className="mx-auto mb-3" style={{ color: "rgba(167, 139, 250, 0.15)" }} />
            <div className="text-xs text-muted-fg/40">No workers yet</div>
            <button
              type="button"
              onClick={onHireWorker}
              className="mt-2 text-[11px] font-medium transition-colors hover:text-fg/70"
              style={{ color: "#A78BFA" }}
            >
              Hire your first worker
            </button>
          </div>
        ) : (
          workerTree.map(({ agent, depth }) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              isSelected={selectedAgentId === agent.id}
              depth={depth}
              budgetInfo={budgetByWorkerId.get(agent.id)}
              onSelectAgent={onSelectAgent}
            />
          ))
        )}
      </div>

      {/* Budget footer */}
      <AgentSidebarBudgetFooter budgetSnapshot={budgetSnapshot} />
    </aside>
  );
});
