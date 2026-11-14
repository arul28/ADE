import { useMemo } from "react";
import type { AppControlSession, BuiltInBrowserStatus } from "../../../shared/types";
import type { ChatDeviceSources, DeviceKind } from "../../../shared/types/deviceSources";
import { deviceKindRunsOnPlatform } from "../../../shared/types/deviceSources";
import type { WorkSidebarTab } from "../../state/appStore";
import {
  desktopToolForMachinePlatform,
  hostDesktopTool,
  IOS_RUNTIME_UNSUPPORTED_REASON,
  workToolAvailability,
  workToolDefinition,
  type WorkToolContext,
} from "./workTools";
import { workToolHasError, type WorkToolStatus, type WorkToolStatusMap } from "./useWorkToolStatuses";
import {
  CARD_DEVICE_KIND,
  chosenMachineFor,
  visibleCatalogCards,
  workCopyUseOn,
  type CatalogCardId,
} from "./workToolCatalog";
import type { ChatToolActivity, ToolActivity, ToolActivityTool } from "./useChatToolActivity";
import type { RemoteDeviceProbe } from "./useRemoteDeviceProbes";
import type { ToolMachine } from "./useToolMachines";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";

export type CatalogCardView = {
  id: CatalogCardId;
  /** The tab opening this tile shows. */
  tool: WorkSidebarTab;
  label: string;
  /** The tile's tool colour: its live ring and glow. */
  color: string;
  /** The mark's colour: the brand's own (Apple and GitHub are monochrome). */
  markColor: string;
  /** The one status line: the agent's action while it works, else what the tool is doing. */
  line: string | null;
  /** The tile opens its tool. */
  available: boolean;
  /** Something of this chat's is running in it now. */
  live: boolean;
  /** The agent's call to this tool is running right now. */
  agentNow: boolean;
  activity: ToolActivity | null;
  error: boolean;
  attention: boolean;
  stale: boolean;
  kind: DeviceKind | null;
  /** For a device tile: the machine its device is on now (plain text on the tile). */
  machine: ToolMachine | null;
};

const CARD_LABEL: Record<CatalogCardId, string> = {
  ios: "Apple Simulators",
  android: "Android",
  screen: "Screen",
  "app-control": "App Control",
  terminal: "Terminal",
  browser: "Browser",
  git: "Git",
  pr: "Pull request",
  issues: "Issues",
  files: "Files",
  "side-chat": "Side chat",
};

/** Monochrome brands: the mark takes the text colour, the ring keeps the tool's. */
const MONO_MARKS: ReadonlySet<CatalogCardId> = new Set<CatalogCardId>(["ios", "pr"]);

/** Brand colours where the tool has a brand; the catalogue's own colour elsewhere. */
const CARD_COLOR: Partial<Record<CatalogCardId, string>> = {
  android: "#3ddc84",
  git: "#f05032",
  issues: "#7b8af0",
};

const ACTIVITY_TOOL: Partial<Record<CatalogCardId, ToolActivityTool>> = {
  ios: "ios",
  android: "android",
  screen: "screen",
  browser: "browser",
  "app-control": "app-control",
  terminal: "terminal",
  git: "git",
  pr: "pr",
  issues: "issues",
};

export type WorkToolCatalogInputs = {
  context: WorkToolContext;
  statuses: WorkToolStatusMap;
  machines: readonly ToolMachine[];
  sources: ChatDeviceSources | null;
  /** Where each device is now when that is another machine (`currentRemoteDeviceMachines`). */
  deviceMachines: Partial<Record<DeviceKind, ToolMachine>>;
  activity: ChatToolActivity;
  probes: Partial<Record<DeviceKind, RemoteDeviceProbe>>;
  remoteWork: readonly AgentChatRemoteWorkUse[] | null | undefined;
  panelSessionId: string | null;
  hasSideChat: boolean;
  appControlSession: AppControlSession | null;
  browserStatus: BuiltInBrowserStatus | null;
};

