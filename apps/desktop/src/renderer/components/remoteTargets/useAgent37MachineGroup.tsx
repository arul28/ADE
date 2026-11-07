import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { UserMinus } from "@phosphor-icons/react";
import type { Agent37Machine } from "../../../shared/agent37";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import { accountMachinePresence, machineIsAwake } from "../../../shared/machinePresence";
import type { AdeAccountMachine, RemoteRuntimeTarget } from "../../../shared/types";
import { useActivityStore } from "../../state/activityStore";
import { Agent37BoxOnlyRow, Agent37BoxStrip, Agent37GroupBanners, Agent37GroupHead, agent37ParkedRow } from "./Agent37MachineGroup";
import { agent37BoxWork, isDeletedAgent37Row, matchAgent37Boxes } from "./agent37MachineModel";
import { connectButtonStyle } from "./remoteTargetListStyles";
import type { MachineAction } from "./MachineActionsMenu";
import type { MachineRow, MachineSection, MachineSections } from "./remoteMachineModel";
import { useAgent37BoxActions, type Agent37BoxContext } from "./useAgent37BoxActions";
import { useAgent37Machines } from "./useAgent37Machines";

/** While a box's row lags, how often the account list is read again. */
const AGENT37_ROW_CATCH_UP_REFRESH_MS = 15_000;
/** How long a running box's row may lag (still asleep) before the list stops re-reading. */
const AGENT37_ROW_CATCH_UP_MS = 3 * 60_000;

/** What a row in the Agent 37 group carries beyond the ordinary row. */
export type RowExtras = {
  footer?: ReactNode;
  extraActions?: MachineAction[];
  hideLocalRemove?: boolean;
  parked?: { label: string; action: ReactNode } | null;
};

/**
 * The Agent 37 group of the machine list: the workspace's boxes matched to
 * their rows, the extras each row gets, the rows that leave their section for
 * the group, and the group itself. Account-level (the key is the account's),
 * so the reads and every box action go out with no pin.
 */
