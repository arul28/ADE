import { ArrowRight, CircleNotch, Play, Power } from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import type { DeviceKind } from "../../../shared/types/deviceSources";
import { cn } from "../ui/cn";
import { DEVICE_KINDS, railMachineName } from "./workToolCatalog";
import { workToolDefinition } from "./workTools";
import type { ToolMachine } from "./useToolMachines";
import { MachineOsMark, WorkToolTileMark } from "./workToolTileMarks";

type StartAsk = { id: string; label: string; detail: string; icon: ReactNode; prompt: (machine: string) => string };

const SHOW = "and show it to me in the tools pane";

/** What a person can ask the agent to do with a device that is not running yet. */
const START_ASKS: Readonly<Record<DeviceKind, readonly StartAsk[]>> = {
  ios: [
    {
      id: "boot",
      label: "Boot a simulator",
      detail: "An iPhone, ready to drive",
      icon: <Power size={15} weight="bold" />,
      prompt: (machine) => `Start an Apple simulator for this chat on ${machine} (ade apple start) ${SHOW}.`,
    },
    {
      id: "run",
      label: "Run this app on it",
      detail: "Build, install and open it",
      icon: <Play size={15} weight="fill" />,
      prompt: (machine) => `Build this app and run it on an Apple simulator on ${machine} (ade apple), then open it ${SHOW}.`,
    },
  ],
  android: [
    {
      id: "boot",
      label: "Boot an emulator",
      detail: "A Pixel, ready to drive",
      icon: <Power size={15} weight="bold" />,
      prompt: (machine) => `Start an Android emulator for this chat on ${machine} (ade android) ${SHOW}.`,
    },
    {
      id: "run",
      label: "Run this app on it",
      detail: "Build, install and open it",
      icon: <Play size={15} weight="fill" />,
      prompt: (machine) => `Build this app and run it on an Android emulator on ${machine} (ade android), then open it ${SHOW}.`,
    },
  ],
  app: [
    {
      id: "run",
      label: "Launch this app",
      detail: "Start it and drive it with App Control",
      icon: <Play size={15} weight="fill" />,
      prompt: (machine) => `Launch this project's app on ${machine} with App Control (ade app-control) ${SHOW}.`,
    },
  ],
  screen: [
    {
      id: "boot",
      label: "Open a screen",
      detail: "A private desktop for this chat",
      icon: <Power size={15} weight="bold" />,
      prompt: (machine) => `Start a private screen for this chat on ${machine} (ade screen) ${SHOW}.`,
    },
  ],
};

const KIND_CARD = { ios: "ios", android: "android", screen: "screen", app: "app-control" } as const;
const KIND_TOOL = { ios: "ios", android: "android", screen: "mac-desktop", app: "app-control" } as const;

function startStyle(kind: DeviceKind): CSSProperties {
  const color = workToolDefinition(KIND_TOOL[kind])?.color ?? "var(--color-accent)";
  return { ["--start-color" as string]: kind === "ios" ? "var(--color-fg)" : color } as CSSProperties;
}

/**
 * The screen's frame: centred while it fits, and scrolls only when it does
 * not (many Macs in a short pane), with the first choice still reachable.
 */
function StartFrame({ kind, testId, children }: { kind: DeviceKind; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} style={startStyle(kind)} className="flex h-full min-h-0 flex-col overflow-y-auto px-6 [scrollbar-width:thin]">
      <div className="m-auto flex w-full flex-col items-center gap-6 py-6 text-center">{children}</div>
    </div>
  );
}

const START_CHOICE = cn(
  "group flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left",
  "bg-fg/[0.03] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)]",
  "transition-colors duration-[120ms] ease-out hover:bg-fg/[0.06]",
  "hover:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--start-color)_35%,transparent)]",
  "focus-visible:outline-none! focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:pointer-events-none disabled:opacity-45",
);

const START_CHOICE_PICKED = "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--start-color)_35%,transparent)]";

