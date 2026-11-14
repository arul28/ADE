import { CheckCircle, CloudArrowUp, HandGrabbing, HandPalm } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type { DeviceKind } from "../../../shared/types/deviceSources";
import { sameMachineKey } from "../../../shared/machineAddress";
import { cn } from "../ui/cn";
import { WORK_TOOL_CHROME_CHIP, WORK_TOOL_CHROME_ROW } from "./workToolChrome";
import { joinNames, machinesForKind, railMachineName } from "./workToolCatalog";
import type { CatalogCardView } from "./useWorkToolCatalog";
import type { ToolMachine } from "./useToolMachines";
import { MachineOsMark } from "./workToolTileMarks";

/** What a device is called in a note to the agent. */
export const DEVICE_NOUN: Readonly<Record<DeviceKind, string>> = {
  ios: "Apple simulator",
  android: "Android emulator",
  screen: "screen",
  app: "App Control app",
};

/** The tool as a note to the agent names it. */
export function toolNoun(tile: Pick<CatalogCardView, "kind" | "label">): string {
  return tile.kind ? DEVICE_NOUN[tile.kind] : tile.label;
}

export type PanelBarMode = "agent" | "held" | "free";

/**
 * The rows above an open tool.
 *
 * - The agent is using it (`agent`): what it is doing, and Take over. The
 *   machine row ASKS the agent: a pick sends it a note ("Please switch the
 *   Apple simulator to …") on the chat's own send path, and changes nothing
 *   itself. The agent keeps its turn.
 * - The person took it over (`held`): Hand back, and the person's own
 *   options. The agent was told to leave it alone and is told when it is free.
 * - Nobody is (`free`): for a device, the machine it runs on, switched in
 *   place. A switch is this chat's device choice (`chat.setDeviceSource`, the
 *   setting `ade devices use` writes), so the tile, this row and the agent's
 *   next command agree.
 */
export function WorkToolPanelBar({
  tile,
  mode,
  machines,
  canChoose,
  chooseUnavailableReason,
  sentNote,
  onChooseMachine,
  onAskMachine,
  onTakeOver,
  onHandBack,
}: {
  tile: CatalogCardView;
  mode: PanelBarMode;
  machines: readonly ToolMachine[];
  /** A choice can be kept for this chat (an ADE chat whose brain keeps them). */
  canChoose: boolean;
  /** Why it cannot, in a sentence (a CLI session, the hosted web client). */
  chooseUnavailableReason: string | null;
  /** "Sent to the agent" for a moment after a note went. */
  sentNote: string | null;
  onChooseMachine: (kind: DeviceKind, machine: ToolMachine) => void;
  onAskMachine: (kind: DeviceKind, machine: ToolMachine) => void;
  onTakeOver: (() => void) | null;
  onHandBack: () => void;
}) {
  const style = { ["--tool-color" as string]: tile.color } as CSSProperties;
  const head = mode === "agent" && tile.activity ? (
    <div className={cn(WORK_TOOL_CHROME_ROW, "gap-2 px-3")} data-testid="work-tool-agent-bar">
      <span aria-hidden="true" className="ade-tool-tile-dot ade-tool-agent-dot" style={{ background: "var(--tool-color)" }} />
      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-fg/85" title={tile.activity.text}>
        <span className="font-medium text-fg">Agent</span>
        <span className="text-muted-fg">: </span>
        {tile.activity.text}
      </span>
      {onTakeOver ? (
        <button
          type="button"
          className={WORK_TOOL_CHROME_CHIP}
          onClick={onTakeOver}
          title={`Use the ${toolNoun(tile)} yourself. The agent keeps working and is asked to leave it alone until you hand it back.`}
        >
          <HandGrabbing size={13} weight="fill" />
          <span>Take over</span>
        </button>
      ) : null}
    </div>
  ) : mode === "held" ? (
    <div className={cn(WORK_TOOL_CHROME_ROW, "gap-2 px-3")} data-testid="work-tool-held-bar">
      <HandPalm size={14} weight="fill" className="shrink-0" style={{ color: "var(--tool-color)" }} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-fg/85">
        You have the {toolNoun(tile)}. The agent was asked to wait.
      </span>
      <button type="button" className={WORK_TOOL_CHROME_CHIP} onClick={onHandBack} title="Give it back to the agent">
        <span>Hand back</span>
      </button>
    </div>
  ) : null;

  const kind = tile.kind;
  const machineRow = kind ? (
    <MachineRow
      tile={tile}
      kind={kind}
      machines={machines}
      asking={mode === "agent"}
      canChoose={canChoose}
      chooseUnavailableReason={chooseUnavailableReason}
      sentNote={sentNote}
      onPick={(machine) => (mode === "agent" ? onAskMachine(kind, machine) : onChooseMachine(kind, machine))}
    />
  ) : null;
  if (!head && !machineRow) return null;
  return (
    <div style={style} className="shrink-0">
      {head}
      {machineRow}
    </div>
  );
}

