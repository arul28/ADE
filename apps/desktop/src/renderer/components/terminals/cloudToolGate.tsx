import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Moon } from "@phosphor-icons/react";
import { cloudOutOfHours, type CloudMachine } from "../../../shared/adeCloud";
import type { OpenProjectBinding } from "../../../shared/types";
import { PushAllWorkButton } from "../remoteTargets/PushAllWorkButton";
import { computerIsDown, useCloudComputer } from "../remoteTargets/useCloudComputer";
import { Banner } from "../ui/notice";
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
  const { box, account, refresh } = useCloudComputer(pin, needsComputer);
  useStillWatching(tool, pin, box);

  const down = computerIsDown(box);
  const outOfHours = cloudOutOfHours(account);
  const instanceId = box?.instanceId ?? null;
  const openedByPerson = opened != null && opened.tool === tool && Date.now() - opened.at < OPENED_BY_PERSON_WINDOW_MS;
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const wakeTriedFor = useRef<string | null>(null);

  const wake = useCallback(() => {
    const machineAction = window.ade.cloud?.machineAction;
    if (!instanceId || !machineAction) return;
    setWaking(true);
    setWakeError(null);
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
      <div className="flex h-full min-h-0 flex-col justify-center gap-3 px-4">
        <Banner layout="inline" model={{ id: "cloud-tool-out-of-hours", tone: "warning", title: "Out of hours", detail: `${name} needs ADE Cloud hours to wake. They come back when your hours reset.`, report: false }} />
        <PushAllWorkButton instanceId={box.instanceId} />
      </div>
    );
  }
  const comingUp = waking || box.state === "starting";
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-3 px-4">
      <Banner
        layout="inline"
        model={{
          id: "cloud-tool-asleep",
          tone: "info",
          icon: <Moon size={15} />,
          busy: comingUp,
          title: comingUp ? `Waking ${name}…` : `${name} is asleep`,
          actions: comingUp ? undefined : [{ label: "Wake", variant: "solid", onClick: wake }],
        }}
      />
      {wakeError ? <Banner layout="inline" model={{ id: "cloud-tool-wake-failed", tone: "error", title: "ADE couldn't wake this computer", detail: wakeError, report: { surface: "cloud_tool_wake" } }} /> : null}
    </div>
  );
}
