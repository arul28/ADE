import type { ReactNode } from "react";
import { ArrowBendUpRight, Cube, TreeStructure, X } from "@phosphor-icons/react";
import { GlowMenu, type GlowMenuItem } from "../ui/GlowMenu";

export type ChatActionsTab = "agents" | "proof" | "handoff";

const CHAT_ACTIONS_TABS: Array<GlowMenuItem<ChatActionsTab>> = [
  {
    id: "agents",
    label: "Agents",
    icon: TreeStructure,
    gradient: "radial-gradient(circle, rgba(251,191,36,0.38) 0%, transparent 70%)",
    color: "#fbbf24",
  },
  {
    id: "proof",
    label: "Proof",
    icon: Cube,
    gradient: "radial-gradient(circle, rgba(52,211,153,0.42) 0%, transparent 70%)",
    color: "#34d399",
  },
  {
    id: "handoff",
    label: "Handoff",
    icon: ArrowBendUpRight,
    gradient: "radial-gradient(circle, rgba(167,139,250,0.42) 0%, transparent 70%)",
    color: "#a78bfa",
  },
];

export function ChatActionsDrawerPanel({
  tab,
  onTabChange,
  onClose,
  agentsContent,
  proofContent,
  handoffContent,
}: {
  tab: ChatActionsTab;
  onTabChange: (tab: ChatActionsTab) => void;
  onClose: () => void;
  agentsContent: ReactNode;
  proofContent: ReactNode;
  handoffContent: ReactNode;
}) {
  const body = tab === "agents" ? agentsContent : tab === "proof" ? proofContent : handoffContent;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-[42px] shrink-0 items-stretch border-b border-white/[0.08]">
        <GlowMenu
          variant="flat"
          className="min-w-0"
          items={CHAT_ACTIONS_TABS}
          activeItem={tab}
          onItemClick={onTabChange}
        />
        <button
          type="button"
          className="ade-shell-control inline-flex w-9 shrink-0 items-center justify-center self-stretch rounded-none border-l border-white/[0.08] text-muted-fg/70 transition-colors hover:bg-white/[0.04] hover:text-fg"
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