function MachineRow({
  tile,
  kind,
  machines,
  asking,
  canChoose,
  chooseUnavailableReason,
  sentNote,
  onPick,
}: {
  tile: CatalogCardView;
  kind: DeviceKind;
  machines: readonly ToolMachine[];
  /** The agent is using it: a pick asks the agent instead of switching. */
  asking: boolean;
  canChoose: boolean;
  chooseUnavailableReason: string | null;
  sentNote: string | null;
  onPick: (machine: ToolMachine) => void;
}) {
  const { able, unable } = machinesForKind(kind, machines, tile.machine);
  if (!able.length && !unable.length) return null;
  const enabled = asking || canChoose;
  return (
    <div className={cn(WORK_TOOL_CHROME_ROW, "gap-1 px-3")} data-testid="work-tool-machine-bar">
      <span className="mr-1 shrink-0 font-sans text-[12px] text-muted-fg">
        {asking ? "Ask the agent to use" : "Runs on"}
      </span>
      <div role="radiogroup" aria-label={`${tile.label} runs on`} className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {able.map((machine) => {
          const chosen = Boolean(tile.machine && sameMachineKey(tile.machine.key, machine.key));
          const title = chosen
            ? `This chat's ${toolNoun(tile)} runs on ${machine.name}`
            : asking
              ? `Ask the agent to switch the ${toolNoun(tile)} to ${machine.name}`
              : enabled
                ? `Use ${machine.name} for this chat (same as ade devices use)`
                : chooseUnavailableReason ?? undefined;
          return (
            <button
              key={machine.key}
              type="button"
              role="radio"
              aria-checked={chosen}
              disabled={!enabled && !chosen}
              onClick={() => { if (!chosen) onPick(machine); }}
              title={title}
              className={cn(
                WORK_TOOL_CHROME_CHIP,
                "h-6 shrink-0 rounded-full px-2.5",
                chosen
                  ? "bg-[color-mix(in_srgb,var(--tool-color)_16%,transparent)] text-fg shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--tool-color)_55%,transparent)]"
                  : "text-fg/70",
                !machine.online && "opacity-55",
              )}
              data-machine-key={machine.key}
            >
              <MachineOsMark machine={machine} size={12} />
              <span className="max-w-[140px] truncate">{railMachineName(machine)}</span>
              {!machine.online ? <span className="text-[10.5px] text-muted-fg">offline</span> : null}
            </button>
          );
        })}
        {kind === "ios" && !sentNote ? (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 px-1.5 font-sans text-[11.5px] text-muted-fg/70" title="ADE Cloud iPhone: a phone that runs on no machine of yours">
            <CloudArrowUp size={12} weight="bold" aria-hidden="true" />
            ADE Cloud soon
          </span>
        ) : null}
      </div>
      {sentNote ? (
        <span role="status" className="ml-auto inline-flex shrink-0 items-center gap-1 pl-2 font-sans text-[11.5px] text-fg/80">
          <CheckCircle size={12} weight="fill" className="text-[var(--color-success,#34d399)]" aria-hidden="true" />
          {sentNote}
        </span>
      ) : kind === "ios" && unable.length ? (
        <span className="ml-auto shrink-0 truncate pl-2 font-sans text-[11.5px] text-muted-fg/70">
          {joinNames(unable.map(railMachineName))}: needs a Mac
        </span>
      ) : !enabled && chooseUnavailableReason ? (
        <span className="ml-auto shrink-0 truncate pl-2 font-sans text-[11.5px] text-muted-fg/70" title={chooseUnavailableReason}>
          {chooseUnavailableReason}
        </span>
      ) : null}
    </div>
  );
}
