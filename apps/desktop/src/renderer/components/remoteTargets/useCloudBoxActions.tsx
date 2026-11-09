import { useCallback, useRef, useState, type ReactNode } from "react";
import { ArrowClockwise, ArrowsOutSimple, ArrowsLeftRight, CloudArrowUp, Copy, Moon, MoonStars, PlugsConnected, Sun, Trash, UserMinus } from "@phosphor-icons/react";
import {
  CLOUD_SHAPES,
  cloudHoursRate,
  formatCloudHoursRate,
  type CloudMachine,
  type CloudMachineActionKind,
  type CloudMachineActionResult,
  type CloudShapeId,
} from "../../../shared/adeCloud";
import { accountMachineDisplayName, accountMachineRemovalConfirmBody } from "../../../shared/accountDirectory";
import { captureError } from "../../../shared/sentry/capture";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { AttentionItem } from "../../../shared/types/attention";
import { showToast } from "../app/toast/toastStore";
import { confirmDialog, Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";
import { cloudBoxWork, type CloudBoxWork } from "./cloudMachineModel";
import type { MachineAction } from "./MachineActionsMenu";

/** What one box is doing in the list right now, shown on its card. */
export type CloudBoxPending = CloudMachineActionKind | "remove" | "copy" | "move" | "reconnect";

export type CloudBoxActionError = {
  message: string;
  blocker: CloudMachineActionResult["blocker"];
};

/** One box's context in the list: its ADE row (if it has one) and what runs on it. */
export type CloudBoxContext = {
  box: CloudMachine;
  name: string;
  /** The account row the box is, or null for a box not (or no longer) in ADE. */
  accountMachine: AdeAccountMachine | null;
  /** This computer's saved connection to it, removed with it. */
  targetId: string | null;
  work: CloudBoxWork;
  /** The account list was read, so a null `accountMachine` really means "not in ADE". */
  accountKnown: boolean;
};

/**
 * A box's context from its account row (if any): the row's name wins, then
 * the provider's name, then the instance id. `name` overrides it (a saved
 * connection's own name).
 */
export function cloudBoxContext(args: {
  box: CloudMachine;
  accountMachine: AdeAccountMachine | null;
  targetId: string | null;
  activityItems: readonly AttentionItem[];
  accountKnown: boolean;
  name?: string | null;
}): CloudBoxContext {
  const { box, accountMachine } = args;
  return {
    box,
    name: args.name ?? (accountMachine ? accountMachineDisplayName(accountMachine) : null) ?? (box.name?.trim() || box.instanceId),
    accountMachine,
    targetId: args.targetId,
    work: cloudBoxWork(accountMachine, args.activityItems),
    accountKnown: args.accountKnown,
  };
}

const PENDING_LABELS: Record<CloudBoxPending, string> = {
  sleep: "Putting it to sleep…",
  wake: "Waking it…",
  resize: "Resizing. The box restarts…",
  backup: "Backing up. On a big disk this takes a few minutes…",
  delete: "Deleting the computer…",
  update: "Updating. It restarts…",
  remove: "Removing it from ADE…",
  copy: "Copying it into a new machine. A big disk takes a few minutes…",
  move: "Moving it: a new machine, then every file copied over…",
  reconnect: "Signing it back in to your account…",
};

export function cloudPendingLabel(pending: CloudBoxPending): string {
  return PENDING_LABELS[pending];
}

function chatsLine(count: number, name: string): string {
  return `${count === 1 ? "A chat is" : `${count} chats are`} running on ${name}.`;
}

/**
 * Sleep, wake, resize, back up, Remove from ADE and Delete box for the
 * the ADE Cloud group, with the confirmations each one needs.
 *
 * The box actions go to ADE Cloud through this desktop's main
 * process, and Remove from ADE to the account directory; both are account
 * level, so nothing here takes a pin.
 */
export function useCloudBoxActions(args: {
  /** Read the boxes again (state, spend). */
  refresh: () => void;
  /** Read the account's machines again. */
  onAccountChanged?: () => void;
  /** Forget this computer's saved connection to a machine that left ADE. */
  forgetTarget: (targetId: string) => Promise<void>;
}) {
  const { refresh, onAccountChanged, forgetTarget } = args;
  const [pendingById, setPendingById] = useState<Record<string, CloudBoxPending>>({});
  const [errorById, setErrorById] = useState<Record<string, CloudBoxActionError>>({});
  const [resizing, setResizing] = useState<CloudBoxContext | null>(null);

  const setPending = useCallback((instanceId: string, pending: CloudBoxPending | null) => {
    setPendingById((current) => {
      const next = { ...current };
      if (pending) next[instanceId] = pending;
      else delete next[instanceId];
      return next;
    });
  }, []);
  const setError = useCallback((instanceId: string, error: CloudBoxActionError | null) => {
    setErrorById((current) => {
      if (!error && !(instanceId in current)) return current;
      const next = { ...current };
      if (error) next[instanceId] = error;
      else delete next[instanceId];
      return next;
    });
  }, []);

  const run = useCallback(async (
    ctx: CloudBoxContext,
    action: CloudMachineActionKind,
    extra: { shape?: CloudShapeId } = {},
  ): Promise<CloudMachineActionResult | null> => {
    const machineAction = window.ade?.cloud?.machineAction;
    if (!machineAction) return null;
    const { instanceId } = ctx.box;
    setPending(instanceId, action);
    setError(instanceId, null);
    let result: CloudMachineActionResult | null;
    try {
      result = await machineAction({
        instanceId,
        action,
        ...extra,
        ...(action === "delete" ? { machineKey: ctx.accountMachine?.machineKey ?? null } : {}),
      });
    } catch (error) {
      // the provider's refusals come back as results; a throw is the IPC itself.
      captureError(error, { fingerprint: ["cloud", "machine_action_ipc"], handled: true });
      result = { ok: false, blocker: null, message: extractError(error) };
    } finally {
      setPending(instanceId, null);
    }
    if (!result) return null;
    if (result.ok) {
      showToast({ tone: "success", title: toastTitle(action, ctx.name), message: result.message, replayMask: { title: true } });
    } else {
      setError(instanceId, { message: result.message, blocker: result.blocker });
    }
    refresh();
    return result;
  }, [refresh, setError, setPending]);

  const sleep = useCallback(async (ctx: CloudBoxContext) => {
    if (ctx.work.runningChats > 0) {
      const ok = await confirmDialog({
        title: `Sleep ${ctx.name}?`,
        message: `${chatsLine(ctx.work.runningChats, ctx.name)} Sleep freezes everything on it, so a turn in progress may fail and need a retry after it wakes. It uses no hours while asleep.`,
        confirmLabel: "Sleep",
      });
      if (!ok) return;
    }
    await run(ctx, "sleep");
  }, [run]);

  const deleteBox = useCallback(async (ctx: CloudBoxContext) => {
    const ok = await confirmDialog({
      title: `Delete ${ctx.name}?`,
      message: `ADE deletes ${ctx.name} on ADE Cloud and removes it from your computers. Everything on its disk is gone for good: repos, lanes, and any work you have not pushed.`,
      children: ctx.work.runningChats > 0
        ? <Banner layout="inline" model={{ id: "cloud-delete-running", tone: "warning", title: `${chatsLine(ctx.work.runningChats, ctx.name)} They stop for good.` }} />
        : undefined,
      confirmLabel: "Delete computer",
      destructive: true,
      size: "md",
    });
    if (!ok) return;
    const result = await run(ctx, "delete");
    if (result?.ok) {
      if (ctx.targetId) {
        await forgetTarget(ctx.targetId).catch((error: unknown) =>
          captureError(error, { fingerprint: ["cloud", "forget_deleted_target"], handled: true }));
      }
      onAccountChanged?.();
    }
  }, [forgetTarget, onAccountChanged, run]);

  // Machine keys with a removal running (its confirmation included), so a second click starts nothing.
  const removing = useRef(new Set<string>());
  /**
   * Remove from ADE: the account row goes (on every computer), and this
   * computer's saved connection with it. Any machine can be removed; a
   * cloud computer keeps running, and the confirmation says it keeps using hours.
   */
  const removeFromAde = useCallback(async (input: {
    machine: AdeAccountMachine;
    name: string;
    targetId: string | null;
    box: CloudMachine | null;
    /** The row is a box deleted on the provider site: only its ADE entry is left. */
    deletedOnCloud?: boolean;
    onError: (message: string) => void;
  }) => {
    const key = input.machine.machineKey;
    if (removing.current.has(key)) return;
    removing.current.add(key);
    try {
      const message = input.box
        ? `${input.name} leaves your computers on every device. The computer stays on ADE Cloud and uses hours whenever it's awake. To remove it for good, use Delete computer instead.`
        : input.deletedOnCloud
          ? `${input.name} was deleted on ADE Cloud, so it no longer exists. This removes its entry from your computers on every device.`
          : `${input.name} leaves your computers on every device.\n\n${accountMachineRemovalConfirmBody(input.machine)}`;
      const ok = await confirmDialog({
        title: `Remove ${input.name} from ADE?`,
        message: <span style={{ whiteSpace: "pre-line" }}>{message}</span>,
        confirmLabel: "Remove from ADE",
        destructive: true,
        size: "md",
      });
      if (!ok) return;
      const removeMachine = window.ade?.account?.removeMachine;
      if (!removeMachine) return;
      if (input.box) setPending(input.box.instanceId, "remove");
      try {
        await removeMachine(input.machine.machineKey);
        if (input.targetId) {
          await forgetTarget(input.targetId).catch((error: unknown) =>
            captureError(error, { fingerprint: ["cloud", "forget_removed_target"], handled: true }));
        }
        showToast({
          tone: "success",
          title: `Removed ${input.name} from ADE`,
          message: input.box ? "It still runs on ADE Cloud. Delete computer removes it for good." : undefined,
          replayMask: { title: true },
        });
      } catch (error) {
        captureError(error, { fingerprint: ["cloud", "remove_from_ade"], handled: true });
        input.onError(extractError(error));
      } finally {
        if (input.box) setPending(input.box.instanceId, null);
        onAccountChanged?.();
        refresh();
      }
    } finally {
      removing.current.delete(key);
    }
  }, [forgetTarget, onAccountChanged, refresh, setPending]);

  /**
   * Copy, Move and Reconnect run for minutes in the main process and report
   * like a create; the card shows the step meanwhile and a toast says how it
   * ended.
   */
  const runLong = useCallback(async (ctx: CloudBoxContext, kind: "copy" | "move" | "reconnect", start: (requestId: string) => Promise<{ started: boolean }>) => {
    const bridge = window.ade?.cloud;
    if (!bridge?.onCreateProgress) return;
    const requestId = `${kind}-${ctx.box.instanceId}-${Date.now()}`;
    const { instanceId } = ctx.box;
    setPending(instanceId, kind);
    setError(instanceId, null);
    const off = bridge.onCreateProgress((progress) => {
      if (progress.requestId !== requestId) return;
      if (progress.stage === "done") {
        off();
        setPending(instanceId, null);
        showToast({ tone: "success", title: kind === "copy" ? `Copied ${ctx.name}` : kind === "move" ? `Moved ${ctx.name}` : `Reconnected ${ctx.name}`, message: progress.message, replayMask: { title: true } });
        refresh();
        onAccountChanged?.();
      } else if (progress.stage === "failed") {
        off();
        setPending(instanceId, null);
        setError(instanceId, { message: progress.error ?? progress.message, blocker: null });
        refresh();
      }
    });
    try {
      const started = await start(requestId);
      if (!started.started) throw new Error("ADE couldn't start that.");
    } catch (error) {
      off();
      setPending(instanceId, null);
      setError(instanceId, { message: extractError(error), blocker: null });
    }
  }, [onAccountChanged, refresh, setError, setPending]);

  const copyBox = useCallback(async (ctx: CloudBoxContext) => {
    const copyMachine = window.ade.cloud?.copyMachine;
    if (!copyMachine) return;
    const rate = ctx.box.hoursRate != null ? formatCloudHoursRate(ctx.box.hoursRate) : null;
    const ok = await confirmDialog({
      title: `Copy ${ctx.name}?`,
      message: `ADE makes a new computer with the same files (repos, lanes, installed dependencies) and signs it in as a new computer${rate ? `. It uses ${rate} while awake` : ""}. A big disk takes a few minutes.`,
      confirmLabel: "Copy",
    });
    if (!ok) return;
    await runLong(ctx, "copy", (requestId) => copyMachine({ requestId, instanceId: ctx.box.instanceId, name: `${ctx.name} copy` }));
  }, [runLong]);

  const updateBox = useCallback(async (ctx: CloudBoxContext) => {
    const ok = await confirmDialog({
      title: `Update ${ctx.name}?`,
      message: `${ctx.name} restarts on the current ADE. Its files and repos stay; running chats, terminals and processes stop.`,
      confirmLabel: "Update",
    });
    if (ok) await run(ctx, "update");
  }, [run]);

  const moveBox = useCallback(async (ctx: CloudBoxContext) => {
    const moveMachine = window.ade.cloud?.moveMachine;
    if (!moveMachine) return;
    const to = ctx.box.type === "vm" ? "box" : "vm";
    const ok = await confirmDialog({
      title: to === "vm" ? `Move ${ctx.name} to a full computer?` : `Move ${ctx.name} to a standard computer?`,
      message: to === "vm"
        ? `ADE makes a full computer (Android and Docker, about 2.5× the hours), copies every repo, lane and chat on ${ctx.name} into it, then deletes ${ctx.name}. Running processes stop.`
        : `ADE makes a standard computer, copies every repo, lane and chat on ${ctx.name} into it, then deletes ${ctx.name}. Docker images and volumes stay behind, and running processes stop.`,
      confirmLabel: "Move",
      destructive: true,
      size: "md",
    });
    if (!ok) return;
    await runLong(ctx, "move", (requestId) => moveMachine({
      requestId,
      instanceId: ctx.box.instanceId,
      machineKey: ctx.accountMachine?.machineKey ?? null,
      to,
    }));
  }, [runLong]);

  /**
   * Reconnect: a box removed from ADE keeps its files and identity, and its
   * ADE refuses the account until it is signed in again. ADE does that on the
   * box and approves it with this computer's account; it comes back as the
   * same machine under Your computers.
   */
  const reconnectBox = useCallback(async (ctx: CloudBoxContext) => {
    const reconnectMachine = window.ade.cloud?.reconnectMachine;
    if (!reconnectMachine) return;
    await runLong(ctx, "reconnect", (requestId) => reconnectMachine({ requestId, instanceId: ctx.box.instanceId }));
  }, [runLong]);

  /** The ⋯ menu items for a box, after the row's own (Rename, Test…). */
  const actionsFor = useCallback((ctx: CloudBoxContext, onAccountError: (message: string) => void): MachineAction[] => {
    const { box } = ctx;
    const busy = pendingById[box.instanceId] != null;
    const suspended = box.pastDue;
    const items: MachineAction[] = [];
    if (box.state === "running") {
      items.push({ key: "cloud-sleep", label: "Sleep", icon: <Moon size={14} />, disabled: busy, onSelect: () => void sleep(ctx) });
    }
    if ((box.state === "asleep" || box.state === "stopped") && !suspended) {
      items.push({
        key: "cloud-wake",
        label: box.state === "stopped" ? "Start" : "Wake",
        icon: <Sun size={14} />,
        disabled: busy,
        onSelect: () => void run(ctx, "wake"),
      });
    }
    if (box.state === "running" && box.resources) {
      items.push({ key: "cloud-resize", label: "Resize…", icon: <ArrowsOutSimple size={14} />, disabled: busy, onSelect: () => setResizing(ctx) });
    }
    if (box.madeByAde && box.machineKey && (box.state === "running" || box.state === "asleep" || box.state === "stopped")) {
      items.push({ key: "cloud-copy", label: "Copy…", icon: <Copy size={14} />, disabled: busy, onSelect: () => void copyBox(ctx) });
      items.push({
        key: "cloud-move",
        label: box.type === "vm" ? "Move to a standard computer…" : "Move to a full computer…",
        icon: <ArrowsLeftRight size={14} />,
        disabled: busy,
        onSelect: () => void moveBox(ctx),
      });
    }
    if (box.madeByAde && (box.state === "running" || box.state === "asleep" || box.state === "stopped")) {
      items.push({ key: "cloud-update", label: "Update this computer", icon: <ArrowClockwise size={14} />, disabled: busy, onSelect: () => void updateBox(ctx) });
    }
    if (box.state === "running" || box.state === "asleep" || box.state === "stopped") {
      items.push({ key: "cloud-backup", label: "Back up now", icon: <CloudArrowUp size={14} />, disabled: busy, onSelect: () => void run(ctx, "backup") });
    }
    // A box that joined once (it carries its machine key) and left the account.
    if (ctx.accountKnown && !ctx.accountMachine && box.machineKey && !suspended && window.ade?.cloud?.reconnectMachine
      && (box.state === "running" || box.state === "asleep" || box.state === "stopped")) {
      items.push({ key: "cloud-reconnect", label: "Reconnect to ADE", icon: <PlugsConnected size={14} />, disabled: busy, onSelect: () => void reconnectBox(ctx) });
    }
    if (ctx.accountMachine) {
      const accountMachine = ctx.accountMachine;
      items.push({
        key: "cloud-remove",
        label: "Remove from ADE",
        ariaLabel: `Remove ${ctx.name} from ADE`,
        icon: <UserMinus size={14} />,
        danger: true,
        disabled: busy,
        onSelect: () => void removeFromAde({ machine: accountMachine, name: ctx.name, targetId: ctx.targetId, box, onError: onAccountError }),
      });
    }
    items.push({
      key: "cloud-delete",
      label: "Delete computer",
      ariaLabel: `Delete ${ctx.name} on ADE Cloud`,
      icon: <Trash size={14} />,
      danger: true,
      disabled: busy || box.state === "deleting",
      onSelect: () => void deleteBox(ctx),
    });
    return items;
  }, [copyBox, deleteBox, moveBox, pendingById, reconnectBox, removeFromAde, run, sleep, updateBox]);

  const dialog: ReactNode = resizing ? (
    <CloudResizeDialog
      ctx={resizing}
      onCancel={() => setResizing(null)}
      onResize={(shape) => {
        const ctx = resizing;
        setResizing(null);
        void run(ctx, "resize", { shape });
      }}
    />
   ) : null;

  return {
    pendingById,
    errorById,
    dismissError: (instanceId: string) => setError(instanceId, null),
    actionsFor,
    wake: (ctx: CloudBoxContext) => run(ctx, "wake"),
    removeFromAde,
    dialog,
  };
}

function toastTitle(action: CloudMachineActionKind, name: string): string {
  switch (action) {
    case "sleep":
      return `${name} is asleep`;
    case "wake":
      return `${name} is waking`;
    case "resize":
      return `Resized ${name}`;
    case "backup":
      return `Backed up ${name}`;
    case "delete":
      return `Deleted ${name}`;
    case "update":
      return `Updating ${name}`;
  }
}

/**
 * Pick a new size. The box restarts to change it: files stay, running work
 * stops. Said plainly every time, and louder when Activity shows chats running.
 */
function CloudResizeDialog({
  ctx,
  onCancel,
  onResize,
}: {
  ctx: CloudBoxContext;
  onCancel: () => void;
  onResize: (shape: CloudShapeId) => void;
}) {
  const { box, name, work } = ctx;
  const current = box.shapeId;
  const [picked, setPicked] = useState<CloudShapeId | null>(null);
  const choice = picked ?? CLOUD_SHAPES.find((shape) => shape.id !== current)?.id ?? null;
  const kind = box.type === "vm" ? "vm" : "box";
  const running = work.runningChats > 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title={`Resize ${name}`}
      description={`${name} restarts to change size. Its files stay; running chats, terminals and processes stop, and ADE on it starts again in a few seconds.`}
      size="sm"
      actions={[
        {
          label: running ? "Resize anyway" : "Resize",
          onClick: () => { if (choice) onResize(choice); },
          disabled: !choice || choice === current,
          autoFocus: true,
        },
        { label: "Cancel", onClick: onCancel, variant: "secondary" },
      ]}
    >
      <div style={{ display: "grid", gap: 10 }}>
        {running ? (
          <Banner layout="inline" model={{ id: "cloud-resize-running", tone: "warning", title: chatsLine(work.runningChats, name), detail: "Resizing stops them. Wait for them to finish, or resize anyway." }} />
        ) : null}
        <div role="radiogroup" aria-label="Size" className="ade-cx-cloud-shapes">
          {CLOUD_SHAPES.map((shape) => {
            const rate = formatCloudHoursRate(cloudHoursRate(kind, shape.id));
            const isCurrent = shape.id === current;
            return (
              <button
                key={shape.id}
                type="button"
                role="radio"
                aria-checked={shape.id === choice}
                className="ade-cx-cloud-shape"
                data-current={isCurrent ? "true" : undefined}
                onClick={() => setPicked(shape.id)}
              >
                <span className="ade-cx-cloud-shape-size kit-num">{shape.label} · {shape.cpu} CPU · {shape.memoryGb} GB</span>
                <span className="ade-cx-cloud-shape-price kit-num">{rate}</span>
                {isCurrent ? <span className="kit-tag">Now</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
