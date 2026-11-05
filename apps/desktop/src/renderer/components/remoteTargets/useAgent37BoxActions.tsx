import { useCallback, useState, type ReactNode } from "react";
import { ArrowsOutSimple, ArrowsLeftRight, CloudArrowUp, Copy, Moon, MoonStars, Sun, Trash, UserMinus } from "@phosphor-icons/react";
import {
  AGENT37_DEFAULT_SLEEP_AFTER_MINUTES,
  AGENT37_SHAPES,
  AGENT37_SLEEP_AFTER_CHOICES,
  agent37RunningHourlyUsd,
  formatAgent37HourlyPrice,
  type Agent37Machine,
  type Agent37MachineActionKind,
  type Agent37MachineActionResult,
  type Agent37ShapeId,
} from "../../../shared/agent37";
import { accountMachineRemovalConfirmBody } from "../../../shared/accountDirectory";
import { captureError } from "../../../shared/sentry/capture";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { showToast } from "../app/toast/toastStore";
import { confirmDialog, Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";
import { describeAgent37Rate, type Agent37BoxWork } from "./agent37MachineModel";
import type { MachineAction } from "./MachineActionsMenu";

/** What one box is doing in the list right now, shown on its card. */
export type Agent37BoxPending = Agent37MachineActionKind | "remove" | "copy" | "move";

export type Agent37BoxActionError = {
  message: string;
  blocker: Agent37MachineActionResult["blocker"];
};

/** One box's context in the list: its ADE row (if it has one) and what runs on it. */
export type Agent37BoxContext = {
  box: Agent37Machine;
  name: string;
  /** The account row the box is, or null for a box not (or no longer) in ADE. */
  accountMachine: AdeAccountMachine | null;
  /** This computer's saved connection to it, removed with it. */
  targetId: string | null;
  work: Agent37BoxWork;
};

const PENDING_LABELS: Record<Agent37BoxPending, string> = {
  sleep: "Putting it to sleep…",
  wake: "Waking it…",
  resize: "Resizing. The box restarts…",
  backup: "Backing up. On a big disk this takes a few minutes…",
  delete: "Deleting the box…",
  remove: "Removing it from ADE…",
  set_sleep: "Changing how it sleeps…",
  copy: "Copying it into a new machine. A big disk takes a few minutes…",
  move: "Moving it: a new machine, then every file copied over…",
};

export function agent37PendingLabel(pending: Agent37BoxPending): string {
  return PENDING_LABELS[pending];
}

function chatsLine(count: number, name: string): string {
  return `${count === 1 ? "A chat is" : `${count} chats are`} running on ${name}.`;
}

/**
 * Sleep, wake, resize, back up, Remove from ADE and Delete box for the
 * Agent37 group, with the confirmations each one needs.
 *
 * The box actions go to the Agent37 workspace through this desktop's main
 * process, and Remove from ADE to the account directory; both are account
 * level, so nothing here takes a pin.
 */
export function useAgent37BoxActions(args: {
  /** Read the boxes again (state, spend). */
  refresh: () => void;
  /** Read the account's machines again. */
  onAccountChanged?: () => void;
  /** Forget this computer's saved connection to a machine that left ADE. */
  forgetTarget: (targetId: string) => Promise<void>;
  /** The workspace tier: 0 (before the first top-up) allows only the smallest size. */
  tier: number | null;
}) {
  const { refresh, onAccountChanged, forgetTarget, tier } = args;
  const [pendingById, setPendingById] = useState<Record<string, Agent37BoxPending>>({});
  const [errorById, setErrorById] = useState<Record<string, Agent37BoxActionError>>({});
  const [resizing, setResizing] = useState<Agent37BoxContext | null>(null);
  const [sleepSetting, setSleepSetting] = useState<Agent37BoxContext | null>(null);

  const setPending = useCallback((instanceId: string, pending: Agent37BoxPending | null) => {
    setPendingById((current) => {
      const next = { ...current };
      if (pending) next[instanceId] = pending;
      else delete next[instanceId];
      return next;
    });
  }, []);
  const setError = useCallback((instanceId: string, error: Agent37BoxActionError | null) => {
    setErrorById((current) => {
      if (!error && !(instanceId in current)) return current;
      const next = { ...current };
      if (error) next[instanceId] = error;
      else delete next[instanceId];
      return next;
    });
  }, []);

  const run = useCallback(async (
    ctx: Agent37BoxContext,
    action: Agent37MachineActionKind,
    extra: { shape?: Agent37ShapeId; sleepAfterMinutes?: number | null } = {},
  ): Promise<Agent37MachineActionResult | null> => {
    const machineAction = window.ade?.agent37?.machineAction;
    if (!machineAction) return null;
    const { instanceId } = ctx.box;
    setPending(instanceId, action);
    setError(instanceId, null);
    let result: Agent37MachineActionResult | null;
    try {
      result = await machineAction({
        instanceId,
        action,
        ...extra,
        ...(action === "delete" ? { machineKey: ctx.accountMachine?.machineKey ?? null } : {}),
      });
    } catch (error) {
      // Agent 37's refusals come back as results; a throw is the IPC itself.
      captureError(error, { fingerprint: ["agent37", "machine_action_ipc"], handled: true });
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

  const sleep = useCallback(async (ctx: Agent37BoxContext) => {
    if (ctx.work.runningChats > 0) {
      const ok = await confirmDialog({
        title: `Sleep ${ctx.name}?`,
        message: `${chatsLine(ctx.work.runningChats, ctx.name)} Sleep freezes everything on the box, so a turn in progress may fail and need a retry after it wakes. Until then, only its disk bills.`,
        confirmLabel: "Sleep",
      });
      if (!ok) return;
    }
    await run(ctx, "sleep");
  }, [run]);

  const deleteBox = useCallback(async (ctx: Agent37BoxContext) => {
    const ok = await confirmDialog({
      title: `Delete ${ctx.name}?`,
      message: `ADE deletes ${ctx.name} on Agent 37 and removes it from your computers. Everything on its disk is gone for good: repos, lanes, and any work you have not pushed. Agent 37 stops billing for it.`,
      children: ctx.work.runningChats > 0
        ? <Banner layout="inline" model={{ id: "agent37-delete-running", tone: "warning", title: `${chatsLine(ctx.work.runningChats, ctx.name)} They stop for good.` }} />
        : undefined,
      confirmLabel: "Delete box",
      destructive: true,
      size: "md",
    });
    if (!ok) return;
    const result = await run(ctx, "delete");
    if (result?.ok) {
      if (ctx.targetId) {
        await forgetTarget(ctx.targetId).catch((error: unknown) =>
          captureError(error, { fingerprint: ["agent37", "forget_deleted_target"], handled: true }));
      }
      onAccountChanged?.();
    }
  }, [forgetTarget, onAccountChanged, run]);

  /**
   * Remove from ADE: the account row goes (on every computer), and this
   * computer's saved connection with it. Any machine can be removed; an
   * Agent37 box keeps running, and the confirmation says it keeps billing.
   */
  const removeFromAde = useCallback(async (input: {
    machine: AdeAccountMachine;
    name: string;
    targetId: string | null;
    box: Agent37Machine | null;
    onError: (message: string) => void;
  }) => {
    const rate = input.box && !input.box.pastDue ? describeAgent37Rate(input.box) : null;
    const message = input.box
      ? `${input.name} leaves your computers on every device. The box stays on Agent 37 and keeps billing${rate ? ` (${rate})` : ""}. To stop the bill, use Delete box instead.`
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
          captureError(error, { fingerprint: ["agent37", "forget_removed_target"], handled: true }));
      }
      showToast({
        tone: "success",
        title: `Removed ${input.name} from ADE`,
        message: input.box ? "It still runs on Agent 37. Delete box stops the bill." : undefined,
        replayMask: { title: true },
      });
    } catch (error) {
      captureError(error, { fingerprint: ["agent37", "remove_from_ade"], handled: true });
      input.onError(extractError(error));
    } finally {
      if (input.box) setPending(input.box.instanceId, null);
      onAccountChanged?.();
      refresh();
    }
  }, [forgetTarget, onAccountChanged, refresh, setPending]);

  /**
   * Copy and Move run for minutes in the main process and report like a
   * create; the card shows the step meanwhile and a toast says how it ended.
   */
  const runLong = useCallback(async (ctx: Agent37BoxContext, kind: "copy" | "move", start: (requestId: string) => Promise<{ started: boolean }>) => {
    const bridge = window.ade?.agent37;
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
        showToast({ tone: "success", title: kind === "copy" ? `Copied ${ctx.name}` : `Moved ${ctx.name}`, message: progress.message, replayMask: { title: true } });
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

  const copyBox = useCallback(async (ctx: Agent37BoxContext) => {
    const rate = describeAgent37Rate({ ...ctx.box, state: "running" });
    const ok = await confirmDialog({
      title: `Copy ${ctx.name}?`,
      message: `ADE makes a new machine with the same files (repos, lanes, installed dependencies) and signs it in as a new computer${rate ? `. It bills ${rate} while awake` : ""}. A big disk takes a few minutes.`,
      confirmLabel: "Copy",
    });
    if (!ok) return;
    await runLong(ctx, "copy", (requestId) => window.ade.agent37!.copyMachine!({ requestId, instanceId: ctx.box.instanceId, name: `${ctx.name} copy` }));
  }, [runLong]);

  const moveBox = useCallback(async (ctx: Agent37BoxContext) => {
    const to = ctx.box.type === "vm" ? "box" : "vm";
    const ok = await confirmDialog({
      title: `Move ${ctx.name} to a ${to === "vm" ? "VM" : "box"}?`,
      message: to === "vm"
        ? `ADE makes a VM (Docker and Android, about 2.5 times the price), copies every repo, lane and chat on ${ctx.name} into it, then deletes ${ctx.name}. Running processes stop.`
        : `ADE makes a box, copies every repo, lane and chat on ${ctx.name} into it, then deletes ${ctx.name}. Docker images and volumes stay behind, and running processes stop.`,
      confirmLabel: "Move",
      destructive: true,
      size: "md",
    });
    if (!ok) return;
    await runLong(ctx, "move", (requestId) => window.ade.agent37!.moveMachine!({
      requestId,
      instanceId: ctx.box.instanceId,
      machineKey: ctx.accountMachine?.machineKey ?? null,
      to,
    }));
  }, [runLong]);

  /** The ⋯ menu items for a box, after the row's own (Rename, Test…). */
  const actionsFor = useCallback((ctx: Agent37BoxContext, onAccountError: (message: string) => void): MachineAction[] => {
    const { box } = ctx;
    const busy = pendingById[box.instanceId] != null;
    const suspended = box.pastDue;
    const items: MachineAction[] = [];
    if (box.state === "running") {
      items.push({ key: "a37-sleep", label: "Sleep", icon: <Moon size={14} />, disabled: busy, onSelect: () => void sleep(ctx) });
    }
    if ((box.state === "asleep" || box.state === "stopped") && !suspended) {
      items.push({
        key: "a37-wake",
        label: box.state === "stopped" ? "Start" : "Wake",
        icon: <Sun size={14} />,
        disabled: busy,
        onSelect: () => void run(ctx, "wake"),
      });
    }
    if (box.state === "running" && box.resources) {
      items.push({ key: "a37-resize", label: "Resize…", icon: <ArrowsOutSimple size={14} />, disabled: busy, onSelect: () => setResizing(ctx) });
    }
    if (box.madeByAde && box.machineKey && (box.state === "running" || box.state === "asleep" || box.state === "stopped")) {
      items.push({ key: "a37-copy", label: "Copy…", icon: <Copy size={14} />, disabled: busy, onSelect: () => void copyBox(ctx) });
      items.push({
        key: "a37-move",
        label: box.type === "vm" ? "Move to a box…" : "Move to a VM…",
        icon: <ArrowsLeftRight size={14} />,
        disabled: busy,
        onSelect: () => void moveBox(ctx),
      });
    }
    if (box.madeByAde && (box.state === "running" || box.state === "asleep")) {
      items.push({ key: "a37-sleep-after", label: "Sleep when idle…", icon: <MoonStars size={14} />, disabled: busy, onSelect: () => setSleepSetting(ctx) });
    }
    if (box.state === "running" || box.state === "asleep" || box.state === "stopped") {
      items.push({ key: "a37-backup", label: "Back up now", icon: <CloudArrowUp size={14} />, disabled: busy, onSelect: () => void run(ctx, "backup") });
    }
    if (ctx.accountMachine) {
      const accountMachine = ctx.accountMachine;
      items.push({
        key: "a37-remove",
        label: "Remove from ADE",
        ariaLabel: `Remove ${ctx.name} from ADE`,
        icon: <UserMinus size={14} />,
        danger: true,
        disabled: busy,
        onSelect: () => void removeFromAde({ machine: accountMachine, name: ctx.name, targetId: ctx.targetId, box, onError: onAccountError }),
      });
    }
    items.push({
      key: "a37-delete",
      label: "Delete box",
      ariaLabel: `Delete ${ctx.name} on Agent 37`,
      icon: <Trash size={14} />,
      danger: true,
      disabled: busy || box.state === "deleting",
      onSelect: () => void deleteBox(ctx),
    });
    return items;
  }, [copyBox, deleteBox, moveBox, pendingById, removeFromAde, run, sleep]);

  const dialog: ReactNode = resizing ? (
    <Agent37ResizeDialog
      ctx={resizing}
      smallestOnly={tier === 0}
      onCancel={() => setResizing(null)}
      onResize={(shape) => {
        const ctx = resizing;
        setResizing(null);
        void run(ctx, "resize", { shape });
      }}
    />
  ) : sleepSetting ? (
    <Agent37SleepDialog
      ctx={sleepSetting}
      onCancel={() => setSleepSetting(null)}
      onSave={(minutes) => {
        const ctx = sleepSetting;
        setSleepSetting(null);
        void run(ctx, "set_sleep", { sleepAfterMinutes: minutes });
      }}
    />
  ) : null;

  return {
    pendingById,
    errorById,
    dismissError: (instanceId: string) => setError(instanceId, null),
    actionsFor,
    wake: (ctx: Agent37BoxContext) => run(ctx, "wake"),
    removeFromAde,
    dialog,
  };
}

function toastTitle(action: Agent37MachineActionKind, name: string): string {
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
    case "set_sleep":
      return `${name}'s sleep changed`;
  }
}

/**
 * How long a box waits with nothing running before Agent 37 puts it to sleep.
 * ADE on the box keeps it awake while a chat, a command or a setup runs, so a
 * short wait costs nothing in interruptions; opening a lane or sending to a
 * chat there wakes it in about a second.
 */
function Agent37SleepDialog({
  ctx,
  onCancel,
  onSave,
}: {
  ctx: Agent37BoxContext;
  onCancel: () => void;
  onSave: (minutes: number | null) => void;
}) {
  const { box, name } = ctx;
  const current = box.sleep.state === "auto" ? box.sleep.afterMinutes : box.sleep.state === "never" ? null : undefined;
  const [picked, setPicked] = useState<number | null | undefined>(current ?? AGENT37_DEFAULT_SLEEP_AFTER_MINUTES);
  const choices: Array<{ value: number | null; label: string }> = [
    ...AGENT37_SLEEP_AFTER_CHOICES.map((minutes) => ({ value: minutes as number | null, label: minutes < 60 ? `${minutes} min` : "1 hour" })),
    { value: null, label: "Never" },
  ];
  const hourly = box.runningHourlyUsd != null ? formatAgent37HourlyPrice(box.runningHourlyUsd) : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title={`Sleep ${name} when idle`}
      description="It sleeps once nothing has run on it for this long. A running chat, command or setup keeps it awake, and opening one of its lanes wakes it in about a second."
      size="sm"
      actions={[
        { label: "Save", onClick: () => { if (picked !== undefined) onSave(picked); }, disabled: picked === undefined || picked === current, autoFocus: true },
        { label: "Cancel", onClick: onCancel, variant: "secondary" },
      ]}
    >
      <div style={{ display: "grid", gap: 10 }}>
        <div role="radiogroup" aria-label="Sleep after" className="ade-cx-a37-shapes">
          {choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="radio"
              aria-checked={choice.value === picked}
              className="ade-cx-a37-shape"
              data-current={choice.value === current ? "true" : undefined}
              onClick={() => setPicked(choice.value)}
            >
              <span className="ade-cx-a37-shape-size kit-num">{choice.label}</span>
              {choice.value === current ? <span className="kit-tag">Now</span> : null}
            </button>
          ))}
        </div>
        {picked === null && hourly ? (
          <p className="ade-cx-a37-note">It bills {hourly} around the clock until you sleep it.</p>
        ) : null}
        {box.sleep.state === "pending" ? (
          <p className="ade-cx-a37-note">ADE wakes it for a moment to set this up.</p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Pick a new size. The box restarts to change it: files stay, running work
 * stops. Said plainly every time, and louder when Activity shows chats running.
 */
function Agent37ResizeDialog({
  ctx,
  smallestOnly,
  onCancel,
  onResize,
}: {
  ctx: Agent37BoxContext;
  smallestOnly: boolean;
  onCancel: () => void;
  onResize: (shape: Agent37ShapeId) => void;
}) {
  const { box, name, work } = ctx;
  const current = box.shapeId;
  const [picked, setPicked] = useState<Agent37ShapeId | null>(null);
  const allowed = (id: Agent37ShapeId) => !smallestOnly || id === "2x4";
  const choice = picked ?? AGENT37_SHAPES.find((shape) => shape.id !== current && allowed(shape.id))?.id ?? null;
  const target = AGENT37_SHAPES.find((shape) => shape.id === choice) ?? null;
  const keepsDisk = target && box.resources && target.diskGb < box.resources.diskGb;
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
          <Banner layout="inline" model={{ id: "agent37-resize-running", tone: "warning", title: chatsLine(work.runningChats, name), detail: "Resizing stops them. Wait for them to finish, or resize anyway." }} />
        ) : null}
        <div role="radiogroup" aria-label="Size" className="ade-cx-a37-shapes">
          {AGENT37_SHAPES.map((shape) => {
            const price = formatAgent37HourlyPrice(agent37RunningHourlyUsd(box.type === "box" ? "default" : box.type, {
              cpu: shape.cpu,
              memoryGb: shape.memoryGb,
              diskGb: Math.max(shape.diskGb, box.resources?.diskGb ?? 0),
            }));
            const isCurrent = shape.id === current;
            return (
              <button
                key={shape.id}
                type="button"
                role="radio"
                aria-checked={shape.id === choice}
                className="ade-cx-a37-shape"
                data-current={isCurrent ? "true" : undefined}
                disabled={!allowed(shape.id)}
                onClick={() => setPicked(shape.id)}
              >
                <span className="ade-cx-a37-shape-size kit-num">{shape.cpu} vCPU · {shape.memoryGb} GB</span>
                <span className="ade-cx-a37-shape-price kit-num">{price}</span>
                {isCurrent ? <span className="kit-tag">Now</span> : null}
              </button>
            );
          })}
        </div>
        {smallestOnly ? (
          <p className="ade-cx-a37-note">Agent 37 unlocks bigger sizes after your first top-up.</p>
        ) : null}
        {keepsDisk && box.resources ? (
          <p className="ade-cx-a37-note">The disk stays at {box.resources.diskGb} GB: Agent 37 never shrinks a disk.</p>
        ) : null}
      </div>
    </Dialog>
  );
}