const START_CHOICE_ICON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[color-mix(in_srgb,var(--start-color)_12%,transparent)] text-fg";

/** One full-width choice: icon tile, label over a detail line, arrow. */
function StartChoice({
  icon,
  label,
  detail,
  disabled,
  picked = false,
  onClick,
  testId,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  disabled: boolean;
  picked?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={cn(START_CHOICE, picked && START_CHOICE_PICKED)}
    >
      <span aria-hidden="true" className={START_CHOICE_ICON}>{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-sans text-[13px] font-medium text-fg">{label}</span>
        <span className="truncate font-sans text-[11.5px] text-muted-fg">{detail}</span>
      </span>
      <ArrowRight
        size={14}
        weight="bold"
        aria-hidden="true"
        className="shrink-0 text-muted-fg/60 transition-transform duration-[120ms] group-hover:translate-x-0.5 group-hover:text-fg"
      />
    </button>
  );
}

/** The tool's mark on a soft glow, and the machine it runs on under it. */
function StartHero({ kind, machine, glowing }: { kind: DeviceKind; machine: ToolMachine | null; glowing: boolean }) {
  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 h-[180px] w-[180px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-2xl",
          "bg-[radial-gradient(circle,color-mix(in_srgb,var(--start-color)_16%,transparent),transparent_70%)]",
          glowing && "motion-safe:animate-pulse",
        )}
      />
      <div
        className={cn(
          "relative grid h-[84px] w-[84px] place-items-center rounded-[24px] text-fg",
          "bg-[linear-gradient(160deg,color-mix(in_srgb,var(--start-color)_14%,var(--color-surface)),var(--color-surface))]",
          "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--start-color)_22%,transparent),0_12px_32px_-12px_rgba(0,0,0,0.5)]",
        )}
      >
        <WorkToolTileMark card={KIND_CARD[kind]} machine={machine} size="38px" />
      </div>
      {machine ? (
        <span
          className={cn(
            "absolute -bottom-3 left-1/2 inline-flex max-w-[220px] -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1",
            "bg-[var(--color-surface)] font-sans text-[11.5px] font-medium text-fg/85",
            "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_80%,transparent)]",
          )}
        >
          <span
            aria-hidden="true"
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", machine.online ? "bg-emerald-400" : "bg-muted-fg/50")}
          />
          <MachineOsMark machine={machine} size={11} />
          <span className="truncate">{railMachineName(machine)}</span>
        </span>
      ) : null}
    </div>
  );
}

function StartText({ title, line }: { title: string; line: string }) {
  return (
    <div className="mt-2 flex max-w-[320px] flex-col gap-1.5">
      <p className="font-sans text-[15px] font-semibold text-fg">{title}</p>
      <p className="font-sans text-[12.5px] leading-[18px] text-muted-fg">{line}</p>
    </div>
  );
}

/**
 * An open device tool on a machine where nothing runs for this chat yet.
 *
 * Picking a machine only says where the chat's devices of this kind go (the
 * setting `ade devices use` writes); the agent starts one there. So this
 * screen is where you ask it to: each button sends the agent a plain
 * request as your message, and the device shows up here once it is running.
 * Without a chat to ask (`onAskAgent` null), it says how to get one.
 */
