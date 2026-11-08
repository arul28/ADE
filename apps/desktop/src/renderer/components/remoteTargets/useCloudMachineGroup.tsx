import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { UserMinus } from "@phosphor-icons/react";
import type { CloudMachine } from "../../../shared/adeCloud";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import { accountMachinePresence, machineIsAwake } from "../../../shared/machinePresence";
import type { AdeAccountMachine, RemoteRuntimeTarget } from "../../../shared/types";
import { useActivityStore } from "../../state/activityStore";
import { CloudBoxOnlyRow, CloudBoxStrip, CloudGroupBanners, CloudGroupHead, cloudDeletedRow, cloudParkedRow } from "./CloudMachineGroup";
import { isDeletedCloudRow, matchCloudBoxes } from "./cloudMachineModel";
import type { MachineAction } from "./MachineActionsMenu";
import type { MachineRow, MachineSection, MachineSections } from "./remoteMachineModel";
import { cloudBoxContext, useCloudBoxActions, type CloudBoxContext } from "./useCloudBoxActions";
import { useCloudMachines } from "./useCloudMachines";

/** While a box's row lags, how often the account list is read again. */
const CLOUD_ROW_CATCH_UP_REFRESH_MS = 15_000;
/** How long a running box's row may lag (still asleep) before the list stops re-reading. */
const CLOUD_ROW_CATCH_UP_MS = 3 * 60_000;

/** What a row in the provider group carries beyond the ordinary row. */
export type RowExtras = {
  footer?: ReactNode;
  extraActions?: MachineAction[];
  hideLocalRemove?: boolean;
  parked?: { label: string; action: ReactNode } | null;
};

/**
 * The provider group of the machine list: the workspace's boxes matched to
 * their rows, the extras each row gets, the rows that leave their section for
 * the group, and the group itself. Account-level (the key is the account's),
 * so the reads and every box action go out with no pin.
 */