/** "Tapping “General”…" as the tile says it: "Agent: tapping “General”…". */
export function agentActivityLine(activity: ToolActivity): string {
  const text = activity.text;
  return `Agent: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/**
 * The tiles the picker draws, from reads the pane already makes. Every line
 * says what is true NOW: the chat's device choice, the machine's device read
 * live, the agent's current call. Nothing comes from which machines the chat
 * used before.
 */
export function useWorkToolCatalog(inputs: WorkToolCatalogInputs): CatalogCardView[] {
  const {
    context,
    statuses,
    machines,
    sources,
    deviceMachines,
    activity,
    probes,
    remoteWork,
    panelSessionId,
    hasSideChat,
    appControlSession,
    browserStatus,
  } = inputs;
  return useMemo(() => {
    const chatMachine = machines.find((machine) => machine.isChat) ?? null;
    const browserOwnedHere = Boolean(panelSessionId && browserStatus?.tabs?.some((tab) => tab.ownerChatSessionId === panelSessionId));

    const build = (card: CatalogCardId): CatalogCardView => {
      const kind = CARD_DEVICE_KIND[card] ?? null;
      const remote = kind ? deviceMachines[kind] ?? null : null;
      const onMachine = kind ? remote ?? chosenMachineFor(kind, sources, machines) ?? chatMachine : null;
      // A machine that cannot run this device is not where it is: the tool picks one that can.
      const cannotRunHere = Boolean(kind && onMachine && !deviceKindRunsOnPlatform(kind, onMachine.platform));
      const machine = cannotRunHere ? null : onMachine;
      const tool: WorkSidebarTab = card === "screen"
        ? (remote ? desktopToolForMachinePlatform(remote.platform) : hostDesktopTool(context))
        : card;
      const definition = workToolDefinition(tool);
      const status: WorkToolStatus | undefined = statuses[tool];
      const availability = workToolAvailability(tool, context);
      const activityTool = ACTIVITY_TOOL[card];
      const act = activityTool ? activity.byTool[activityTool] ?? null : null;
      const agentNow = Boolean(act?.running);

      let running = false;
      let line: string | null = availability.available ? status?.line ?? definition?.hint ?? null : availability.reason;
      if (remote && kind) {
        const probe = probes[kind] ?? null;
        running = probe === "running";
        line = !workCopyUseOn(remoteWork, remote.key)
          ? "Starts with the agent's next command there"
          : probe === "running" ? "Running" : probe === "off" ? "Off" : "Ready";
      } else if (card === "ios" || card === "android" || card === "screen" || card === "terminal") {
        running = Boolean(status?.live);
      } else if (card === "app-control") {
        running = Boolean(status?.live) && (!appControlSession?.chatSessionId || appControlSession.chatSessionId === panelSessionId);
      } else if (card === "browser") {
        running = browserOwnedHere;
      }
      // A device this machine cannot run: the tool opens on a machine that can.
      if (cannotRunHere || (!remote && availability.reason === IOS_RUNTIME_UNSUPPORTED_REASON)) line = "Runs on a Mac";
      if (agentNow && act) line = agentActivityLine(act);

      return {
        id: card,
        tool,
        label: CARD_LABEL[card],
        color: CARD_COLOR[card] ?? definition?.color ?? "var(--color-accent)",
        markColor: MONO_MARKS.has(card) ? "var(--color-fg)" : CARD_COLOR[card] ?? definition?.color ?? "var(--color-accent)",
        line,
        available: availability.available,
        live: running || agentNow,
        agentNow,
        activity: act,
        error: availability.available && workToolHasError(status),
        attention: availability.available && status?.attention === true,
        stale: Boolean(status?.stale),
        kind,
        machine,
      };
    };

    return visibleCatalogCards(hasSideChat).map(build);
  }, [
    activity,
    appControlSession,
    browserStatus,
    context,
    deviceMachines,
    hasSideChat,
    machines,
    panelSessionId,
    probes,
    remoteWork,
    sources,
    statuses,
  ]);
}
