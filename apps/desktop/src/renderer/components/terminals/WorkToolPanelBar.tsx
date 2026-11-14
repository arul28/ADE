import { CloudArrowUp, HandGrabbing, Stop } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import type { DeviceKind } from "../../../shared/types/deviceSources";
import { sameMachineKey } from "../../../shared/machineAddress";
import { cn } from "../ui/cn";
import { MachinePlatformLogo } from "../remoteTargets/MachineIdentity";
import { WORK_TOOL_CHROME_CHIP, WORK_TOOL_CHROME_ROW } from "./workToolChrome";
import { joinNames, machinesForKind, railMachineName } from "./workToolCatalog";
import type { CatalogCardView } from "./useWorkToolCatalog";
import type { ToolMachine } from "./useToolMachines";

/**
 * The row above an open tool, in one of two states.
 *
 * The agent is using it: no setup options. The row says what the agent is
 * doing, under the tool's live view, with Stop (interrupts the agent's turn)
 * and Take over (stops it and hands the tool's options to the person).
 *
 * Nobody is: for a device, the machine it runs on, switched in place. A
 * switch is this chat's device choice (`chat.setDeviceSource`, the same
 * setting as `ade devices use`), so the tile, this row and the agent's next
 * command all agree.
 */
export function WorkToolPanelBar({
  tile,
  machines,
  takenOver,
  canChoose,
  onChooseMachine,
  onStopAgent,
  onTakeOver,
}: {
  tile: CatalogCardView;
  machines: readonly ToolMachine[];
  /** The person took over during this agent call: show the options. */
  takenOver: boolean;
  canChoose: boolean;
  onChooseMachine: (kind: DeviceKind, machine: ToolMachine) => void;
  onStopAgent: (() => void) | null;
  onTakeOver: (() => void) | null;
}) {
  const style = { ["--tool-color" as string]: tile.color } as CSSProperties;
  if (tile.agentNow && !takenOver && tile.activity) {
    return (
      <div className={cn(WORK_TOOL_CHROME_ROW, "gap-2 px-3")} style={style} data-testid="work-tool-agent-bar">
        <span aria-hidden="true" className="ade-tool-tile-dot m-0" style={{ background: "var(--tool-color)" }} />
        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-fg/85" title={tile.activity.text}>
          <span className="font-medium text-fg">Agent</span>
          <span className="text-muted-fg"> · </span>
          {tile.activity.text}
        </span>
        {onStopAgent ? (
          <button type="button" className={WORK_TOOL_CHROME_CHIP} onClick={onStopAgent} title="Stop the agent's turn">
            <Stop size={12} weight="fill" />
            <span>Stop</span>
          </button>
        ) : null}
        {onTakeOver ? (
          <button type="button" className={WORK_TOOL_CHROME_CHIP} onClick={onTakeOver} title="Stop the agent and use this yourself">
            <HandGrabbing size={12} weight="fill" />
            <span>Take over</span>
          </button>
        ) : null}
      </div>
    );
  }
  if (!tile.kind) return null;
  const kind = tile.kind;
  const { able, unable } = machinesForKind(kind, machines, tile.machine);
  if (!able.length && !unable.length) return null;
  return (
    <div className={cn(WORK_TOOL_CHROME_ROW, "gap-1 px-3")} style={style} data-testid="work-tool-machine-bar">
      <span className="mr-1 shrink-0 font-sans text-[12px] text-muted-fg">Runs on</span>
      <div role="radiogroup" aria-label={`${tile.label} runs on`} className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {able.map((machine) => {
          const chosen = Boolean(tile.machine && sameMachineKey(tile.machine.key, machine.key));
          return (
            <button
              key={machine.key}
              type="button"
              role="radio"
              aria-checked={chosen}
              disabled={!canChoose && !chosen}
              onClick={() => { if (!chosen) onChooseMachine(kind, machine); }}
              title={chosen ? `This chat's ${tile.label} runs on ${machine.name}` : `Use ${machine.name} for this chat (same as ade devices use)`}
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
              <MachinePlatformLogo platform={machine.platform} size={12} weight="fill" fallback />
              <span className="max-w-[140px] truncate">{railMachineName(machine)}</span>
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
      {kind === "ios" && unable.length ? (
        <span className="ml-auto shrink-0 truncate pl-2 font-sans text-[11.5px] text-muted-fg/70">
          {joinNames(unable.map(railMachineName))}: needs a Mac
        </span>
      ) : null}
    </div>
  );
}