export function WorkToolStartState({
  kind,
  machine,
  viewOnly,
  onAskAgent,
}: {
  kind: DeviceKind;
  machine: ToolMachine;
  /** The chat's machine keeps no device choice: this machine is only what the panel shows. */
  viewOnly: boolean;
  onAskAgent: ((text: string) => Promise<boolean>) | null;
}) {
  const [asked, setAsked] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const noun = DEVICE_KINDS[kind].noun;
  const offline = !machine.online;

  const ask = (option: StartAsk) => {
    if (!onAskAgent || sending) return;
    setSending(option.id);
    void onAskAgent(option.prompt(machine.name)).then((ok) => {
      setSending(null);
      if (ok) setAsked(option.id);
    });
  };

  let footer: string;
  if (offline) footer = `${railMachineName(machine)} is offline. Wake it, then ask again.`;
  else if (asked) footer = "Asked. It shows up here as soon as it's running.";
  else if (onAskAgent) footer = "Or ask for anything in the chat.";
  else footer = `Ask the agent to start the ${noun}, and it shows up here.`;

  return (
    <StartFrame kind={kind} testId="remote-work-no-code-there">
      <StartHero kind={kind} machine={machine} glowing={Boolean(asked)} />
      <StartText
        title={asked ? `Starting the ${noun}…` : `No ${noun} running yet`}
        line={viewOnly
          ? `Showing ${machine.name}. Ask the agent to start one there and watch it here.`
          : `This chat's ${noun}s run on ${machine.name}. Tell the agent what to do and watch it here.`}
      />
      {onAskAgent ? (
        <div className="flex w-full max-w-[320px] flex-col gap-2">
          {START_ASKS[kind].map((option) => (
            <StartChoice
              key={option.id}
              testId={`work-tool-start-${option.id}`}
              icon={sending === option.id ? <CircleNotch size={15} className="animate-spin" /> : option.icon}
              label={option.label}
              detail={asked === option.id ? "Asked the agent" : option.detail}
              picked={asked === option.id}
              disabled={offline || Boolean(sending)}
              onClick={() => ask(option)}
            />
          ))}
        </div>
      ) : null}
      <p className="max-w-[320px] font-sans text-[11.5px] text-muted-fg/80">{footer}</p>
    </StartFrame>
  );
}

/**
 * An open device tool whose chat runs on a machine that can't run it, with no
 * other machine chosen yet: the machines that can, one press each. A press is
 * the chat's device choice (`ade devices use`), the same as the row above.
 */
export function WorkToolPickMachineState({
  kind,
  machines,
  read,
  viewOnly,
  onChoose,
}: {
  kind: DeviceKind;
  /** The machines that can run it, offline ones too. */
  machines: readonly ToolMachine[];
  /** Whether the account's machine list was read: an unread list is not an empty one. */
  read: "pending" | "ok" | "failed";
  /** The chat's machine keeps no device choice: a pick only changes what this panel shows. */
  viewOnly: boolean;
  onChoose: ((machine: ToolMachine) => void) | null;
}) {
  const noun = DEVICE_KINDS[kind].noun;
  const title = kind === "ios" ? "Apple simulators run on a Mac" : `This machine can't run the ${noun}`;
  const somewhere = kind === "ios" ? "a Mac" : "a machine that can run it";
  let line: string;
  if (!machines.length && read === "pending") line = "Looking for your machines…";
  else if (!machines.length && read === "failed") line = "Couldn't read your account's machines. Check that ADE is signed in, then open this again.";
  else if (!machines.length) line = `Sign in to ADE on ${somewhere} and it shows up here.`;
  else if (!onChoose) line = `Open a chat on this lane to pick where its ${noun}s run.`;
  else if (viewOnly) line = `Pick ${somewhere} to show its ${noun} here, then ask the agent to start one.`;
  else line = `Pick where this chat's ${noun}s run. Then ask the agent to start one.`;
  return (
    <StartFrame kind={kind} testId="work-tool-pick-machine">
      <StartHero kind={kind} machine={null} glowing={false} />
      <StartText title={title} line={line} />
      {onChoose && machines.length ? (
        <div className="flex w-full max-w-[320px] flex-col gap-2">
          {machines.map((machine) => (
            <StartChoice
              key={machine.key}
              icon={<MachineOsMark machine={machine} size={15} />}
              label={railMachineName(machine)}
              detail={machine.online ? "Online" : "Offline"}
              disabled={!machine.online}
              onClick={() => onChoose(machine)}
            />
          ))}
        </div>
      ) : null}
    </StartFrame>
  );
}
