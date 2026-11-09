import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Moon } from "@phosphor-icons/react";
import type { CloudAccountState, CloudMachine } from "../../../shared/adeCloud";
import type { OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { effectiveRuntimeBinding } from "../../lib/chatMachineRouting";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { cloudBoxForMachine } from "../remoteTargets/cloudMachineModel";
import { useNativeToolFeeds } from "./NativeToolFeedsContext";

/**
 * ADE Cloud's half of a Work tool: a person opening a tool that needs the
 * computer wakes it (a stopped computer starts), a restored tab or a background
 * read never does, and at 0 hours the tool says so instead.
 *
 * Account-level on the wake (ADE Cloud knows the machine by its id); the tool
 * itself keeps its `pin`. Everything here is a no-op off the machine list:
 * no ADE Cloud, or a machine that isn't a cloud computer, renders the tool.
 */

/** Tools that run on the computer; PR, Issues and Apple Development don't need it awake. */
const TOOLS_NEEDING_COMPUTER = new Set<string>([
  "terminal", "git", "files", "android", "app-control", "mac-desktop", "windows-desktop", "side-chat", "browser",
]);

/** How long after a click a tool's mount still counts as that person opening it. */
const OPENED_BY_PERSON_WINDOW_MS = 4_000;
/** Once a minute, while the person is at this window and moved in the last few minutes. */
const STILL_WATCHING_MS = 60_000;

export type WorkToolOpen = { tool: string; at: number };

/** The cloud computer behind the machine a surface works on, with the account's hours. */
export function useCloudComputer(pin: OpenProjectBinding | null | undefined): {
  box: CloudMachine | null;
  account: CloudAccountState | null;
  refresh: () => void;
} {
  const cloudEnabled = useAdeCloudEnabled();
  const bound = useAppStore((state) => state.projectBinding ?? null);
  const binding = effectiveRuntimeBinding(pin, bound);
  const { result, refresh } = useCloudMachines(cloudEnabled && binding?.kind === "remote");
  const hostname = binding?.kind === "remote" ? binding.hostname ?? null : null;
  const machineKey = useTargetMachineKey(cloudEnabled && binding?.kind === "remote" ? binding.targetId : null);
  const box = useMemo(
    () => (result && (machineKey || hostname) ? cloudBoxForMachine(result.machines, { machineKey, hostname }) : null),
    [hostname, machineKey, result],
  );
  return { box, account: result?.account ?? null, refresh };
}

/** The computer's account key behind a paired machine: a relay connection's hostname is the relay's, not the computer's. */
function useTargetMachineKey(targetId: string | null): string | null {
  const [machineKey, setMachineKey] = useState<string | null>(null);
  useEffect(() => {
    setMachineKey(null);
    if (!targetId) return;
    let cancelled = false;
    void window.ade.remoteRuntime?.listTargets?.().then(
      (targets) => {
        if (!cancelled) setMachineKey(targets.find((target) => target.id === targetId)?.pairedMachine?.machineKey?.trim() ?? null);
      },
      (error: unknown) => console.warn("[cloud] reading connection targets failed", error),
    );
    return () => {
      cancelled = true;
    };
  }, [targetId]);
  return machineKey;
}

function computerIsDown(box: CloudMachine | null): boolean {
  return box?.state === "asleep" || box?.state === "stopped";
}

/** Whether the computer is out of reach for now; PR and Jira read around it. */
export function useCloudComputerAsleep(pin: OpenProjectBinding | null | undefined): CloudMachine | null {
  const { box } = useCloudComputer(pin);
  return box && (computerIsDown(box) || box.state === "starting" || box.state === "stopping") ? box : null;
}

/** "Still watching": a real signal the computer's keep-awake counts as use. */
function useStillWatching(tool: string, pin: OpenProjectBinding | null | undefined, box: CloudMachine | null): void {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const { browserStatus } = useNativeToolFeeds();
  // The Browser counts only on the lane's own dev server; a local page keeps it awake, the open web does not.
  const onLanePreview = tool !== "browser" || isLocalPreviewUrl(browserStatus?.url ?? null);
  const watching = Boolean(box && box.state === "running") && onLanePreview && TOOLS_NEEDING_COMPUTER.has(tool);
  useEffect(() => {
    if (!watching) return;
    const beat = () => {
      void (async () => {
        const here = await window.ade.cloud?.personIsHere?.().catch((error: unknown) => {
          console.warn("[cloud] still-watching check failed", error);
          return false;
        });
        if (here) {
          await window.ade.workTools?.noteWatching?.(pinRef.current).catch((error: unknown) => {
            console.warn("[cloud] still-watching signal failed", error);
          });
        }
      })();
    };
    beat();
    const timer = window.setInterval(beat, STILL_WATCHING_MS);
    return () => window.clearInterval(timer);
    // Keyed on the stable pin key; the pin object is read through `pinRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, watching]);
}

function isLocalPreviewUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * The Push all work to GitHub button, with its own outcome line. Used on the
 * 0-hours states and the 30-day warnings. Account-level: it names the computer.
 */
export function PushAllWorkButton({ instanceId, className }: { instanceId: string; className?: string }) {
  const [state, setState] = useState<"idle" | "pushing" | string>("idle");
  const run = useCallback(() => {
    setState("pushing");
    const push = window.ade.cloud?.pushAllWork;
    if (!push) return;
    void push(instanceId).then(
      (result) => setState(result.message),
      (error: unknown) => setState(error instanceof Error ? error.message : "ADE couldn't push the work. Try again."),
    );
  }, [instanceId]);
  return (
    <span className={className}>
      <button type="button" className="ade-modern-btn" data-size="sm" disabled={state === "pushing"} onClick={run}>
        {state === "pushing" ? "Pushing all work…" : "Push all work to GitHub"}
      </button>
      {state !== "idle" && state !== "pushing" ? <span className="ml-2 text-[12px] text-muted-fg">{state}</span> : null}
    </span>
  );
}

/** Wraps one Work tool panel. Renders the tool itself when the computer can answer. */
export function CloudToolGate({
  tool,
  pin,
  opened,
  children,
}: {
  tool: string;
  pin: OpenProjectBinding | null | undefined;
  /** The last tool a person clicked open, and when. */
  opened: WorkToolOpen | null;
  children: ReactNode;
}) {
  const needsComputer = TOOLS_NEEDING_COMPUTER.has(tool);
  const { box, account, refresh } = useCloudComputer(needsComputer ? pin : null);
  useStillWatching(tool, pin, box);

  const down = computerIsDown(box);
  const outOfHours = account?.hours.state === "zero";
  const instanceId = box?.instanceId ?? null;
  const openedByPerson = opened != null && opened.tool === tool && Date.now() - opened.at < OPENED_BY_PERSON_WINDOW_MS;
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const wakeTriedFor = useRef<string | null>(null);

  const wake = useCallback(() => {
    if (!instanceId) return;
    setWaking(true);
    setWakeError(null);
    const machineAction = window.ade.cloud?.machineAction;
    if (!machineAction) return;
    void machineAction({ instanceId, action: "wake" }).then(
      (result) => {
        setWaking(false);
        if (result && !result.ok) setWakeError(result.message);
        refresh();
      },
      (error: unknown) => {
        setWaking(false);
        setWakeError(error instanceof Error ? error.message : "ADE couldn't wake this computer. Try again.");
      },
    );
  }, [instanceId, refresh]);

  // A click wakes once; a reopened tab shows the button instead.
  useEffect(() => {
    if (!down || outOfHours || !openedByPerson || !instanceId || wakeTriedFor.current === instanceId) return;
    wakeTriedFor.current = instanceId;
    wake();
  }, [down, instanceId, openedByPerson, outOfHours, wake]);

  if (!needsComputer || !box || (!down && !waking && box.state !== "starting")) return <>{children}</>;
  const name = box.name ?? "This computer";
  if (outOfHours && down) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-[13px] text-fg/80">Out of hours</p>
        <p className="text-[12px] text-muted-fg">{`${name} needs ADE Cloud hours to wake. They come back when your hours reset.`}</p>
        <PushAllWorkButton instanceId={box.instanceId} />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4 text-center">
      <Moon size={20} className="text-muted-fg" />
      <p className="text-[13px] text-fg/80">{waking || box.state === "starting" ? `Waking ${name}…` : `${name} is asleep`}</p>
      {!waking && box.state !== "starting" ? (
        <button type="button" className="ade-modern-btn" data-size="sm" data-tone="primary" onClick={wake}>
          Wake
        </button>
      ) : null}
      {wakeError ? <p className="text-[12px] text-error">{wakeError}</p> : null}
    </div>
  );
}
