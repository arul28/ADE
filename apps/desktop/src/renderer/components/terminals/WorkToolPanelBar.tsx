import { CloudArrowUp, HandGrabbing, HandPalm } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type { DeviceKind } from "../../../shared/types/deviceSources";
import { sameMachineKey } from "../../../shared/machineAddress";
import { cn } from "../ui/cn";
import { WORK_TOOL_CHROME_CHIP, WORK_TOOL_CHROME_ROW } from "./workToolChrome";
import { DEVICE_KINDS, joinNames, machinesForKind, railMachineName } from "./workToolCatalog";
import type { CatalogCardView } from "./useWorkToolCatalog";
import type { ToolMachine } from "./useToolMachines";
import { MachineOsMark } from "./workToolTileMarks";

/** The tool as a note to the agent names it. */
export function toolNoun(tile: Pick<CatalogCardView, "kind" | "label">): string {
  return tile.kind ? DEVICE_KINDS[tile.kind].noun : tile.label;
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
 *   options. An agent that takes input mid-turn was told to leave it alone
 *   and is told when it is free; one that cannot (`canTellAgent` false) is
 *   told nothing, and the row says so.
 * - Nobody is (`free`): for a device, the machine it runs on, switched in
 *   place. A switch is this chat's device choice (`chat.setDeviceSource`, the
 *   setting `ade devices use` writes), so the tile, this row and the agent's
 *   next command agree. When the chat's brain cannot keep a choice
 *   (`viewOnly`), a pick changes only what this panel shows.
 */
