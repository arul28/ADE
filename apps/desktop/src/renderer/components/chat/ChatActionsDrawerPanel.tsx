import { useMemo, type ReactNode } from "react";
import { ArrowBendUpRight, Cube, LinkSimple, Rocket, TreeStructure, X } from "@phosphor-icons/react";
import { GlowMenu, type GlowMenuItem } from "../ui/GlowMenu";
import {
  isPluginPanelSlotId,
  PluginSlotPanel,
  pluginSessionContext,
  usePluginPanelSlots,
} from "../plugins/sockets";

/**
 * The drawer's tabs, plus whatever plugins contribute.
 *
 * The template literal is the whole `drawer-tab` socket on this side: a plugin
 * tab is a `plugin:<pluginId>:<panelId>` id, so the strip, the fallback and the
 * persisted selection all keep working on strings without a parallel "is this
 * one of ours" flag riding alongside every one of them.
 */
export type ChatActionsTab =
  | "sources"
  | "agents"
  | "proof"
  | "handoff"
  | "missions"
  | `plugin:${string}`;

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

const SOURCES_TAB: GlowMenuItem<ChatActionsTab> = {
  id: "sources",
  label: "Sources",
  icon: LinkSimple,
  ...NEUTRAL_INDICATOR,
};

// Missions tab — surfaced only for Droid AGI orchestrator sessions that have an
// active mission (feature checklist / state / progress). Leads the strip so the
// orchestrator's plan is the first thing you see.
const MISSIONS_TAB: GlowMenuItem<ChatActionsTab> = {
  id: "missions",
  label: "Missions",
  icon: Rocket,
  ...NEUTRAL_INDICATOR,
};

export function ChatActionsDrawerPanel({
  tab,
  onTabChange,
  onClose,
  agentsContent,
  proofContent,
  handoffContent,
  sourcesContent,
  missionsContent,
  sessionId = null,
  sessionTitle = null,
  sessionProvider = null,
  sessionStatus = null,
  active = true,
}: {
  tab: ChatActionsTab;
  onTabChange: (tab: ChatActionsTab) => void;
  onClose: () => void;
  agentsContent: ReactNode;
  proofContent: ReactNode;
  handoffContent: ReactNode;
  sourcesContent?: ReactNode;
  missionsContent?: ReactNode;
  /**
   * The chat this drawer belongs to, for contributed tabs.
   *
   * Four primitives rather than a session object, the way `PluginChatCard`
   * takes them: the parent rebuilds its session record on every transcript
   * event, so an object prop would hand the panel a new context identity
   * several times a second while the fields it actually reads never changed.
   *
   * Optional because the drawer predates the socket and the built-in tabs
   * receive their content already rendered. Without a session id a plugin
   * panel still draws — it simply receives no session context, the same
   * degradation a composer action gets before its chat exists.
   */
  sessionId?: string | null;
  sessionTitle?: string | null;
  sessionProvider?: string | null;
  sessionStatus?: string | null;
  /** False while the chat pane is mounted but the drawer is not showing. */
  active?: boolean;
}) {
  const sessionContext = useMemo(
    () => (sessionId
      ? pluginSessionContext({
        id: sessionId,
        title: sessionTitle ?? "",
        provider: sessionProvider ?? null,
        status: sessionStatus ?? null,
      })
      : null),
    [sessionId, sessionProvider, sessionStatus, sessionTitle],
  );
  const pluginSlots = usePluginPanelSlots("work", "drawer-tab", {
    active,
    context: sessionContext,
  });
  const tabs = [
    ...(sourcesContent ? [SOURCES_TAB] : []),
    ...(missionsContent ? [MISSIONS_TAB] : []),
    ...CHAT_ACTIONS_TABS,
    // Always last: placement is host-controlled and a contribution never
    // reorders the product's own tabs.
    ...pluginSlots.map((slot): GlowMenuItem<ChatActionsTab> => ({
      id: slot.id as ChatActionsTab,
      label: slot.label,
      icon: slot.icon,
      ...NEUTRAL_INDICATOR,
    })),
  ];
  const selectedSlot = pluginSlots.find((slot) => slot.id === tab) ?? null;
  // Fall back off tabs that aren't currently available — which now includes a
  // plugin tab whose plugin was disabled or uninstalled while the drawer sat
  // open on it, and a persisted selection from a plugin that is no longer here.
  const activeTab: ChatActionsTab =
    (tab === "missions" && !missionsContent)
    || (tab === "sources" && !sourcesContent)
    || (isPluginPanelSlotId(tab) && !selectedSlot)
      ? "agents"
      : tab;
  const bodyByTab: Record<Exclude<ChatActionsTab, `plugin:${string}`>, ReactNode> = {
    missions: missionsContent,
    sources: sourcesContent,
    agents: agentsContent,
    proof: proofContent,
    handoff: handoffContent,
  };
  const body = selectedSlot && activeTab === selectedSlot.id ? (
    <div className="h-full min-h-0 overflow-auto px-3 py-3">
      <PluginSlotPanel slot={selectedSlot} active={active} context={sessionContext} placement="drawer" />
    </div>
  ) : bodyByTab[activeTab as Exclude<ChatActionsTab, `plugin:${string}`>];

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