export function useAgent37MachineGroup(args: {
  /** Only where the account list comes in: without it no box can find its row. */
  enabled: boolean;
  accountMachines: readonly AdeAccountMachine[] | undefined;
  /** Whether the account's machine list was read; otherwise "not in ADE" is unknown. */
  accountKnown: boolean;
  sections: MachineSections;
  accountMachineForTarget: (target: RemoteRuntimeTarget) => AdeAccountMachine | null;
  /** Drops this computer's saved connection to a removed or deleted machine. */
  forgetTarget: (targetId: string) => Promise<void>;
  setAccountRowError: (machineKey: string, message: string) => void;
  onAccountMachinesChanged?: () => void;
  onOpenSettings?: (() => void) | null;
}) {
  const {
    accountMachines,
    accountKnown,
    sections,
    accountMachineForTarget,
    forgetTarget,
    setAccountRowError,
    onAccountMachinesChanged,
    onOpenSettings,
  } = args;
  const agent37Machines = useAgent37Machines(args.enabled && Boolean(window.ade?.agent37?.listMachines));
  const agent37Result = agent37Machines.result;
  const agent37Boxes = useMemo(
    () => (agent37Result?.state === "ok" ? agent37Result.machines : []),
    [agent37Result],
  );
  const agent37ByMachineKey = useMemo(
    () => matchAgent37Boxes(agent37Boxes, accountMachines ?? []),
    [agent37Boxes, accountMachines],
  );
  // A box Agent 37 just woke (or resized) runs before its brain reports in,
  // so its row still says asleep. Read the account list again every 15 s
  // until the row catches up, for at most 3 minutes; no standing poll.
  const agent37RowsBehind = useMemo(() => {
    const keys: string[] = [];
    for (const [machineKey, box] of agent37ByMachineKey) {
      if (box.state !== "running") continue;
      const machine = (accountMachines ?? []).find((entry) => entry.machineKey === machineKey);
      if (machine && !machineIsAwake(accountMachinePresence(machine, { connected: false }))) keys.push(machineKey);
    }
    return keys.sort().join(",");
  }, [agent37ByMachineKey, accountMachines]);
  // When the lag started, and for which rows. A newly lagging row (another
  // box woken) starts a new window; a row that caught up does not.
  const agent37BehindSince = useRef<{ keys: Set<string>; since: number } | null>(null);
  useEffect(() => {
    if (!agent37RowsBehind || !onAccountMachinesChanged) {
      agent37BehindSince.current = null;
      return;
    }
    const keys = new Set(agent37RowsBehind.split(","));
    const previous = agent37BehindSince.current;
    const since = previous && [...keys].every((key) => previous.keys.has(key)) ? previous.since : Date.now();
    agent37BehindSince.current = { keys, since };
    if (Date.now() - since > AGENT37_ROW_CATCH_UP_MS) return;
    // Re-armed by each new account list, so one read at a time.
    const timer = window.setTimeout(() => onAccountMachinesChanged(), AGENT37_ROW_CATCH_UP_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [agent37RowsBehind, onAccountMachinesChanged, accountMachines]);

  const activityItemsById = useActivityStore((state) => state.itemsById);
  const activityItems = useMemo(() => Object.values(activityItemsById), [activityItemsById]);

  /** The account row a list row is (directly, or through its saved connection). */
  const rowAccountMachine = useCallback((row: MachineRow): AdeAccountMachine | null => {
    if (row.kind === "account") return row.machine;
    if (row.kind === "saved") return accountMachineForTarget(row.target);
    return null;
  }, [accountMachineForTarget]);
  const rowBox = useCallback((row: MachineRow): Agent37Machine | null => {
    const machineKey = rowAccountMachine(row)?.machineKey
      ?? (row.kind === "saved" ? row.target.pairedMachine?.machineKey ?? null : null);
    if (!machineKey) return null;
    return agent37ByMachineKey.get(machineKey) ?? agent37Boxes.find((box) => box.machineKey === machineKey) ?? null;
  }, [agent37Boxes, agent37ByMachineKey, rowAccountMachine]);

  const agent37Actions = useAgent37BoxActions({
    refresh: agent37Machines.refresh,
    onAccountChanged: onAccountMachinesChanged,
    forgetTarget,
    tier: agent37Result?.tier ?? null,
  });

  const boxContext = useCallback((box: Agent37Machine, row: MachineRow | null): Agent37BoxContext => {
    const accountMachine = row ? rowAccountMachine(row) : null;
    const name = row?.kind === "saved"
      ? row.target.name
      : accountMachine
        ? accountMachineDisplayName(accountMachine) ?? box.name ?? box.instanceId
        : box.name?.trim() || box.instanceId;
    return {
      box,
      name,
      accountMachine,
      targetId: row?.kind === "saved" ? row.target.id : row?.kind === "account" ? row.matchedTargetId : null,
      work: agent37BoxWork(accountMachine, activityItems),
    };
  }, [activityItems, rowAccountMachine]);

  // A row puts Wake where Connect goes; a box with no row gets it on its card.
  const boxStrip = (ctx: Agent37BoxContext, wakeOnCard: boolean) => (
    <Agent37BoxStrip
      box={ctx.box}
      work={ctx.work}
      pending={agent37Actions.pendingById[ctx.box.instanceId] ?? null}
      error={agent37Actions.errorById[ctx.box.instanceId] ?? null}
      onDismissError={() => agent37Actions.dismissError(ctx.box.instanceId)}
      onWake={wakeOnCard ? () => void agent37Actions.wake(ctx) : null}
      onOpenSettings={onOpenSettings}
    />
  );

  /**
   * The extras every row gets: an Agent 37 box its strip and box actions, any
   * other account machine Remove from ADE.
   */
  function rowExtrasFor(row: MachineRow): RowExtras {
    const accountMachine = rowAccountMachine(row);
    const box = rowBox(row);
    const onAccountError = (message: string) => {
      if (accountMachine) setAccountRowError(accountMachine.machineKey, message);
    };
    if (box) {
      const ctx = boxContext(box, row);
      return {
        footer: boxStrip(ctx, false),
        extraActions: agent37Actions.actionsFor(ctx, onAccountError),
        // Remove from ADE takes the saved connection with it; without an
        // account row, the row keeps its own Remove from this computer.
        hideLocalRemove: ctx.accountMachine != null,
        parked: agent37ParkedRow(box, ctx.name, agent37Actions.pendingById[box.instanceId] ?? null, () => void agent37Actions.wake(ctx)),
      };
    }
    if (!accountMachine) return {};
    const name = row.kind === "saved" ? row.target.name : accountMachineDisplayName(accountMachine) ?? "this computer";
    const removeFromAde = () => void agent37Actions.removeFromAde({
      machine: accountMachine,
      name,
      targetId: row.kind === "saved" ? row.target.id : row.kind === "account" ? row.matchedTargetId : null,
      box: null,
      onError: onAccountError,
    });
    // A box deleted on the Agent 37 site leaves its row on the account, offline for good.
    const deletedBox = agent37Result?.state === "ok" && isDeletedAgent37Row(accountMachine, agent37Result.deletedInstanceIds ?? []);
    return {
      extraActions: [{
        key: "remove-ade",
        label: "Remove from ADE",
        ariaLabel: `Remove ${name} from ADE`,
        icon: <UserMinus size={14} />,
        danger: true,
        onSelect: removeFromAde,
      }],
      parked: deletedBox
        ? {
          label: "Deleted on Agent 37. It no longer exists.",
          action: (
            <button type="button" aria-label={`Remove ${name} from ADE`} onClick={removeFromAde} style={{ ...connectButtonStyle, marginRight: 4 }}>
              <UserMinus size={13} />
              Remove
            </button>
          ),
        }
        : null,
    };
  }

  // Rows that are Agent 37 boxes leave their section for the Agent 37 group,
  // which keeps the order Connected, Ready to connect, Not reachable.
  const agent37Rows: Array<{ row: MachineRow; section: MachineSection }> = [];
  const listedSections: Record<MachineSection, MachineRow[]> = { connected: [], available: [], unavailable: [] };
  const matchedBoxIds = new Set<string>();
  for (const section of ["connected", "available", "unavailable"] as const) {
    for (const row of sections[section]) {
      const box = rowBox(row);
      if (box && !matchedBoxIds.has(box.instanceId)) {
        matchedBoxIds.add(box.instanceId);
        agent37Rows.push({ row, section });
      } else {
        listedSections[section].push(row);
      }
    }
  }
  // Boxes ADE made that no row stands for: joining, removed from ADE, or
  // never signed in. They still bill, so they stay visible.
  const looseBoxes = agent37Boxes.filter((box) => box.madeByAde && !matchedBoxIds.has(box.instanceId));
  const agent37GroupBoxes = [...agent37Rows.map(({ row }) => rowBox(row)!), ...looseBoxes];
  const showAgent37Group = agent37Result != null && agent37Result.state !== "not_connected"
    && (agent37GroupBoxes.length > 0 || agent37Result.state !== "ok" || agent37Result.pastDue);

  /** The group, with each matched row drawn by the list's own row renderer. */
  function renderGroup(renderRow: (row: MachineRow, section: MachineSection) => ReactNode): ReactNode {
    if (!showAgent37Group) return null;
    return (
      <div className="ade-cx-section" data-machine-group="agent37">
        <Agent37GroupHead boxes={agent37GroupBoxes} result={agent37Result} loading={agent37Machines.loading} />
        <Agent37GroupBanners
          result={agent37Result}
          loadError={agent37Machines.loadError}
          boxes={agent37GroupBoxes}
          onRetry={agent37Machines.refresh}
          onOpenSettings={onOpenSettings}
        />
        {agent37GroupBoxes.length > 0 ? (
          <div className="ade-cx-list">
            {agent37Rows.map(({ row, section }) => renderRow(row, section))}
            {looseBoxes.map((box) => {
              const ctx = boxContext(box, null);
              return (
                <Agent37BoxOnlyRow
                  key={`agent37:${box.instanceId}`}
                  box={box}
                  accountKnown={accountKnown}
                  actions={agent37Actions.actionsFor(ctx, () => undefined)}
                  strip={boxStrip(ctx, true)}
                />
              );
            })}
          </div>
        ) : null}
        {agent37Actions.dialog}
      </div>
    );
  }


  return {
    rowExtrasFor,
    /** The list's sections without the rows that moved to the group. */
    listedSections,
    showGroup: showAgent37Group,
    renderGroup,
  };
}
