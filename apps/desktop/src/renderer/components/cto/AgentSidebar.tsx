import React, { useMemo } from "react";
import { Brain, Robot, Plus, CaretRight } from "@phosphor-icons/react";
import type { AgentIdentity, AgentBudgetSnapshot } from "../../../shared/types";
import { AgentStatusDot } from "./shared/AgentStatusBadge";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";

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
        "group w-full rounded-lg text-left px-3.5 py-2.5 transition-all duration-150",
        isSelected
          ? "bg-accent/8 border border-accent/20"
          : "hover:bg-white/[0.03] border border-transparent",
      )}
      style={{
        paddingLeft: `${14 + depth * 18}px`,
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
          <CaretRight size={9} weight="bold" className="shrink-0 text-accent" />
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
      style={{
        width: 252,
        minWidth: 252,
        borderRight: "1px solid rgba(255, 255, 255, 0.06)",
        background: "var(--work-sidebar-bg)",
      }}
    >
      <div className="border-b border-white/[0.06] px-4 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-fg/38">
          CTO
        </div>
        <div className="mt-2 text-sm font-semibold text-fg">Control room</div>
        <div className="mt-1 text-[11px] leading-5 text-muted-fg/40">
          Persistent leadership, durable memory, and worker coordination.
        </div>
      </div>

      {/* CTO entry */}
      <div className="px-3 py-3">
        <button
          type="button"
          onClick={onSelectCto}
          className={cn(
            "w-full rounded-lg text-left px-3.5 py-3 transition-all duration-150",
            isCtoSelected
              ? "bg-accent/8 border border-accent/20"
              : "hover:bg-white/[0.03] border border-transparent",
          )}
        >
          <div className="flex items-start gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-accent/10 border border-accent/15">
              <Brain size={16} weight="duotone" className="text-accent" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="text-sm font-semibold text-fg">CTO</div>
                <span className="rounded-full border border-success/20 bg-success/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-success">
                  Persistent
                </span>
              </div>
              <div className="mt-1 text-[11px] leading-5 text-muted-fg/40">
                Always-on technical lead.
              </div>
              {ctoModelInfo && (
                <div className="mt-1.5 text-[10px] text-muted-fg/35 truncate">
                  {ctoModelInfo.provider}/{ctoModelInfo.model}
                </div>
              )}
            </div>
          </div>
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-fg/36">
              Team
            </span>
            <span className="text-[10px] text-muted-fg/50">
              {agents.length} total
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <SmartTooltip content={{ label: "Hire worker", description: "Create a new autonomous worker from a template or custom config." }}>
              <Button
                variant="ghost"
                size="sm"
                className="!h-7 flex-1 !rounded-lg !border !border-white/[0.06] !bg-white/[0.02] !text-[10px]"
                onClick={onHireWorker}
                data-testid="worker-create-btn"
              >
                <Plus size={10} weight="bold" />
                Hire worker
              </Button>
            </SmartTooltip>
          </div>
        </div>
      </div>

      {/* Worker tree */}
      <div className="flex-1 overflow-y-auto min-h-0 px-3 pb-3" data-testid="worker-tree">
        {workerTree.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/[0.08] px-4 py-10 text-center">
            <Robot size={24} className="mx-auto mb-3 text-accent/40" />
            <div className="text-xs text-muted-fg/40">No workers yet</div>
            <button
              type="button"
              onClick={onHireWorker}
              className="mt-2 text-[11px] font-medium text-accent transition-colors hover:text-fg/70"
            >
              Hire your first worker
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {workerTree.map(({ agent, depth }) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                isSelected={selectedAgentId === agent.id}
                depth={depth}
                budgetInfo={budgetByWorkerId.get(agent.id)}
                onSelectAgent={onSelectAgent}
              />
            ))}
          </div>
        )}
      </div>

      {/* Budget footer */}
      <div className="px-3 pb-3">
        <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02]">
          <AgentSidebarBudgetFooter budgetSnapshot={budgetSnapshot} />
        </div>
      </div>
    </aside>
  );
});
