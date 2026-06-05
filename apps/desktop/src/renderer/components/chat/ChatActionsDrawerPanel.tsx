import type { ReactNode } from "react";
import { ArrowBendUpRight, Cube, ListChecks, Play, TreeStructure, X } from "@phosphor-icons/react";
import { GlowMenu, type GlowMenuItem } from "../ui/GlowMenu";

export type ChatActionsTab = "agents" | "proof" | "handoff" | "plan" | "run";

// The drawer tabs use GlowMenu's `neutral` mode, which renders every tab with
// the same muted-grey-→-bright-fg treatment plus one shared violet indicator.
// The `gradient`/`color` fields are required by GlowMenuItem but are ignored in
// neutral mode, so they're set to a single neutral placeholder here (NOT a
// per-tab saturated palette) to make that intent explicit.
const NEUTRAL_INDICATOR = {
  gradient: "transparent",
  color: "currentColor",
} as const;

const CHAT_ACTIONS_TABS: Array<GlowMenuItem<ChatActionsTab>> = [
  { id: "agents", label: "Agents", icon: TreeStructure, ...NEUTRAL_INDICATOR },
  { id: "proof", label: "Proof", icon: Cube, ...NEUTRAL_INDICATOR },
  { id: "handoff", label: "Handoff", icon: ArrowBendUpRight, ...NEUTRAL_INDICATOR },
];

// Plan tab is surfaced only when the active chat has a plan to show — it leads
// the tab strip so a freshly proposed plan is one glance away (the runtime's
// native plan instructions are untouched; we only re-present the markdown here).
const PLAN_TAB: GlowMenuItem<ChatActionsTab> = {
  id: "plan",
  label: "Plan",
  icon: ListChecks,
  ...NEUTRAL_INDICATOR,
};

// Run tab (moved off the header) — surfaced only when the chat has a lane that
// can run process groups.
const RUN_TAB: GlowMenuItem<ChatActionsTab> = {
  id: "run",
  label: "Run",
  icon: Play,
  ...NEUTRAL_INDICATOR,
};

export function ChatActionsDrawerPanel({
  tab,
  onTabChange,
  onClose,
  agentsContent,
  proofContent,
  handoffContent,
  planContent,
  runContent,
}: {
  tab: ChatActionsTab;
  onTabChange: (tab: ChatActionsTab) => void;
  onClose: () => void;
  agentsContent: ReactNode;
  proofContent: ReactNode;
  handoffContent: ReactNode;
  planContent?: ReactNode;
  runContent?: ReactNode;
}) {
  const tabs = [
    ...(planContent ? [PLAN_TAB] : []),
    ...CHAT_ACTIONS_TABS,
    ...(runContent ? [RUN_TAB] : []),
  ];
  // Fall back off tabs that aren't currently available.
  const activeTab: ChatActionsTab =
    (tab === "plan" && !planContent) || (tab === "run" && !runContent) ? "agents" : tab;
  const bodyByTab: Record<ChatActionsTab, ReactNode> = {
    plan: planContent,
    run: runContent,
    agents: agentsContent,
    proof: proofContent,
    handoff: handoffContent,
  };
  const body = bodyByTab[activeTab];

  return (
    // Transparent wrapper — the floating pane's own neutral background shows
    // through; we add no surface of our own here.
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <div className="sticky top-0 z-10 flex min-h-[40px] shrink-0 items-stretch border-b border-white/[0.06] bg-[color:var(--work-sidebar-bg,#161618)]">
        <GlowMenu
          variant="flat"
          neutral
          className="min-w-0"
          items={tabs}
          activeItem={activeTab}
          onItemClick={onTabChange}
        />
        <button
          type="button"
          className="ade-shell-control inline-flex w-9 shrink-0 items-center justify-center self-stretch rounded-none border-l border-white/[0.06] text-muted-fg/60 transition-colors hover:bg-white/[0.04] hover:text-fg"
          data-variant="ghost"
          onClick={onClose}
          title="Close Chat actions"
          aria-label="Close Chat actions"
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {body}
      </div>
    </div>
  );
}