export function WorkToolPanelBar({
  tile,
  mode,
  machines,
  canChoose,
  viewOnly,
  chooseUnavailableReason,
  canTellAgent,
  told,
  onChooseMachine,
  onAskMachine,
  onTakeOver,
  onHandBack,
}: {
  tile: CatalogCardView;
  mode: PanelBarMode;
  machines: readonly ToolMachine[];
  /** A machine can be picked here: kept for this chat, or for this view only (`viewOnly`). */
  canChoose: boolean;
  /** The chat's brain keeps no choice: a pick only changes what this panel shows. */
  viewOnly: boolean;
  /** Why no machine can be picked, or what a view-only pick means, in a sentence. */
  chooseUnavailableReason: string | null;
  /** The chat's provider takes a note while it works (`inline`); a queue-only one does not. */
  canTellAgent: boolean;
  /** The agent was told about the take-over (`held` only). */
  told: boolean;
  onChooseMachine: (kind: DeviceKind, machine: ToolMachine) => void;
  onAskMachine: (kind: DeviceKind, machine: ToolMachine) => void;
  onTakeOver: (() => void) | null;
  onHandBack: () => void;
}) {
  const style = { ["--tool-color" as string]: tile.color } as CSSProperties;
  const noun = toolNoun(tile);
  let head = null;
  if (mode === "agent" && tile.activity) {
    head = (
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
            title={canTellAgent
              ? `Use the ${noun} yourself. The agent keeps working and is asked to leave it alone until you hand it back.`
              : `Use the ${noun} yourself. This agent can't be told while it works, so it may still use it.`}
          >
            <HandGrabbing size={13} weight="fill" />
            <span>Take over</span>
          </button>
        ) : null}
      </div>
    );
  } else if (mode === "held") {
    head = (
      <div className={cn(WORK_TOOL_CHROME_ROW, "gap-2 px-3")} data-testid="work-tool-held-bar">
        <HandPalm size={14} weight="fill" className="shrink-0" style={{ color: "var(--tool-color)" }} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-fg/85">
          You have the {noun}. {heldLine(canTellAgent, told)}
        </span>
        <button type="button" className={WORK_TOOL_CHROME_CHIP} onClick={onHandBack} title="Give it back to the agent">
          <span>Hand back</span>
        </button>
      </div>
    );
  }

  const kind = tile.kind;
  const machineRow = kind ? (
    <MachineRow
      tile={tile}
      kind={kind}
      machines={machines}
      asking={mode === "agent"}
      canChoose={canChoose}
      viewOnly={viewOnly}
      chooseUnavailableReason={chooseUnavailableReason}
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

/** What the held row says about the agent. */
function heldLine(canTellAgent: boolean, told: boolean): string {
  if (told) return "The agent was asked to wait.";
  if (!canTellAgent) return "This agent can't be told while it works, so it may still use it.";
  return "The agent isn't working now.";
}

/** A machine chip's tooltip. */
function machineChipTitle(args: {
  noun: string;
  machine: ToolMachine;
  chosen: boolean;
  asking: boolean;
  enabled: boolean;
  viewOnly: boolean;
  chooseUnavailableReason: string | null;
}): string | undefined {
  const { noun, machine } = args;
  if (args.chosen) return args.viewOnly ? `Showing ${machine.name}'s ${noun}` : `This chat's ${noun} runs on ${machine.name}`;
  if (args.asking) return `Ask the agent to switch the ${noun} to ${machine.name}`;
  if (args.enabled && args.viewOnly) return `Show ${machine.name}'s ${noun} here. The agent's commands still pick with --machine.`;
  if (args.enabled) return `Use ${machine.name} for this chat (same as ade devices use)`;
  return args.chooseUnavailableReason ?? undefined;
}

function rowLabel(asking: boolean, viewOnly: boolean): string {
  if (asking) return "Ask the agent to use";
  return viewOnly ? "Show from" : "Runs on";
}

/** The row's one quiet note on the right: who cannot run it, or why nothing can be picked. */
function rowNote(args: {
  kind: DeviceKind;
  unable: readonly ToolMachine[];
  enabled: boolean;
  asking: boolean;
  viewOnly: boolean;
  chooseUnavailableReason: string | null;
}): string | null {
  if (args.kind === "ios" && args.unable.length) return `${joinNames(args.unable.map(railMachineName))}: needs a Mac`;
  if (!args.enabled || (args.viewOnly && !args.asking)) return args.chooseUnavailableReason;
  return null;
}

function MachineRow({
  tile,
  kind,
  machines,
  asking,
  canChoose,
  viewOnly,
  chooseUnavailableReason,
  onPick,
}: {
  tile: CatalogCardView;
  kind: DeviceKind;
  machines: readonly ToolMachine[];
  /** The agent is using it: a pick asks the agent instead of switching. */
  asking: boolean;
  canChoose: boolean;
  viewOnly: boolean;
  chooseUnavailableReason: string | null;
  onPick: (machine: ToolMachine) => void;
}) {
  const { able, unable } = machinesForKind(kind, machines, tile.machine);
  if (!able.length && !unable.length) return null;
  const enabled = asking || canChoose;
  const noun = toolNoun(tile);
  const note = rowNote({ kind, unable, enabled, asking, viewOnly, chooseUnavailableReason });
  return (
    <div className={cn(WORK_TOOL_CHROME_ROW, "gap-1 px-3")} data-testid="work-tool-machine-bar">
      <span className="mr-1 shrink-0 font-sans text-[12px] text-muted-fg">
        {rowLabel(asking, viewOnly)}
      </span>
      <div role="radiogroup" aria-label={`${tile.label} runs on`} className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {able.map((machine) => {
          const chosen = Boolean(tile.machine && sameMachineKey(tile.machine.key, machine.key));
          const title = machineChipTitle({ noun, machine, chosen, asking, enabled, viewOnly, chooseUnavailableReason });
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
        {kind === "ios" ? (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 px-1.5 font-sans text-[11.5px] text-muted-fg/70" title="ADE Cloud iPhone: a phone that runs on no machine of yours">
            <CloudArrowUp size={12} weight="bold" aria-hidden="true" />
            ADE Cloud soon
          </span>
        ) : null}
      </div>
      {note ? (
        <span className="ml-auto shrink-0 truncate pl-2 font-sans text-[11.5px] text-muted-fg/70" title={note}>
          {note}
        </span>
      ) : null}
    </div>
  );
}
