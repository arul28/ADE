import { CalendarBlank, Clock, ShieldWarning } from "@phosphor-icons/react";
import React, { useMemo, useState } from "react";
import {
  MAX_DRAFT_GRACE_SECONDS,
  type DraftDeliveryPolicy,
  type DraftScheduleInput,
  type DraftTargetKind,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";

export type DraftScheduleConfig = {
  provider: string | null;
  modelId: string | null;
  /** Runtime-facing model string; a new chat cannot start without one. */
  model: string | null;
  permissionMode: string | null;
  thinking: string | null;
};

export type DraftScheduleTargets = {
  sessionId: string | null;
  laneId: string | null;
  laneName: string | null;
  machineKey: string | null;
  machineName: string | null;
};

export type DraftScheduleLaneOption = { id: string; name: string };

export type DraftSchedulePopoverProps = {
  targets: DraftScheduleTargets;
  config: DraftScheduleConfig;
  /** Lanes a "new chat" target may start in. */
  lanes: DraftScheduleLaneOption[];
  busy?: boolean;
  error?: string | null;
  onSubmit: (input: DraftScheduleInput) => void;
  onClose: () => void;
};

/** Elevated modes are allowed on a schedule, but never silently. */
const ELEVATED_PERMISSION_MODES = new Set([
  "full-auto",
  "bypassPermissions",
  "danger-full-access",
]);

const GRACE_CHOICES: Array<{ seconds: number; label: string }> = [
  { seconds: 15 * 60, label: "15 min" },
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 6 * 60 * 60, label: "6 hours" },
];

/** Local wall-clock "YYYY-MM-DDTHH:mm", which is what `datetime-local` wants. */
function localInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultWhenInput(): string {
  const target = new Date(Date.now() + 60 * 60 * 1000);
  target.setSeconds(0, 0);
  // Round up to the next quarter hour: nobody schedules "at :07".
  const remainder = target.getMinutes() % 15;
  if (remainder) target.setMinutes(target.getMinutes() + (15 - remainder));
  return localInputValue(target);
}

