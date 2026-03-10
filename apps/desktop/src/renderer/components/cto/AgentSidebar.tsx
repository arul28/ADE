import React, { useMemo, useCallback } from "react";
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
  onClick,
}: {
  agent: AgentIdentity;
  isSelected: boolean;
  depth: number;
  budgetInfo?: AgentBudgetSnapshot["workers"][number];
  onClick: () => void;
}) {
  const budgetBreached =
    (budgetInfo?.budgetMonthlyCents ?? 0) > 0 &&
    (budgetInfo?.spentMonthlyCents ?? 0) >= (budgetInfo?.budgetMonthlyCents ?? 0);

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`worker-row-${agent.id}`}
      className={cn(
        "group w-full text-left px-3 py-2 transition-all duration-100",
        "border-l-2",
        isSelected
          ? "border-l-accent bg-accent/8"
          : "border-l-transparent hover:bg-muted/40",
      )}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <AgentStatusDot status={agent.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn(
              "truncate font-mono text-xs font-semibold",
              isSelected ? "text-fg" : "text-fg/80 group-hover:text-fg",
            )}>
              {agent.name}
            </span>
            {budgetBreached && (
              <span className="text-[9px] text-warning font-mono">$</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="font-mono text-[9px] text-muted-fg">
              {agent.role}
            </span>
            <span className="text-border">·</span>
            <span className="font-mono text-[9px] text-muted-fg/60">
              {agent.adapterType.replace("-local", "").replace("-webhook", "")}
            </span>
            {budgetInfo && (
              <>
                <span className="text-border">·</span>
                <span className="font-mono text-[9px] text-muted-fg/60">
                  {dollars(budgetInfo.spentMonthlyCents)}
                </span>
              </>
            )}
          </div>
        </div>
        {isSelected && (
          <CaretRight size={10} weight="bold" className="shrink-0 text-accent" />
        )}
      </div>
    </button>
  );
});

export function AgentSidebar({
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

  const renderTree = useCallback((parentId: string | null, depth = 0): React.ReactNode => {
    const children = agents
      .filter((a) => (a.reportsTo ?? null) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
    return children.map((agent) => (
      <React.Fragment key={agent.id}>
        <AgentRow
          agent={agent}
          isSelected={selectedAgentId === agent.id}
          depth={depth}
          budgetInfo={budgetByWorkerId.get(agent.id)}
          onClick={() => onSelectAgent(agent.id)}
        />
        {renderTree(agent.id, depth + 1)}
      </React.Fragment>
    ));
  }, [agents, selectedAgentId, budgetByWorkerId, onSelectAgent]);

  return (
    <aside
      className="flex flex-col h-full border-r border-border/60 select-none"
      style={{ width: 240, minWidth: 240, background: "var(--gradient-surface)" }}
    >
      {/* Header */}
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/60 mb-2">
          Department
        </div>
      </div>

      {/* CTO entry */}
      <button
        type="button"
        onClick={onSelectCto}
        className={cn(
          "w-full text-left px-3 py-2.5 transition-all duration-100",
          "border-l-2",
          isCtoSelected
            ? "border-l-accent bg-accent/8"
            : "border-l-transparent hover:bg-muted/40",
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 bg-accent/12 border border-accent/20">
            <Brain size={14} weight="duotone" className="text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-xs font-bold text-fg">CTO</div>
            {ctoModelInfo && (
              <div className="font-mono text-[9px] text-muted-fg/60 mt-0.5 truncate">
                {ctoModelInfo.provider}/{ctoModelInfo.model}
              </div>
            )}
          </div>
        </div>
      </button>

      {/* Separator */}
      <div className="mx-3 my-1.5 border-t border-border/40" />

      {/* Workers header */}
      <div className="flex items-center justify-between px-3 py-1">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/60">
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
        {agents.filter((a) => a.reportsTo === null).length === 0 ? (
          <div className="px-3 py-6 text-center">
            <Robot size={24} className="mx-auto text-muted-fg/30 mb-2" />
            <div className="font-mono text-[10px] text-muted-fg/50">No workers yet</div>
            <button
              type="button"
              onClick={onHireWorker}
              className="mt-2 font-mono text-[10px] text-accent hover:text-accent/80 transition-colors"
            >
              Hire your first worker
            </button>
          </div>
        ) : (
          renderTree(null)
        )}
      </div>

      {/* Budget footer */}
      <div className="shrink-0 border-t border-border/40 px-3 py-2" data-testid="budget-company-row">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9px] text-muted-fg/50 uppercase">Budget</span>
          <span className="font-mono text-[10px] text-muted-fg">
            {dollars(budgetSnapshot?.companySpentMonthlyCents ?? 0)}
            {(budgetSnapshot?.companyBudgetMonthlyCents ?? 0) > 0
              ? ` / ${dollars(budgetSnapshot!.companyBudgetMonthlyCents)}`
              : ""}
          </span>
        </div>
      </div>
    </aside>
  );
}