export function useCloudMachineGroup(args: {
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
  const cloudMachines = useCloudMachines(args.enabled && Boolean(window.ade?.cloud?.listMachines));
  const cloudResult = cloudMachines.result;
  const cloudBoxes = useMemo(
    () => (cloudResult?.state === "ok" ? cloudResult.machines : []),
    [cloudResult],
  );
  const cloudByMachineKey = useMemo(
    () => matchCloudBoxes(cloudBoxes, accountMachines ?? []),
    [cloudBoxes, accountMachines],
  );
  // A box the provider just woke (or resized) runs before its brain reports in,
  // so its row still says asleep. Read the account list again every 15 s
  // until the row catches up, for at most 3 minutes; no standing poll.
  const cloudRowsBehind = useMemo(() => {
    const keys: string[] = [];
    for (const [machineKey, box] of cloudByMachineKey) {
      if (box.state !== "running") continue;
      const machine = (accountMachines ?? []).find((entry) => entry.machineKey === machineKey);
      if (machine && !machineIsAwake(accountMachinePresence(machine, { connected: false }))) keys.push(machineKey);
    }
    return keys.sort().join(",");
  }, [cloudByMachineKey, accountMachines]);
  // When the lag started, and for which rows. A newly lagging row (another
  // box woken) starts a new window; a row that caught up does not.
  const cloudBehindSince = useRef<{ keys: Set<string>; since: number } | null>(null);
  useEffect(() => {
    if (!cloudRowsBehind || !onAccountMachinesChanged) {
      cloudBehindSince.current = null;
      return;
    }
    const keys = new Set(cloudRowsBehind.split(","));
    const previous = cloudBehindSince.current;
    const since = previous && [...keys].every((key) => previous.keys.has(key)) ? previous.since : Date.now();
    cloudBehindSince.current = { keys, since };
    if (Date.now() - since > CLOUD_ROW_CATCH_UP_MS) return;
    // Re-armed by each new account list, so one read at a time.
    const timer = window.setTimeout(() => onAccountMachinesChanged(), CLOUD_ROW_CATCH_UP_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [cloudRowsBehind, onAccountMachinesChanged, accountMachines]);

  const activityItemsById = useActivityStore((state) => state.itemsById);
  const activityItems = useMemo(() => Object.values(activityItemsById), [activityItemsById]);

  /** The account row a list row is (directly, or through its saved connection). */
  const rowAccountMachine = useCallback((row: MachineRow): AdeAccountMachine | null => {
    if (row.kind === "account") return row.machine;
    if (row.kind === "saved") return accountMachineForTarget(row.target);
    return null;
  }, [accountMachineForTarget]);
  const rowBox = useCallback((row: MachineRow): CloudMachine | null => {
    const machineKey = rowAccountMachine(row)?.machineKey
      ?? (row.kind === "saved" ? row.target.pairedMachine?.machineKey ?? null : null);
    if (!machineKey) return null;
    return cloudByMachineKey.get(machineKey) ?? cloudBoxes.find((box) => box.machineKey === machineKey) ?? null;
  }, [cloudBoxes, cloudByMachineKey, rowAccountMachine]);

  const cloudActions = useCloudBoxActions({
    refresh: cloudMachines.refresh,
    onAccountChanged: onAccountMachinesChanged,
    forgetTarget,
  });

  const boxContext = useCallback((box: CloudMachine, row: MachineRow | null): CloudBoxContext => cloudBoxContext({
    box,
    accountMachine: row ? rowAccountMachine(row) : null,
    name: row?.kind === "saved" ? row.target.name : null,
    targetId: row?.kind === "saved" ? row.target.id : row?.kind === "account" ? row.matchedTargetId : null,
    activityItems,
    accountKnown,
  }), [accountKnown, activityItems, rowAccountMachine]);

  // A row puts Wake where Connect goes; a box with no row gets it on its card.
  const boxStrip = (ctx: CloudBoxContext, wakeOnCard: boolean) => (
    <CloudBoxStrip
      box={ctx.box}
      work={ctx.work}
      pending={cloudActions.pendingById[ctx.box.instanceId] ?? null}
      error={cloudActions.errorById[ctx.box.instanceId] ?? null}
      onDismissError={() => cloudActions.dismissError(ctx.box.instanceId)}
      onWake={wakeOnCard ? () => void cloudActions.wake(ctx) : null}
      onOpenSettings={onOpenSettings}
    />
  );

  /**
   * The extras every row gets: a cloud box its strip and box actions, any
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
        extraActions: cloudActions.actionsFor(ctx, onAccountError),
        // Remove from ADE takes the saved connection with it; without an
        // account row, the row keeps its own Remove from this computer.
        hideLocalRemove: ctx.accountMachine != null,
        parked: cloudParkedRow(box, ctx.name, cloudActions.pendingById[box.instanceId] ?? null, () => void cloudActions.wake(ctx)),
      };
    }
    if (!accountMachine) return {};
    const name = row.kind === "saved" ? row.target.name : accountMachineDisplayName(accountMachine) ?? "this computer";
    // A box deleted on the provider site leaves its row on the account, offline for good.
    const deletedBox = cloudResult?.state === "ok" && isDeletedCloudRow(accountMachine, cloudResult.deletedInstanceIds ?? []);
    const removeFromAde = () => void cloudActions.removeFromAde({
      machine: accountMachine,
      name,
      targetId: row.kind === "saved" ? row.target.id : row.kind === "account" ? row.matchedTargetId : null,
      box: null,
      deletedOnCloud: deletedBox,
      onError: onAccountError,
    });
    return {
      extraActions: [{
        key: "remove-ade",
        label: "Remove from ADE",
        ariaLabel: `Remove ${name} from ADE`,
        icon: <UserMinus size={14} />,
        danger: true,
        onSelect: removeFromAde,
      }],
      parked: deletedBox ? cloudDeletedRow(name, removeFromAde) : null,
    };
  }

  // Rows that are cloud boxes leave their section for the provider group,
  // which keeps the order Connected, Ready to connect, Not reachable.
  const cloudRows: Array<{ row: MachineRow; section: MachineSection; box: CloudMachine }> = [];
  const listedSections: Record<MachineSection, MachineRow[]> = { connected: [], available: [], unavailable: [] };
  const matchedBoxIds = new Set<string>();
  for (const section of ["connected", "available", "unavailable"] as const) {
    for (const row of sections[section]) {
      const box = rowBox(row);
      if (box && !matchedBoxIds.has(box.instanceId)) {
        matchedBoxIds.add(box.instanceId);
        cloudRows.push({ row, section, box });
      } else {
        listedSections[section].push(row);
      }
    }
  }
  // Boxes ADE made that no row stands for: joining, removed from ADE, or
  // never signed in. They still bill, so they stay visible.
  const looseBoxes = cloudBoxes.filter((box) => box.madeByAde && !matchedBoxIds.has(box.instanceId));
  const cloudGroupBoxes = [...cloudRows.map(({ box }) => box), ...looseBoxes];
  const showCloudGroup = cloudResult != null && cloudResult.state !== "not_connected"
    && (cloudGroupBoxes.length > 0 || cloudResult.state !== "ok");

  /** The group, with each matched row drawn by the list's own row renderer. */
  function renderGroup(renderRow: (row: MachineRow, section: MachineSection) => ReactNode): ReactNode {
    if (!showCloudGroup) return null;
    return (
      <div className="ade-cx-section" data-machine-group="cloud">
        <CloudGroupHead boxes={cloudGroupBoxes} loading={cloudMachines.loading} />
        <CloudGroupBanners
          result={cloudResult}
          loadError={cloudMachines.loadError}
          onRetry={cloudMachines.refresh}
          onOpenSettings={onOpenSettings}
        />
        {cloudGroupBoxes.length > 0 ? (
          <div className="ade-cx-list">
            {cloudRows.map(({ row, section }) => renderRow(row, section))}
            {looseBoxes.map((box) => {
              const ctx = boxContext(box, null);
              return (
                <CloudBoxOnlyRow
                  key={`cloud:${box.instanceId}`}
                  box={box}
                  accountKnown={accountKnown}
                  actions={cloudActions.actionsFor(ctx, () => undefined)}
                  strip={boxStrip(ctx, true)}
                />
              );
            })}
          </div>
        ) : null}
        {cloudActions.dialog}
      </div>
    );
  }


  return {
    rowExtrasFor,
    /** The list's sections without the rows that moved to the group. */
    listedSections,
    showGroup: showCloudGroup,
    renderGroup,
  };
}