export function DraftSchedulePopover({
  targets,
  config,
  lanes,
  busy = false,
  error = null,
  onSubmit,
  onClose,
}: DraftSchedulePopoverProps) {
  const hasExistingTarget = Boolean(targets.sessionId);
  const [targetKind, setTargetKind] = useState<DraftTargetKind>(
    hasExistingTarget ? "existing" : "new",
  );
  const [laneId, setLaneId] = useState<string | null>(
    targets.laneId ?? lanes[0]?.id ?? null,
  );
  const [when, setWhen] = useState<string>(defaultWhenInput);
  const [policy, setPolicy] = useState<DraftDeliveryPolicy>("wait");
  const [graceSeconds, setGraceSeconds] = useState<number>(GRACE_CHOICES[1]!.seconds);
  const [localError, setLocalError] = useState<string | null>(null);

  const elevated = useMemo(
    () => ELEVATED_PERMISSION_MODES.has((config.permissionMode ?? "").trim()),
    [config.permissionMode],
  );

  const submit = () => {
    const fireAt = new Date(when);
    if (!Number.isFinite(fireAt.getTime())) {
      setLocalError("Pick a date and time.");
      return;
    }
    if (fireAt.getTime() <= Date.now()) {
      setLocalError("Pick a time in the future.");
      return;
    }
    if (targetKind === "existing" && !targets.sessionId) {
      setLocalError("This chat is not ready to receive a scheduled send yet.");
      return;
    }
    if (targetKind === "new" && !laneId) {
      setLocalError("Choose a lane for the new chat.");
      return;
    }
    setLocalError(null);
    onSubmit({
      scheduledAt: fireAt.toISOString(),
      targetKind,
      ...(targetKind === "existing"
        ? { targetSessionId: targets.sessionId }
        : { targetLaneId: laneId }),
      ...(targets.machineKey ? { targetMachineKey: targets.machineKey } : {}),
      deliveryPolicy: policy,
      ...(policy === "grace" ? { graceSeconds } : {}),
      provider: config.provider,
      modelId: config.modelId,
      // The runtime-facing string the composer would launch with. Falling back
      // to the model id keeps a new chat startable on hosts that only know ids.
      model: config.model ?? config.modelId,
      permissionMode: config.permissionMode,
      thinking: config.thinking,
      scheduledBy: "user",
    });
  };

  const shown = localError ?? error;

  return (
    <div
      data-draft-schedule-popover=""
      role="dialog"
      aria-label="Scheduled send"
      className={cn("w-[min(340px,calc(100vw-32px))] p-3", POPOVER_SURFACE_CLASS)}
    >
      <div className="font-sans text-[11px] font-semibold text-fg/82">Scheduled send</div>
      <div className="mt-0.5 font-sans text-[9.5px] text-muted-fg/42">
        {targets.machineName
          ? `Sent by ${targets.machineName} at that machine's local time`
          : "Sent at the target machine's local time"}
      </div>

      <div className="mt-2.5 space-y-2.5">
        <div>
          <div className="mb-1 font-sans text-[9.5px] font-semibold uppercase tracking-wide text-muted-fg/40">
            Send to
          </div>
          <div className="flex flex-col gap-1">
            <label className={cn(
              "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] transition-colors",
              targetKind === "existing" ? "bg-fg/[0.07] text-fg/85" : "text-fg/62 hover:bg-fg/[0.04]",
              !hasExistingTarget && "cursor-not-allowed opacity-40",
            )}>
              <input
                type="radio"
                name="draft-schedule-target"
                className="accent-violet-400"
                disabled={!hasExistingTarget}
                checked={targetKind === "existing"}
                onChange={() => setTargetKind("existing")}
              />
              <span className="truncate">
                {targets.laneName ? `This chat · ${targets.laneName}` : "This chat"}
              </span>
            </label>
            <label className={cn(
              "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] transition-colors",
              targetKind === "new" ? "bg-fg/[0.07] text-fg/85" : "text-fg/62 hover:bg-fg/[0.04]",
            )}>
              <input
                type="radio"
                name="draft-schedule-target"
                className="accent-violet-400"
                checked={targetKind === "new"}
                onChange={() => setTargetKind("new")}
              />
              <span>New chat in a lane</span>
            </label>
          </div>
          {targetKind === "new" ? (
            <select
              value={laneId ?? ""}
              onChange={(event) => setLaneId(event.target.value || null)}
              className="mt-1.5 w-full rounded-lg border border-fg/[0.09] bg-black/25 px-2 py-1.5 font-sans text-[11px] text-fg/78 outline-none"
            >
              {lanes.length === 0 ? <option value="">No lanes available</option> : null}
              {lanes.map((lane) => (
                <option key={lane.id} value={lane.id}>{lane.name}</option>
              ))}
            </select>
          ) : null}
        </div>

        <div>
          <div className="mb-1 font-sans text-[9.5px] font-semibold uppercase tracking-wide text-muted-fg/40">
            When
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-fg/[0.09] bg-black/25 px-2 py-1.5">
            <CalendarBlank size={12} className="shrink-0 text-muted-fg/45" aria-hidden />
            <input
              type="datetime-local"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
              className="w-full bg-transparent font-sans text-[11px] text-fg/82 outline-none [color-scheme:dark]"
            />
          </div>
        </div>

        <div>
          <div className="mb-1 font-sans text-[9.5px] font-semibold uppercase tracking-wide text-muted-fg/40">
            If late
          </div>
          <div className="flex flex-col gap-1">
            {([
              ["wait", "Wait for me", "Send whenever this machine can, however late."],
              ["strict", "Strict", "Send on time or report it missed."],
              ["grace", "Grace window", "Send late, but give up after a while."],
            ] as const).map(([value, label, detail]) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors",
                  policy === value ? "bg-fg/[0.07]" : "hover:bg-fg/[0.04]",
                )}
              >
                <input
                  type="radio"
                  name="draft-schedule-policy"
                  className="mt-0.5 accent-violet-400"
                  checked={policy === value}
                  onChange={() => setPolicy(value)}
                />
                <span className="min-w-0">
                  <span className="block font-sans text-[11px] text-fg/82">{label}</span>
                  <span className="block font-sans text-[9.5px] leading-4 text-muted-fg/42">{detail}</span>
                </span>
              </label>
            ))}
          </div>
          {policy === "grace" ? (
            <select
              value={String(graceSeconds)}
              onChange={(event) => setGraceSeconds(Number(event.target.value))}
              className="mt-1.5 w-full rounded-lg border border-fg/[0.09] bg-black/25 px-2 py-1.5 font-sans text-[11px] text-fg/78 outline-none"
            >
              {GRACE_CHOICES.filter((choice) => choice.seconds <= MAX_DRAFT_GRACE_SECONDS).map((choice) => (
                <option key={choice.seconds} value={choice.seconds}>Give up after {choice.label}</option>
              ))}
            </select>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 rounded-lg bg-fg/[0.035] px-2 py-1.5">
          {elevated ? (
            <ShieldWarning size={12} className="shrink-0 text-amber-300/80" aria-hidden />
          ) : (
            <Clock size={12} className="shrink-0 text-muted-fg/40" aria-hidden />
          )}
          <span className="min-w-0 truncate font-mono text-[9.5px] text-muted-fg/52">
            {[config.provider, config.modelId ?? config.model, config.permissionMode]
              .filter((value): value is string => Boolean(value && value.trim()))
              .join(" · ") || "Host defaults"}
          </span>
          {elevated ? (
            <span className="shrink-0 rounded bg-amber-400/12 px-1 py-px font-sans text-[8.5px] font-semibold text-amber-200/85">
              Elevated
            </span>
          ) : null}
        </div>
      </div>

      {shown ? (
        <div className="mt-2 rounded-lg border border-red-300/[0.08] bg-red-500/[0.05] px-2 py-1.5 font-sans text-[10px] leading-4 text-red-200/75" role="alert">
          {shown}
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-1.5">
        <button
          type="button"
          className="rounded-lg px-2.5 py-1.5 font-sans text-[11px] text-muted-fg/55 transition-colors hover:bg-fg/[0.05] hover:text-fg/75"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          className={cn(
            "rounded-lg bg-violet-500/85 px-3 py-1.5 font-sans text-[11px] font-semibold text-white transition-colors hover:bg-violet-500",
            busy && "cursor-not-allowed opacity-50",
          )}
          onClick={submit}
        >
          {busy ? "Scheduling…" : "Schedule"}
        </button>
      </div>
    </div>
  );
}
